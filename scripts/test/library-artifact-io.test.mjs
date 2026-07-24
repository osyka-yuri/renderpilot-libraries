import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import {
  CANONICAL_ZSTD_CHECKSUM_FLAG,
  CANONICAL_ZSTD_VERSION,
  assertCanonicalZstdRuntime,
  canonicalPeVersion,
  persistCompressedDll,
  reconcileLockedAuthenticodeSignature,
} from "../lib/library-artifact-io.mjs";

const zstdDecompressAsync = promisify(zstdDecompress);

test("DLL compression requires the reviewed Zstandard runtime", () => {
  assert.equal(CANONICAL_ZSTD_VERSION, "1.5.7");
  assert.equal(CANONICAL_ZSTD_CHECKSUM_FLAG, 1);
  assert.doesNotThrow(() => assertCanonicalZstdRuntime());
  assert.throws(
    () => assertCanonicalZstdRuntime("1.5.8"),
    /unsupported Zstandard runtime "1\.5\.8"; expected 1\.5\.7/u,
  );
});

test("nullable PE versions remain nullable and numeric versions canonicalize", () => {
  assert.throws(() => canonicalPeVersion(null), /required/);
  assert.equal(canonicalPeVersion(null, { allowNull: true }), null);
  assert.equal(canonicalPeVersion("1.2.0.0"), "1.2");
  assert.equal(canonicalPeVersion("0.0.0.0"), "0");
  assert.throws(() => canonicalPeVersion("1.2-preview"), /invalid PE version/);
});

test("locked Authenticode metadata tolerates only adjacent timestamp rounding", () => {
  const locked = {
    status: "signed",
    subject: "CN=Example",
    thumbprint: "A".repeat(40),
    signed_at: "2021-05-14T00:23:56.563Z",
  };
  const adjacent = {
    ...locked,
    signed_at: "2021-05-14T00:23:56.562Z",
  };
  assert.deepEqual(reconcileLockedAuthenticodeSignature(adjacent, locked), locked);

  assert.throws(
    () =>
      reconcileLockedAuthenticodeSignature(
        { ...locked, signed_at: "2021-05-14T00:23:56.561Z" },
        locked,
      ),
    /verified timestamp 2021-05-14T00:23:56\.561Z differs from locked 2021-05-14T00:23:56\.563Z/u,
  );
  assert.throws(
    () =>
      reconcileLockedAuthenticodeSignature(
        { ...locked, thumbprint: "B".repeat(40) },
        locked,
      ),
    /signer differs/,
  );

  const undated = { ...locked, signed_at: null };
  assert.throws(
    () => reconcileLockedAuthenticodeSignature(locked, undated),
    /timestamp presence differs/,
  );
  assert.deepEqual(
    reconcileLockedAuthenticodeSignature(locked, undated, {
      allowTimestampBackfill: true,
    }),
    locked,
  );
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
      expectedTransport: first,
    });
    assert.deepEqual(repeated, first);

    await unlink(objectPath);
    await assert.rejects(
      persistCompressedDll(dll, {
        cdnDirectory: directory,
        compressionLevel: 12,
        expectedTransport: {
          ...first,
          zst_size_bytes: first.zst_size_bytes + 1,
        },
      }),
      /does not match locked identity/u,
    );
    await assert.rejects(readFile(objectPath), { code: "ENOENT" });

    const recovered = await persistCompressedDll(dll, {
      cdnDirectory: directory,
      compressionLevel: 12,
      expectedTransport: first,
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
