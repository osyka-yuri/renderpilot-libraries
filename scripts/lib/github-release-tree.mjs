import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { getNextUrlFromLinkHeader, githubHeaders } from "./github.mjs";
import { fetchWithTimeout } from "./http.mjs";
import {
  assertLegalDocumentContentIdentity,
  assertLegalDocumentDescriptor,
  assertNumericVersion,
  assertPeNamedExports,
  assertVendorSource,
  blobObjectKey,
  legalDocumentObjectKey,
  recordImmutableObjectIdentity,
} from "./library-catalog.mjs";
import {
  compareProfileReleases,
  githubReleaseTreeProfile,
} from "./github-release-tree-profiles.mjs";
import { latestRfc3339Timestamp, normalizeRfc3339Timestamp } from "./library-values.mjs";

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function assertGitHubReleaseTreeConfig(config) {
  const profile = githubReleaseTreeProfile(config?.profile);
  if (
    config?.schema_version !== 1 ||
    !REPOSITORY_PATTERN.test(config.repository ?? "") ||
    config.repository !== profile.repository ||
    !Number.isSafeInteger(config.expected_stable_releases) ||
    config.expected_stable_releases <= 0 ||
    !Array.isArray(config.trusted_signer_subjects) ||
    config.trusted_signer_subjects.length === 0
  ) {
    throw new Error(`${profile.id}: GitHub release-tree config is invalid`);
  }
  const subjects = new Set();
  for (const subject of config.trusted_signer_subjects) {
    if (typeof subject !== "string" || !subject.trim() || subject !== subject.trim()) {
      throw new Error(`${profile.id}: trusted signer subject is invalid`);
    }
    if (subjects.has(subject)) {
      throw new Error(`${profile.id}: duplicate trusted signer subject ${subject}`);
    }
    subjects.add(subject);
  }
  if (
    [...subjects]
      .sort()
      .some((subject, index) => subject !== config.trusted_signer_subjects[index])
  ) {
    throw new Error(`${profile.id}: trusted signer subjects must be sorted`);
  }
  if (config.require_valid_signature_at_or_after !== undefined) {
    normalizedTimestamp(
      config.require_valid_signature_at_or_after,
      `${profile.id}: signature cutoff`,
    );
    if (!profile.allowsUnsigned) {
      throw new Error(
        `${profile.id}: a signature cutoff is invalid for a profile that requires signed DLLs`,
      );
    }
  } else if (profile.allowsUnsigned) {
    throw new Error(`${profile.id}: profiles that allow unsigned DLLs require a cutoff`);
  }
  return profile;
}

export async function listStableGitHubReleases(
  config,
  { fetchFn = fetch, tagIdentities } = {},
) {
  const profile = assertGitHubReleaseTreeConfig(config);
  if (!(tagIdentities instanceof Map)) {
    throw new Error(`${profile.id}: release discovery requires resolved tag identities`);
  }
  const initialUrl = `https://api.github.com/repos/${config.repository}/releases?per_page=100`;
  const releases = [];
  const visitedPages = new Set();
  let nextUrl = initialUrl;
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
    if (!Array.isArray(page)) throw new Error("GitHub releases response must be an array");
    for (const value of page) {
      if (value?.draft || value?.prerelease) continue;
      const tag = value?.tag_name;
      const parsed = profile.parseTag(tag);
      const tagIdentity = tagIdentities.get(tag);
      if (!tagIdentity) throw new Error(`${tag}: resolved tag identity is missing`);
      if (!Number.isSafeInteger(value.id) || value.id <= 0) {
        throw new Error(`${tag}: GitHub release id is invalid`);
      }
      releases.push({
        releaseId: value.id,
        tag,
        version: parsed.version,
        label: parsed.label,
        publishedAt: normalizedTimestamp(value.published_at, `${tag}: published_at`),
        tagRefSha: tagIdentity.tagRefSha,
        commitSha: tagIdentity.commitSha,
      });
    }
    const linked = getNextUrlFromLinkHeader(response.headers.get("link"));
    nextUrl =
      linked === null
        ? null
        : validatedReleasesPageUrl(linked, config.repository).toString();
  }
  assertUniqueReleaseIdentities(releases, profile.id);
  releases.sort(compareProfileReleases);
  if (releases.length < config.expected_stable_releases) {
    throw new Error(
      `${profile.id}: expected at least ${config.expected_stable_releases} stable releases, got ${releases.length}`,
    );
  }
  return releases;
}

export function parseRemoteTagIdentities(output) {
  if (typeof output !== "string") throw new Error("git ls-remote output is invalid");
  const direct = new Map();
  const peeled = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/u.exec(line);
    if (!match) throw new Error(`unexpected git ls-remote line ${line}`);
    const [, sha, tag, isPeeled] = match;
    const target = isPeeled ? peeled : direct;
    if (target.has(tag)) throw new Error(`duplicate remote tag record ${tag}`);
    target.set(tag, sha);
  }
  const identities = new Map();
  for (const [tag, tagRefSha] of direct) {
    identities.set(tag, {
      tagRefSha,
      commitSha: peeled.get(tag) ?? tagRefSha,
    });
  }
  for (const tag of peeled.keys()) {
    if (!direct.has(tag)) throw new Error(`peeled tag ${tag} has no direct ref`);
  }
  return identities;
}

export async function fetchCommitTree(config, commitSha, { fetchFn = fetch } = {}) {
  if (!SHA1_PATTERN.test(commitSha)) throw new Error("commit SHA is invalid");
  const url = `https://api.github.com/repos/${config.repository}/git/trees/${commitSha}?recursive=1`;
  const response = await fetchWithTimeout(url, {
    fetchFn,
    timeoutMs: 60_000,
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GitHub tree request failed (${response.status}) for ${url}`);
  }
  const value = await response.json();
  if (value?.truncated === true) {
    throw new Error(`${commitSha}: GitHub returned a truncated commit tree`);
  }
  if (!Array.isArray(value?.tree)) {
    throw new Error(`${commitSha}: GitHub commit tree is invalid`);
  }
  const blobs = new Map();
  for (const entry of value.tree) {
    if (entry?.type !== "blob") continue;
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      !SHA1_PATTERN.test(entry.sha ?? "") ||
      blobs.has(entry.path)
    ) {
      throw new Error(`${commitSha}: invalid or duplicate Git tree blob`);
    }
    blobs.set(entry.path, entry.sha);
  }
  return blobs;
}

export function assertGitHubReleaseTreeLock(lock, config) {
  const profile = assertGitHubReleaseTreeConfig(config);
  if (
    lock?.schema_version !== 1 ||
    lock.profile !== profile.id ||
    !Array.isArray(lock.releases)
  ) {
    throw new Error(`${profile.id}: GitHub release-tree lock is invalid`);
  }
  const tags = new Set();
  const ids = new Set();
  const assetObjects = new Map();
  for (const release of lock.releases) {
    const context = `${profile.id}/${release?.tag ?? "<unknown>"}`;
    const parsed = profile.parseTag(release?.tag);
    if (
      !Number.isSafeInteger(release.release_id) ||
      release.release_id <= 0 ||
      release.version !== parsed.version ||
      release.label !== parsed.label ||
      !SHA1_PATTERN.test(release.tag_ref_sha ?? "") ||
      !SHA1_PATTERN.test(release.commit_sha ?? "")
    ) {
      throw new Error(`${context}: release identity is invalid`);
    }
    normalizedTimestamp(release.published_at, `${context}: published_at`);
    if (tags.has(release.tag) || ids.has(release.release_id)) {
      throw new Error(`${context}: duplicate release identity`);
    }
    tags.add(release.tag);
    ids.add(release.release_id);
    const plan = profile.releasePlan({
      tag: release.tag,
      version: release.version,
      label: release.label,
    });
    if (release.disposition !== plan.disposition) {
      throw new Error(`${context}: release disposition differs from the reviewed profile`);
    }
    if (release.disposition === "excluded") {
      if (
        release.exclusion_reason !== plan.exclusionReason ||
        release.artifacts !== undefined ||
        release.legal_documents !== undefined
      ) {
        throw new Error(`${context}: excluded release contract is invalid`);
      }
      continue;
    }
    if (release.exclusion_reason !== undefined) {
      throw new Error(`${context}: imported release cannot have an exclusion reason`);
    }
    assertImportedRelease(release, plan, config, profile, context, assetObjects);
  }
  const sorted = structuredClone(lock);
  sortGitHubReleaseTreeLock(sorted);
  if (!isDeepStrictEqual(sorted, lock)) {
    throw new Error(`${profile.id}: lock must be deterministically sorted`);
  }
}

function assertImportedRelease(release, plan, config, profile, context, assetObjects) {
  if (
    !Array.isArray(release.artifacts) ||
    release.artifacts.length !== plan.artifacts.length ||
    !Array.isArray(release.legal_documents) ||
    release.legal_documents.length !== plan.legalDocuments.length
  ) {
    throw new Error(`${context}: imported release layout is incomplete`);
  }
  const plannedArtifacts = new Map(
    plan.artifacts.map((artifact) => [artifact.repository_path, artifact]),
  );
  for (const artifact of release.artifacts) {
    const planned = plannedArtifacts.get(artifact?.repository_path);
    if (
      !planned ||
      artifact.component !== planned.component ||
      artifact.architecture !== planned.architecture
    ) {
      throw new Error(`${context}: unreviewed artifact layout`);
    }
    assertLockedArtifact(artifact, release, config, profile, context);
    recordImmutableObjectIdentity(
      assetObjects,
      artifact.r2.object_key,
      {
        kind: "dll",
        dll_sha256: artifact.dll_sha256,
        dll_size_bytes: artifact.dll_size_bytes,
        zst_sha256: artifact.r2.zst_sha256,
        zst_size_bytes: artifact.r2.zst_size_bytes,
        compression_level: artifact.r2.compression_level,
      },
      `${context}/${artifact.repository_path}`,
    );
  }
  const plannedDocuments = new Map(
    plan.legalDocuments.map((document) => [document.repository_path, document]),
  );
  for (const document of release.legal_documents) {
    const planned = plannedDocuments.get(document?.repository_path);
    if (
      !planned ||
      document.kind !== planned.kind ||
      document.title !== planned.title ||
      document.format !== planned.format ||
      document.file_name !== planned.file_name
    ) {
      throw new Error(`${context}: unreviewed legal document layout`);
    }
    assertLockedLegalDocument(document, context);
    recordImmutableObjectIdentity(
      assetObjects,
      document.object_key,
      {
        kind: "legal",
        sha256: document.sha256,
        size_bytes: document.size_bytes,
        format: document.format,
      },
      `${context}/${document.repository_path}`,
    );
  }
}

function assertLockedArtifact(artifact, release, config, profile, context) {
  const artifactContext = `${context}/${artifact?.architecture ?? "<unknown>"}/${artifact?.component ?? "<unknown>"}`;
  if (
    typeof artifact.component !== "string" ||
    !/^[a-z][a-z0-9._-]*$/u.test(artifact.component) ||
    !new Set(["X64", "X86"]).has(artifact.architecture) ||
    !SHA1_PATTERN.test(artifact.git_blob_sha1 ?? "") ||
    !SHA256_PATTERN.test(artifact.dll_sha256 ?? "") ||
    !Number.isSafeInteger(artifact.dll_size_bytes) ||
    artifact.dll_size_bytes <= 0
  ) {
    throw new Error(`${artifactContext}: artifact identity is invalid`);
  }
  if (artifact.pe_version !== null) {
    assertNumericVersion(artifact.pe_version, `${artifactContext}: PE version`);
  }
  if (!Array.isArray(artifact.pe_named_exports)) {
    throw new Error(`${artifactContext}: PE exports must be recorded`);
  }
  if (artifact.pe_named_exports.length > 0) {
    assertPeNamedExports(artifact.pe_named_exports, `${artifactContext}: PE exports`);
  }
  if (profile.publishExports && artifact.pe_named_exports.length === 0) {
    throw new Error(`${artifactContext}: compatibility exports are required`);
  }
  assertGitHubSignaturePolicy(
    artifact.signature,
    release.published_at,
    config,
    artifactContext,
  );
  if (
    artifact.r2?.object_key !== blobObjectKey(artifact.r2?.zst_sha256) ||
    !Number.isSafeInteger(artifact.r2?.zst_size_bytes) ||
    artifact.r2.zst_size_bytes <= 0 ||
    !Number.isSafeInteger(artifact.r2?.compression_level) ||
    artifact.r2.compression_level < 1 ||
    artifact.r2.compression_level > 22
  ) {
    throw new Error(`${artifactContext}: R2 transport is invalid`);
  }
}

function assertLockedLegalDocument(document, context) {
  const documentContext = `${context}/${document?.repository_path ?? "<unknown document>"}`;
  assertLegalDocumentDescriptor(document, documentContext);
  assertLegalDocumentContentIdentity(document, documentContext);
  if (!SHA1_PATTERN.test(document?.git_blob_sha1 ?? "")) {
    throw new Error(`${documentContext}: legal document identity is invalid`);
  }
}

export function assertGitHubSignaturePolicy(signature, publishedAt, config, context) {
  if (signature?.status === "signed") {
    if (
      Object.keys(signature).sort().join(",") !== "signed_at,status,subject,thumbprint" ||
      !config.trusted_signer_subjects.includes(signature.subject) ||
      typeof signature.thumbprint !== "string" ||
      !/^[A-F0-9]{40,64}$/u.test(signature.thumbprint) ||
      (signature.signed_at !== null &&
        normalizedTimestamp(signature.signed_at, `${context}: signed_at`) !==
          signature.signed_at)
    ) {
      throw new Error(`${context}: signed Authenticode metadata is invalid`);
    }
    return;
  }
  if (signature?.status !== "unsigned" || Object.keys(signature).length !== 1) {
    throw new Error(`${context}: Authenticode status is invalid`);
  }
  const cutoff = config.require_valid_signature_at_or_after;
  if (
    cutoff === undefined ||
    new Date(publishedAt).valueOf() >= new Date(cutoff).valueOf()
  ) {
    throw new Error(`${context}: unsigned release violates the signature policy`);
  }
}

export function sortGitHubReleaseTreeLock(lock) {
  lock.releases.sort(compareProfileReleases);
  for (const release of lock.releases) {
    release.artifacts?.sort(
      (left, right) =>
        left.repository_path.localeCompare(right.repository_path) ||
        left.architecture.localeCompare(right.architecture),
    );
    release.legal_documents?.sort((left, right) =>
      left.repository_path.localeCompare(right.repository_path),
    );
  }
  return lock;
}

export function assertGitHubReleaseTreeLockExtendsBaseline(
  lock,
  baseline,
  { allowSignatureTimestampBackfill = false } = {},
) {
  if (
    baseline?.schema_version !== lock?.schema_version ||
    baseline?.profile !== lock?.profile ||
    !Array.isArray(baseline?.releases)
  ) {
    throw new Error("GitHub lock baseline uses a different contract");
  }
  const current = new Map(lock.releases.map((release) => [release.tag, release]));
  for (const previous of baseline.releases) {
    const next = current.get(previous.tag);
    if (!next) throw new Error(`${previous.tag}: locked GitHub release was removed`);
    const comparableNext = withoutArtifactTransport(next);
    const comparablePrevious = withoutArtifactTransport(previous);
    if (allowSignatureTimestampBackfill) {
      normalizeAllowedSignatureTimestampBackfills(comparableNext, comparablePrevious);
    }
    if (!isDeepStrictEqual(comparableNext, comparablePrevious)) {
      throw new Error(`${previous.tag}: immutable GitHub release content changed`);
    }
  }
}

function normalizeAllowedSignatureTimestampBackfills(current, baseline) {
  const previousByPath = new Map(
    (baseline.artifacts ?? []).map((artifact) => [artifact.repository_path, artifact]),
  );
  for (const artifact of current.artifacts ?? []) {
    const previous = previousByPath.get(artifact.repository_path);
    if (
      previous?.signature?.status === "signed" &&
      previous.signature.signed_at === null &&
      artifact.signature?.status === "signed" &&
      typeof artifact.signature.signed_at === "string"
    ) {
      artifact.signature.signed_at = null;
    }
  }
}

function withoutArtifactTransport(release) {
  const value = structuredClone(release);
  for (const artifact of value.artifacts ?? []) delete artifact.r2;
  return value;
}

export function assertLockedReleaseIdentities(lock, upstream) {
  const upstreamByTag = new Map(upstream.map((release) => [release.tag, release]));
  for (const locked of lock.releases) {
    const current = upstreamByTag.get(locked.tag);
    if (!current) throw new Error(`${locked.tag}: locked release disappeared upstream`);
    if (
      locked.release_id !== current.releaseId ||
      locked.version !== current.version ||
      locked.label !== current.label ||
      locked.published_at !== current.publishedAt ||
      locked.tag_ref_sha !== current.tagRefSha ||
      locked.commit_sha !== current.commitSha
    ) {
      throw new Error(`${locked.tag}: immutable GitHub release identity changed`);
    }
  }
}

export function buildGitHubReleaseTreeVendorSource(lock, config, overlay = null) {
  const profile = assertGitHubReleaseTreeConfig(config);
  assertGitHubReleaseTreeLock(lock, config);
  if (overlay !== null) {
    assertVendorSource(overlay);
    if (overlay.vendor.id !== profile.vendor.id) {
      throw new Error(`${profile.id}: overlay vendor identity is inconsistent`);
    }
    for (const artifact of overlay.artifacts) {
      assertGitHubSignaturePolicy(
        artifact.signature,
        overlay.generated_at,
        config,
        `${profile.id}/overlay/${artifact.artifact_key}`,
      );
    }
  }

  const officialArtifacts = new Map();
  const legalDocuments = new Map();
  const packages = [];
  const packageIds = new Set();
  const packageContentIdentities = new Set();
  const contributingTimestamps = [];
  // Locks are sorted oldest-first for review. Project newest-first so an
  // identical payload shared by several official releases keeps the newest
  // release provenance and the unsuffixed stable package id.
  for (const release of lock.releases.toReversed()) {
    if (release.disposition !== "imported") continue;
    const releaseValue = { ...release, repository: config.repository };
    const releaseArtifacts = release.artifacts.map((artifact) => {
      const artifact_key = `${artifact.component}.${artifact.dll_sha256}`;
      const value = {
        artifact_key,
        library_id: artifact.component,
        file_name: `${artifact.component}.dll`,
        file_version: artifact.pe_version,
        architecture: artifact.architecture,
        ...(profile.publishExports ? { pe_named_exports: artifact.pe_named_exports } : {}),
        dll: { sha256: artifact.dll_sha256, size_bytes: artifact.dll_size_bytes },
        transport: {
          sha256: artifact.r2.zst_sha256,
          size_bytes: artifact.r2.zst_size_bytes,
        },
        signature: artifact.signature,
      };
      const previous = officialArtifacts.get(artifact.dll_sha256);
      if (previous && !isDeepStrictEqual(previous, value)) {
        throw new Error(
          `${release.tag}/${artifact.component}: duplicate DLL has inconsistent metadata`,
        );
      }
      officialArtifacts.set(artifact.dll_sha256, value);
      return artifact;
    });
    const legalDocumentIds = release.legal_documents
      .map((document) => {
        const legal_document_id = `${document.kind}.${document.sha256}`;
        const value = {
          legal_document_id,
          kind: document.kind,
          title: document.title,
          format: document.format,
          file_name: document.file_name,
          content: { sha256: document.sha256, size_bytes: document.size_bytes },
        };
        const previous = legalDocuments.get(legal_document_id);
        if (previous && !isDeepStrictEqual(previous, value)) {
          throw new Error(`${release.tag}: duplicate legal document is inconsistent`);
        }
        legalDocuments.set(legal_document_id, value);
        return legal_document_id;
      })
      .sort();

    let contributed = false;
    for (const candidate of profile.buildPackages(
      releaseValue,
      releaseArtifacts,
      legalDocumentIds,
    )) {
      const contentIdentity = packageContentIdentity(candidate, officialArtifacts);
      if (profile.deduplicatePackagesByContent) {
        if (packageContentIdentities.has(contentIdentity)) {
          continue;
        }
        candidate.package_id = `${candidate.package_id}.${createHash("sha256")
          .update(contentIdentity, "utf8")
          .digest("hex")}`;
      }
      if (packageIds.has(candidate.package_id)) {
        throw new Error(`${profile.id}: duplicate package id ${candidate.package_id}`);
      }
      packageIds.add(candidate.package_id);
      packageContentIdentities.add(contentIdentity);
      packages.push(candidate);
      contributed = true;
    }
    if (contributed) contributingTimestamps.push(release.published_at);
  }

  const artifacts = [...officialArtifacts.values()];
  if (overlay) {
    const officialHashes = new Set(artifacts.map((artifact) => artifact.dll.sha256));
    for (const artifact of overlay.artifacts) {
      if (officialHashes.has(artifact.dll.sha256)) {
        throw new Error(
          `${profile.id}: official payload collides with overlay ${artifact.artifact_key}; migrate it explicitly`,
        );
      }
      artifacts.push(artifact);
    }
    for (const document of overlay.legal_documents) {
      if (legalDocuments.has(document.legal_document_id)) {
        throw new Error(
          `${profile.id}: official legal document collides with overlay ${document.legal_document_id}`,
        );
      }
      legalDocuments.set(document.legal_document_id, document);
    }
    for (const packageValue of overlay.packages) {
      if (packageIds.has(packageValue.package_id)) {
        throw new Error(
          `${profile.id}: official package collides with overlay ${packageValue.package_id}`,
        );
      }
      packages.push(packageValue);
    }
    if (overlay.packages.length > 0) contributingTimestamps.push(overlay.generated_at);
  }

  const referencedArtifactKeys = new Set(
    packages.flatMap((packageValue) =>
      packageValue.members.map((member) => member.artifact_key),
    ),
  );
  const referencedLegalDocumentIds = new Set(
    packages.flatMap((packageValue) => packageValue.legal_document_ids ?? []),
  );
  const source = {
    schema_version: 1,
    vendor: profile.vendor,
    generated_at: latestTimestamp(contributingTimestamps),
    legal_documents: [...legalDocuments.values()]
      .filter((document) => referencedLegalDocumentIds.has(document.legal_document_id))
      .sort((left, right) => left.legal_document_id.localeCompare(right.legal_document_id)),
    artifacts: artifacts
      .filter((artifact) => referencedArtifactKeys.has(artifact.artifact_key))
      .sort((left, right) => left.artifact_key.localeCompare(right.artifact_key)),
    packages: packages.sort((left, right) =>
      left.package_id.localeCompare(right.package_id),
    ),
  };
  assertVendorSource(source);
  return source;
}

function packageContentIdentity(packageValue, artifactsBySha) {
  const byKey = new Map(
    [...artifactsBySha.values()].map((artifact) => [artifact.artifact_key, artifact]),
  );
  return packageValue.members
    .map((member) => {
      const artifact = byKey.get(member.artifact_key);
      if (!artifact) {
        throw new Error(
          `${packageValue.package_id}: unknown artifact ${member.artifact_key}`,
        );
      }
      return `${member.install_as.toLowerCase()}\0${artifact.dll.sha256}`;
    })
    .sort()
    .join("\n");
}

export function gitBlobSha1(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Git blob payload must be a Buffer");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

export function normalizedTimestamp(value, context) {
  try {
    return normalizeRfc3339Timestamp(value, context);
  } catch {
    throw new Error(`${context} must be a date-time`);
  }
}

function latestTimestamp(values) {
  return latestRfc3339Timestamp(values, "generated_at source");
}

function validatedReleasesPageUrl(value, repository) {
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
    url.port !== "" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/repos/${repository}/releases` ||
    [...url.searchParams.keys()].some((key) => !allowedParameters.has(key)) ||
    url.searchParams.getAll("per_page").length !== 1 ||
    url.searchParams.get("per_page") !== "100" ||
    (url.searchParams.has("page") &&
      (url.searchParams.getAll("page").length !== 1 ||
        !/^[1-9]\d*$/u.test(url.searchParams.get("page") ?? "")))
  ) {
    throw new Error(`untrusted GitHub releases pagination URL ${value}`);
  }
  return url;
}

function assertUniqueReleaseIdentities(releases, profileId) {
  const tags = new Set();
  const ids = new Set();
  for (const release of releases) {
    if (tags.has(release.tag)) throw new Error(`duplicate ${profileId} tag ${release.tag}`);
    if (ids.has(release.releaseId)) {
      throw new Error(`duplicate ${profileId} release id ${release.releaseId}`);
    }
    tags.add(release.tag);
    ids.add(release.releaseId);
  }
}
