import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import { canonicalPeVersion, persistCompressedDll } from "../lib/library-artifact-io.mjs";

const zstdDecompressAsync = promisify(zstdDecompress);

test("nullable PE versions remain nullable and numeric versions canonicalize", () => {
  assert.throws(() => canonicalPeVersion(null), /required/);
  assert.equal(canonicalPeVersion(null, { allowNull: true }), null);
  assert.equal(canonicalPeVersion("1.2.0.0"), "1.2");
  assert.equal(canonicalPeVersion("0.0.0.0"), "0");
  assert.throws(() => canonicalPeVersion("1.2-preview"), /invalid PE version/);
});

test("locked DLL transport can be recovered deterministically without mutable writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "renderpilot-artifact-io-test-"));
  try {
    const dll = Buffer.from("synthetic-openvr-dll");
    const first = await persistCompressedDll(dll, {
      cdnDirectory: directory,
      compressionLevel: 12,
    });
    const objectPath = path.join(directory, first.object_key);
    assert.deepEqual(await zstdDecompressAsync(await readFile(objectPath)), dll);

    const repeated = await persistCompressedDll(dll, {
      cdnDirectory: directory,
      compressionLevel: 12,
    });
    assert.deepEqual(repeated, first);

    await unlink(objectPath);
    const recovered = await persistCompressedDll(dll, {
      cdnDirectory: directory,
      compressionLevel: 12,
    });
    assert.deepEqual(recovered, first);
    assert.deepEqual(await zstdDecompressAsync(await readFile(objectPath)), dll);

    await writeFile(objectPath, Buffer.from("tampered"));
    await assert.rejects(
      persistCompressedDll(dll, {
        cdnDirectory: directory,
        compressionLevel: 12,
      }),
      /immutable object has other bytes/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
