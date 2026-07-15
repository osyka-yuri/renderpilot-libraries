// Pure ZIP metadata helpers for the Luma payload identity guard. The network
// caller fetches only the EOCD tail and central-directory byte range; archive
// payloads are never downloaded or unpacked.

import { isPlainObject } from "./common.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

export const ZIP_EOCD_TAIL_BYTES = 0xffff + 22;

export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value ?? ""));
  if (!match) throw new Error(`invalid Content-Range header: ${JSON.stringify(value)}`);

  const [, startText, endText, totalText] = match;
  const start = Number(startText);
  const end = Number(endText);
  const total = Number(totalText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    throw new Error(`invalid Content-Range bounds: ${JSON.stringify(value)}`);
  }
  return { start, end, total };
}

export function assertPartialResponse({
  status,
  contentRange,
  bytesLength,
  expected,
  maxBytes,
}) {
  if (status !== 206)
    throw new Error(`server did not honor range request (HTTP ${status})`);
  const range = parseContentRange(contentRange);
  if (range.start !== expected.start || range.end !== expected.end) {
    throw new Error(
      `server returned ${range.start}-${range.end}, expected ${expected.start}-${expected.end}`,
    );
  }
  if (range.total !== expected.total || bytesLength !== range.end - range.start + 1) {
    throw new Error("range response length does not match Content-Range");
  }
  if (bytesLength > maxBytes)
    throw new Error(`range response exceeds ${maxBytes} byte safety limit`);
  return range;
}

/**
 * Locate ZIP central-directory metadata from a suffix response that ends at
 * the archive's final byte. Only standard single-disk, non-ZIP64 archives are
 * accepted, so a changed upstream layout requires deliberate curation.
 */
export function centralDirectoryFromTail(tailBytes, tailRange) {
  const bytes = Buffer.from(tailBytes);
  const range = normalizeRange(tailRange);
  if (range.end !== range.total - 1) {
    throw new Error("ZIP tail range must end at the archive's final byte");
  }
  if (bytes.length !== range.end - range.start + 1) {
    throw new Error("ZIP tail bytes do not match the supplied range");
  }

  const eocdOffset = findEndOfCentralDirectory(bytes);
  const absoluteEocdOffset = range.start + eocdOffset;
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const entries = bytes.readUInt16LE(eocdOffset + 10);
  const size = bytes.readUInt32LE(eocdOffset + 12);
  const start = bytes.readUInt32LE(eocdOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntries !== entries ||
    diskEntries === ZIP64_SENTINEL_16 ||
    entries === ZIP64_SENTINEL_16 ||
    size === ZIP64_SENTINEL_32 ||
    start === ZIP64_SENTINEL_32
  ) {
    throw new Error(
      "ZIP64 or multi-disk archive layout is not supported by the catalog guard",
    );
  }

  const endExclusive = start + size;
  if (!Number.isSafeInteger(endExclusive) || endExclusive > absoluteEocdOffset) {
    throw new Error("ZIP central directory lies outside the archive bounds");
  }
  if (size === 0) throw new Error("ZIP central directory is empty");

  return { start, end: endExclusive - 1, size, total: range.total, entries };
}

export function rootAddonFromCentralDirectory(centralDirectoryBytes, descriptor) {
  const bytes = Buffer.from(centralDirectoryBytes);
  const { entries, size } = descriptor ?? {};
  if (!Number.isInteger(entries) || entries < 0 || !Number.isInteger(size) || size < 0) {
    throw new Error("invalid central directory descriptor");
  }
  if (bytes.length !== size) {
    throw new Error(
      `central directory length ${bytes.length} does not match expected ${size}`,
    );
  }

  let offset = 0;
  const rootAddons = [];
  for (let index = 0; index < entries; index += 1) {
    requireRange(bytes, offset, 46, "central directory header");
    if (bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`invalid central directory entry ${index}`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, offset, entryLength, `central directory entry ${index}`);

    const name = decodeZipName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      flags,
    );
    if (
      !name.includes("/") &&
      !name.includes("\\") &&
      name.toLowerCase().endsWith(".addon")
    ) {
      rootAddons.push(name);
    }
    offset += entryLength;
  }

  if (offset !== bytes.length) {
    throw new Error("central directory size does not match its entry records");
  }
  if (rootAddons.length !== 1) {
    throw new Error(
      `Luma archive must contain exactly one root .addon, found ${rootAddons.length}`,
    );
  }
  return rootAddons[0];
}

// Compatibility helper for unit tests and local archive inspection.
export function rootAddonFromZip(zipBytes) {
  const bytes = Buffer.from(zipBytes);
  const descriptor = centralDirectoryFromTail(bytes, {
    start: 0,
    end: bytes.length - 1,
    total: bytes.length,
  });
  return rootAddonFromCentralDirectory(
    bytes.subarray(descriptor.start, descriptor.end + 1),
    descriptor,
  );
}

export function collectAssetPayloadIdentities(manifest) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.games)) {
    throw new Error("addons/v1/luma.json must be an object with a games array");
  }

  const identities = new Map();
  for (const [index, game] of manifest.games.entries()) {
    if (!isPlainObject(game) || !isPlainObject(game.package)) {
      throw new Error(`addons/v1/luma.json games[${index}] must have a package object`);
    }
    const { release_asset: asset, addon_file: addonFile } = game.package;
    if (typeof asset !== "string" || asset.length === 0) {
      throw new Error(
        `addons/v1/luma.json games[${index}].package.release_asset must be a non-empty string`,
      );
    }
    if (typeof addonFile !== "string" || addonFile.length === 0) {
      throw new Error(
        `addons/v1/luma.json games[${index}].package.addon_file must be a non-empty string`,
      );
    }

    const previous = identities.get(asset);
    if (previous !== undefined && previous !== addonFile) {
      throw new Error(
        `asset "${asset}" maps to multiple root add-ons: "${previous}" and "${addonFile}"`,
      );
    }
    identities.set(asset, addonFile);
  }

  return [...identities]
    .map(([asset, addonFile]) => ({ asset, addonFile }))
    .sort((left, right) => left.asset.localeCompare(right.asset));
}

function normalizeRange(range) {
  if (
    !range ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    !Number.isSafeInteger(range.total) ||
    range.start < 0 ||
    range.end < range.start ||
    range.total <= range.end
  ) {
    throw new Error("invalid ZIP byte range");
  }
  return range;
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("ZIP archive has no valid end of central directory record");
}

function decodeZipName(bytes, flags) {
  if (flags & 0x0800) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if ([...bytes].some((byte) => byte > 0x7f)) {
    throw new Error("non-UTF-8 ZIP filenames are not supported by the catalog guard");
  }
  return bytes.toString("ascii");
}

function requireRange(bytes, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`truncated ZIP ${label}`);
  }
}
