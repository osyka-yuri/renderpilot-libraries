import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import { sha256Hex } from "./hash.mjs";
import { assertLegalDocumentPayload, legalDocumentObjectKey } from "./library-catalog.mjs";

const zstdDecompressAsync = promisify(zstdDecompress);

/**
 * Validates one immutable library object without requiring an object-store
 * client or credentials. Callers may repeat this immediately before upload.
 */
export async function validateLibraryAssetPayload(key, body, expected) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Error(`${key}: library asset payload is empty or invalid`);
  }
  if (body.length !== expected.storedSize) {
    throw new Error(
      `${key}: local size mismatch (expected ${expected.storedSize}, got ${body.length})`,
    );
  }
  const storedSha256 = sha256Hex(body);
  if (storedSha256 !== expected.storedSha256) {
    throw new Error(`${key}: local bytes do not match the catalog SHA-256`);
  }

  if (expected.kind === "dll") {
    await validateBinaryPayload(key, body, expected);
  } else if (expected.kind === "legal") {
    if (key !== legalDocumentObjectKey(expected.storedSha256, expected.format)) {
      throw new Error(`${key}: legal object key does not match content identity`);
    }
    assertLegalDocumentPayload(body, expected.format, key);
  } else {
    throw new Error(
      `${key}: unsupported library asset kind ${JSON.stringify(expected.kind)}`,
    );
  }

  return { size: body.length, sha256: storedSha256 };
}

async function validateBinaryPayload(key, body, expected) {
  let dll;
  try {
    dll = await zstdDecompressAsync(body, {
      maxOutputLength: expected.dllSize + 1,
    });
  } catch (error) {
    throw new Error(`${key}: invalid ZST payload`, { cause: error });
  }
  if (dll.length !== expected.dllSize) {
    throw new Error(
      `${key}: DLL size mismatch (expected ${expected.dllSize}, got ${dll.length})`,
    );
  }
  const dllSha256 = sha256Hex(dll);
  if (dllSha256 !== expected.dllSha256) {
    throw new Error(
      `${key}: DLL SHA-256 mismatch (expected ${expected.dllSha256}, got ${dllSha256})`,
    );
  }
}
