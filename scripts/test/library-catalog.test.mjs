import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  curatedLibraryVendors,
  githubReleaseTreeVendors,
  jsonDocuments,
  libraryVendors,
  microsoftLibraryVendor,
  publishedJsonDocuments,
  repoRoot,
} from "../catalog.mjs";
import {
  assertLegalDocumentPayload,
  assertLibraryIndex,
  assertNumericVersion,
  assertVendorSource,
  buildLibraryIndex,
  buildVendorSnapshot,
  jsonDocument,
} from "../lib/library-catalog.mjs";
import { sha256Hex } from "../lib/hash.mjs";

test("catalog versions accept canonical u64 segments and reject overflow", () => {
  assert.doesNotThrow(() =>
    assertNumericVersion("1.18446744073709551615", "release version"),
  );
  assert.throws(
    () => assertNumericVersion("1.18446744073709551616", "release version"),
    /dotted numeric version/,
  );
  assert.throws(
    () => assertNumericVersion("1.0001", "release version"),
    /dotted numeric version/,
  );
});

test("legal document payloads bind their declared byte representation", () => {
  assert.doesNotThrow(() =>
    assertLegalDocumentPayload(Buffer.from("License text\n", "utf8"), "text", "license"),
  );
  assert.throws(
    () => assertLegalDocumentPayload(Buffer.from([0xff, 0xfe]), "text", "license"),
    /valid UTF-8/,
  );
  assert.throws(
    () => assertLegalDocumentPayload(Buffer.from("text\0binary"), "text", "license"),
    /NUL byte/,
  );
  assert.doesNotThrow(() =>
    assertLegalDocumentPayload(Buffer.from("%PDF-1.7\nfixture", "ascii"), "pdf", "license"),
  );
  assert.throws(
    () => assertLegalDocumentPayload(Buffer.from("not a PDF"), "pdf", "license"),
    /canonical PDF header/,
  );
});

test("package revision is stable across transport recompression", () => {
  const first = source();
  const second = structuredClone(first);
  second.artifacts[0].transport = { sha256: "c".repeat(64), size_bytes: 9 };

  const left = buildVendorSnapshot(first);
  const right = buildVendorSnapshot(second);
  assert.equal(left.packages[0].revision_sha256, right.packages[0].revision_sha256);
  assert.notEqual(
    left.artifacts[0].transport.object_key,
    right.artifacts[0].transport.object_key,
  );
});

test("package revision ignores presentation metadata but binds release behavior", () => {
  const first = source();
  first.packages[0].display_name = "Original runtime";
  first.packages[0].release.label = "Original annotation";
  const second = structuredClone(first);
  second.packages[0].display_name = "Renamed runtime";
  second.packages[0].release.label = "Updated annotation";

  const left = buildVendorSnapshot(first);
  const right = buildVendorSnapshot(second);
  assert.equal(left.packages[0].revision_sha256, right.packages[0].revision_sha256);

  second.packages[0].release.channel = "beta";
  const behaviorChange = buildVendorSnapshot(second);
  assert.notEqual(
    left.packages[0].revision_sha256,
    behaviorChange.packages[0].revision_sha256,
  );
});

test("legal references are presentation metadata and remain strictly relational", () => {
  const first = sourceWithLegalDocument();
  const second = structuredClone(first);
  second.legal_documents[0].title = "Updated license title";

  const left = buildVendorSnapshot(first);
  const right = buildVendorSnapshot(second);
  assert.equal(left.packages[0].revision_sha256, right.packages[0].revision_sha256);
  assert.match(
    left.legal_documents[0].object_key,
    /^libraries\/legal\/sha256\/[0-9a-f]{64}\.txt$/u,
  );

  const unknown = structuredClone(first);
  unknown.packages[0].legal_document_ids = ["license.unknown"];
  assert.throws(() => assertVendorSource(unknown), /unknown legal document/);

  const orphan = structuredClone(first);
  delete orphan.packages[0].legal_document_ids;
  assert.throws(() => assertVendorSource(orphan), /unreferenced legal document/);

  const unsorted = structuredClone(first);
  unsorted.legal_documents.push({
    ...structuredClone(unsorted.legal_documents[0]),
    legal_document_id: `license.${"f".repeat(64)}`,
    content: { sha256: "f".repeat(64), size_bytes: 8 },
  });
  unsorted.legal_documents.reverse();
  unsorted.packages[0].legal_document_ids = unsorted.legal_documents
    .map((document) => document.legal_document_id)
    .sort();
  assert.throws(() => assertVendorSource(unsorted), /legal documents must be sorted by id/);
});

test("legal document metadata has one bounded content-addressed contract", () => {
  const wrongIdentity = sourceWithLegalDocument();
  const wrongId = `license.${"d".repeat(64)}`;
  wrongIdentity.legal_documents[0].legal_document_id = wrongId;
  wrongIdentity.packages[0].legal_document_ids = [wrongId];
  assert.throws(() => assertVendorSource(wrongIdentity), /id is not content-addressed/);

  const mismatchedFormat = sourceWithLegalDocument();
  mismatchedFormat.legal_documents[0].format = "pdf";
  assert.throws(
    () => assertVendorSource(mismatchedFormat),
    /file name extension does not match document format/,
  );

  const oversized = sourceWithLegalDocument();
  oversized.legal_documents[0].content.size_bytes = 16 * 1024 * 1024 + 1;
  assert.throws(() => assertVendorSource(oversized), /content exceeds/);

  const unsafeTitle = sourceWithLegalDocument();
  unsafeTitle.legal_documents[0].title = "Example\nLicense";
  assert.throws(() => assertVendorSource(unsafeTitle), /concise, printable, and trimmed/);
});

test("release labels contain supplemental information only", () => {
  const redundant = source();
  redundant.packages[0].release.version = "4.1.1.2740";
  redundant.packages[0].release.label = "FSR 4.1.1";
  assert.throws(
    () => assertVendorSource(redundant),
    /release label repeats the package version/,
  );

  const supplemental = source();
  supplemental.packages[0].release.version = "0.9.0.2740";
  supplemental.packages[0].release.label = "preview";
  assert.doesNotThrow(() => assertVendorSource(supplemental));

  const repeatedName = source();
  repeatedName.packages[0].release.label = repeatedName.packages[0].display_name;
  assert.throws(
    () => assertVendorSource(repeatedName),
    /release label repeats the package display name/,
  );
});

test("source rejects case-insensitive install target collisions", () => {
  const value = source();
  value.artifacts.push({
    ...structuredClone(value.artifacts[0]),
    artifact_key: "second",
    dll: { sha256: "d".repeat(64), size_bytes: 7 },
  });
  value.packages[0].members.push({
    artifact_key: "second",
    role: "support",
    install_as: "RUNTIME.DLL",
  });
  assert.throws(() => assertVendorSource(value), /duplicate install target/);
});

test("source requires the sole primary member first and rejects orphan artifacts", () => {
  const reordered = source();
  reordered.artifacts.push({
    ...structuredClone(reordered.artifacts[0]),
    artifact_key: "support",
    dll: { sha256: "d".repeat(64), size_bytes: 7 },
  });
  reordered.packages[0].members.unshift({
    artifact_key: "support",
    role: "support",
    install_as: "support.dll",
  });
  assert.throws(() => assertVendorSource(reordered), /primary member must be listed first/);

  const orphaned = source();
  orphaned.artifacts.push({
    ...structuredClone(orphaned.artifacts[0]),
    artifact_key: "orphan",
    dll: { sha256: "e".repeat(64), size_bytes: 7 },
  });
  assert.throws(() => assertVendorSource(orphaned), /unreferenced artifact orphan/);
});

test("published package revision must match its canonical contract", () => {
  const snapshot = buildVendorSnapshot(source());
  snapshot.packages[0].variant = "tampered";
  assert.throws(
    () => buildLibraryIndex([{ snapshot, body: jsonDocument(snapshot) }]),
    /revision_sha256 does not match package contract/,
  );
});

test("index binds immutable vendor bytes by hash and size", () => {
  const snapshot = buildVendorSnapshot(source());
  const body = jsonDocument(snapshot);
  const index = buildLibraryIndex([{ snapshot, body }]);
  assert.equal(index.vendors[0].snapshot_sha256, sha256Hex(body));
  assert.equal(index.vendors[0].snapshot_size_bytes, body.length);
  assert.match(index.vendors[0].snapshot_key, new RegExp(`${sha256Hex(body)}\\.json$`));
});

test("index rejects a snapshot key that does not match its digest", () => {
  const snapshot = buildVendorSnapshot(source());
  const index = buildLibraryIndex([{ snapshot, body: jsonDocument(snapshot) }]);
  index.vendors[0].snapshot_key = "libraries/v1/vendors/example/not-content-addressed.json";
  assert.throws(() => assertLibraryIndex(index), /snapshot key is not content-addressed/);
});

test("index rejects package ids reused across vendor boundaries", () => {
  const first = buildVendorSnapshot(source());
  const secondSource = source();
  secondSource.vendor = { id: "second", display_name: "Second" };
  const second = buildVendorSnapshot(secondSource);

  assert.throws(
    () =>
      buildLibraryIndex([
        { snapshot: first, body: jsonDocument(first) },
        { snapshot: second, body: jsonDocument(second) },
      ]),
    /duplicate package .* across vendors/,
  );
});

test("library vendor registry matches source and snapshot identities", async () => {
  const documents = new Map(jsonDocuments.map((document) => [document.file, document]));
  for (const vendor of libraryVendors) {
    assert.equal(
      documents.get(vendor.outputFile)?.schema,
      "schemas/library_vendor_v1.schema.json",
    );
    assert.equal(vendor.vendorId, vendor.outputFile.split("/").at(-1).slice(0, -5));

    const snapshot = JSON.parse(
      await readFile(path.join(repoRoot, vendor.outputFile), "utf8"),
    );
    assert.equal(snapshot.vendor.id, vendor.vendorId);
  }

  for (const vendor of curatedLibraryVendors) {
    assert.equal(
      documents.get(vendor.sourceFile)?.schema,
      "schemas/library_vendor_source.schema.json",
    );
    const source = JSON.parse(
      await readFile(path.join(repoRoot, vendor.sourceFile), "utf8"),
    );
    assert.equal(source.vendor.id, vendor.vendorId);
  }

  assert.equal(
    documents.get(microsoftLibraryVendor.configFile)?.schema,
    "schemas/microsoft_nuget_config.schema.json",
  );
  assert.equal(
    documents.get(microsoftLibraryVendor.lockFile)?.schema,
    "schemas/microsoft_nuget_lock.schema.json",
  );
  for (const vendor of githubReleaseTreeVendors) {
    assert.equal(
      documents.get(vendor.configFile)?.schema,
      "schemas/github_release_tree_config.schema.json",
    );
    assert.equal(
      documents.get(vendor.lockFile)?.schema,
      "schemas/github_release_tree_lock.schema.json",
    );
    if (vendor.overlayFile) {
      assert.equal(
        documents.get(vendor.overlayFile)?.schema,
        "schemas/library_vendor_source.schema.json",
      );
    }
  }
});

test("source binds compatibility and provenance to Microsoft runtime semantics", () => {
  const invalidCompatibility = source();
  invalidCompatibility.packages[0].target.compatibility = {
    kind: "d3d12_sdk",
    version: 1,
  };
  assert.throws(
    () => assertVendorSource(invalidCompatibility),
    /compatibility is only valid for D3D12 Agility/,
  );

  const missingProvenance = source();
  missingProvenance.packages[0].technology = "microsoft_dxc";
  assert.throws(
    () => assertVendorSource(missingProvenance),
    /Microsoft runtime provenance is missing or inconsistent/,
  );

  const invalidExtensions = source();
  invalidExtensions.packages[0].extensions = [];
  assert.throws(
    () => assertVendorSource(invalidExtensions),
    /extensions must be an object/,
  );
});

test("generated catalog has explicit package units and repaired DLSS-D identities", async () => {
  const [nvidia, amd, intel, microsoft] = await Promise.all(
    ["nvidia", "amd", "intel", "microsoft"].map(async (vendor) =>
      JSON.parse(
        await readFile(
          path.join(repoRoot, "libraries", "v1", "vendors", `${vendor}.json`),
          "utf8",
        ),
      ),
    ),
  );
  for (const vendor of [nvidia, amd, intel, microsoft]) {
    assert.ok(vendor.artifacts.length > 0);
    assert.ok(vendor.packages.length > 0);
  }

  const dlssd = new Map(
    nvidia.artifacts
      .filter((artifact) => artifact.library_id === "nvngx_dlssd")
      .map((artifact) => [artifact.extensions?.nvidia?.internal_name, artifact]),
  );
  assert.equal(
    dlssd.get("CL 33263601")?.dll.sha256,
    "1f485ddb99a8311acb09af0f5e58f682fbfabe91224b57bbc8073310beef3f48",
  );
  assert.equal(
    dlssd.get("CL 33284283")?.dll.sha256,
    "65c09757edc439b8fea71459636b36fb3225046faa5be3ddfe0d7384226c83c2",
  );
  assert.equal(
    dlssd.get("CL 33367307")?.dll.sha256,
    "9454861746c218a9138384f46a2f96c7b4b958941edeff5c955fb9f587eb99a1",
  );

  assert.equal(
    microsoft.packages
      .filter((packageValue) => packageValue.technology === "microsoft_dxc")
      .every((packageValue) => packageValue.members.length === 2),
    true,
  );
  assert.equal(
    nvidia.packages
      .filter((packageValue) => packageValue.technology === "nvidia_streamline")
      .every((packageValue) => packageValue.members.length === 11),
    true,
  );
  assert.equal(
    amd.packages
      .filter((packageValue) => packageValue.package_id.startsWith("amd_fidelityfx_dx12_"))
      .every((packageValue) => packageValue.variant === "dx12_runtime"),
    true,
  );
  assert.equal(
    amd.packages
      .filter((packageValue) => packageValue.package_id.startsWith("amd_fidelityfx_vk_"))
      .every((packageValue) => packageValue.variant === "vulkan_runtime"),
    true,
  );
  assert.equal(
    intel.packages
      .filter((packageValue) => packageValue.package_id.startsWith("libxess_dx11_"))
      .every((packageValue) => packageValue.variant === "dx11_runtime"),
    true,
  );
  assert.equal(
    intel.packages
      .filter(
        (packageValue) =>
          packageValue.package_id.startsWith("libxess_") &&
          !packageValue.package_id.startsWith("libxess_dx11_"),
      )
      .every((packageValue) => packageValue.variant === "dx12_runtime"),
    true,
  );
});

test("every frozen legacy DLL is represented in the v1 catalog", async () => {
  const [legacy, ...snapshots] = await Promise.all([
    readFile(path.join(repoRoot, "manifest.json"), "utf8").then(JSON.parse),
    ...libraryVendors.map(async ({ outputFile }) =>
      JSON.parse(await readFile(path.join(repoRoot, outputFile), "utf8")),
    ),
  ]);
  const artifacts = new Map(
    snapshots.flatMap((snapshot) =>
      snapshot.artifacts.map((artifact) => [artifact.dll.sha256, artifact]),
    ),
  );

  for (const entry of legacy.entries) {
    const artifact = artifacts.get(entry.files.dll.hashes.sha256);
    assert.ok(artifact, `${entry.entry_id}: DLL identity is missing from v1`);
    assert.equal(artifact.library_id, entry.library.id, `${entry.entry_id}: library id`);
    assert.equal(
      artifact.file_name,
      entry.library.file_name,
      `${entry.entry_id}: filename`,
    );
    assert.equal(
      normalizeNumericVersion(artifact.file_version),
      normalizeNumericVersion(entry.version.value),
      `${entry.entry_id}: file version`,
    );
    assert.equal(
      artifact.dll.size_bytes,
      entry.files.dll.size_bytes,
      `${entry.entry_id}: size`,
    );
    assert.equal(
      artifact.signature.status,
      entry.signature.status,
      `${entry.entry_id}: signature`,
    );
  }
});

test("legacy root manifest is frozen and excluded from publication", async () => {
  const body = await readFile(path.join(repoRoot, "manifest.json"));
  assert.equal(body.length, 245_101);
  assert.equal(
    sha256Hex(body),
    "28437a39c46e7f19f5d952552a5562de9a1a7ae5f375b43b7d7ff138db0bb7f8",
  );
  assert.equal(
    publishedJsonDocuments.some((document) => document.r2Key === "manifest.json"),
    false,
  );
});

function source() {
  return {
    schema_version: 1,
    vendor: { id: "example", display_name: "Example" },
    generated_at: "2026-07-22T00:00:00.000Z",
    legal_documents: [],
    artifacts: [
      {
        artifact_key: "runtime",
        library_id: "runtime",
        file_name: "runtime.dll",
        file_version: "1.0.0",
        architecture: "X64",
        dll: { sha256: "a".repeat(64), size_bytes: 7 },
        transport: { sha256: "b".repeat(64), size_bytes: 5 },
        signature: { status: "unsigned" },
      },
    ],
    packages: [
      {
        package_id: "runtime.1.0.0.x64",
        technology: "unknown",
        variant: "runtime",
        display_name: "Runtime",
        release: { version: "1.0.0", channel: "stable", label: null },
        target: { os: "windows", architecture: "X64" },
        members: [{ artifact_key: "runtime", role: "primary", install_as: "runtime.dll" }],
      },
    ],
  };
}

function sourceWithLegalDocument() {
  const value = source();
  const legalDocumentId = `license.${"c".repeat(64)}`;
  value.legal_documents = [
    {
      legal_document_id: legalDocumentId,
      kind: "license",
      title: "Example License",
      format: "text",
      file_name: "LICENSE.txt",
      content: { sha256: "c".repeat(64), size_bytes: 7 },
    },
  ];
  value.packages[0].legal_document_ids = [legalDocumentId];
  return value;
}

function normalizeNumericVersion(value) {
  const parts = value.split(".");
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts.map((part) => String(BigInt(part))).join(".");
}
