import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepoPath } from "../catalog.mjs";
import { finalizeXiphSource } from "../finalize-xiph-source.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { assertXiphCatalogMatchesLock } from "../lib/xiph-catalog-state.mjs";
import { xiphBuildConfigurations } from "../lib/xiph-matrix.mjs";

const FIXED_TIME = "2026-07-27T12:00:00.000Z";

test("finalizer materializes the complete matrix into a valid lock and catalog", async () => {
  const fixture = await createFixture();
  try {
    const result = await finalizeXiphSource({
      ...fixture.paths,
      ...fakePersistence(),
      now: () => new Date(FIXED_TIME),
    });

    assert.equal(result.source.packages.length, 12);
    assert.equal(result.source.artifacts.length, 42);
    assert.equal(result.pair.builds.length, 1);
    assert.equal(result.pair.builds[0].artifacts.length, 42);
    assert.deepEqual(result.pair.builds[0].patches, {});
    assert.doesNotThrow(() => assertXiphCatalogMatchesLock(result.source, result.lock));
    assert.equal(result.source.packages[0].release.version, "1.0.0");
    assert.deepEqual(result.source.packages[0].release.components, {
      ogg: "1.0.0",
      vorbis: "1.0.0",
    });
    assert.equal(result.source.packages[0].provenance.sources.ogg.version, "1.0");
    assert.equal(result.source.packages[0].provenance.sources.vorbis.version, "1.0");
    assert.deepEqual(
      result.source.packages[0].provenance.toolchain,
      result.pair.builds[0].toolchain,
    );

    const committedSource = JSON.parse(await readFile(fixture.paths.sourceFile, "utf8"));
    const committedLock = JSON.parse(await readFile(fixture.paths.lockFile, "utf8"));
    assert.deepEqual(committedSource, result.source);
    assert.deepEqual(committedLock, result.lock);

    const before = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    await assert.rejects(
      finalizeXiphSource({
        ...fixture.paths,
        ...fakePersistence(),
        now: () => new Date(FIXED_TIME),
      }),
      /locked Xiph builds are immutable/u,
    );
    const after = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    assert.ok(before[0].equals(after[0]));
    assert.ok(before[1].equals(after[1]));
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects an incomplete matrix before persisting any asset", async () => {
  const fixture = await createFixture();
  try {
    const manifestFile = path.join(fixture.paths.buildRoot, "build-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.artifacts.pop();
    await writeJson(manifestFile, manifest);
    let persistenceCalls = 0;

    await assert.rejects(
      finalizeXiphSource({
        ...fixture.paths,
        persistObject: async () => {
          persistenceCalls += 1;
          throw new Error("must not persist");
        },
      }),
      /missing matrix members/u,
    );
    assert.equal(persistenceCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer deduplicates identical DLL bytes without collapsing build receipts", async () => {
  const fixture = await createFixture({
    deduplicateTopologyInvariantArtifacts: true,
  });
  try {
    const result = await finalizeXiphSource({
      ...fixture.paths,
      ...fakePersistence(),
      now: () => new Date(FIXED_TIME),
    });

    assert.equal(result.source.packages.length, 12);
    assert.equal(result.source.artifacts.length, 36);
    assert.equal(result.pair.builds[0].artifacts.length, 42);
    assert.equal(
      new Set(result.source.artifacts.map((artifact) => artifact.dll.sha256)).size,
      36,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer reuses identical DLLs across historical pairs and skips recompression", async () => {
  const fixture = await createFixture({
    pairTuples: ["1.0|1.1", "1.0|1.0"],
    deduplicateTopologyInvariantArtifacts: true,
    pairInvariantComponents: ["vorbisenc"],
  });
  try {
    const persistence = fakePersistence();
    let preparationCalls = 0;
    const prepareDll = async (bytes) => {
      preparationCalls += 1;
      return persistence.prepareDll(bytes);
    };
    const first = await finalizeXiphSource({
      ...fixture.paths,
      ...persistence,
      prepareDll,
      now: () => new Date(FIXED_TIME),
    });
    assert.equal(preparationCalls, 36);
    assert.equal(first.source.artifacts.length, 36);
    assert.equal(first.pair.builds[0].artifacts.length, 42);
    const priorVorbisEncKeys = new Set(
      first.source.packages.flatMap((packageValue) =>
        packageValue.members
          .filter((member) => member.component === "vorbisenc")
          .map((member) => member.artifact_key),
      ),
    );

    await fixture.writeBuildForPair(fixture.pairs[1]);
    preparationCalls = 0;
    const second = await finalizeXiphSource({
      ...fixture.paths,
      ...persistence,
      prepareDll,
      now: () => new Date(FIXED_TIME),
    });

    assert.equal(preparationCalls, 30);
    assert.equal(second.source.packages.length, 24);
    assert.equal(second.source.artifacts.length, 66);
    assert.equal(
      new Set(second.source.artifacts.map((artifact) => artifact.dll.sha256)).size,
      66,
    );
    assert.deepEqual(
      second.lock.pairs.map((pair) => pair.builds[0].artifacts.length),
      [42, 42],
    );

    const currentPackages = second.source.packages.filter(
      (packageValue) => packageValue.provenance.sources.ogg.version === "1.0",
    );
    const reusedVorbisEncKeys = currentPackages.map(
      (packageValue) =>
        packageValue.members.find((member) => member.component === "vorbisenc")
          .artifact_key,
    );
    assert.equal(currentPackages.length, 12);
    assert.ok(
      reusedVorbisEncKeys.every(
        (artifactKey) =>
          artifactKey.startsWith("dll.") && priorVorbisEncKeys.has(artifactKey),
      ),
    );
    assert.ok(
      second.lock.pairs[1].builds[0].artifacts
        .filter((artifact) => artifact.artifact_key.endsWith(".vorbisenc"))
        .every((artifact) => artifact.artifact_key.includes(".ogg-1.0.")),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("catalog identity is independent of pair finalization order", async () => {
  const options = {
    pairTuples: ["1.0|1.1", "1.0|1.0"],
    deduplicateTopologyInvariantArtifacts: true,
    pairInvariantComponents: ["vorbisenc"],
  };
  const forward = await createFixture(options);
  const reverse = await createFixture({ ...options, initialPairIndex: 1 });
  try {
    const forwardPersistence = fakePersistence();
    await finalizeXiphSource({
      ...forward.paths,
      ...forwardPersistence,
      now: () => new Date(FIXED_TIME),
    });
    await forward.writeBuildForPair(forward.pairs[1]);
    const forwardResult = await finalizeXiphSource({
      ...forward.paths,
      ...forwardPersistence,
      now: () => new Date(FIXED_TIME),
    });

    const reversePersistence = fakePersistence();
    await finalizeXiphSource({
      ...reverse.paths,
      ...reversePersistence,
      now: () => new Date(FIXED_TIME),
    });
    await reverse.writeBuildForPair(reverse.pairs[0]);
    const reverseResult = await finalizeXiphSource({
      ...reverse.paths,
      ...reversePersistence,
      now: () => new Date(FIXED_TIME),
    });

    assert.deepEqual(reverseResult.source, forwardResult.source);
    assert.deepEqual(reverseResult.lock, forwardResult.lock);
  } finally {
    await Promise.all([forward.cleanup(), reverse.cleanup()]);
  }
});

test("cross-pair DLL reuse fails closed on conflicting binary metadata", async () => {
  const fixture = await createFixture({
    pairTuples: ["1.0|1.1", "1.0|1.0"],
    deduplicateTopologyInvariantArtifacts: true,
    pairInvariantComponents: ["vorbisenc"],
  });
  try {
    const persistence = fakePersistence();
    await finalizeXiphSource({
      ...fixture.paths,
      ...persistence,
      now: () => new Date(FIXED_TIME),
    });
    await fixture.writeBuildForPair(fixture.pairs[1]);

    const manifestFile = path.join(fixture.paths.buildRoot, "build-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const conflictingArtifact = manifest.artifacts.find(
      (artifact) => artifact.component === "vorbisenc",
    );
    conflictingArtifact.pe_named_exports = ["conflicting_export"];
    await writeJson(manifestFile, manifest);
    const before = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);

    await assert.rejects(
      finalizeXiphSource({
        ...fixture.paths,
        ...persistence,
        now: () => new Date(FIXED_TIME),
      }),
      /identical Xiph DLL bytes have conflicting metadata/u,
    );

    const after = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    assert.ok(before[0].equals(after[0]));
    assert.ok(before[1].equals(after[1]));
  } finally {
    await fixture.cleanup();
  }
});

test("catalog and lock validation binds packages to exact build receipts", async () => {
  const fixture = await createFixture();
  try {
    const result = await finalizeXiphSource({
      ...fixture.paths,
      ...fakePersistence(),
      now: () => new Date(FIXED_TIME),
    });

    const pendingRebuild = structuredClone(result.lock);
    pendingRebuild.pairs[0].build_revision = 2;
    assert.doesNotThrow(() => assertXiphCatalogMatchesLock(result.source, pendingRebuild));

    const completedRebuild = structuredClone(pendingRebuild);
    const secondBuild = structuredClone(completedRebuild.pairs[0].builds[0]);
    secondBuild.build_revision = 2;
    secondBuild.generated_at = "2026-07-27T13:00:00.000Z";
    for (const artifact of secondBuild.artifacts) {
      artifact.artifact_key = artifact.artifact_key.replace(".r1.", ".r2.");
    }
    completedRebuild.pairs[0].builds.push(secondBuild);
    assert.throws(
      () => assertXiphCatalogMatchesLock(result.source, completedRebuild),
      /does not reference the latest completed build/u,
    );

    const mismatchedProvenance = structuredClone(result.source);
    mismatchedProvenance.packages[0].provenance.recipe_sha256 = "9".repeat(64);
    assert.throws(
      () => assertXiphCatalogMatchesLock(mismatchedProvenance, result.lock),
      /package provenance differs from its locked build/u,
    );

    const mismatchedCatalogArtifact = structuredClone(result.source);
    const artifactKey = mismatchedCatalogArtifact.packages[0].members[0].artifact_key;
    const sourceArtifact = mismatchedCatalogArtifact.artifacts.find(
      (artifact) => artifact.artifact_key === artifactKey,
    );
    sourceArtifact.transport.sha256 = "8".repeat(64);
    assert.throws(
      () => assertXiphCatalogMatchesLock(mismatchedCatalogArtifact, result.lock),
      /artifact differs from its exact locked build receipt/u,
    );

    const mismatchedReceipt = structuredClone(result.lock);
    const receiptKey = mismatchedReceipt.pairs[0].builds[0].artifacts[0].artifact_key;
    const receipt = mismatchedReceipt.pairs[0].builds[0].artifacts.find(
      (artifact) => artifact.artifact_key === receiptKey,
    );
    receipt.dll_sha256 = "7".repeat(64);
    assert.throws(
      () => assertXiphCatalogMatchesLock(result.source, mismatchedReceipt),
      /artifact differs from its exact locked build receipt/u,
    );

    const wrongVendor = structuredClone(result.source);
    wrongVendor.vendor.id = "other";
    assert.throws(
      () => assertXiphCatalogMatchesLock(wrongVendor, result.lock),
      /unexpected vendor/u,
    );

    const foreignPackage = structuredClone(result.source);
    foreignPackage.packages[0].technology = "foreign";
    assert.throws(
      () => assertXiphCatalogMatchesLock(foreignPackage, result.lock),
      /non-Xiph package is forbidden/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer completes every possible preparation before persisting immutable assets", async () => {
  const fixture = await createFixture();
  try {
    const before = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    const persistence = fakePersistence();
    let preparations = 0;
    let persistenceCalls = 0;
    await assert.rejects(
      finalizeXiphSource({
        ...fixture.paths,
        ...persistence,
        prepareDll: async (bytes) => {
          preparations += 1;
          if (preparations === 3) throw new Error("synthetic preparation failure");
          return persistence.prepareDll(bytes);
        },
        persistObject: async () => {
          persistenceCalls += 1;
        },
      }),
      /synthetic preparation failure/u,
    );
    assert.equal(persistenceCalls, 0);
    const after = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    assert.ok(before[0].equals(after[0]));
    assert.ok(before[1].equals(after[1]));
  } finally {
    await fixture.cleanup();
  }
});

test("asset persistence failure leaves JSON untouched and permits only orphan blobs", async () => {
  const fixture = await createFixture();
  try {
    const before = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    let persistenceCalls = 0;
    await assert.rejects(
      finalizeXiphSource({
        ...fixture.paths,
        ...fakePersistence(),
        persistObject: async () => {
          persistenceCalls += 1;
          if (persistenceCalls === 2) throw new Error("synthetic immutable write failure");
        },
      }),
      /synthetic immutable write failure/u,
    );
    assert.equal(persistenceCalls, 2);
    const after = await Promise.all([
      readFile(fixture.paths.sourceFile),
      readFile(fixture.paths.lockFile),
    ]);
    assert.ok(before[0].equals(after[0]));
    assert.ok(before[1].equals(after[1]));
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture({
  pairTuples = ["1.0|1.0"],
  initialPairIndex = 0,
  deduplicateTopologyInvariantArtifacts = false,
  pairInvariantComponents = [],
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderpilot-xiph-finalize-"));
  const buildRoot = path.join(root, "build");
  const lockFile = path.join(root, "xiph.lock.json");
  const sourceFile = path.join(root, "xiph.json");
  await mkdir(buildRoot, { recursive: true });

  const committedLock = JSON.parse(
    await readFile(resolveRepoPath("catalogs", "libraries", "xiph.lock.json"), "utf8"),
  );
  const pairs = pairTuples.map((tuple) => {
    const pair = committedLock.pairs.find(
      (candidate) => `${candidate.vorbis_version}|${candidate.ogg_version}` === tuple,
    );
    assert.ok(pair, `reviewed Xiph pair is missing from the fixture source: ${tuple}`);
    return { ...structuredClone(pair), builds: [] };
  });
  const lock = { schema_version: 1, pairs };
  assert.ok(
    Number.isInteger(initialPairIndex) &&
      initialPairIndex >= 0 &&
      initialPairIndex < pairs.length,
    "initialPairIndex must select a fixture pair",
  );
  const source = {
    schema_version: 1,
    vendor: { id: "xiph", display_name: "Xiph.Org Foundation" },
    generated_at: "1970-01-01T00:00:00.000Z",
    legal_documents: [],
    artifacts: [],
    packages: [],
  };

  const writeBuildForPair = (pair) =>
    writeFixtureBuild({
      buildRoot,
      pair,
      deduplicateTopologyInvariantArtifacts,
      pairInvariantComponents,
    });

  await Promise.all([
    writeBuildForPair(pairs[initialPairIndex]),
    writeJson(lockFile, lock),
    writeJson(sourceFile, source),
  ]);
  return {
    paths: { buildRoot, lockFile, sourceFile },
    pairs,
    writeBuildForPair,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function writeFixtureBuild({
  buildRoot,
  pair,
  deduplicateTopologyInvariantArtifacts,
  pairInvariantComponents,
}) {
  const invariantComponents = new Set(pairInvariantComponents);
  const artifacts = [];
  for (const configuration of xiphBuildConfigurations()) {
    const names = namesForProfile(configuration.profile);
    for (const component of configuration.components) {
      const configurationIdentity =
        deduplicateTopologyInvariantArtifacts && component === "vorbisenc"
          ? `${configuration.architecture}-${configuration.profile}-${component}`
          : `${configuration.architecture}-${configuration.topology}-` +
            `${configuration.profile}-${component}`;
      const sourceIdentity = invariantComponents.has(component)
        ? `vorbis-${pair.vorbis_version}`
        : `vorbis-${pair.vorbis_version}-ogg-${pair.ogg_version}`;
      const identity = `${sourceIdentity}-${configurationIdentity}`;
      const bytes = Buffer.from(`synthetic DLL ${identity}`, "utf8");
      const artifactPath = path.join(buildRoot, `${identity}.dll`);
      await writeFile(artifactPath, bytes);
      artifacts.push({
        architecture: configuration.architecture,
        topology: configuration.topology,
        profile: configuration.profile,
        component,
        file_name: names[component],
        path: artifactPath,
        sha256: sha256Hex(bytes),
        size_bytes: bytes.length,
        pe_version: component === "ogg" ? pair.ogg_version : pair.vorbis_version,
        pe_named_exports: [`${component}_export`],
        pe_imports: {
          regular: [
            ...expectedImports(configuration.topology, component, names),
            "kernel32.dll",
          ].sort(),
          delay: [],
        },
      });
    }
  }
  const manifest = {
    schema_version: 1,
    pair: {
      vorbis_version: pair.vorbis_version,
      ogg_version: pair.ogg_version,
      build_revision: pair.build_revision,
    },
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
    artifacts,
  };

  await Promise.all([
    writeJson(path.join(buildRoot, "build-manifest.json"), manifest),
    writeFile(path.join(buildRoot, "COPYING.ogg.txt"), "Ogg license\n"),
    writeFile(path.join(buildRoot, "COPYING.vorbis.txt"), "Vorbis license\n"),
  ]);
}

function fakePersistence() {
  return {
    prepareDll: async (bytes) => {
      const digest = sha256Hex(Buffer.concat([Buffer.from("transport:"), bytes]));
      return {
        object_key: `libraries/blobs/sha256/${digest}.dll.zst`,
        bytes: Buffer.from(bytes),
        result: {
          object_key: `libraries/blobs/sha256/${digest}.dll.zst`,
          zst_sha256: digest,
          zst_size_bytes: bytes.length,
          compression_level: 12,
        },
      };
    },
    prepareLegal: async (bytes) => {
      const digest = sha256Hex(bytes);
      return {
        object_key: `libraries/legal/sha256/${digest}.txt`,
        bytes: Buffer.from(bytes),
        result: {
          object_key: `libraries/legal/sha256/${digest}.txt`,
          sha256: digest,
          size_bytes: bytes.length,
        },
      };
    },
    persistObject: async () => {},
  };
}

function namesForProfile(profile) {
  const names = {
    plain: {
      ogg: "ogg.dll",
      vorbis: "vorbis.dll",
      vorbisfile: "vorbisfile.dll",
      vorbisenc: "vorbisenc.dll",
    },
    lib: {
      ogg: "libogg.dll",
      vorbis: "libvorbis.dll",
      vorbisfile: "libvorbisfile.dll",
      vorbisenc: "libvorbisenc.dll",
    },
    abi: {
      ogg: "libogg-0.dll",
      vorbis: "libvorbis-0.dll",
      vorbisfile: "libvorbisfile-3.dll",
      vorbisenc: "libvorbisenc-2.dll",
    },
  };
  return names[profile];
}

function expectedImports(topology, component, names) {
  if (component === "vorbis") return topology === "shared" ? [names.ogg] : [];
  if (component === "vorbisfile") {
    return topology === "shared" ? [names.ogg, names.vorbis] : [names.vorbis];
  }
  if (component === "vorbisenc") return [names.vorbis];
  return [];
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
