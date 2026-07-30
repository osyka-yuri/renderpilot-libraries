import { isDeepStrictEqual } from "node:util";

import { blobObjectKey } from "./library-catalog.mjs";
import { dottedNumericVersionParts, normalizeRfc3339Timestamp } from "./library-values.mjs";
import {
  XIPH_SOURCE_IDS,
  expectedXiphArtifactKeys,
  isXiphIntegrationRunner,
  isXiphPublishableRunner,
} from "./xiph-matrix.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const COMPONENTS = XIPH_SOURCE_IDS;

export function assertXiphLock(lock, { runnerContext = "publication" } = {}) {
  const isAllowedRunner =
    runnerContext === "publication"
      ? isXiphPublishableRunner
      : runnerContext === "integration"
        ? (value) => isXiphPublishableRunner(value) || isXiphIntegrationRunner(value)
        : null;
  if (isAllowedRunner === null) {
    throw new Error(`unsupported Xiph runner context ${JSON.stringify(runnerContext)}`);
  }
  if (lock?.schema_version !== 1 || !Array.isArray(lock.pairs) || lock.pairs.length === 0) {
    throw new Error("Xiph lock must contain append-only source pairs");
  }
  const tuples = new Set();
  const immutableArtifactsByDllSha = new Map();
  for (const pair of lock.pairs) {
    const tuple = `${pair.vorbis_version}|${pair.ogg_version}`;
    try {
      dottedNumericVersionParts(pair.vorbis_version, `${tuple}: Vorbis version`);
      dottedNumericVersionParts(pair.ogg_version, `${tuple}: Ogg version`);
    } catch (error) {
      throw new Error(`${tuple}: invalid source versions`, { cause: error });
    }
    if (tuples.has(tuple)) throw new Error(`duplicate historical Xiph tuple ${tuple}`);
    tuples.add(tuple);
    if (!Number.isSafeInteger(pair.build_revision) || pair.build_revision < 1) {
      throw new Error(`${tuple}: invalid build_revision`);
    }
    if (!Array.isArray(pair.builds)) throw new Error(`${tuple}: builds must be an array`);
    if (Object.keys(pair.sources ?? {}).join(",") !== COMPONENTS.join(",")) {
      throw new Error(`${tuple}: sources must contain exactly sorted ogg and vorbis pins`);
    }
    for (const name of COMPONENTS) {
      const source = pair.sources[name];
      const expectedVersion = name === "ogg" ? pair.ogg_version : pair.vorbis_version;
      const expectedTag =
        name === "vorbis" && expectedVersion === "1.0" ? "v1.0.0" : `v${expectedVersion}`;
      const hasTaggedGitPin =
        source.tag === expectedTag &&
        SHA1.test(source.tag_object_sha) &&
        SHA1.test(source.commit_sha);
      const hasArchiveOnlyPin =
        name === "ogg" &&
        ["1.0", "1.1"].includes(expectedVersion) &&
        source.tag === null &&
        source.tag_object_sha === null &&
        source.commit_sha === null;
      if (
        source.repository !== `xiph/${name}` ||
        (!hasTaggedGitPin && !hasArchiveOnlyPin) ||
        !SHA256.test(source.archive_sha256) ||
        !new RegExp(
          `^https://downloads\\.xiph\\.org/releases/${name}/lib${name}-` +
            `${expectedVersion.replaceAll(".", "\\.")}\\.tar\\.(?:xz|bz2|gz)$`,
          "u",
        ).test(source.archive_url)
      ) {
        throw new Error(`${tuple}: invalid immutable ${name} source pin`);
      }
    }
    const revisions = pair.builds.map((build) => build.build_revision);
    if (
      new Set(revisions).size !== revisions.length ||
      revisions.some((revision, index) => revision !== index + 1) ||
      revisions.some((revision) => revision > pair.build_revision)
    ) {
      throw new Error(`${tuple}: build revisions must be unique contiguous history`);
    }
    for (const build of pair.builds) {
      const toolchain = build.toolchain;
      if (
        !isCanonicalTimestamp(build.generated_at) ||
        !SHA256.test(build.recipe_sha256) ||
        !SHA256.test(build.verification_policy_sha256) ||
        !toolchain ||
        !isAllowedRunner(toolchain.runner_image) ||
        ["compiler", "linker", "windows_sdk", "cmake"].some(
          (field) => typeof toolchain[field] !== "string" || !toolchain[field].trim(),
        ) ||
        !Array.isArray(build.artifacts)
      ) {
        throw new Error(`${tuple}/r${build.build_revision}: incomplete build receipt`);
      }
      assertPatchReceipts(build.patches, `${tuple}/r${build.build_revision}`);
      const keys = new Set();
      for (const artifact of build.artifacts) {
        const transport = artifact.transport;
        if (
          typeof artifact.artifact_key !== "string" ||
          keys.has(artifact.artifact_key) ||
          !SHA256.test(artifact.dll_sha256) ||
          !Number.isSafeInteger(artifact.dll_size_bytes) ||
          artifact.dll_size_bytes <= 0 ||
          !SHA256.test(transport?.zst_sha256) ||
          transport.object_key !== blobObjectKey(transport.zst_sha256) ||
          !Number.isSafeInteger(transport.zst_size_bytes) ||
          transport.zst_size_bytes <= 0 ||
          !Number.isSafeInteger(transport.compression_level) ||
          transport.compression_level < 1 ||
          transport.compression_level > 22
        ) {
          throw new Error(
            `${tuple}/r${build.build_revision}: invalid content-addressed build artifact`,
          );
        }
        keys.add(artifact.artifact_key);
        const immutableIdentity = {
          dll_size_bytes: artifact.dll_size_bytes,
          transport: artifact.transport,
        };
        const existingIdentity = immutableArtifactsByDllSha.get(artifact.dll_sha256);
        if (
          existingIdentity !== undefined &&
          !isDeepStrictEqual(existingIdentity, immutableIdentity)
        ) {
          throw new Error(
            `${tuple}/r${build.build_revision}: conflicting immutable transport ` +
              `for DLL ${artifact.dll_sha256}`,
          );
        }
        immutableArtifactsByDllSha.set(artifact.dll_sha256, immutableIdentity);
      }
      const expectedKeys = expectedXiphArtifactKeys(pair, build.build_revision);
      const observedKeys = [...keys].sort();
      if (
        observedKeys.length !== expectedKeys.length ||
        observedKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        throw new Error(
          `${tuple}/r${build.build_revision}: build receipt does not match the Xiph matrix`,
        );
      }
    }
  }
  return lock;
}

function isCanonicalTimestamp(value) {
  try {
    return normalizeRfc3339Timestamp(value) === value;
  } catch {
    return false;
  }
}

function assertPatchReceipts(patches, context) {
  if (
    patches === null ||
    typeof patches !== "object" ||
    Array.isArray(patches) ||
    Object.keys(patches).some((patchId) => !/^[a-z0-9][a-z0-9._-]*$/u.test(patchId))
  ) {
    throw new Error(`${context}: invalid source patch receipts`);
  }
  for (const [patchId, patch] of Object.entries(patches)) {
    if (
      !COMPONENTS.includes(patch?.source) ||
      typeof patch.target !== "string" ||
      patch.target.length === 0 ||
      patch.target.includes("\\") ||
      patch.target.startsWith("/") ||
      /^[A-Za-z]:/u.test(patch.target) ||
      patch.target.split("/").some((segment) => ["", ".", ".."].includes(segment)) ||
      !SHA256.test(patch.descriptor_sha256) ||
      !SHA256.test(patch.original_sha256) ||
      !SHA256.test(patch.patched_sha256) ||
      patch.original_sha256 === patch.patched_sha256
    ) {
      throw new Error(`${context}: invalid source patch receipt ${patchId}`);
    }
  }
}

export function assertXiphLockExtendsBaseline(baseline, current) {
  assertXiphLock(baseline);
  assertXiphLock(current);
  if (current.pairs.length < baseline.pairs.length) {
    throw new Error("Xiph lock removed historical source pairs");
  }

  for (const [index, oldPair] of baseline.pairs.entries()) {
    const nextPair = current.pairs[index];
    const oldIdentity = { ...oldPair, build_revision: undefined, builds: undefined };
    const nextIdentity = { ...nextPair, build_revision: undefined, builds: undefined };
    if (canonical(oldIdentity) !== canonical(nextIdentity)) {
      throw new Error(`Xiph lock rewrote historical pair at index ${index}`);
    }
    if (
      nextPair.build_revision < oldPair.build_revision ||
      nextPair.build_revision > oldPair.build_revision + 1
    ) {
      throw new Error("Xiph build revision may only remain stable or increment by one");
    }
    const oldBuilds = oldPair.builds.map(canonical);
    const nextBuilds = nextPair.builds.map(canonical);
    if (oldBuilds.some((build, buildIndex) => nextBuilds[buildIndex] !== build)) {
      throw new Error("Xiph lock rewrote historical build receipts");
    }
  }
  return current;
}

function canonical(value) {
  return JSON.stringify(value, (_key, item) => (item === undefined ? undefined : item));
}
