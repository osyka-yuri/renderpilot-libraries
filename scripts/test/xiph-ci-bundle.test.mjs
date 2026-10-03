import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepoPath } from "../lib/repo-paths.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { buildVendorSnapshot } from "../lib/library-catalog.mjs";
import {
  BUNDLE_MANIFEST_FILE,
  XIPH_ASSET_BUNDLE_KIND,
  XIPH_CATALOG_BUNDLE_PATHS,
  XIPH_CATALOG_BUNDLE_KIND,
  assertXiphCatalogTransition,
  collectXiphAssetDelta,
  createXiphCiBundles,
  verifyBundle,
  verifyXiphAssetBundle,
  verifyXiphCatalogBundle,
  xiphLogicalPackageKey,
} from "../lib/xiph-ci-bundle.mjs";

test("Xiph asset bundle contains only the exact candidate delta", () => {
  const existing = artifactExpectation("a");
  const added = artifactExpectation("b");
  const legal = {
    object_key: `libraries/legal/sha256/${"c".repeat(64)}.txt`,
    format: "text",
    content: { sha256: "c".repeat(64), size_bytes: 23 },
  };
  const delta = collectXiphAssetDelta(
    { artifacts: [existing], legal_documents: [] },
    { artifacts: [existing, added], legal_documents: [legal] },
  );

  assert.deepEqual([...delta.keys()].sort(), [
    added.transport.object_key,
    legal.object_key,
  ]);
});

test("Xiph asset delta preserves existing content identities while omitting superseded baseline assets", () => {
  const existing = artifactExpectation("a");
  const changed = structuredClone(existing);
  changed.dll.size_bytes += 1;

  // An unreachable baseline asset is simply omitted from the upload delta without error
  const delta = collectXiphAssetDelta(
    { artifacts: [existing], legal_documents: [] },
    { artifacts: [], legal_documents: [] },
  );
  assert.equal(delta.size, 0);

  // Changing the content identity of an existing CAS key is strictly forbidden
  assert.throws(
    () =>
      collectXiphAssetDelta(
        { artifacts: [existing], legal_documents: [] },
        { artifacts: [changed], legal_documents: [] },
      ),
    /changed an existing asset identity/u,
  );
});

test("Xiph legal documents follow CAS reachability and strict immutability", () => {
  const legalA = {
    object_key: `libraries/legal/sha256/${"a".repeat(64)}.txt`,
    format: "text",
    content: { sha256: "a".repeat(64), size_bytes: 100 },
  };
  const legalB = {
    object_key: `libraries/legal/sha256/${"b".repeat(64)}.txt`,
    format: "text",
    content: { sha256: "b".repeat(64), size_bytes: 200 },
  };
  const mutatedLegalA = structuredClone(legalA);
  mutatedLegalA.content.size_bytes = 101;

  // Unreachable superseded legal document is omitted from upload delta without error
  const delta = collectXiphAssetDelta(
    { artifacts: [], legal_documents: [legalA] },
    { artifacts: [], legal_documents: [legalB] },
  );
  assert.deepEqual([...delta.keys()], [legalB.object_key]);

  // Mutating content of an existing CAS legal document is strictly forbidden
  assert.throws(
    () =>
      collectXiphAssetDelta(
        { artifacts: [], legal_documents: [legalA] },
        { artifacts: [], legal_documents: [mutatedLegalA] },
      ),
    /changed an existing asset identity/u,
  );
});

test("Xiph catalog transition enforces package reachability and revision monotonicity", () => {
  const basePackage = packageExpectation({
    vorbis: "1.2.0",
    ogg: "1.2.0",
    architecture: "X86",
    variant: "shared.plain",
    revision: 1,
  });
  const supersededPackage = packageExpectation({
    vorbis: "1.2.0",
    ogg: "1.2.0",
    architecture: "X86",
    variant: "shared.plain",
    revision: 2,
  });
  const extendedPackage = packageExpectation({
    vorbis: "1.2.0",
    ogg: "1.2.0",
    architecture: "X64",
    variant: "embedded_ogg.unreal",
    revision: 2,
  });
  const mutatedSameRevisionPackage = structuredClone(basePackage);
  mutatedSameRevisionPackage.members = [
    {
      artifact_id: `sha256:${"f".repeat(64)}`,
      component: "ogg",
      role: "primary",
      install_as: "ogg.dll",
    },
  ];

  // Identical packages pass
  assert.doesNotThrow(() =>
    assertXiphCatalogTransition(
      { vendor: { id: "xiph" }, packages: [basePackage] },
      { vendor: { id: "xiph" }, packages: [basePackage] },
    ),
  );

  // Superseding with a higher build revision passes
  assert.doesNotThrow(() =>
    assertXiphCatalogTransition(
      { vendor: { id: "xiph" }, packages: [basePackage] },
      { vendor: { id: "xiph" }, packages: [supersededPackage] },
    ),
  );

  // Adding new configurations/packages passes
  assert.doesNotThrow(() =>
    assertXiphCatalogTransition(
      { vendor: { id: "xiph" }, packages: [basePackage] },
      { vendor: { id: "xiph" }, packages: [supersededPackage, extendedPackage] },
    ),
  );

  // Mutating package members/metadata without incrementing revision fails
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [mutatedSameRevisionPackage] },
      ),
    /mutated without incrementing build_revision/u,
  );

  // Dropping a package configuration fails
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [] },
      ),
    /baseline Xiph package configuration was removed in candidate catalog/u,
  );

  // Regressing a package build revision fails
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [supersededPackage] },
        { vendor: { id: "xiph" }, packages: [basePackage] },
      ),
    /candidate Xiph package has regressed build_revision \(1 < 2\)/u,
  );

  // Missing, non-integer, or non-positive build_revision fails closed
  const missingRevisionPackage = structuredClone(basePackage);
  delete missingRevisionPackage.provenance.build_revision;
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [missingRevisionPackage] },
      ),
    /invalid or missing Xiph build_revision provenance/u,
  );

  const nonIntegerRevisionPackage = structuredClone(basePackage);
  nonIntegerRevisionPackage.provenance.build_revision = 1.5;
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [nonIntegerRevisionPackage] },
      ),
    /invalid or missing Xiph build_revision provenance/u,
  );

  const zeroRevisionPackage = structuredClone(basePackage);
  zeroRevisionPackage.provenance.build_revision = 0;
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [zeroRevisionPackage] },
      ),
    /invalid or missing Xiph build_revision provenance/u,
  );

  // Baseline invalid revision fails closed symmetrically
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [nonIntegerRevisionPackage] },
        { vendor: { id: "xiph" }, packages: [basePackage] },
      ),
    /invalid or missing Xiph build_revision provenance/u,
  );

  // Duplicate candidate configurations fail
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage] },
        { vendor: { id: "xiph" }, packages: [basePackage, basePackage] },
      ),
    /duplicate candidate Xiph logical package configuration/u,
  );

  // Duplicate baseline configurations fail symmetrically
  assert.throws(
    () =>
      assertXiphCatalogTransition(
        { vendor: { id: "xiph" }, packages: [basePackage, basePackage] },
        { vendor: { id: "xiph" }, packages: [basePackage] },
      ),
    /duplicate baseline Xiph logical package configuration/u,
  );
});

test("production regression: superseding build_revision (r1 -> r2) replaces blobs and delta contains only new blobs", () => {
  const blobA = artifactExpectation("a");
  const blobB = artifactExpectation("b");

  const r1Package = packageExpectation({
    vorbis: "1.2.0",
    ogg: "1.2.0",
    architecture: "X86",
    variant: "shared.plain",
    revision: 1,
  });
  r1Package.members = [
    {
      artifact_id: `sha256:${blobA.dll.sha256}`,
      component: "ogg",
      role: "primary",
      install_as: "ogg.dll",
    },
  ];

  const r2Package = packageExpectation({
    vorbis: "1.2.0",
    ogg: "1.2.0",
    architecture: "X86",
    variant: "shared.plain",
    revision: 2,
  });
  r2Package.members = [
    {
      artifact_id: `sha256:${blobB.dll.sha256}`,
      component: "ogg",
      role: "primary",
      install_as: "ogg.dll",
    },
  ];

  const baseline = {
    vendor: { id: "xiph" },
    artifacts: [blobA],
    legal_documents: [],
    packages: [r1Package],
  };

  const candidate = {
    vendor: { id: "xiph" },
    artifacts: [blobB],
    legal_documents: [],
    packages: [r2Package],
  };

  // 1. Transition validation succeeds because r2 legitimately supersedes r1
  assert.doesNotThrow(() => assertXiphCatalogTransition(baseline, candidate));

  // 2. Upload delta contains ONLY the new blob B; unreachable baseline blob A is excluded without throwing
  const delta = collectXiphAssetDelta(baseline, candidate);
  assert.deepEqual([...delta.keys()], [blobB.transport.object_key]);
  assert.equal(delta.has(blobA.transport.object_key), false);
});

test("xiphLogicalPackageKey extracts canonical identity and rejects inconsistencies", () => {
  const pkg = packageExpectation({
    vorbis: "1.3.7",
    ogg: "1.3.6",
    architecture: "X64",
    variant: "embedded_ogg.unreal",
    revision: 2,
  });
  assert.equal(
    xiphLogicalPackageKey(pkg),
    ["1.3.7", "1.3.6", "windows", "X64", "embedded_ogg.unreal"].join("\0"),
  );

  const divergent = structuredClone(pkg);
  divergent.release.components.vorbis = "9.9.9";
  assert.throws(
    () => xiphLogicalPackageKey(divergent),
    /release component versions diverge from provenance sources/u,
  );

  assert.throws(
    () => xiphLogicalPackageKey({}),
    /incomplete Xiph logical package identity/u,
  );
});

test("CI bundle verifier accepts only exact manifested bytes", async () => {
  const fixture = await bundleFixture();
  try {
    await verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND);
    await writeFile(fixture.file, "tampered");
    await assert.rejects(
      verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND),
      /hash or size mismatch/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("CI bundle verifier rejects extra, missing, and traversal paths", async (context) => {
  await context.test("extra file", async () => {
    const fixture = await bundleFixture();
    try {
      await writeFile(path.join(fixture.root, "extra.txt"), "extra");
      await assert.rejects(
        verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND),
        /missing, extra, or unmanifested/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("missing file", async () => {
    const fixture = await bundleFixture();
    try {
      await rm(fixture.file);
      await assert.rejects(
        verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND),
        /missing, extra, or unmanifested/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test("path traversal", async () => {
    const fixture = await bundleFixture();
    try {
      await writeManifest(fixture.root, XIPH_ASSET_BUNDLE_KIND, [
        { path: "../escape", size_bytes: 1, sha256: "0".repeat(64) },
      ]);
      await assert.rejects(
        verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND),
        /unsafe bundle path/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("CI bundle verifier rejects reparse entries", async () => {
  const fixture = await bundleFixture();
  try {
    const target = path.join(fixture.root, "target");
    const link = path.join(fixture.root, "linked");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      verifyBundle(fixture.root, XIPH_ASSET_BUNDLE_KIND),
      /reparse point|reparse entries are forbidden/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("catalog bundle verifier enforces the reviewed JSON allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderpilot-catalog-bundle-"));
  try {
    const relative = "catalogs/libraries/unreviewed.json";
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from("{}");
    await writeFile(file, bytes);
    await writeManifest(root, XIPH_CATALOG_BUNDLE_KIND, [
      { path: relative, size_bytes: bytes.length, sha256: sha256Hex(bytes) },
    ]);
    await assert.rejects(verifyXiphCatalogBundle(root), /exact reviewed path allowlist/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog bundle creator produces bundles accepted by the trusted verifier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderpilot-created-bundles-"));
  const assetsRoot = path.join(root, "assets");
  const catalogRoot = path.join(root, "catalog");
  const baselineVendorFile = resolveRepoPath("libraries", "v1", "vendors", "xiph.json");
  try {
    await createXiphCiBundles({
      repoRoot: resolveRepoPath(),
      assetsRoot,
      catalogRoot,
      baselineVendorFile,
    });
    await assert.doesNotReject(verifyXiphCatalogBundle(catalogRoot));
    await assert.doesNotReject(
      verifyXiphAssetBundle(assetsRoot, catalogRoot, baselineVendorFile),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog bundle verifier rejects independently valid but inconsistent Xiph state", async () => {
  const fixture = await catalogBundleFixture();
  try {
    await assert.doesNotReject(verifyXiphCatalogBundle(fixture.root));

    const sourceFile = path.join(fixture.root, "catalogs", "libraries", "xiph.json");
    const vendorFile = path.join(fixture.root, "libraries", "v1", "vendors", "xiph.json");
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    const omittedPackage = source.packages[0];
    const omittedBuild = omittedPackage.provenance;
    source.packages = source.packages.filter(
      ({ provenance }) =>
        provenance.build_revision !== omittedBuild.build_revision ||
        provenance.sources.ogg.version !== omittedBuild.sources.ogg.version ||
        provenance.sources.vorbis.version !== omittedBuild.sources.vorbis.version,
    );
    const referencedArtifacts = new Set(
      source.packages.flatMap(({ members }) =>
        members.map(({ artifact_key }) => artifact_key),
      ),
    );
    const referencedLegalDocuments = new Set(
      source.packages.flatMap(({ legal_document_ids }) => legal_document_ids),
    );
    source.artifacts = source.artifacts.filter(({ artifact_key }) =>
      referencedArtifacts.has(artifact_key),
    );
    source.legal_documents = source.legal_documents.filter(({ legal_document_id }) =>
      referencedLegalDocuments.has(legal_document_id),
    );
    await Promise.all([
      writeJson(sourceFile, source),
      writeJson(vendorFile, buildVendorSnapshot(source)),
    ]);
    await refreshCatalogBundleManifest(fixture.root);

    await assert.rejects(
      verifyXiphCatalogBundle(fixture.root),
      /missing packages for completed locked builds/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("catalog bundle verifier rejects a snapshot detached from its source", async () => {
  const fixture = await catalogBundleFixture();
  try {
    const vendorFile = path.join(fixture.root, "libraries", "v1", "vendors", "xiph.json");
    const vendor = JSON.parse(await readFile(vendorFile, "utf8"));
    vendor.generated_at = "1970-01-01T00:00:01.000Z";
    await writeJson(vendorFile, vendor);
    await refreshCatalogBundleManifest(fixture.root);

    await assert.rejects(
      verifyXiphCatalogBundle(fixture.root),
      /snapshot does not match its reviewed source catalog/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

async function bundleFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderpilot-asset-bundle-"));
  const relative = "cdn/libraries/blobs/sha256/example.dll.zst";
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from("verified bundle bytes");
  await writeFile(file, bytes);
  await writeManifest(root, XIPH_ASSET_BUNDLE_KIND, [
    { path: relative, size_bytes: bytes.length, sha256: sha256Hex(bytes) },
  ]);
  return {
    root,
    file,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function catalogBundleFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderpilot-catalog-bundle-"));
  for (const relative of XIPH_CATALOG_BUNDLE_PATHS) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(resolveRepoPath(...relative.split("/"))));
  }
  await refreshCatalogBundleManifest(root);
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function refreshCatalogBundleManifest(root) {
  const files = [];
  for (const relative of XIPH_CATALOG_BUNDLE_PATHS) {
    const bytes = await readFile(path.join(root, ...relative.split("/")));
    files.push({
      path: relative,
      size_bytes: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writeManifest(root, XIPH_CATALOG_BUNDLE_KIND, files);
}

function artifactExpectation(marker) {
  return {
    dll: { sha256: marker.repeat(64), size_bytes: 17 },
    transport: {
      object_key: `libraries/blobs/sha256/${marker.repeat(64)}.dll.zst`,
      sha256: marker.repeat(64),
      size_bytes: 11,
    },
  };
}

function packageExpectation({
  vorbis = "1.2.0",
  ogg = "1.2.0",
  architecture = "X86",
  variant = "shared.plain",
  revision = 1,
} = {}) {
  return {
    package_id: `xiph_vorbis.vorbis-${vorbis}.ogg-${ogg}.r${revision}.${architecture.toLowerCase()}.${variant}`,
    technology: "xiph_vorbis",
    variant,
    target: { os: "windows", architecture },
    release: {
      version: vorbis,
      channel: "stable",
      label: null,
      components: { ogg, vorbis },
    },
    provenance: {
      kind: "source_build",
      build_revision: revision,
      sources: {
        ogg: { version: ogg },
        vorbis: { version: vorbis },
      },
    },
    members: [],
  };
}

async function writeManifest(root, kind, files) {
  await writeFile(
    path.join(root, BUNDLE_MANIFEST_FILE),
    `${JSON.stringify({ schema_version: 1, kind, files }, null, 2)}\n`,
  );
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
