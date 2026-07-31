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
  packageRevisionInput,
} from "../lib/library-catalog.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { compileJsonSchema } from "../lib/json-schema-validation.mjs";

const validateSourceSchema = compileJsonSchema(
  JSON.parse(
    await readFile(
      new URL("../../schemas/library_vendor_source.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const validateSnapshotSchema = compileJsonSchema(
  JSON.parse(
    await readFile(
      new URL("../../schemas/library_vendor_v1.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

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

test("legacy V1 package revision bytes remain frozen", () => {
  assert.equal(
    buildVendorSnapshot(source()).packages[0].revision_sha256,
    "dc7bcca34ff75e258425052d02c8bced1cd13210e39c072f07deb7d4653b67d3",
  );
});

test("composite V2 revision binds components, source build, target, and members", () => {
  const original = compositeSourceBuild();
  const baseline = buildVendorSnapshot(original).packages[0].revision_sha256;

  const presentationOnly = structuredClone(original);
  presentationOnly.packages[0].display_name = "Renamed Xiph package";
  assert.equal(buildVendorSnapshot(presentationOnly).packages[0].revision_sha256, baseline);

  for (const mutate of [
    (value) => {
      value.packages[0].release.components.ogg = "1.3.5";
      value.packages[0].package_id =
        "xiph_vorbis.vorbis-1.3.7.ogg-1.3.5.r1.x64.shared.plain";
      value.packages[0].provenance.sources.ogg.version = "1.3.5";
      value.packages[0].provenance.sources.ogg.tag = "v1.3.5";
      value.packages[0].provenance.sources.ogg.archive_url =
        "https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.xz";
      value.artifacts[3].file_version = "1.3.5";
    },
    (value) => {
      value.packages[0].provenance.sources.ogg.commit_sha = "9".repeat(40);
    },
    (value) => {
      value.packages[0].target.architecture = "X86";
      value.packages[0].package_id =
        "xiph_vorbis.vorbis-1.3.7.ogg-1.3.6.r1.x86.shared.plain";
      value.artifacts.forEach((artifact) => {
        artifact.architecture = "X86";
      });
    },
    (value) => {
      value.artifacts[1].dll.sha256 = "9".repeat(64);
      value.artifacts[1].artifact_key = `dll.${"9".repeat(64)}`;
      value.packages[0].members[1].artifact_key = value.artifacts[1].artifact_key;
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(buildVendorSnapshot(changed).packages[0].revision_sha256, baseline);
  }
});

test("generic composite V2 requires and binds discriminated provenance", () => {
  const value = compositeSourceBuild();
  const packageValue = value.packages[0];
  packageValue.package_id = "example.composite.x64";
  packageValue.technology = "example_composite";
  packageValue.provenance = {
    kind: "nuget",
    package_id: "Example.Composite",
    version: packageValue.release.version,
    package_sha512: `${"A".repeat(86)}==`,
  };
  const snapshot = buildVendorSnapshot(value);
  const revisionInput = packageRevisionInput(packageValue, snapshot.packages[0].members);
  assert.equal(revisionInput.schema_version, 2);
  assert.deepEqual(revisionInput.provenance, packageValue.provenance);

  delete packageValue.provenance;
  assert.throws(() => buildVendorSnapshot(value), /composite packages require provenance/u);
  assert.throws(
    () => packageRevisionInput(packageValue, snapshot.packages[0].members),
    /composite revision input requires provenance/u,
  );
  packageValue.provenance = null;
  assert.throws(() => buildVendorSnapshot(value), /composite packages require provenance/u);
});

test("both catalog schemas require provenance on composite packages", () => {
  const sourceValue = compositeSourceBuild();
  const snapshot = buildVendorSnapshot(sourceValue);
  delete sourceValue.packages[0].provenance;
  delete snapshot.packages[0].provenance;

  assert.equal(validateSourceSchema(sourceValue), false);
  assert.equal(validateSnapshotSchema(snapshot), false);
  assert.ok(
    validateSourceSchema.errors?.some(
      (error) => error.instancePath === "/packages/0" && error.keyword === "required",
    ),
  );
  assert.ok(
    validateSnapshotSchema.errors?.some(
      (error) => error.instancePath === "/packages/0" && error.keyword === "required",
    ),
  );
});

test("Xiph package validation rejects API-set dynamic CRT imports", () => {
  const value = compositeSourceBuild();
  value.artifacts[0].pe_imports.regular = [
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "kernel32.dll",
    "ogg.dll",
  ];

  assert.throws(
    () => buildVendorSnapshot(value),
    /forbidden Xiph regular dependency api-ms-win-crt-runtime-l1-1-0\.dll/,
  );
});

test("Xiph build origin belongs to provenance rather than the release label", () => {
  const value = compositeSourceBuild();
  value.packages[0].release.label = "source build";

  assert.throws(
    () => buildVendorSnapshot(value),
    /Xiph release label must be null; build origin belongs to provenance/u,
  );
});

test("Xiph package validation keeps regular and delay import graphs distinct", () => {
  const value = compositeSourceBuild();
  value.artifacts[0].pe_imports.regular = ["kernel32.dll"];
  value.artifacts[0].pe_imports.delay = ["ogg.dll"];

  assert.throws(
    () => buildVendorSnapshot(value),
    /Xiph regular import graph does not match shared/u,
  );
});

test("Xiph source artifact keys are bound to DLL content identity", () => {
  const value = compositeSourceBuild();
  value.artifacts[0].artifact_key = "contextual-key";
  value.packages[0].members[0].artifact_key = "contextual-key";

  assert.throws(
    () => buildVendorSnapshot(value),
    /artifact_key must equal the DLL content identity/u,
  );
});

test("PE import metadata rejects fields outside its closed contract", () => {
  const value = compositeSourceBuild();
  value.artifacts[0].pe_imports.other = [];

  assert.throws(() => buildVendorSnapshot(value), /must contain regular and delay arrays/u);
});

test("generic source patches must reference an existing provenance source", () => {
  const source = compositeSourceBuild();
  source.packages[0].provenance.patches = {
    "custom.patch": {
      source: "missing",
      target: "src/example.c",
      descriptor_sha256: "1".repeat(64),
      original_sha256: "2".repeat(64),
      patched_sha256: "3".repeat(64),
    },
  };
  assert.throws(
    () => buildVendorSnapshot(source),
    /invalid source patch target custom\.patch/u,
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

  const dxcPackages = microsoft.packages.filter(
    (packageValue) => packageValue.technology === "microsoft_dxc",
  );
  assert.equal(
    dxcPackages.every(
      (packageValue) =>
        packageValue.members[0]?.install_as === "dxcompiler.dll" &&
        packageValue.members.length <= 2 &&
        packageValue.members.slice(1).every((member) => member.install_as === "dxil.dll"),
    ),
    true,
  );
  assert.equal(
    dxcPackages.some((packageValue) => packageValue.members.length === 1),
    true,
    "historical listed DXC previews legitimately omit the optional validator",
  );
  assert.equal(
    dxcPackages.some((packageValue) => packageValue.members.length === 2),
    true,
    "modern DXC packages retain the complete compiler/validator bundle",
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

function compositeSourceBuild() {
  const sourceInput = (repository, version, marker) => ({
    repository,
    version,
    tag: `v${version}`,
    tag_object_sha: marker.repeat(40),
    commit_sha: marker.toUpperCase().toLowerCase().repeat(40),
    archive_url:
      `https://downloads.xiph.org/releases/${repository.split("/")[1]}/` +
      `lib${repository.split("/")[1]}-${version}.tar.xz`,
    archive_sha256: marker.repeat(64),
  });
  return {
    schema_version: 1,
    vendor: { id: "xiph", display_name: "Xiph.Org Foundation" },
    generated_at: "2026-07-27T00:00:00.000Z",
    legal_documents: [],
    artifacts: [
      {
        artifact_key: `dll.${"a".repeat(64)}`,
        library_id: "xiph_vorbis",
        file_name: "vorbis.dll",
        file_version: "1.3.7",
        architecture: "X64",
        pe_named_exports: ["vorbis_info_init"],
        pe_imports: { regular: ["kernel32.dll", "ogg.dll"], delay: [] },
        dll: { sha256: "a".repeat(64), size_bytes: 7 },
        transport: { sha256: "b".repeat(64), size_bytes: 5 },
        signature: { status: "unsigned" },
      },
      {
        artifact_key: `dll.${"c".repeat(64)}`,
        library_id: "xiph_vorbisfile",
        file_name: "vorbisfile.dll",
        file_version: "1.3.7",
        architecture: "X64",
        pe_named_exports: ["ov_open"],
        pe_imports: {
          regular: ["kernel32.dll", "ogg.dll", "vorbis.dll"],
          delay: [],
        },
        dll: { sha256: "c".repeat(64), size_bytes: 11 },
        transport: { sha256: "d".repeat(64), size_bytes: 9 },
        signature: { status: "unsigned" },
      },
      {
        artifact_key: `dll.${"5".repeat(64)}`,
        library_id: "xiph_vorbisenc",
        file_name: "vorbisenc.dll",
        file_version: "1.3.7",
        architecture: "X64",
        pe_named_exports: ["vorbis_encode_init"],
        pe_imports: { regular: ["kernel32.dll", "vorbis.dll"], delay: [] },
        dll: { sha256: "5".repeat(64), size_bytes: 13 },
        transport: { sha256: "6".repeat(64), size_bytes: 10 },
        signature: { status: "unsigned" },
      },
      {
        artifact_key: `dll.${"7".repeat(64)}`,
        library_id: "xiph_ogg",
        file_name: "ogg.dll",
        file_version: "1.3.6",
        architecture: "X64",
        pe_named_exports: ["ogg_sync_init"],
        pe_imports: { regular: ["kernel32.dll"], delay: [] },
        dll: { sha256: "7".repeat(64), size_bytes: 17 },
        transport: { sha256: "8".repeat(64), size_bytes: 12 },
        signature: { status: "unsigned" },
      },
    ],
    packages: [
      {
        package_id: "xiph_vorbis.vorbis-1.3.7.ogg-1.3.6.r1.x64.shared.plain",
        technology: "xiph_vorbis",
        variant: "shared.plain",
        display_name: "Xiph Vorbis/Ogg",
        release: {
          version: "1.3.7",
          channel: "stable",
          label: null,
          components: { ogg: "1.3.6", vorbis: "1.3.7" },
        },
        target: { os: "windows", architecture: "X64" },
        provenance: {
          kind: "source_build",
          sources: {
            ogg: sourceInput("xiph/ogg", "1.3.6", "1"),
            vorbis: sourceInput("xiph/vorbis", "1.3.7", "2"),
          },
          build_revision: 1,
          recipe_sha256: "e".repeat(64),
          verification_policy_sha256: "f".repeat(64),
          patches: {},
          toolchain: {
            runner_image: "windows-2025-vs2026@test",
            compiler: "MSVC 19.50",
            linker: "link 14.50",
            windows_sdk: "10.0.26100.0",
            cmake: "4.1.0",
          },
        },
        members: [
          {
            artifact_key: `dll.${"a".repeat(64)}`,
            component: "vorbis",
            role: "primary",
            install_as: "vorbis.dll",
          },
          {
            artifact_key: `dll.${"c".repeat(64)}`,
            component: "vorbisfile",
            role: "support",
            install_as: "vorbisfile.dll",
          },
          {
            artifact_key: `dll.${"5".repeat(64)}`,
            component: "vorbisenc",
            role: "support",
            install_as: "vorbisenc.dll",
          },
          {
            artifact_key: `dll.${"7".repeat(64)}`,
            component: "ogg",
            role: "support",
            install_as: "ogg.dll",
          },
        ],
      },
    ],
  };
}

function normalizeNumericVersion(value) {
  const parts = value.split(".");
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts.map((part) => String(BigInt(part))).join(".");
}
