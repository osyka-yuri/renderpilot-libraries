import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertLockBackfillsSignatures,
  assertLockExtendsBaseline,
  assertLockSemantics,
  assertMicrosoftConfig,
  contentAddressedObjectKey,
  fetchPackageSha512,
  listedStableReleases,
  selectPackageFiles,
} from "../lib/microsoft-nuget.mjs";
import { compareNumericVersions } from "../lib/library-catalog.mjs";

const validateMicrosoftConfigSchema = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile(
  JSON.parse(
    readFileSync(
      new URL("../../schemas/microsoft_nuget_config.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

const d3d12 = {
  package_id: "Microsoft.Direct3D.D3D12",
  architectures: [
    { package_directory: "x64", catalog_architecture: "X64", required: true },
    { package_directory: "win32", catalog_architecture: "X86", required: true },
  ],
  files: [{ library_id: "d3d12_core", file_name: "D3D12Core.dll" }],
};

const dxc = {
  package_id: "Microsoft.Direct3D.DXC",
  architectures: [
    { package_directory: "x64", catalog_architecture: "X64", required: true },
    { package_directory: "x86", catalog_architecture: "X86", required: false },
  ],
  files: [
    { library_id: "dxcompiler", file_name: "dxcompiler.dll" },
    { library_id: "dxil", file_name: "dxil.dll" },
  ],
};

test("historical D3D12 win32 layout maps strictly to X86 and ignores SDKLayers", () => {
  const selected = selectPackageFiles(
    [
      "build/native/bin/x64/D3D12Core.dll",
      "build/native/bin/x64/d3d12SDKLayers.dll",
      "build/native/bin/win32/D3D12Core.dll",
      "build/native/bin/win32/d3d12SDKLayers.dll",
    ],
    d3d12,
  );
  assert.deepEqual(
    selected.map(({ architecture, members }) => [
      architecture.catalog_architecture,
      members.map((member) => member.file_name),
    ]),
    [
      ["X64", ["D3D12Core.dll"]],
      ["X86", ["D3D12Core.dll"]],
    ],
  );
});

test("historical DXC package without x86 is a valid package capability", () => {
  const selected = selectPackageFiles(
    [
      "build/native/bin/x64/dxcompiler.dll",
      "build/native/bin/x64/dxil.dll",
      "build/native/bin/arm64/dxcompiler.dll",
      "build/native/bin/arm64/dxil.dll",
    ],
    dxc,
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].architecture.catalog_architecture, "X64");
  assert.deepEqual(
    selected[0].members.map((member) => member.library_id),
    ["dxcompiler", "dxil"],
  );
});

test("one missing DXC pair member is rejected even for optional x86", () => {
  assert.throws(
    () =>
      selectPackageFiles(
        [
          "build/native/bin/x64/dxcompiler.dll",
          "build/native/bin/x64/dxil.dll",
          "build/native/bin/x86/dxcompiler.dll",
        ],
        dxc,
      ),
    /incomplete x86 install unit; missing dxil\.dll/,
  );
});

test("package paths cannot claim two configured architectures", () => {
  assert.throws(
    () =>
      selectPackageFiles(
        ["build/native/bin/x64/x86/dxcompiler.dll", "build/native/bin/x64/x86/dxil.dll"],
        dxc,
      ),
    /ambiguous architecture path/,
  );
});

test("selected package paths reject traversal and Windows drive syntax", () => {
  for (const unsafe of [
    "../x64/dxcompiler.dll",
    "C:/build/x64/dxcompiler.dll",
    "build/x64/drive:alias/dxcompiler.dll",
  ]) {
    assert.throws(
      () => selectPackageFiles([unsafe, "build/x64/dxil.dll"], dxc),
      /unsafe package path/,
    );
  }
});

test("Microsoft version ordering preserves the full catalog u64 precision", () => {
  assert.equal(
    compareNumericVersions("1.18446744073709551614", "1.18446744073709551615"),
    -1,
  );
  assert.equal(compareNumericVersions("1.10000.0", "1.9999.9999"), 1);
});

test("Registration API selection excludes unlisted and prerelease versions", async () => {
  const entries = [
    catalogEntry("1.9.1", true),
    catalogEntry("101.7.2207.25", false),
    catalogEntry("1.10.0-preview.1", true),
    catalogEntry("1.8.9", true),
  ];
  const releases = await listedStableReleases("Example.Package", async () => ({
    ok: true,
    async json() {
      return { items: [{ items: entries.map((entry) => ({ catalogEntry: entry })) }] };
    },
  }));
  assert.deepEqual(
    releases.map((release) => release.packageVersion),
    ["1.8.9", "1.9.1"],
  );
});

test("Catalog Details supplies the authoritative NuGet package SHA-512", async () => {
  const expected = `${"A".repeat(86)}==`;
  const actual = await fetchPackageSha512(
    "https://example.invalid/catalog/details.json",
    async () => ({
      ok: true,
      async json() {
        return { packageHashAlgorithm: "SHA512", packageHash: expected };
      },
    }),
  );
  assert.equal(actual, expected);
});

test("lock semantics reject artifacts outside the configured product matrix", () => {
  const { config, lock } = strictDxcLock();
  assertLockSemantics(lock, config);

  const unexpected = structuredClone(lock.releases[0].artifacts[0]);
  unexpected.library_id = "unexpected_runtime";
  unexpected.file_name = "unexpected.dll";
  unexpected.package_path = "build/native/bin/x64/unexpected.dll";
  unexpected.r2.object_key = contentAddressedObjectKey(unexpected.r2.zst_sha256);
  lock.releases[0].artifacts.push(unexpected);

  assert.throws(() => assertLockSemantics(lock, config), /unexpected artifact/);
});

test("Microsoft policy requires signed artifacts but permits an absent timestamp", () => {
  const { config, lock } = strictDxcLock();
  assert.doesNotThrow(() => assertLockSemantics(lock, config));

  const unsigned = structuredClone(lock);
  unsigned.releases[0].artifacts[0].signature = { status: "unsigned" };
  assert.throws(
    () => assertLockSemantics(unsigned, config),
    /strict signed Authenticode contract/,
  );

  const invalidTimestamp = structuredClone(lock);
  invalidTimestamp.releases[0].artifacts[0].signature.signed_at = "not-a-date";
  assert.throws(
    () => assertLockSemantics(invalidTimestamp, config),
    /strict signed Authenticode contract/,
  );
});

test("Microsoft config enforces canonical product and runtime identities", () => {
  const { config } = strictDxcLock();
  assert.doesNotThrow(() => assertMicrosoftConfig(config));

  const wrongPackage = structuredClone(config);
  wrongPackage.products[0].package_id = "Example.DXC";
  assert.throws(
    () => assertMicrosoftConfig(wrongPackage),
    /package identity or compatibility differs from contract/,
  );

  const nonCanonicalFileName = structuredClone(config);
  nonCanonicalFileName.products[0].files[0].file_name = "dxcompiler.DLL";
  assert.throws(
    () => assertMicrosoftConfig(nonCanonicalFileName),
    /invalid or duplicate runtime file mapping/,
  );
});

test("Microsoft config schema rejects structural drift", () => {
  const { config } = strictDxcLock();
  assert.equal(
    validateMicrosoftConfigSchema(config),
    true,
    JSON.stringify(validateMicrosoftConfigSchema.errors),
  );

  const unknownField = structuredClone(config);
  unknownField.products[0].files[0].legacy_name = "dxcompiler.dll";
  assert.equal(validateMicrosoftConfigSchema(unknownField), false);

  const wrongType = structuredClone(config);
  wrongType.products[0].expected_listed_stable_releases = "1";
  assert.equal(validateMicrosoftConfigSchema(wrongType), false);
});

test("lock semantics reject numerically equivalent duplicate package versions", () => {
  const { config, lock } = strictDxcLock();
  const duplicate = structuredClone(lock.releases[0]);
  duplicate.package_version = "1.9.1.0";
  lock.releases.push(duplicate);

  assert.throws(
    () => assertLockSemantics(lock, config),
    /duplicate Microsoft NuGet release/,
  );
});

test("lock semantics require the compressed SHA-256 in the R2 key", () => {
  const { config, lock } = strictDxcLock();
  lock.releases[0].artifacts[0].r2.object_key =
    "dxcompiler_1.9.1_x64_not-content-addressed.dll.zst";

  assert.throws(
    () => assertLockSemantics(lock, config),
    /R2 key does not match compressed content identity/,
  );
});

test("immutable baseline rejects changed and removed package versions", () => {
  const { lock: baseline } = strictDxcLock();
  const enriched = structuredClone(baseline);
  enriched.releases[0].artifacts[0].signature.signed_at = "2026-05-27T00:12:51.244Z";
  assert.throws(
    () => assertLockExtendsBaseline(enriched, baseline),
    /immutable release content changed/,
  );

  const changed = structuredClone(baseline);
  changed.releases[0].artifacts[0].dll_sha256 = "f".repeat(64);
  assert.throws(
    () => assertLockExtendsBaseline(changed, baseline),
    /immutable release content changed/,
  );

  assert.throws(
    () =>
      assertLockExtendsBaseline(
        {
          schema_version: 2,
          releases: [],
        },
        baseline,
      ),
    /immutable release was removed/,
  );
});

test("immutable baseline permits content-addressed transport replacement", () => {
  const { lock: baseline } = strictDxcLock();
  const recompressed = structuredClone(baseline);
  const artifact = recompressed.releases[0].artifacts[0];
  artifact.r2.zst_sha256 = "c".repeat(64);
  artifact.r2.zst_size_bytes = 42;
  artifact.r2.compression_level = 19;
  artifact.r2.object_key = contentAddressedObjectKey(artifact.r2.zst_sha256);

  assert.doesNotThrow(() => assertLockExtendsBaseline(recompressed, baseline));
});

test("signature backfill permits only null to verified date enrichment", () => {
  const { lock: baseline } = strictDxcLock();
  const enriched = structuredClone(baseline);
  enriched.releases[0].artifacts[0].signature.signed_at = "2026-05-27T00:12:51.244Z";
  assert.doesNotThrow(() => assertLockBackfillsSignatures(enriched, baseline));

  const changedHash = structuredClone(enriched);
  changedHash.releases[0].artifacts[0].dll_sha256 = "f".repeat(64);
  assert.throws(
    () => assertLockBackfillsSignatures(changedHash, baseline),
    /signature backfill changed immutable release data/,
  );

  const changedTransport = structuredClone(enriched);
  changedTransport.releases[0].artifacts[0].r2.zst_size_bytes += 1;
  assert.throws(
    () => assertLockBackfillsSignatures(changedTransport, baseline),
    /signature backfill changed immutable release data/,
  );

  const datedBaseline = structuredClone(enriched);
  const changedDate = structuredClone(enriched);
  changedDate.releases[0].artifacts[0].signature.signed_at = "2026-05-28T00:12:51.244Z";
  assert.throws(
    () => assertLockBackfillsSignatures(changedDate, datedBaseline),
    /signature backfill changed immutable release data/,
  );
});

function catalogEntry(version, listed) {
  return {
    "@id": `https://example.invalid/catalog/${version}.json`,
    id: "Example.Package",
    version,
    listed,
    published: "2026-01-01T00:00:00Z",
    packageContent: `https://example.invalid/${version}.nupkg`,
  };
}

function strictDxcLock() {
  const product = {
    key: "dxc",
    package_id: "Microsoft.Direct3D.DXC",
    expected_listed_stable_releases: 1,
    architectures: [
      { package_directory: "x64", catalog_architecture: "X64", required: true },
    ],
    files: [
      { library_id: "dxcompiler", file_name: "dxcompiler.dll" },
      { library_id: "dxil", file_name: "dxil.dll" },
    ],
    compatibility: null,
  };
  const artifact = (libraryId, fileName, hash) => ({
    architecture: "X64",
    package_path: `build/native/bin/x64/${fileName}`,
    library_id: libraryId,
    file_name: fileName,
    pe_version: "1.9.1",
    dll_sha256: hash.repeat(64),
    dll_size_bytes: 100,
    signature: {
      status: "signed",
      subject: "CN=Microsoft Corporation",
      thumbprint: "A".repeat(40),
      signed_at: null,
    },
    r2: {
      object_key: contentAddressedObjectKey(hash.repeat(64)),
      zst_sha256: hash.repeat(64),
      zst_size_bytes: 50,
      compression_level: 12,
    },
  });
  return {
    config: { schema_version: 1, products: [product] },
    lock: {
      schema_version: 2,
      releases: [
        {
          product: "dxc",
          package_id: product.package_id,
          package_version: "1.9.1",
          package_sha512: `${"A".repeat(86)}==`,
          published_at: "2026-01-01T00:00:00.000Z",
          artifacts: [
            artifact("dxcompiler", "dxcompiler.dll", "a"),
            artifact("dxil", "dxil.dll", "b"),
          ],
        },
      ],
    },
  };
}
