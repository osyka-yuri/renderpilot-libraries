import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, zstdCompress } from "node:zlib";

import { resolveRepoPath } from "../catalog.mjs";
import { sha256Hex } from "./hash.mjs";
import {
  assertLegalDocumentPayload,
  blobObjectKey,
  legalDocumentObjectKey,
} from "./library-catalog.mjs";

const execFileAsync = promisify(execFile);
const zstdCompressAsync = promisify(zstdCompress);
const INSPECT_SCRIPT = resolveRepoPath("scripts", "inspect-pe.ps1");
const AUTHENTICODE_MODES = new Set(["RequireSigned", "AllowUnsigned"]);
const MAX_LOCKED_TIMESTAMP_ROUNDING_DRIFT_MS = 1;

export async function inspectPeFiles(paths, { authenticodeMode = "RequireSigned" } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("PE inspection requires at least one path");
  }
  if (!AUTHENTICODE_MODES.has(authenticodeMode)) {
    throw new Error(`unsupported Authenticode inspection mode ${authenticodeMode}`);
  }
  const { stdout } = await execFileAsync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-File",
      INSPECT_SCRIPT,
      "-AuthenticodeMode",
      authenticodeMode,
      ...paths,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const inspections = Array.isArray(parsed) ? parsed : [parsed];
  if (inspections.length !== paths.length) {
    throw new Error(
      `PE inspector returned ${inspections.length} results for ${paths.length} files`,
    );
  }
  return inspections;
}

export async function persistCompressedDll(
  dll,
  { cdnDirectory = resolveRepoPath("cdn"), compressionLevel = 12 } = {},
) {
  if (!Buffer.isBuffer(dll) || dll.length === 0) {
    throw new Error("DLL payload must be a non-empty Buffer");
  }
  if (
    !Number.isSafeInteger(compressionLevel) ||
    compressionLevel < 1 ||
    compressionLevel > 22
  ) {
    throw new Error(`invalid Zstandard compression level ${compressionLevel}`);
  }
  const compressed = await zstdCompressAsync(dll, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: compressionLevel,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const sha256 = sha256Hex(compressed);
  const objectKey = blobObjectKey(sha256);
  await writeImmutableObject(path.join(cdnDirectory, objectKey), compressed);
  return {
    object_key: objectKey,
    zst_sha256: sha256,
    zst_size_bytes: compressed.length,
    compression_level: compressionLevel,
  };
}

export async function persistLegalDocument(
  bytes,
  format,
  { cdnDirectory = resolveRepoPath("cdn") } = {},
) {
  assertLegalDocumentPayload(bytes, format, "legal document");
  const sha256 = sha256Hex(bytes);
  const objectKey = legalDocumentObjectKey(sha256, format);
  await writeImmutableObject(path.join(cdnDirectory, objectKey), bytes);
  return {
    object_key: objectKey,
    sha256,
    size_bytes: bytes.length,
  };
}

export async function writeImmutableObject(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await readFile(file);
    if (!existing.equals(bytes)) {
      throw new Error(`${file}: immutable object has other bytes`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(file);
      if (!existing.equals(bytes)) {
        throw new Error(`${file}: immutable object has other bytes`);
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export function canonicalPeVersion(version, { allowNull = false } = {}) {
  if (version === null) {
    if (allowNull) return null;
    throw new Error("PE version is required");
  }
  if (typeof version !== "string" || !/^\d+(?:\.\d+)*$/u.test(version)) {
    throw new Error(`invalid PE version ${JSON.stringify(version)}`);
  }
  const parts = version.split(".");
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts.join(".");
}

export function canonicalAuthenticodeSignature(signature) {
  if (signature?.status === "unsigned") return { status: "unsigned" };
  if (signature?.status !== "signed") {
    throw new Error("unsupported Authenticode signature result");
  }
  return {
    status: "signed",
    subject: signature.subject,
    thumbprint: signature.thumbprint,
    signed_at:
      signature.signed_at === null ? null : new Date(signature.signed_at).toISOString(),
  };
}

export function reconcileLockedAuthenticodeSignature(
  observedSignature,
  lockedSignature,
  { allowTimestampBackfill = false, context = "Authenticode signature" } = {},
) {
  const observed = canonicalAuthenticodeSignature(observedSignature);
  const locked = canonicalAuthenticodeSignature(lockedSignature);
  if (
    observed.status !== locked.status ||
    (locked.status === "signed" &&
      (observed.subject !== locked.subject || observed.thumbprint !== locked.thumbprint))
  ) {
    throw new Error(`${context}: verified signer differs from locked metadata`);
  }
  if (locked.status === "unsigned") return locked;

  if (locked.signed_at === null) {
    if (observed.signed_at === null) return locked;
    if (allowTimestampBackfill) return observed;
    throw new Error(`${context}: verified timestamp presence differs from locked metadata`);
  }
  if (observed.signed_at === null) {
    throw new Error(`${context}: verified timestamp is missing`);
  }

  const drift = Math.abs(Date.parse(observed.signed_at) - Date.parse(locked.signed_at));
  if (drift > MAX_LOCKED_TIMESTAMP_ROUNDING_DRIFT_MS) {
    throw new Error(
      `${context}: verified timestamp ${observed.signed_at} differs from locked ${locked.signed_at}`,
    );
  }

  // The same content-pinned DLL can be rounded to adjacent milliseconds by
  // different Windows/.NET timestamp decoders. Preserve the reviewed lock
  // representation after bounding that runtime-only variance.
  return locked;
}
