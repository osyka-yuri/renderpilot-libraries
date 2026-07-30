import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertLockBackfillsSignatures,
  assertLockExtendsBaseline,
  assertLockSemantics,
  assertNuGetPackageIdentity,
  assessMicrosoftRefreshProduct,
  assertMicrosoftConfig,
  buildMicrosoftVendorSource,
  fetchPackageSha512,
  knownPreviewReleaseCounts,
  knownReleaseCounts,
  listedReleases,
  microsoftPrunePlan,
  selectPackageNuspec,
  selectPackageFiles,
} from "../lib/microsoft-nuget.mjs";
import { blobObjectKey, compareNumericVersions } from "../lib/library-catalog.mjs";
import { activeCatalogTransportObjectKeys } from "../lib/library-generation.mjs";

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
const validateMicrosoftLockSchema = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile(
  JSON.parse(
    readFileSync(
      new URL("../../schemas/microsoft_nuget_lock.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("production Microsoft R2 mutations share one serialized concurrency group", () => {
  const workflow = (name) =>
    readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
  const setup = readFileSync(
    new URL("../../.github/actions/setup-library-tools/action.yml", import.meta.url),
    "utf8",
  );
  const refresh = workflow("microsoft-nuget-refresh.yml");
  const publish = workflow("publish.yml");
  const withdrawal = workflow("microsoft-nuget-withdrawal.yml");

  for (const source of [refresh, publish, withdrawal]) {
    assert.match(source, /group:\s+libraries-production-r2/u);
    assert.match(source, /cancel-in-progress:\s+false/u);
    assert.match(source, /uses:\s+\.\/\.github\/actions\/setup-library-tools/u);
  }
  assert.match(setup, /pnpm\/action-setup@[0-9a-f]{40}\s+# v6/u);
  assert.match(setup, /actions\/setup-node@[0-9a-f]{40}\s+# v7\.0\.0/u);
  assert.match(withdrawal, /operation == 'withdraw'/u);
  assert.match(withdrawal, /operation == 'prune'/u);
  assert.match(withdrawal, /withdraw[\s\S]+--write/u);
  assert.match(withdrawal, /prune[\s\S]+--execute/u);
});

const d3d12 = {
  package_id: "Microsoft.Direct3D.D3D12",
  architectures: [
    { package_directory: "x64", catalog_architecture: "X64", required: true },
    { package_directory: "win32", catalog_architecture: "X86", required: true },
  ],
  files: [{ library_id: "d3d12_core", file_name: "D3D12Core.dll", required: true }],
};

const dxc = {
  package_id: "Microsoft.Direct3D.DXC",
  architectures: [
    { package_directory: "x64", catalog_architecture: "X64", required: true },
    { package_directory: "x86", catalog_architecture: "X86", required: false },
  ],
  files: [
    { library_id: "dxcompiler", file_name: "dxcompiler.dll", required: true },
    { library_id: "dxil", file_name: "dxil.dll", required: false },
  ],
};

test("historical D3D12 win32 layout maps strictly to X86 and ignores SDKLayers", () => {
  const selected = selectPackageFiles(
    [
      "_rels/",
      "build/native/bin/",
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

test("optional DXIL member may be absent when the required compiler is present", () => {
  const selected = selectPackageFiles(
    [
      "build/native/bin/x64/dxcompiler.dll",
      "build/native/bin/x64/dxil.dll",
      "build/native/bin/x86/dxcompiler.dll",
    ],
    dxc,
  );
  assert.deepEqual(
    selected.map(({ architecture, members }) => [
      architecture.catalog_architecture,
      members.map((member) => member.library_id),
    ]),
    [
      ["X64", ["dxcompiler", "dxil"]],
      ["X86", ["dxcompiler"]],
    ],
  );
});

test("missing required DXC compiler is rejected even for optional x86", () => {
  assert.throws(
    () =>
      selectPackageFiles(
        [
          "build/native/bin/x64/dxcompiler.dll",
          "build/native/bin/x64/dxil.dll",
          "build/native/bin/x86/dxil.dll",
        ],
        dxc,
      ),
    /incomplete x86 install unit; missing dxcompiler\.dll/,
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

test("Registration API selection includes listed stable and preview but excludes unlisted", async () => {
  const entries = [
    catalogEntry("1.9.1", true),
    catalogEntry("101.7.2207.25", false),
    catalogEntry("1.10.0-preview.1", true),
    catalogEntry("1.8.9", true),
  ];
  const releases = await listedReleases("Example.Package", async () => ({
    ok: true,
    async json() {
      return {
        count: 1,
        items: [
          {
            count: entries.length,
            items: entries.map((entry) => ({ catalogEntry: entry })),
          },
        ],
      };
    },
  }));
  assert.deepEqual(
    releases.map((release) => release.packageVersion),
    ["1.8.9", "1.9.1", "1.10.0-preview.1"],
  );
  await assert.rejects(
    listedReleases("Example.Package", async () => ({
      ok: true,
      async json() {
        return {
          count: 1,
          items: [{ count: 1, items: [{ catalogEntry: catalogEntry("1.9.1") }] }],
        };
      },
    })),
    /malformed Registration leaf/u,
  );
  await assert.rejects(
    listedReleases("Example.Package", async () => ({
      ok: true,
      async json() {
        return {
          count: 1,
          items: [
            {
              count: entries.length + 1,
              items: entries.map((entry) => ({ catalogEntry: entry })),
            },
          ],
        };
      },
    })),
    /incomplete Registration page/u,
  );
  await assert.rejects(
    listedReleases("Example.Package", async () => ({
      ok: true,
      async json() {
        return {
          count: 2,
          items: [
            {
              count: entries.length,
              items: entries.map((entry) => ({ catalogEntry: entry })),
            },
          ],
        };
      },
    })),
    /malformed Registration index pages/u,
  );
  await assert.rejects(
    listedReleases("Example.Package", async () => ({
      ok: true,
      async json() {
        return {
          count: 1,
          items: [
            {
              items: entries.map((entry) => ({ catalogEntry: entry })),
            },
          ],
        };
      },
    })),
    /incomplete Registration page/u,
  );
});

test("Registration coverage independently preserves the reviewed preview inventory", async () => {
  const { config, lock } = strictDxcLock();
  const product = config.products[0];
  product.minimum_known_preview_releases = 1;
  const release = lock.releases[0];
  await assert.rejects(
    assessMicrosoftRefreshProduct(product, lock, [
      {
        packageId: release.package_id,
        packageVersion: release.package_version,
        packageContent: "https://example.invalid/package.nupkg",
        catalogEntry: "https://example.invalid/catalog",
        publishedAt: release.published_at,
        listed: true,
      },
    ]),
    /expected at least 1 known preview releases, got 0/u,
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

test(".nuspec identity is parsed exactly and normalized against Registration", () => {
  const path = selectPackageNuspec(
    ["_rels/.rels", "Microsoft.Direct3D.DXC.nuspec", "build/native/runtime.dll"],
    "DXC",
  );
  assert.equal(path, "Microsoft.Direct3D.DXC.nuspec");
  assert.equal(
    selectPackageNuspec(["./Microsoft.Direct3D.DXC.nuspec"], "DXC"),
    "./Microsoft.Direct3D.DXC.nuspec",
  );
  const nuspec = Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>microsoft.direct3d.dxc</id>
    <version>01.09.000+build.sha</version>
  </metadata>
</package>`);
  assert.doesNotThrow(() =>
    assertNuGetPackageIdentity(nuspec, "Microsoft.Direct3D.DXC", "1.9.0", "DXC"),
  );
  assert.throws(
    () => assertNuGetPackageIdentity(nuspec, "Microsoft.Direct3D.D3D12", "1.9.0", "DXC"),
    /nuspec identity/,
  );
  assert.throws(
    () => selectPackageNuspec(["nested/package.nuspec"], "DXC"),
    /exactly one root/,
  );
  assert.throws(
    () =>
      assertNuGetPackageIdentity(
        Buffer.from(
          "<!DOCTYPE package><package><metadata><id>x</id><version>1</version></metadata></package>",
        ),
        "x",
        "1.0.0",
        "unsafe",
      ),
    /forbidden/,
  );
});

test("lock semantics reject artifacts outside the configured product matrix", () => {
  const { config, lock } = strictDxcLock();
  assertLockSemantics(lock, config);

  const unexpected = structuredClone(lock.releases[0].artifacts[0]);
  unexpected.library_id = "unexpected_runtime";
  unexpected.file_name = "unexpected.dll";
  unexpected.package_path = "build/native/bin/x64/unexpected.dll";
  unexpected.r2.object_key = blobObjectKey(unexpected.r2.zst_sha256);
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

  const wrongCapabilityTypes = structuredClone(config);
  wrongCapabilityTypes.products[0].architectures[0].package_directory = 64;
  assert.throws(
    () => assertMicrosoftConfig(wrongCapabilityTypes),
    /invalid or duplicate architecture mapping/,
  );

  wrongCapabilityTypes.products[0].architectures[0].package_directory = "x64";
  wrongCapabilityTypes.products[0].files[0].file_name = 64;
  assert.throws(
    () => assertMicrosoftConfig(wrongCapabilityTypes),
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

test("Microsoft lock schema requires evidence for manual withdrawals", () => {
  const { lock } = strictDxcLock();
  lock.withdrawn.push({
    product: "dxc",
    package_id: "Microsoft.Direct3D.DXC",
    package_version: "99.0.0-security",
    reason: "security",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: [
      "libraries/blobs/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dll.zst",
    ],
  });
  assert.equal(validateMicrosoftLockSchema(lock), false);
  lock.withdrawn[0].evidence = "security-report";
  assert.equal(
    validateMicrosoftLockSchema(lock),
    true,
    JSON.stringify(validateMicrosoftLockSchema.errors),
  );
});

test("lock semantics reject noncanonical numerically equivalent package versions", () => {
  const { config, lock } = strictDxcLock();
  const duplicate = structuredClone(lock.releases[0]);
  duplicate.package_version = "1.9.1.0";
  lock.releases.push(duplicate);

  assert.throws(
    () => assertLockSemantics(lock, config),
    /must use canonical NuGet version 1\.9\.1/,
  );
});

test("stable and preview with the same numeric core remain distinct package identities", () => {
  const { config, lock } = strictDxcLock();
  const preview = structuredClone(lock.releases[0]);
  preview.package_version = "1.9.1-preview";
  lock.releases.push(preview);

  assert.doesNotThrow(() => assertLockSemantics(lock, config));
  assert.equal(knownPreviewReleaseCounts(lock).get("dxc"), 1);
  const source = buildMicrosoftVendorSource(lock, config);
  assert.deepEqual(
    source.packages.map((packageValue) => [
      packageValue.package_id,
      packageValue.release.channel,
    ]),
    [
      ["dxc.1.9.1.x64", "stable"],
      ["dxc.1.9.1-preview.x64", "preview"],
    ],
  );
});

test("withdrawal lifecycle reports first, then validates and refreshes with a tombstone", async () => {
  const { config, lock: baseline } = strictDxcLock();
  const product = config.products[0];
  const release = baseline.releases[0];
  const unlistedRegistration = [
    {
      packageId: release.package_id,
      packageVersion: release.package_version,
      packageContent: "https://example.invalid/package.nupkg",
      catalogEntry: "https://example.invalid/catalog",
      publishedAt: release.published_at,
      listed: false,
    },
  ];

  const beforeWithdrawal = await assessMicrosoftRefreshProduct(
    product,
    baseline,
    unlistedRegistration,
  );
  assert.equal(beforeWithdrawal.state, "withdrawal_review_required");
  assert.deepEqual(beforeWithdrawal.withdrawalReport, [
    {
      package_id: release.package_id,
      package_version: release.package_version,
      reason: "unlisted",
    },
  ]);

  const afterWithdrawal = structuredClone(baseline);
  afterWithdrawal.releases.splice(0, 1);
  afterWithdrawal.withdrawn.push({
    product: release.product,
    package_id: release.package_id,
    package_version: release.package_version,
    reason: "unlisted",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: release.artifacts
      .map((artifact) => artifact.r2.object_key)
      .sort(),
  });
  const afterRefresh = await assessMicrosoftRefreshProduct(
    product,
    afterWithdrawal,
    unlistedRegistration,
  );
  assert.equal(afterRefresh.state, "ready");
  assert.deepEqual(afterRefresh.missing, []);
  assert.equal(knownReleaseCounts(afterWithdrawal).get(product.key), 1);
  assert.doesNotThrow(() => assertLockExtendsBaseline(afterWithdrawal, baseline));
});

test("hard-delete and manual security tombstones have closed refresh states", async () => {
  const { config, lock: baseline } = strictDxcLock();
  const product = config.products[0];
  const release = baseline.releases[0];
  const tombstone = {
    product: release.product,
    package_id: release.package_id,
    package_version: release.package_version,
    reason: "hard_delete",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: release.artifacts
      .map((artifact) => artifact.r2.object_key)
      .sort(),
  };
  const withdrawn = {
    ...structuredClone(baseline),
    releases: [],
    withdrawn: [tombstone],
  };

  const hardDelete = await assessMicrosoftRefreshProduct(product, withdrawn, []);
  assert.equal(hardDelete.state, "ready");

  withdrawn.withdrawn[0].reason = "security";
  withdrawn.withdrawn[0].evidence = "GHSA-example";
  const listedRegistration = [
    {
      packageId: release.package_id,
      packageVersion: release.package_version,
      packageContent: "https://example.invalid/package.nupkg",
      catalogEntry: "https://example.invalid/catalog",
      publishedAt: release.published_at,
      listed: true,
    },
  ];
  const security = await assessMicrosoftRefreshProduct(
    product,
    withdrawn,
    listedRegistration,
  );
  assert.equal(security.state, "ready");
  assert.deepEqual(security.missing, []);

  const missingEvidence = structuredClone(withdrawn);
  delete missingEvidence.withdrawn[0].evidence;
  assert.throws(
    () => assertLockSemantics(missingEvidence, config),
    /evidence is required/u,
  );

  withdrawn.withdrawn[0].reason = "unlisted";
  const relisted = await assessMicrosoftRefreshProduct(
    product,
    withdrawn,
    listedRegistration,
  );
  assert.equal(relisted.state, "relisted_review_required");
});

test("withdrawal tombstone enables removal and prune retains shared blobs", () => {
  const { config, lock: baseline } = strictDxcLock();
  const sharedRelease = structuredClone(baseline.releases[0]);
  sharedRelease.package_version = "1.9.2";
  baseline.releases.push(sharedRelease);
  const next = structuredClone(baseline);
  const [withdrawn] = next.releases.splice(0, 1);
  next.withdrawn.push({
    product: withdrawn.product,
    package_id: withdrawn.package_id,
    package_version: withdrawn.package_version,
    reason: "unlisted",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: withdrawn.artifacts
      .map((artifact) => artifact.r2.object_key)
      .sort(),
  });

  assert.doesNotThrow(() => assertLockSemantics(next, config));
  assert.doesNotThrow(() => assertLockExtendsBaseline(next, baseline));
  const activeObjectKeys = new Set(
    next.releases.flatMap((release) =>
      release.artifacts.map((artifact) => artifact.r2.object_key),
    ),
  );
  const first = microsoftPrunePlan(
    next,
    withdrawn.package_id,
    withdrawn.package_version,
    activeObjectKeys,
  );
  const second = microsoftPrunePlan(
    next,
    withdrawn.package_id,
    withdrawn.package_version,
    activeObjectKeys,
  );
  assert.deepEqual(first, second, "prune planning must be idempotent");
  assert.deepEqual(first.delete_object_keys, []);
  assert.deepEqual(
    first.retained_shared_object_keys,
    withdrawn.artifacts.map((artifact) => artifact.r2.object_key).sort(),
  );
});

test("prune retains a withdrawn blob referenced by another active vendor", () => {
  const { config, lock: baseline } = strictDxcLock();
  const next = structuredClone(baseline);
  const [withdrawn] = next.releases.splice(0, 1);
  const objectKeys = withdrawn.artifacts.map((artifact) => artifact.r2.object_key).sort();
  next.withdrawn.push({
    product: withdrawn.product,
    package_id: withdrawn.package_id,
    package_version: withdrawn.package_version,
    reason: "unlisted",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: objectKeys,
  });

  assert.doesNotThrow(() => assertLockSemantics(next, config));
  const plan = microsoftPrunePlan(
    next,
    withdrawn.package_id,
    withdrawn.package_version,
    new Set(objectKeys),
  );
  assert.deepEqual(plan.delete_object_keys, []);
  assert.deepEqual(plan.retained_shared_object_keys, objectKeys);
});

test("global active transport graph follows package members across vendors", () => {
  const snapshot = (vendor, objectKey) => ({
    file: `libraries/v1/vendors/${vendor}.json`,
    value: {
      artifacts: [
        {
          artifact_id: `sha256:${vendor}`,
          transport: { object_key: objectKey },
        },
      ],
      packages: [
        {
          package_id: `${vendor}.package`,
          members: [{ artifact_id: `sha256:${vendor}` }],
        },
      ],
    },
  });
  assert.deepEqual(
    [
      ...activeCatalogTransportObjectKeys([
        snapshot("microsoft", "libraries/blobs/sha256/a.dll.zst"),
        snapshot("amd", "libraries/blobs/sha256/b.dll.zst"),
      ]),
    ].sort(),
    ["libraries/blobs/sha256/a.dll.zst", "libraries/blobs/sha256/b.dll.zst"],
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
          schema_version: 4,
          releases: [],
          withdrawn: [],
        },
        baseline,
      ),
    /immutable release was removed/,
  );

  const fabricated = structuredClone(baseline);
  fabricated.withdrawn.push({
    product: "dxc",
    package_id: "Microsoft.Direct3D.DXC",
    package_version: "99.0.0-preview",
    reason: "security",
    evidence: "reviewed-security-report",
    confirmed_at: "2026-07-26T00:00:00.000Z",
    transport_object_keys: [
      "libraries/blobs/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dll.zst",
    ],
  });
  assert.throws(
    () => assertLockExtendsBaseline(fabricated, baseline),
    /no active baseline release/,
  );
});

test("immutable baseline permits content-addressed transport replacement", () => {
  const { lock: baseline } = strictDxcLock();
  const recompressed = structuredClone(baseline);
  const artifact = recompressed.releases[0].artifacts[0];
  artifact.r2.zst_sha256 = "c".repeat(64);
  artifact.r2.zst_size_bytes = 42;
  artifact.r2.compression_level = 19;
  artifact.r2.object_key = blobObjectKey(artifact.r2.zst_sha256);

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
    minimum_known_releases: 1,
    minimum_known_preview_releases: 0,
    architectures: [
      { package_directory: "x64", catalog_architecture: "X64", required: true },
    ],
    files: [
      { library_id: "dxcompiler", file_name: "dxcompiler.dll", required: true },
      { library_id: "dxil", file_name: "dxil.dll", required: false },
    ],
    legal_documents: [
      {
        kind: "license",
        title: "Microsoft DirectX Shader Compiler License",
        format: "text",
        file_name: "LICENSE-LLVM.txt",
        package_path: "LICENSE-LLVM.txt",
      },
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
      object_key: blobObjectKey(hash.repeat(64)),
      zst_sha256: hash.repeat(64),
      zst_size_bytes: 50,
      compression_level: 12,
    },
  });
  return {
    config: {
      schema_version: 1,
      trusted_signer_subjects: ["CN=Microsoft Corporation"],
      products: [product],
    },
    lock: {
      schema_version: 4,
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
          legal_documents: [
            {
              kind: "license",
              title: "Microsoft DirectX Shader Compiler License",
              format: "text",
              file_name: "LICENSE-LLVM.txt",
              package_path: "LICENSE-LLVM.txt",
              sha256: "c".repeat(64),
              size_bytes: 123,
              object_key: `libraries/legal/sha256/${"c".repeat(64)}.txt`,
            },
          ],
        },
      ],
      withdrawn: [],
    },
  };
}
