import { cancelResponseBody, fetchWithTimeout } from "./http.mjs";
import { comparePackageVersions } from "./library-catalog.mjs";
import { normalizePackageVersion, packageVersionIdentity } from "./library-values.mjs";
import {
  assertMicrosoftKnownReleaseCoverage,
  upstreamRelistedWithdrawals,
} from "./microsoft-nuget-lock.mjs";

const REGISTRATION_BASE = "https://api.nuget.org/v3/registration5-gz-semver2";
const FLAT_CONTAINER_BASE = "https://api.nuget.org/v3-flatcontainer";
const REQUEST_TIMEOUT_MS = 30_000;

export async function registrationReleases(packageId, fetchImpl = fetch) {
  const normalizedId = packageId.toLowerCase();
  const index = await fetchJson(
    `${REGISTRATION_BASE}/${encodeURIComponent(normalizedId)}/index.json`,
    fetchImpl,
  );
  if (
    !Array.isArray(index.items) ||
    !Number.isSafeInteger(index.count) ||
    index.count !== index.items.length
  ) {
    throw new Error(`${packageId}: malformed Registration index pages`);
  }

  const pages = await Promise.all(
    index.items.map((page, pageIndex) =>
      resolveRegistrationPage(packageId, page, pageIndex, fetchImpl),
    ),
  );
  const leaves = [];
  for (const page of pages) {
    if (!Array.isArray(page.items)) {
      throw new Error(`${packageId}: malformed Registration page items`);
    }
    if (!Number.isSafeInteger(page.count) || page.count !== page.items.length) {
      throw new Error(
        `${packageId}: incomplete Registration page (${page.items.length}/${page.count} leaves)`,
      );
    }
    leaves.push(...page.items);
  }

  const releases = leaves.map((leaf, index) =>
    registrationReleaseFromLeaf(packageId, normalizedId, leaf, index),
  );
  assertUniqueVersions(packageId, releases);
  return releases.sort((left, right) =>
    comparePackageVersions(left.packageVersion, right.packageVersion),
  );
}

function resolveRegistrationPage(packageId, page, pageIndex, fetchImpl) {
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw new Error(`${packageId}: malformed Registration page at index ${pageIndex}`);
  }
  if (page.items !== undefined) return Promise.resolve(page);
  if (typeof page["@id"] !== "string" || page["@id"].length === 0) {
    throw new Error(`${packageId}: malformed Registration page at index ${pageIndex}`);
  }
  return fetchJson(page["@id"], fetchImpl);
}

export async function listedReleases(packageId, fetchImpl = fetch) {
  return (await registrationReleases(packageId, fetchImpl)).filter(
    (release) => release.listed,
  );
}

export async function assessNuGetReleaseAvailability(
  packageId,
  packageVersion,
  registration,
  fetchImpl = fetch,
) {
  const normalizedVersion = normalizePackageVersion(packageVersion);
  const leaf = registration.find((release) => release.packageVersion === normalizedVersion);
  if (leaf) {
    return { state: leaf.listed ? "listed" : "unlisted", release: leaf };
  }

  const normalizedId = packageId.toLowerCase();
  const exactUrl =
    `${FLAT_CONTAINER_BASE}/${encodeURIComponent(normalizedId)}/` +
    `${encodeURIComponent(normalizedVersion)}/${encodeURIComponent(normalizedId)}.` +
    `${encodeURIComponent(normalizedVersion)}.nupkg`;
  const response = await fetchWithTimeout(exactUrl, {
    fetchFn: fetchImpl,
    timeoutMs: REQUEST_TIMEOUT_MS,
    method: "GET",
    headers: { range: "bytes=0-0" },
  });
  cancelResponseBody(response);
  if (response.status === 404) return { state: "hard_delete", release: null };
  if (response.ok || response.status === 206) {
    return { state: "registration_missing", release: null };
  }
  throw new Error(
    `${packageId}@${normalizedVersion}: exact NuGet endpoint failed (${response.status})`,
  );
}

/**
 * Computes the fail-closed refresh state for one Microsoft product. Withdrawal
 * detection deliberately precedes completeness checks so an expected unlisting
 * produces an actionable review report instead of a generic count failure.
 */
export async function assessMicrosoftRefreshProduct(
  product,
  lock,
  registration,
  assessAvailability = assessNuGetReleaseAvailability,
) {
  const upstream = registration.filter((release) => release.listed);
  const active = lock.releases.filter(
    (release) => release.package_id === product.package_id,
  );
  const assessments = await Promise.all(
    active.map(async (release) => ({
      release,
      availability: await assessAvailability(
        release.package_id,
        release.package_version,
        registration,
      ),
    })),
  );
  const withdrawalReport = assessments.flatMap(({ release, availability }) => {
    if (availability.state === "unlisted" || availability.state === "hard_delete") {
      return [
        {
          package_id: release.package_id,
          package_version: release.package_version,
          reason: availability.state,
        },
      ];
    }
    if (availability.state === "registration_missing") {
      throw new Error(
        `${release.package_id}@${release.package_version}: exact package still exists but Registration leaf is missing; refusing to infer withdrawal from an incomplete registry view`,
      );
    }
    return [];
  });
  if (withdrawalReport.length > 0) {
    return { state: "withdrawal_review_required", withdrawalReport, upstream };
  }

  const relisted = upstreamRelistedWithdrawals(product, registration, lock.withdrawn);
  if (relisted.length > 0) {
    return { state: "relisted_review_required", relisted, upstream };
  }
  assertMicrosoftKnownReleaseCoverage(product, registration, lock.withdrawn);

  const withdrawnIdentities = new Set(
    lock.withdrawn
      .filter((entry) => entry.package_id === product.package_id)
      .map((entry) => packageVersionIdentity(entry.package_version)),
  );
  const lockedIdentities = new Set(
    active.map((release) => packageVersionIdentity(release.package_version)),
  );
  const missing = upstream.filter((release) => {
    const identity = packageVersionIdentity(release.packageVersion);
    return !lockedIdentities.has(identity) && !withdrawnIdentities.has(identity);
  });
  return { state: "ready", missing, upstream };
}

export async function fetchPackageSha512(catalogEntryUrl, fetchImpl = fetch) {
  const details = await fetchJson(catalogEntryUrl, fetchImpl);
  const algorithm = details.packageHashAlgorithm;
  const hash = details.packageHash;

  if (typeof algorithm !== "string" || algorithm.toUpperCase() !== "SHA512") {
    throw new Error(
      `NuGet catalog entry ${catalogEntryUrl} uses unsupported package hash ${algorithm}`,
    );
  }
  if (typeof hash !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(hash)) {
    throw new Error(
      `NuGet catalog entry ${catalogEntryUrl} has malformed SHA-512 metadata`,
    );
  }
  return hash;
}

function registrationReleaseFromLeaf(packageId, normalizedId, leaf, index) {
  const entry = leaf?.catalogEntry;
  if (
    !entry ||
    typeof entry.id !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.packageContent !== "string" ||
    typeof entry["@id"] !== "string" ||
    typeof entry.published !== "string" ||
    typeof entry.listed !== "boolean"
  ) {
    throw new Error(`${packageId}: malformed Registration leaf at index ${index}`);
  }
  if (entry.id.toLowerCase() !== normalizedId) {
    throw new Error(
      `${packageId}: Registration leaf ${index} belongs to unexpected package ${entry.id}`,
    );
  }

  let publishedAt;
  try {
    publishedAt = new Date(entry.published).toISOString();
  } catch {
    throw new Error(`${packageId}: malformed Registration leaf at index ${index}`);
  }
  return {
    packageId: entry.id,
    packageVersion: normalizePackageVersion(
      entry.version,
      `${packageId}: Registration version`,
    ),
    packageContent: entry.packageContent,
    catalogEntry: entry["@id"],
    publishedAt,
    listed: entry.listed,
  };
}

function assertUniqueVersions(packageId, releases) {
  const identities = new Set();
  for (const release of releases) {
    const identity = packageVersionIdentity(release.packageVersion);
    if (identities.has(identity)) {
      throw new Error(`${packageId}: duplicate Registration version ${identity}`);
    }
    identities.add(identity);
  }
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchWithTimeout(url, {
    fetchFn: fetchImpl,
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`request failed (${response.status}) for ${url}`);
  return response.json();
}
