import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepoPath } from "../catalog.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import {
  BUNDLE_MANIFEST_FILE,
  XIPH_ASSET_BUNDLE_KIND,
  XIPH_CATALOG_BUNDLE_PATHS,
  XIPH_CATALOG_BUNDLE_KIND,
  collectXiphAssetDelta,
  createXiphCiBundles,
  verifyBundle,
  verifyXiphAssetBundle,
  verifyXiphCatalogBundle,
} from "../lib/xiph-ci-bundle.mjs";
import { expectedXiphArtifactKeys } from "../lib/xiph-matrix.mjs";

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

test("Xiph asset delta preserves every existing content identity", () => {
  const existing = artifactExpectation("a");
  const changed = structuredClone(existing);
  changed.dll.size_bytes += 1;

  assert.throws(
    () =>
      collectXiphAssetDelta(
        { artifacts: [existing], legal_documents: [] },
        { artifacts: [], legal_documents: [] },
      ),
    /removed an existing asset/u,
  );
  assert.throws(
    () =>
      collectXiphAssetDelta(
        { artifacts: [existing], legal_documents: [] },
        { artifacts: [changed], legal_documents: [] },
      ),
    /changed an existing asset identity/u,
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

    const lockFile = path.join(fixture.root, "catalogs", "libraries", "xiph.lock.json");
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    const pair = lock.pairs[0];
    pair.builds = [syntheticBuildReceipt(pair)];
    await writeJson(lockFile, lock);
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

function syntheticBuildReceipt(pair) {
  const dllSha256 = "3".repeat(64);
  const zstSha256 = "4".repeat(64);
  return {
    build_revision: pair.build_revision,
    generated_at: "2026-07-27T00:00:00.000Z",
    recipe_sha256: "1".repeat(64),
    verification_policy_sha256: "2".repeat(64),
    patches: {},
    toolchain: {
      runner_image: "windows-2025-vs2026@20260720.1",
      compiler: "MSVC 19.51",
      linker: "LINK 14.51",
      windows_sdk: "10.0.26100.0",
      cmake: "4.3.1",
    },
    artifacts: expectedXiphArtifactKeys(pair, pair.build_revision).map((artifact_key) => ({
      artifact_key,
      dll_sha256: dllSha256,
      dll_size_bytes: 1,
      transport: {
        object_key: `libraries/blobs/sha256/${zstSha256}.dll.zst`,
        zst_sha256: zstSha256,
        zst_size_bytes: 1,
        compression_level: 12,
      },
    })),
  };
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

async function writeManifest(root, kind, files) {
  await writeFile(
    path.join(root, BUNDLE_MANIFEST_FILE),
    `${JSON.stringify({ schema_version: 1, kind, files }, null, 2)}\n`,
  );
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
