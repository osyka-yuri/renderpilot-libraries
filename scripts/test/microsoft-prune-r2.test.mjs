import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "../lib/hash.mjs";
import {
  buildLibraryIndex,
  buildVendorSnapshot,
  jsonDocument,
  vendorSnapshotObjectKey,
} from "../lib/library-catalog.mjs";
import {
  assertPublishedWithdrawalCommitted,
  deleteObjectAndVerifyAbsent,
  LIBRARY_INDEX_OBJECT_KEY,
} from "../lib/microsoft-prune-r2.mjs";

const BUCKET = "test-bucket";
const PACKAGE_ID = "Microsoft.Direct3D.DXC";
const PACKAGE_VERSION = "1.9.0-preview";
const TRANSPORT_KEY = `libraries/blobs/sha256/${"a".repeat(64)}.dll.zst`;

test("published withdrawal guard returns the remote active transport graph", async (t) => {
  const fixture = await publishedFixture(t);
  const active = await assertPublishedWithdrawalCommitted(fixture.s3, {
    bucket: BUCKET,
    localIndexFile: fixture.localIndexFile,
    packageId: PACKAGE_ID,
    packageVersion: PACKAGE_VERSION,
  });
  assert.deepEqual([...active], [TRANSPORT_KEY]);
});

test("published withdrawal guard rejects commit-point and snapshot drift", async (t) => {
  const fixture = await publishedFixture(t);
  await writeFile(fixture.localIndexFile, "{}\n");
  await assert.rejects(
    assertPublishedWithdrawalCommitted(fixture.s3, {
      bucket: BUCKET,
      localIndexFile: fixture.localIndexFile,
      packageId: PACKAGE_ID,
      packageVersion: PACKAGE_VERSION,
    }),
    /commit point/u,
  );

  const stale = await publishedFixture(t, { snapshotSha256: "f".repeat(64) });
  await assert.rejects(
    assertPublishedWithdrawalCommitted(stale.s3, {
      bucket: BUCKET,
      localIndexFile: stale.localIndexFile,
      packageId: PACKAGE_ID,
      packageVersion: PACKAGE_VERSION,
    }),
    /snapshot does not match/u,
  );
});

test("published withdrawal guard rejects a release still visible in production", async (t) => {
  const fixture = await publishedFixture(t, { includeWithdrawnRelease: true });
  await assert.rejects(
    assertPublishedWithdrawalCommitted(fixture.s3, {
      bucket: BUCKET,
      localIndexFile: fixture.localIndexFile,
      packageId: PACKAGE_ID,
      packageVersion: PACKAGE_VERSION,
    }),
    /still references/u,
  );
});

test("published withdrawal guard fails closed on a malformed vendor snapshot", async (t) => {
  const fixture = await publishedFixture(t, { malformedVendor: true });
  await assert.rejects(
    assertPublishedWithdrawalCommitted(fixture.s3, {
      bucket: BUCKET,
      localIndexFile: fixture.localIndexFile,
      packageId: PACKAGE_ID,
      packageVersion: PACKAGE_VERSION,
    }),
    /snapshot is invalid/u,
  );
});

test("R2 deletion is idempotent and verifies absence", async () => {
  const commands = [];
  const absent = {
    async send(command) {
      commands.push(command.constructor.name);
      if (command.constructor.name === "HeadObjectCommand") {
        throw Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {};
    },
  };
  await deleteObjectAndVerifyAbsent(absent, {
    bucket: BUCKET,
    key: TRANSPORT_KEY,
  });
  assert.deepEqual(commands, ["DeleteObjectCommand", "HeadObjectCommand"]);

  const present = { async send() {} };
  await assert.rejects(
    deleteObjectAndVerifyAbsent(present, {
      bucket: BUCKET,
      key: TRANSPORT_KEY,
    }),
    /still exists/u,
  );
});

async function publishedFixture(
  t,
  { includeWithdrawnRelease = false, snapshotSha256 = null, malformedVendor = false } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "renderpilot-prune-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localIndexFile = path.join(directory, "index.json");
  const snapshot = buildVendorSnapshot({
    schema_version: 1,
    vendor: { id: "microsoft", display_name: "Microsoft" },
    generated_at: "2026-01-01T00:00:00.000Z",
    legal_documents: [],
    artifacts: [
      {
        artifact_key: "active",
        library_id: "dxcompiler",
        file_name: "dxcompiler.dll",
        file_version: "1.0.0",
        architecture: "X64",
        dll: { sha256: "b".repeat(64), size_bytes: 1 },
        transport: { sha256: "a".repeat(64), size_bytes: 1 },
        signature: { status: "signed", signed_at: null },
      },
    ],
    packages: [
      {
        package_id: "active.package",
        technology: "microsoft_dxc",
        variant: "runtime",
        display_name: "Microsoft DirectX Shader Compiler",
        release: {
          version: includeWithdrawnRelease ? PACKAGE_VERSION : "2.0.0",
          channel: includeWithdrawnRelease ? "preview" : "stable",
          label: null,
        },
        target: { os: "windows", architecture: "X64" },
        provenance: {
          kind: "nuget",
          package_id: PACKAGE_ID,
          version: includeWithdrawnRelease ? PACKAGE_VERSION : "2.0.0",
          package_sha512: `${"A".repeat(86)}==`,
        },
        members: [
          { artifact_key: "active", role: "primary", install_as: "dxcompiler.dll" },
        ],
      },
    ],
  });
  const snapshotBytes = jsonDocument(snapshot);
  const validIndex = buildLibraryIndex([{ snapshot, body: snapshotBytes }]);
  const microsoftDescriptor = validIndex.vendors[0];
  const objects = new Map([
    [LIBRARY_INDEX_OBJECT_KEY, null],
    [microsoftDescriptor.snapshot_key, snapshotBytes],
  ]);
  const vendors = [
    {
      ...microsoftDescriptor,
      ...(snapshotSha256
        ? {
            snapshot_key: vendorSnapshotObjectKey("microsoft", snapshotSha256),
            snapshot_sha256: snapshotSha256,
          }
        : {}),
    },
  ];
  if (snapshotSha256) {
    objects.set(vendors[0].snapshot_key, snapshotBytes);
  }
  if (malformedVendor) {
    const malformedBytes = jsonDocument({
      schema_version: 1,
      vendor: { id: "amd", display_name: "AMD" },
      generated_at: "2026-01-01T00:00:00.000Z",
      artifacts: "corrupt",
      packages: "corrupt",
    });
    const malformedKey = vendorSnapshotObjectKey("amd", sha256Hex(malformedBytes));
    vendors.push({
      vendor_id: "amd",
      display_name: "AMD",
      snapshot_key: malformedKey,
      snapshot_sha256: sha256Hex(malformedBytes),
      snapshot_size_bytes: malformedBytes.length,
    });
    objects.set(malformedKey, malformedBytes);
  }
  vendors.sort((left, right) => left.vendor_id.localeCompare(right.vendor_id));
  const indexBytes = jsonDocument({
    ...validIndex,
    vendors,
  });
  objects.set(LIBRARY_INDEX_OBJECT_KEY, indexBytes);
  await writeFile(localIndexFile, indexBytes);
  return {
    localIndexFile,
    s3: {
      async send(command) {
        assert.equal(command.input.Bucket, BUCKET);
        const bytes = objects.get(command.input.Key);
        if (!bytes) throw new Error(`missing fixture object ${command.input.Key}`);
        return {
          Body: {
            async transformToByteArray() {
              return bytes;
            },
          },
        };
      },
    },
  };
}
