import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { getNextUrlFromLinkHeader, githubHeaders } from "./github.mjs";
import { fetchWithTimeout } from "./http.mjs";
import {
  assertNumericVersion,
  assertPeNamedExports,
  assertVendorSource,
  blobObjectKey,
  compareNumericVersions,
} from "./library-catalog.mjs";

const REPOSITORY = "ValveSoftware/openvr";
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const KNOWN_REVISION_B_TAGS = new Set(["v1.1.3b", "v1.6.10b"]);
const ARCHITECTURES = new Map([
  ["X64", "bin/win64/openvr_api.dll"],
  ["X86", "bin/win32/openvr_api.dll"],
]);
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RFC3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SIGNED_SIGNATURE_KEYS = new Set(["status", "subject", "thumbprint", "signed_at"]);

export function parseOpenVrTag(tag) {
  if (typeof tag !== "string") throw new Error("OpenVR release tag is missing");
  const match = /^v?(\d+(?:\.\d+)+)(b)?$/u.exec(tag);
  if (!match) throw new Error(`unsupported stable OpenVR tag ${tag}`);
  if (match[2] && !KNOWN_REVISION_B_TAGS.has(tag)) {
    throw new Error(`unreviewed OpenVR revision tag ${tag}`);
  }
  assertNumericVersion(match[1], `${tag}: release version`);
  return {
    version: match[1],
    label: match[2] ? "revision b" : null,
  };
}

export async function listedStableOpenVrReleases(
  config,
  { fetchFn = fetch, tagCommits } = {},
) {
  assertOpenVrConfig(config);
  if (!(tagCommits instanceof Map)) {
    throw new Error("OpenVR release discovery requires resolved tag commits");
  }
  const releases = [];
  let nextUrl = RELEASES_API;
  const visitedPages = new Set();
  while (nextUrl) {
    if (visitedPages.has(nextUrl)) {
      throw new Error(`GitHub releases pagination cycle at ${nextUrl}`);
    }
    visitedPages.add(nextUrl);
    const response = await fetchWithTimeout(nextUrl, {
      fetchFn,
      timeoutMs: 30_000,
      headers: githubHeaders(),
    });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed (${response.status}) for ${nextUrl}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error("GitHub releases response must be an array");
    }
    for (const release of page) {
      if (release?.draft || release?.prerelease) continue;
      const parsed = parseOpenVrTag(release?.tag_name);
      const commitSha = tagCommits.get(release.tag_name);
      if (!commitSha || !SHA1_PATTERN.test(commitSha)) {
        throw new Error(`${release.tag_name}: resolved tag commit is missing`);
      }
      if (!Number.isSafeInteger(release.id) || release.id <= 0) {
        throw new Error(`${release.tag_name}: GitHub release id is invalid`);
      }
      const publishedAt = normalizedTimestamp(
        release.published_at,
        `${release.tag_name}: published_at`,
      );
      releases.push({
        releaseId: release.id,
        tag: release.tag_name,
        version: parsed.version,
        label: parsed.label,
        publishedAt,
        commitSha,
      });
    }
    const linked = getNextUrlFromLinkHeader(response.headers.get("link"));
    nextUrl = linked === null ? null : validatedReleasesPageUrl(linked);
  }
  const tags = new Set();
  const ids = new Set();
  for (const release of releases) {
    if (tags.has(release.tag))
      throw new Error(`duplicate OpenVR release tag ${release.tag}`);
    if (ids.has(release.releaseId)) {
      throw new Error(`duplicate OpenVR release id ${release.releaseId}`);
    }
    tags.add(release.tag);
    ids.add(release.releaseId);
  }
  releases.sort(compareOpenVrReleases);
  if (releases.length < config.expected_stable_releases) {
    throw new Error(
      `expected at least ${config.expected_stable_releases} stable OpenVR releases, got ${releases.length}`,
    );
  }
  return releases;
}

function validatedReleasesPageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid GitHub releases pagination URL ${value}`);
  }
  const allowedParameters = new Set(["page", "per_page"]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/repos/${REPOSITORY}/releases` ||
    [...url.searchParams.keys()].some((key) => !allowedParameters.has(key)) ||
    url.searchParams.get("per_page") !== "100" ||
    (url.searchParams.has("page") &&
      !/^[1-9]\d*$/u.test(url.searchParams.get("page") ?? ""))
  ) {
    throw new Error(`untrusted GitHub releases pagination URL ${value}`);
  }
  return url.toString();
}

export function parseRemoteTagCommits(output) {
  if (typeof output !== "string") throw new Error("git ls-remote output is invalid");
  const direct = new Map();
  const peeled = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/u.exec(line);
    if (!match) throw new Error(`unexpected git ls-remote line ${line}`);
    const [, sha, tag, isPeeled] = match;
    (isPeeled ? peeled : direct).set(tag, sha);
  }
  const commits = new Map();
  for (const [tag, sha] of direct) commits.set(tag, peeled.get(tag) ?? sha);
  return commits;
}

export function gitBlobSha1(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Git blob payload must be a Buffer");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

export function assertOpenVrConfig(config) {
  if (
    config?.schema_version !== 1 ||
    config.repository !== REPOSITORY ||
    !Number.isSafeInteger(config.expected_stable_releases) ||
    config.expected_stable_releases <= 0
  ) {
    throw new Error("OpenVR GitHub config is invalid");
  }
  normalizedTimestamp(
    config.require_signed_release_at_or_after,
    "OpenVR signature policy timestamp",
  );
  if (!Array.isArray(config.architectures) || config.architectures.length !== 2) {
    throw new Error("OpenVR config must declare X64 and X86");
  }
  const seen = new Set();
  for (const architecture of config.architectures) {
    const expectedPath = ARCHITECTURES.get(architecture?.catalog_architecture);
    if (!expectedPath || architecture.repository_path !== expectedPath) {
      throw new Error("OpenVR architecture/path mapping is invalid");
    }
    if (seen.has(architecture.catalog_architecture)) {
      throw new Error(`duplicate OpenVR architecture ${architecture.catalog_architecture}`);
    }
    seen.add(architecture.catalog_architecture);
  }
}

export function assertOpenVrLockSemantics(lock, config) {
  assertOpenVrConfig(config);
  if (lock?.schema_version !== 1 || !Array.isArray(lock.releases)) {
    throw new Error("OpenVR GitHub lock is invalid");
  }
  const tags = new Set();
  const releaseIds = new Set();
  for (const release of lock.releases) {
    const context = `OpenVR ${release?.tag ?? "<unknown>"}`;
    const parsed = parseOpenVrTag(release?.tag);
    if (
      !Number.isSafeInteger(release.release_id) ||
      release.release_id <= 0 ||
      release.version !== parsed.version ||
      release.label !== parsed.label ||
      !SHA1_PATTERN.test(release.commit_sha ?? "")
    ) {
      throw new Error(`${context}: release identity is invalid`);
    }
    normalizedTimestamp(release.published_at, `${context}: published_at`);
    if (tags.has(release.tag) || releaseIds.has(release.release_id)) {
      throw new Error(`${context}: duplicate release identity`);
    }
    tags.add(release.tag);
    releaseIds.add(release.release_id);
    if (!Array.isArray(release.artifacts) || release.artifacts.length !== 2) {
      throw new Error(`${context}: X64 and X86 artifacts are required`);
    }
    const architectures = new Set();
    for (const artifact of release.artifacts) {
      assertOpenVrArtifact(artifact, release, config);
      if (architectures.has(artifact.architecture)) {
        throw new Error(`${context}: duplicate ${artifact.architecture}`);
      }
      architectures.add(artifact.architecture);
    }
  }
  const sorted = structuredClone(lock);
  sortOpenVrLock(sorted);
  if (!isDeepStrictEqual(sorted, lock)) {
    throw new Error("OpenVR lock must be deterministically sorted");
  }
}

function assertOpenVrArtifact(artifact, release, config) {
  const context = `OpenVR ${release.tag}/${artifact?.architecture ?? "<unknown>"}`;
  const expectedPath = ARCHITECTURES.get(artifact?.architecture);
  if (
    !expectedPath ||
    artifact.repository_path !== expectedPath ||
    !SHA1_PATTERN.test(artifact.git_blob_sha1 ?? "") ||
    !SHA256_PATTERN.test(artifact.dll_sha256 ?? "") ||
    !Number.isSafeInteger(artifact.dll_size_bytes) ||
    artifact.dll_size_bytes <= 0
  ) {
    throw new Error(`${context}: artifact identity is invalid`);
  }
  if (artifact.pe_version !== null) {
    assertNumericVersion(artifact.pe_version, `${context}: PE version`);
  }
  assertPeNamedExports(artifact.pe_named_exports, `${context}: exports`);
  assertSignaturePolicy(artifact.signature, release.published_at, config, context);
  if (
    artifact.r2?.object_key !== blobObjectKey(artifact.r2?.zst_sha256) ||
    !Number.isSafeInteger(artifact.r2?.zst_size_bytes) ||
    artifact.r2.zst_size_bytes <= 0 ||
    !Number.isSafeInteger(artifact.r2?.compression_level) ||
    artifact.r2.compression_level < 1 ||
    artifact.r2.compression_level > 22
  ) {
    throw new Error(`${context}: R2 transport is invalid`);
  }
}

export function assertSignaturePolicy(signature, publishedAt, config, context) {
  if (signature?.status === "signed") {
    const keys = Object.keys(signature);
    if (
      keys.length !== 4 ||
      !keys.every((key) => SIGNED_SIGNATURE_KEYS.has(key)) ||
      typeof signature.subject !== "string" ||
      !signature.subject.trim() ||
      typeof signature.thumbprint !== "string" ||
      !/^[A-F0-9]{40,64}$/u.test(signature.thumbprint) ||
      (signature.signed_at !== null &&
        normalizedTimestamp(signature.signed_at, `${context}: signed_at`) === null)
    ) {
      throw new Error(`${context}: signed Authenticode metadata is invalid`);
    }
    return;
  }
  if (signature?.status !== "unsigned" || Object.keys(signature).length !== 1) {
    throw new Error(`${context}: Authenticode status is invalid`);
  }
  if (
    new Date(publishedAt).valueOf() >=
    new Date(config.require_signed_release_at_or_after).valueOf()
  ) {
    throw new Error(`${context}: unsigned release violates the signature cutoff`);
  }
}

export function assertOpenVrLockExtendsBaseline(lock, baseline) {
  const current = new Map(lock.releases.map((release) => [release.tag, release]));
  for (const previous of baseline.releases) {
    const next = current.get(previous.tag);
    if (!next) throw new Error(`${previous.tag}: locked OpenVR release was removed`);
    if (!isDeepStrictEqual(withoutTransport(next), withoutTransport(previous))) {
      throw new Error(`${previous.tag}: immutable OpenVR release content changed`);
    }
  }
}

export function assertOpenVrLockBackfillsTimestamps(lock, baseline) {
  if (lock.releases.length !== baseline.releases.length) {
    throw new Error("OpenVR timestamp backfill cannot add or remove releases");
  }
  const normalized = structuredClone(lock);
  const previousByTag = new Map(baseline.releases.map((release) => [release.tag, release]));
  let backfilled = 0;
  for (const release of normalized.releases) {
    const previous = previousByTag.get(release.tag);
    if (!previous) {
      throw new Error(`${release.tag}: OpenVR timestamp backfill added a release`);
    }
    const previousByArchitecture = new Map(
      previous.artifacts.map((artifact) => [artifact.architecture, artifact]),
    );
    for (const artifact of release.artifacts) {
      const previousArtifact = previousByArchitecture.get(artifact.architecture);
      if (
        previousArtifact?.signature?.status === "signed" &&
        previousArtifact.signature.signed_at === null &&
        artifact.signature?.status === "signed" &&
        typeof artifact.signature.signed_at === "string"
      ) {
        normalizedTimestamp(
          artifact.signature.signed_at,
          `${release.tag}/${artifact.architecture}: backfilled signed_at`,
        );
        artifact.signature.signed_at = null;
        backfilled += 1;
      }
    }
  }
  if (!isDeepStrictEqual(normalized, baseline)) {
    throw new Error(
      "OpenVR timestamp backfill changed data other than null signed_at fields",
    );
  }
  return backfilled;
}

function withoutTransport(release) {
  const value = structuredClone(release);
  for (const artifact of value.artifacts ?? []) delete artifact.r2;
  return value;
}

export function sortOpenVrLock(lock) {
  lock.releases.sort(compareOpenVrReleases);
  for (const release of lock.releases) {
    release.artifacts.sort((left, right) =>
      left.architecture.localeCompare(right.architecture),
    );
  }
  return lock;
}

function compareOpenVrReleases(left, right) {
  return (
    compareNumericVersions(
      left.version ?? left.package_version,
      right.version ?? right.package_version,
    ) || String(left.tag).localeCompare(String(right.tag))
  );
}

export function buildOpenVrVendorSource(lock, config) {
  assertOpenVrLockSemantics(lock, config);
  const artifacts = new Map();
  const packages = [];
  for (const release of lock.releases) {
    for (const artifact of release.artifacts) {
      const artifactKey = `openvr_api.${artifact.dll_sha256}`;
      const value = {
        artifact_key: artifactKey,
        library_id: "openvr_api",
        file_name: "openvr_api.dll",
        file_version: artifact.pe_version,
        architecture: artifact.architecture,
        pe_named_exports: artifact.pe_named_exports,
        dll: {
          sha256: artifact.dll_sha256,
          size_bytes: artifact.dll_size_bytes,
        },
        transport: {
          sha256: artifact.r2.zst_sha256,
          size_bytes: artifact.r2.zst_size_bytes,
        },
        signature: artifact.signature,
      };
      const previous = artifacts.get(artifact.dll_sha256);
      if (previous && !isDeepStrictEqual(previous, value)) {
        throw new Error(
          `${release.tag}/${artifact.architecture}: duplicate DLL has inconsistent metadata`,
        );
      }
      artifacts.set(artifact.dll_sha256, value);
      packages.push({
        package_id: `openvr.${release.tag.replace(/^v/u, "").toLowerCase()}.${artifact.architecture.toLowerCase()}`,
        technology: "openvr",
        variant: "runtime",
        display_name: "OpenVR SDK",
        release: {
          version: release.version,
          channel: "stable",
          label: release.label,
        },
        target: {
          os: "windows",
          architecture: artifact.architecture,
        },
        provenance: {
          kind: "github_release",
          repository: config.repository,
          tag: release.tag,
          commit_sha: release.commit_sha,
        },
        members: [
          {
            artifact_key: artifactKey,
            role: "primary",
            install_as: "openvr_api.dll",
          },
        ],
      });
    }
  }
  const source = {
    schema_version: 1,
    vendor: { id: "valve", display_name: "Valve" },
    generated_at: latestTimestamp(lock.releases.map((release) => release.published_at)),
    artifacts: [...artifacts.values()].sort((left, right) =>
      left.artifact_key.localeCompare(right.artifact_key),
    ),
    packages: packages.sort((left, right) =>
      left.package_id.localeCompare(right.package_id),
    ),
  };
  assertVendorSource(source);
  return source;
}

function normalizedTimestamp(value, context) {
  if (typeof value !== "string" || !RFC3339_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${context} must be a date-time`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${context} must be a date-time`);
  return date.toISOString();
}

function latestTimestamp(values) {
  if (values.length === 0) return "1970-01-01T00:00:00.000Z";
  return values
    .map((value) => normalizedTimestamp(value, "OpenVR generated_at source"))
    .sort()
    .at(-1);
}
