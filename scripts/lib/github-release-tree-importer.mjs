import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256Hex } from "./hash.mjs";
import { fetchWithTimeout, readResponseBufferBounded } from "./http.mjs";
import {
  canonicalAuthenticodeSignature,
  canonicalPeVersion,
  inspectPeFiles,
  persistCompressedDll,
  persistLegalDocument,
  reconcileLockedAuthenticodeSignature,
} from "./library-artifact-io.mjs";
import { MAX_LEGAL_DOCUMENT_SIZE, assertPeNamedExports } from "./library-catalog.mjs";
import {
  assertGitHubSignaturePolicy,
  fetchCommitTree,
  gitBlobSha1,
  sortGitHubReleaseTreeLock,
} from "./github-release-tree.mjs";
import { githubReleaseTreeProfile } from "./github-release-tree-profiles.mjs";

export async function constructGitHubReleaseTreeRelease(
  release,
  config,
  expectedRelease = null,
  { allowTimestampBackfill = false, migrateTransport = false, fetchFn = fetch } = {},
) {
  const profile = githubReleaseTreeProfile(config.profile);
  const plan = profile.releasePlan(release);
  const identity = {
    release_id: release.releaseId,
    tag: release.tag,
    version: release.version,
    label: release.label,
    published_at: release.publishedAt,
    tag_ref_sha: release.tagRefSha,
    commit_sha: release.commitSha,
    disposition: plan.disposition,
  };
  if (plan.disposition === "excluded") {
    const excluded = { ...identity, exclusion_reason: plan.exclusionReason };
    assertExpectedRelease(excluded, expectedRelease, { allowTimestampBackfill });
    return excluded;
  }

  const tree = await fetchCommitTree(config, release.commitSha, { fetchFn });
  assertPlannedPaths(tree, [...plan.artifacts, ...plan.legalDocuments], release.tag);
  const temporary = await mkdtemp(path.join(tmpdir(), `renderpilot-${profile.vendor.id}-`));
  try {
    const units = await Promise.all(
      plan.artifacts.map(async (definition, index) => {
        const bytes = await downloadRepositoryFile(
          config.repository,
          release.commitSha,
          definition.repository_path,
          profile.maxDllSize,
          fetchFn,
        );
        assertGitBlobIdentity(
          bytes,
          tree.get(definition.repository_path),
          `${release.tag}/${definition.repository_path}`,
        );
        const file = path.join(temporary, `${index}-${definition.component}.dll`);
        await writeFile(file, bytes);
        return { definition, bytes, file };
      }),
    );
    const inspections = await inspectPeFiles(
      units.map((unit) => unit.file),
      { authenticodeMode: profile.authenticodeMode },
    );
    const artifacts = [];
    for (const [index, unit] of units.entries()) {
      const inspection = inspections[index];
      const definition = unit.definition;
      const context = `${release.tag}/${definition.repository_path}`;
      if (inspection.architecture !== definition.architecture) {
        throw new Error(
          `${context}: PE architecture is ${inspection.architecture}, expected ${definition.architecture}`,
        );
      }
      if (!Array.isArray(inspection.pe_named_exports)) {
        throw new Error(`${context}: PE inspector did not return named exports`);
      }
      if (inspection.pe_named_exports.length > 0) {
        assertPeNamedExports(inspection.pe_named_exports, `${context}: exports`);
      }
      if (profile.publishExports && inspection.pe_named_exports.length === 0) {
        throw new Error(`${context}: OpenVR export surface is empty`);
      }
      let signature = canonicalAuthenticodeSignature(inspection.signature);
      assertGitHubSignaturePolicy(signature, release.publishedAt, config, context);
      const expectedArtifact = expectedRelease?.artifacts?.find(
        (artifact) => artifact.repository_path === definition.repository_path,
      );
      if (expectedRelease?.disposition === "imported" && !expectedArtifact) {
        throw new Error(`${context}: locked artifact is missing`);
      }
      if (expectedArtifact) {
        signature = reconcileLockedAuthenticodeSignature(
          signature,
          expectedArtifact.signature,
          {
            allowTimestampBackfill,
            context,
          },
        );
      }
      const observed = {
        component: definition.component,
        architecture: definition.architecture,
        repository_path: definition.repository_path,
        git_blob_sha1: gitBlobSha1(unit.bytes),
        pe_version: canonicalPeVersion(inspection.pe_version, { allowNull: true }),
        pe_named_exports: inspection.pe_named_exports,
        dll_sha256: sha256Hex(unit.bytes),
        dll_size_bytes: unit.bytes.length,
        signature,
      };
      assertExpectedArtifact(observed, expectedArtifact, {
        allowTimestampBackfill,
        context,
      });
      const r2 = await persistCompressedDll(unit.bytes, {
        compressionLevel: expectedArtifact?.r2.compression_level ?? 12,
        expectedTransport:
          expectedArtifact && !migrateTransport ? expectedArtifact.r2 : null,
      });
      artifacts.push({ ...observed, r2 });
    }

    const legalDocuments = await Promise.all(
      plan.legalDocuments.map(async (definition) => {
        const context = `${release.tag}/${definition.repository_path}`;
        const bytes = await downloadRepositoryFile(
          config.repository,
          release.commitSha,
          definition.repository_path,
          MAX_LEGAL_DOCUMENT_SIZE,
          fetchFn,
        );
        assertGitBlobIdentity(bytes, tree.get(definition.repository_path), context);
        const persisted = await persistLegalDocument(bytes, definition.format);
        const observed = {
          ...definition,
          git_blob_sha1: gitBlobSha1(bytes),
          sha256: persisted.sha256,
          size_bytes: persisted.size_bytes,
          object_key: persisted.object_key,
        };
        const expectedDocument = expectedRelease?.legal_documents?.find(
          (document) => document.repository_path === definition.repository_path,
        );
        if (expectedRelease?.disposition === "imported" && !expectedDocument) {
          throw new Error(`${context}: locked legal document is missing`);
        }
        if (expectedDocument && !isDeepStrictEqual(observed, expectedDocument)) {
          throw new Error(`${context}: immutable locked legal document changed`);
        }
        return observed;
      }),
    );
    const imported = {
      ...identity,
      artifacts,
      legal_documents: legalDocuments,
    };
    sortGitHubReleaseTreeLock({ releases: [imported] });
    assertExpectedRelease(imported, expectedRelease, { allowTimestampBackfill });
    return imported;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertPlannedPaths(tree, definitions, tag) {
  const seen = new Set();
  for (const definition of definitions) {
    const repositoryPath = definition.repository_path;
    if (seen.has(repositoryPath)) {
      throw new Error(`${tag}: duplicate planned repository path ${repositoryPath}`);
    }
    seen.add(repositoryPath);
    if (!tree.has(repositoryPath)) {
      throw new Error(`${tag}: required commit-tree path is missing: ${repositoryPath}`);
    }
  }
}

function assertGitBlobIdentity(bytes, expectedSha, context) {
  const actual = gitBlobSha1(bytes);
  if (actual !== expectedSha) {
    throw new Error(
      `${context}: raw payload Git blob identity changed (expected ${expectedSha}, got ${actual})`,
    );
  }
}

function assertExpectedArtifact(observed, expected, { allowTimestampBackfill, context }) {
  if (!expected) return;
  const locked = structuredClone(expected);
  delete locked.r2;
  const comparable = structuredClone(observed);
  if (
    allowTimestampBackfill &&
    locked.signature?.status === "signed" &&
    locked.signature.signed_at === null &&
    typeof comparable.signature?.signed_at === "string"
  ) {
    comparable.signature.signed_at = null;
  }
  if (!isDeepStrictEqual(comparable, locked)) {
    throw new Error(`${context}: immutable locked DLL metadata changed`);
  }
}

function assertExpectedRelease(observed, expected, { allowTimestampBackfill }) {
  if (!expected) return;
  const comparable = structuredClone(observed);
  const locked = structuredClone(expected);
  for (const release of [comparable, locked]) {
    for (const artifact of release.artifacts ?? []) delete artifact.r2;
  }
  if (allowTimestampBackfill) {
    for (const artifact of comparable.artifacts ?? []) {
      const previous = locked.artifacts?.find(
        (candidate) => candidate.repository_path === artifact.repository_path,
      );
      if (
        previous?.signature?.status === "signed" &&
        previous.signature.signed_at === null &&
        typeof artifact.signature?.signed_at === "string"
      ) {
        artifact.signature.signed_at = null;
      }
    }
  }
  if (!isDeepStrictEqual(comparable, locked)) {
    throw new Error(`${observed.tag}: immutable locked release content changed`);
  }
}

async function downloadRepositoryFile(
  repository,
  commitSha,
  repositoryPath,
  maximumSize,
  fetchFn,
) {
  const encodedPath = repositoryPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://raw.githubusercontent.com/${repository}/${commitSha}/${encodedPath}`;
  const response = await fetchWithTimeout(url, {
    fetchFn,
    timeoutMs: 120_000,
  });
  if (!response.ok) {
    throw new Error(`repository file download failed (${response.status}) for ${url}`);
  }
  const bytes = await readResponseBufferBounded(response, {
    maximumSize,
    context: repositoryPath,
  });
  if (bytes.length === 0) {
    throw new Error(`${repositoryPath}: payload size is invalid`);
  }
  return bytes;
}
