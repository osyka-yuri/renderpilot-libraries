// GitHub API helpers for RenoDX snapshot tooling and authenticated GETs.
//
// Prefer `http.fetchJsonWithTimeout` for generic JSON (HttpStatusError /
// UpstreamNetworkError). `fetchJson` here always maps failures to
// `SnapshotUnavailableError` (soft-skip policy) and returns `{ data, headers }`
// for Link-header pagination.

import { errorMessage } from "./common.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  UpstreamNetworkError,
  fetchWithTimeout,
} from "./http.mjs";

export const SNAPSHOT_API =
  "https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot";

export class SnapshotUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotUnavailableError";
  }
}

export function githubHeaders() {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

/** GitHub JSON GET → `{ data, headers }`; failures become SnapshotUnavailableError. */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res;

  try {
    res = await fetchWithTimeout(url, {
      fetchFn: options.fetchFn,
      timeoutMs,
      method: "GET",
      headers: githubHeaders(),
    });
  } catch (err) {
    const message =
      err instanceof UpstreamNetworkError
        ? err.message
        : `request failed: ${errorMessage(err)}`;
    throw new SnapshotUnavailableError(message, { cause: err });
  }

  if (!res.ok) {
    throw new SnapshotUnavailableError(
      `GitHub API returned ${res.status} ${res.statusText} for ${url}`,
    );
  }

  try {
    return {
      data: await res.json(),
      headers: res.headers,
    };
  } catch (err) {
    throw new SnapshotUnavailableError(
      `GitHub API returned invalid JSON: ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

export function getNextUrlFromLinkHeader(header) {
  if (!header) return null;

  // Split multiple links like: <url1>; rel="next", <url2>; rel="last"
  const links = header.split(",");

  for (const link of links) {
    const parts = link.split(";");
    if (parts.length < 2) continue;

    const urlPart = parts[0].trim();
    const relPart = parts[1].trim();

    if (
      urlPart.startsWith("<") &&
      urlPart.endsWith(">") &&
      relPart.includes('rel="next"')
    ) {
      return urlPart.slice(1, -1);
    }
  }

  return null;
}

export async function fetchAllPaginatedItems(initialUrl, options = {}) {
  let allItems = [];
  let nextUrl = initialUrl;

  while (nextUrl) {
    const { data, headers } = await fetchJson(nextUrl, options);

    if (Array.isArray(data)) {
      allItems = allItems.concat(data);
    } else {
      throw new SnapshotUnavailableError("Expected array response for paginated items");
    }

    nextUrl = getNextUrlFromLinkHeader(headers.get("link"));
  }

  return allItems;
}

export async function fetchSnapshotRelease(options = {}) {
  const { data: release } = await fetchJson(SNAPSHOT_API, options);

  if (release.assets_url) {
    release.assets = await fetchAllPaginatedItems(
      `${release.assets_url}?per_page=100`,
      options,
    );
  }

  return release;
}

/**
 * Collects non-empty asset basenames from a GitHub release object
 * (paginated assets already attached by `fetchSnapshotRelease`).
 */
export function snapshotAssetNames(release) {
  if (!Array.isArray(release?.assets)) {
    throw new SnapshotUnavailableError(
      "GitHub API response did not contain an assets array",
    );
  }

  return new Set(
    release.assets
      .map((asset) => asset?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );
}

/** Fetches the RenoDX snapshot release and returns its asset basename set. */
export async function fetchSnapshotAssetNames(options = {}) {
  return snapshotAssetNames(await fetchSnapshotRelease(options));
}
