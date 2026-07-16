// Collect and health-check version-pinned managed dependency archives
// (currently dgVoodoo zips embedded in the Luma v1 document).

import { forEachConcurrent } from "../common.mjs";
import { DEFAULT_TIMEOUT_MS } from "../http.mjs";
import { checkUrlHealth } from "./check-url-health.mjs";
import { CHECK_STATUS } from "./result.mjs";

/**
 * Collects unique `requirements.managed_dependency.source.url` values from a
 * Luma v1-shaped document.
 */
export function collectManagedDependencySourceUrls(manifest) {
  const urls = new Set();

  if (!manifest || typeof manifest !== "object") {
    return [];
  }

  const games = Array.isArray(manifest.games) ? manifest.games : [];
  for (const game of games) {
    const source = game?.requirements?.managed_dependency?.source;
    const url = source?.url;
    if (typeof url === "string" && url.trim() !== "") {
      urls.add(url.trim());
    }
  }

  return [...urls].sort();
}

/** Stable check id derived from the archive URL. */
export function pinnedDependencyCheckId(url) {
  return `pinned.dependency:${url}`;
}

/**
 * HEAD-probes each pinned archive URL.
 * Missing (non-OK) responses are hard; network failures are soft.
 */
export async function checkPinnedDependencyUrls(urls, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? 4;
  const results = [];

  await forEachConcurrent(urls, concurrency, async (url) => {
    const result = await checkUrlHealth(pinnedDependencyCheckId(url), url, {
      fetchFn,
      timeoutMs,
      method: "HEAD",
      missingStatus: CHECK_STATUS.hard,
    });
    results.push(result);
  });

  // forEachConcurrent does not preserve push order; sort for stable output.
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}
