import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, zstdCompress } from "node:zlib";

import { resolveRepoPath } from "../catalog.mjs";
import { sha256Hex } from "./hash.mjs";
import { blobObjectKey } from "./library-catalog.mjs";

const execFileAsync = promisify(execFile);
const zstdCompressAsync = promisify(zstdCompress);
const INSPECT_SCRIPT = resolveRepoPath("scripts", "inspect-pe.ps1");
const SIGNATURE_POLICIES = new Set(["Strict", "OpenVr"]);

export async function inspectPeFiles(paths, { signaturePolicy = "Strict" } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("PE inspection requires at least one path");
  }
  if (!SIGNATURE_POLICIES.has(signaturePolicy)) {
    throw new Error(`unsupported PE signature policy ${signaturePolicy}`);
  }
  const { stdout } = await execFileAsync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-File",
      INSPECT_SCRIPT,
      "-SignaturePolicy",
      signaturePolicy,
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
