import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveRepoPath } from "../catalog.mjs";
import { assertXiphLock, assertXiphLockExtendsBaseline } from "../lib/xiph-lock.mjs";
import {
  XIPH_BUILD_MATRIX,
  assertXiphVerificationPolicy,
  expectedXiphArtifactKeys,
} from "../lib/xiph-matrix.mjs";

async function lockFixture() {
  return JSON.parse(
    await readFile(resolveRepoPath("catalogs", "libraries", "xiph.lock.json"), "utf8"),
  );
}

test("committed Xiph source tuple has immutable tags, commits, archives, and limits", async () => {
  const lock = assertXiphLock(await lockFixture());
  assert.equal(lock.pairs.length, 16);
  assert.equal(new Set(lock.pairs.map((pair) => pair.vorbis_version)).size, 15);
  assert.equal(new Set(lock.pairs.map((pair) => pair.ogg_version)).size, 16);
  assert.ok(
    lock.pairs.length < 15 * 16,
    "historical releases must not form a cross-product",
  );
});

test("Vorbis 1.2.3 export backport is bound to one immutable source", async () => {
  const [lock, descriptor] = await Promise.all([
    lockFixture(),
    readFile(
      resolveRepoPath("scripts", "xiph", "patches", "vorbis-win32-analysis-export-v1.json"),
      "utf8",
    ).then(JSON.parse),
  ]);
  const source = lock.pairs.find((pair) => pair.vorbis_version === "1.2.3")?.sources.vorbis;
  assert.ok(source, "the reviewed Vorbis 1.2.3 source must remain locked");
  assert.deepEqual(descriptor.applies_to, {
    repository: source.repository,
    commit_sha: source.commit_sha,
    archive_sha256: source.archive_sha256,
  });
  assert.match(descriptor.description, /c5b59af00de64a474b5aa5190e8349125dbafd79/u);
  assert.match(descriptor.expected_original_sha256, /^[0-9a-f]{64}$/u);
  assert.match(descriptor.expected_patched_sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(descriptor.expected_original_sha256, descriptor.expected_patched_sha256);
  for (const pair of lock.pairs.filter(
    (candidate) => candidate.vorbis_version !== "1.2.3",
  )) {
    assert.notDeepEqual(
      descriptor.applies_to,
      {
        repository: pair.sources.vorbis.repository,
        commit_sha: pair.sources.vorbis.commit_sha,
        archive_sha256: pair.sources.vorbis.archive_sha256,
      },
      `patch must not match Vorbis ${pair.vorbis_version}`,
    );
  }
});

test("Xiph lock rejects source and checksum tampering", async () => {
  for (const mutate of [
    (lock) => {
      lock.pairs[0].sources.ogg.commit_sha = "0".repeat(39);
    },
    (lock) => {
      lock.pairs[0].sources.vorbis.archive_sha256 = "A".repeat(64);
    },
    (lock) => {
      lock.pairs[0].sources.extra = structuredClone(lock.pairs[0].sources.ogg);
    },
  ]) {
    const lock = await lockFixture();
    mutate(lock);
    assert.throws(() => assertXiphLock(lock));
  }
});

test("Xiph append-only comparison rejects rewritten history", async () => {
  const baseline = await lockFixture();
  const current = structuredClone(baseline);
  current.pairs[0].sources.ogg.archive_sha256 = "0".repeat(64);
  assert.throws(
    () => assertXiphLockExtendsBaseline(baseline, current),
    /rewrote historical pair/,
  );

  const next = structuredClone(baseline);
  next.pairs.push({
    ...structuredClone(baseline.pairs[0]),
    vorbis_version: "1.3.8",
    build_revision: 1,
    builds: [],
  });
  next.pairs.at(-1).sources.vorbis.tag = "v1.3.8";
  next.pairs.at(-1).sources.vorbis.archive_url =
    "https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.8.tar.xz";
  assert.doesNotThrow(() => assertXiphLockExtendsBaseline(baseline, next));
});

test("Xiph build receipt requires the exact 42-member topology matrix", async () => {
  const lock = await lockFixture();
  const pair = lock.pairs[0];
  const artifactKeys = expectedXiphArtifactKeys(pair, 1);
  assert.equal(artifactKeys.length, 42);
  pair.builds = [
    {
      build_revision: 1,
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
      artifacts: artifactKeys.map((artifact_key) => ({
        artifact_key,
        dll_sha256: "3".repeat(64),
        dll_size_bytes: 1,
        transport: {
          object_key: `libraries/blobs/sha256/${"4".repeat(64)}.dll.zst`,
          zst_sha256: "4".repeat(64),
          zst_size_bytes: 1,
          compression_level: 12,
        },
      })),
    },
  ];

  assert.doesNotThrow(() => assertXiphLock(lock));
  pair.builds[0].toolchain.runner_image = "local-windows@10.0.26200.0";
  assert.throws(() => assertXiphLock(lock), /incomplete build receipt/u);
  assert.doesNotThrow(() => assertXiphLock(lock, { runnerContext: "integration" }));
  pair.builds[0].toolchain.runner_image = "windows-2025-vs2026@20260720.1";

  pair.builds[0].artifacts[0].transport.object_key = "libraries/blobs/wrong.dll.zst";
  assert.throws(() => assertXiphLock(lock), /invalid content-addressed build artifact/u);
  pair.builds[0].artifacts[0].transport.object_key = `libraries/blobs/sha256/${"4".repeat(64)}.dll.zst`;
  pair.builds[0].artifacts[0].transport.compression_level = 0;
  assert.throws(() => assertXiphLock(lock), /invalid content-addressed build artifact/u);
  pair.builds[0].artifacts[0].transport.compression_level = 12;

  pair.builds[0].artifacts[0].transport = {
    object_key: `libraries/blobs/sha256/${"5".repeat(64)}.dll.zst`,
    zst_sha256: "5".repeat(64),
    zst_size_bytes: 2,
    compression_level: 12,
  };
  assert.throws(() => assertXiphLock(lock), /conflicting immutable transport/u);
  pair.builds[0].artifacts[0].transport = {
    object_key: `libraries/blobs/sha256/${"4".repeat(64)}.dll.zst`,
    zst_sha256: "4".repeat(64),
    zst_size_bytes: 1,
    compression_level: 12,
  };

  pair.builds[0].generated_at = "not-a-timestamp";
  assert.throws(() => assertXiphLock(lock), /incomplete build receipt/u);
  pair.builds[0].generated_at = "2026-07-27T00:00:00.000Z";

  pair.builds[0].artifacts.pop();
  assert.throws(() => assertXiphLock(lock), /does not match the Xiph matrix/u);
});

test("Xiph policy rejects unsafe aliases and unsupported security checks", async () => {
  const policy = JSON.parse(
    await readFile(resolveRepoPath("scripts", "xiph", "verification-policy.json"), "utf8"),
  );
  const unsafeAlias = structuredClone(policy);
  unsafeAlias.aliases.plain.ogg = "../ogg.dll";
  assert.throws(
    () => assertXiphVerificationPolicy(unsafeAlias),
    /aliases must be safe and unique/u,
  );

  const unsupportedSecurity = structuredClone(policy);
  unsupportedSecurity.required_security.X64.push("future_flag");
  assert.throws(
    () => assertXiphVerificationPolicy(unsupportedSecurity),
    /unsupported Xiph security requirement/u,
  );

  const unknownProperty = structuredClone(policy);
  unknownProperty.unused_setting = true;
  assert.throws(
    () => assertXiphVerificationPolicy(unknownProperty),
    /invalid Xiph verification policy/u,
  );

  const unsupportedArchitecture = structuredClone(policy);
  unsupportedArchitecture.matrix.architectures.push("ARM64");
  assert.throws(
    () => assertXiphVerificationPolicy(unsupportedArchitecture),
    /unsupported Xiph build matrix/u,
  );
});

test("Xiph archive-only legacy provenance is explicit and all-or-nothing", async () => {
  const lock = await lockFixture();
  const legacy = lock.pairs.find((pair) => pair.ogg_version === "1.0");
  assert.equal(legacy.sources.ogg.tag, null);
  assert.equal(legacy.sources.ogg.tag_object_sha, null);
  assert.equal(legacy.sources.ogg.commit_sha, null);

  legacy.sources.ogg.commit_sha = "0".repeat(40);
  assert.throws(() => assertXiphLock(lock), /invalid immutable ogg source pin/);

  const modern = await lockFixture();
  modern.pairs[0].sources.ogg.tag = null;
  modern.pairs[0].sources.ogg.tag_object_sha = null;
  modern.pairs[0].sources.ogg.commit_sha = null;
  assert.throws(() => assertXiphLock(modern), /invalid immutable ogg source pin/);
});

test("Xiph recipe is C17, topology-bound, hardened, and reproducible", async () => {
  const [cmake, buildMatrix, policy, workflow, pipelineSources] = await Promise.all([
    readFile(resolveRepoPath("scripts", "xiph", "CMakeLists.txt"), "utf8"),
    readFile(resolveRepoPath("scripts", "xiph", "build-matrix.psm1"), "utf8"),
    readFile(resolveRepoPath("scripts", "xiph", "verification-policy.json"), "utf8"),
    readFile(resolveRepoPath(".github", "workflows", "xiph-source-refresh.yml"), "utf8"),
    readXiphPipelineSources(),
  ]);

  assert.match(cmake, /project\(renderpilot_xiph_adapter LANGUAGES C RC\)/u);
  assert.match(cmake, /set\(CMAKE_C_STANDARD 17\)/u);
  assert.match(cmake, /renderpilot_generate_def\(OGG_DEF/u);
  assert.match(cmake, /VORBISFILE_DEF/u);
  assert.match(cmake, /VORBISENC_DEF/u);
  const coreVorbisSources = cmake.match(/set\(VORBIS_SOURCES[\s\S]*?\n\)/u)?.[0];
  assert.ok(coreVorbisSources, "core Vorbis source list must be explicit");
  assert.doesNotMatch(coreVorbisSources, /lib\/vorbisenc\.c/u);
  assert.equal(
    cmake.match(/"\$\{VORBIS_ROOT\}\/lib\/vorbisenc\.c"/gu)?.length,
    1,
    "vorbisenc.c must be compiled by one explicit object target",
  );
  assert.match(
    cmake,
    /add_library\(\s+vorbis_encoder_objects\s+OBJECT\s+"\$\{VORBIS_ROOT\}\/lib\/vorbisenc\.c"/u,
  );
  assert.equal(
    cmake.match(/\$<TARGET_OBJECTS:vorbis_encoder_objects>/gu)?.length,
    2,
    "the historical Windows ABI requires one encoder object in both public DLLs",
  );
  assert.match(cmake, /add_test\(NAME upstream_ogg_framing/u);
  const compilePolicy = cmake.match(
    /target_compile_options\(\s+renderpilot_compile_policy[\s\S]*?\n\)/u,
  )?.[0];
  assert.ok(compilePolicy, "the shared C compile policy must be explicit");
  const compileFlags = compilePolicy
    .match(/COMPILE_LANGUAGE:C>:([^">]+)>"/u)?.[1]
    .split(";");
  assert.deepEqual(compileFlags, [
    "/O2",
    "/GL",
    "/Gy",
    "/Gw",
    "/GS",
    "/guard:cf",
    "/Brepro",
  ]);
  assert.doesNotMatch(
    cmake,
    /CXX|C\+\+24|\/fp:fast|AVX2|PGO|Skipping.*framing|vorbis_msvc_x64_compat/u,
  );

  const parsedPolicy = assertXiphVerificationPolicy(JSON.parse(policy));
  assert.equal(parsedPolicy.schema_version, 2);
  assert.deepEqual(parsedPolicy.imports.shared.vorbis, {
    regular: ["ogg"],
    delay: [],
  });
  assert.deepEqual(parsedPolicy.required_security, {
    all: ["dynamic_base", "nx_compat", "guard_cf"],
    X86: [],
    X64: ["high_entropy_va"],
  });
  assert.deepEqual(parsedPolicy.publication.allowed_suffixes, [
    ".dll.zst",
    ".txt",
    ".json",
  ]);
  assert.deepEqual(parsedPolicy.publication.forbidden_suffixes, [
    ".pdb",
    ".tar",
    ".tar.bz2",
    ".tar.gz",
    ".tar.xz",
    ".zip",
  ]);
  assert.deepEqual(XIPH_BUILD_MATRIX.profiles, ["plain", "lib", "abi"]);
  assert.deepEqual(parsedPolicy.reproducibility, {
    build_count: 2,
    comparison: "raw_sha256",
  });
  assert.match(
    buildMatrix,
    /if \(\$reproductionIndex -eq 0\) \{[\s\S]*?-Path \$Context\.tools\.ctest/u,
  );
  assert.equal(
    buildMatrix.match(/-Path \$Context\.tools\.ctest/gu)?.length,
    1,
    "functional tests must run once before byte-for-byte DLL comparison",
  );
  assert.doesNotMatch(
    pipelineSources,
    /benchmark|GITHUB_STEP_SUMMARY/u,
    "hosted-runner performance measurements do not belong in the publication pipeline",
  );

  const buildJobStart = workflow.indexOf("  build:");
  const publishJobStart = workflow.indexOf("  publish-assets:");
  const openPrJobStart = workflow.indexOf("  open-pr:");
  assert.ok(
    buildJobStart >= 0 &&
      buildJobStart < publishJobStart &&
      publishJobStart < openPrJobStart,
    "build, asset publication, and PR creation must remain separate ordered jobs",
  );
  const buildJob = workflow.slice(buildJobStart, publishJobStart);
  const publishJob = workflow.slice(publishJobStart, openPrJobStart);
  const openPrJob = workflow.slice(openPrJobStart);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(buildJob, /permissions:\s+contents: read/u);
  assert.match(buildJob, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(buildJob, /persist-credentials: false/u);
  assert.match(buildJob, /::group::Xiph source pair \$pair/u);
  assert.match(buildJob, /::endgroup::/u);
  assert.doesNotMatch(buildJob, /R2_|contents: write|pull-requests: write/u);
  assert.match(publishJob, /permissions:\s+contents: read/u);
  assert.doesNotMatch(publishJob, /contents: write|pull-requests: write/u);
  assert.equal(publishJob.match(/R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/gu)?.length, 4);
  const verifyStep = publishJob.indexOf("Verify and stage untrusted bundles");
  const uploadStep = publishJob.indexOf("Upload and HEAD-verify manifest assets");
  const firstSecret = publishJob.indexOf("R2_ACCESS_KEY_ID");
  assert.ok(
    verifyStep >= 0 && verifyStep < uploadStep && uploadStep < firstSecret,
    "all uncredentialed bundle validation must precede the secret-bearing upload step",
  );
  assert.match(openPrJob, /contents: write\s+pull-requests: write/u);
  assert.match(openPrJob, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(
    openPrJob,
    /base: \$\{\{ github\.event\.repository\.default_branch \}\}/u,
    "detached-HEAD PR creation must name its target branch explicitly",
  );
  assert.doesNotMatch(openPrJob, /R2_/u);
  assert.equal(workflow.match(/runs-on: windows-2025-vs2026/gu)?.length, 3);
});

async function readXiphPipelineSources() {
  const scriptsDirectory = resolveRepoPath("scripts");
  const libraryDirectory = resolveRepoPath("scripts", "lib");
  const [xiphFiles, topLevelEntries, libraryEntries] = await Promise.all([
    listFilesRecursively(resolveRepoPath("scripts", "xiph")),
    readdir(scriptsDirectory, { withFileTypes: true }),
    readdir(libraryDirectory, { withFileTypes: true }),
  ]);
  const pipelineFiles = [
    ...xiphFiles,
    ...topLevelEntries
      .filter((entry) => entry.isFile() && entry.name.includes("xiph"))
      .map((entry) => path.join(scriptsDirectory, entry.name)),
    ...libraryEntries
      .filter((entry) => entry.isFile() && entry.name.startsWith("xiph-"))
      .map((entry) => path.join(libraryDirectory, entry.name)),
    resolveRepoPath(".github", "workflows", "xiph-source-refresh.yml"),
  ];
  return Promise.all(pipelineFiles.map((file) => readFile(file, "utf8"))).then((contents) =>
    contents.join("\n"),
  );
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}
