import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256Hex } from "./hash.mjs";
import { fetchWithTimeout } from "./http.mjs";
import {
  canonicalPeVersion,
  inspectPeFiles,
  persistCompressedDll,
} from "./library-artifact-io.mjs";
import { assertPeNamedExports } from "./library-catalog.mjs";
import {
  assertOpenVrLockBackfillsTimestamps,
  assertOpenVrLockExtendsBaseline,
  assertSignaturePolicy,
  gitBlobSha1,
  sortOpenVrLock,
} from "./openvr-github.mjs";

const MAX_DLL_SIZE = 16 * 1024 * 1024;

export async function constructOpenVrRelease(
  release,
  config,
  expectedRelease = null,
  { allowTimestampBackfill = false, fetchFn = fetch } = {},
) {
  const temporary = await mkdtemp(path.join(tmpdir(), "renderpilot-openvr-"));
  try {
    const units = await Promise.all(
      config.architectures.map(async (architecture) => {
        const bytes = await downloadDll(
          config.repository,
          release.commitSha,
          architecture.repository_path,
          fetchFn,
        );
        const file = path.join(
          temporary,
          `${architecture.catalog_architecture.toLowerCase()}-openvr_api.dll`,
        );
        await writeFile(file, bytes);
        return { architecture, bytes, file };
      }),
    );
    const inspections = await inspectPeFiles(
      units.map((unit) => unit.file),
      { signaturePolicy: "OpenVr" },
    );
    const artifacts = [];
    for (const [index, unit] of units.entries()) {
      const inspection = inspections[index];
      const architecture = unit.architecture.catalog_architecture;
      if (inspection.architecture !== architecture) {
        throw new Error(
          `${release.tag}/${architecture}: PE architecture is ${inspection.architecture}`,
        );
      }
      assertPeNamedExports(
        inspection.pe_named_exports,
        `${release.tag}/${architecture}: exports`,
      );
      const expectedArtifact = expectedRelease?.artifacts.find(
        (artifact) => artifact.architecture === architecture,
      );
      if (expectedRelease && !expectedArtifact) {
        throw new Error(`${release.tag}/${architecture}: locked artifact is missing`);
      }
      const observed = {
        architecture,
        repository_path: unit.architecture.repository_path,
        git_blob_sha1: gitBlobSha1(unit.bytes),
        pe_version: canonicalPeVersion(inspection.pe_version, { allowNull: true }),
        pe_named_exports: inspection.pe_named_exports,
        dll_sha256: sha256Hex(unit.bytes),
        dll_size_bytes: unit.bytes.length,
        signature: inspection.signature,
      };
      assertSignaturePolicy(
        observed.signature,
        release.publishedAt,
        config,
        `${release.tag}/${architecture}`,
      );
      if (expectedArtifact) {
        const lockedIdentity = structuredClone(expectedArtifact);
        delete lockedIdentity.r2;
        const comparableObserved = structuredClone(observed);
        if (
          allowTimestampBackfill &&
          lockedIdentity.signature?.status === "signed" &&
          lockedIdentity.signature.signed_at === null &&
          typeof comparableObserved.signature?.signed_at === "string"
        ) {
          comparableObserved.signature.signed_at = null;
        }
        if (!isDeepStrictEqual(comparableObserved, lockedIdentity)) {
          throw new Error(
            `${release.tag}/${architecture}: immutable locked DLL metadata changed`,
          );
        }
      }
      const r2 = await persistCompressedDll(unit.bytes, {
        compressionLevel: expectedArtifact?.r2.compression_level ?? 12,
      });
      artifacts.push({ ...observed, r2 });
    }

    const imported = {
      release_id: release.releaseId,
      tag: release.tag,
      version: release.version,
      label: release.label,
      published_at: release.publishedAt,
      commit_sha: release.commitSha,
      artifacts,
    };
    sortOpenVrLock({ releases: [imported] });
    if (expectedRelease) {
      const current = { releases: [imported] };
      const baseline = { releases: [expectedRelease] };
      if (allowTimestampBackfill) {
        assertOpenVrLockBackfillsTimestamps(current, baseline);
      } else {
        assertOpenVrLockExtendsBaseline(current, baseline);
      }
    }
    return imported;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function downloadDll(repository, commitSha, repositoryPath, fetchFn) {
  const url = `https://raw.githubusercontent.com/${repository}/${commitSha}/${repositoryPath}`;
  const response = await fetchWithTimeout(url, {
    fetchFn,
    timeoutMs: 120_000,
  });
  if (!response.ok) {
    throw new Error(`OpenVR DLL download failed (${response.status}) for ${url}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_DLL_SIZE) {
    throw new Error(`OpenVR DLL exceeds ${MAX_DLL_SIZE} bytes: ${repositoryPath}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_DLL_SIZE) {
    throw new Error(`OpenVR DLL size is invalid: ${repositoryPath}`);
  }
  return bytes;
}
