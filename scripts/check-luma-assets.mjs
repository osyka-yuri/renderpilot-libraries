#!/usr/bin/env node
// Build-time guard: assert every asset referenced by the Luma v1 document still
// exists on the upstream Luma Framework rolling release, and that the
// "latest" alias still resolves to a tagged build (latest-<run_number>).
//
// Luma has no snapshot repository to list assets from (unlike RenoDX) — it
// ships a single rolling GitHub "latest" release, so the only way to check
// availability is a live HEAD request per referenced asset:
//
//   https://github.com/Filoppi/Luma-Framework/releases/latest/download/<asset>
//
// GitHub answers with a redirect to the concrete tag
// (.../releases/download/latest-<N>/<asset>), then a second redirect to a
// signed, time-limited blob URL. We follow the chain manually so we can
// inspect the *first* hop's Location header (the final blob URL carries no
// tag information at all) and separately confirm the asset ultimately
// resolves (200).
//
// Missing/renamed assets or a tag format drift are hard failures.
// Network/GitHub availability problems are soft warnings so offline or
// rate-limited runs do not block CI (mirrors check-renodx-slugs.mjs).
//
//   node scripts/check-luma-assets.mjs

import { addonCatalogs } from "./catalog.mjs";
import { forEachConcurrent } from "./lib/common.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import { printIssues } from "./lib/checks.mjs";
import {
  AssetUnavailableError,
  assertManifestShape,
  collectReferencedAssets,
} from "./lib/luma-asset-checks.mjs";

const RELEASE_BASE = "https://github.com/Filoppi/Luma-Framework/releases";
const LATEST_DOWNLOAD_BASE = `${RELEASE_BASE}/latest/download`;
const TAG_LOCATION_RE =
  /^https:\/\/github\.com\/Filoppi\/Luma-Framework\/releases\/download\/(latest-\d+)\/([^/?#]+)$/u;

const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

async function headWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    return await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AssetUnavailableError(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }

    throw new AssetUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks one asset: the "latest/download" alias must redirect to a concrete
 * `latest-<N>` tag carrying the same asset basename, and that tagged URL must
 * itself resolve (following any further redirects) without a client/server
 * error.
 */
async function checkAsset(asset) {
  const aliasUrl = `${LATEST_DOWNLOAD_BASE}/${encodeURIComponent(asset)}`;
  const aliasResponse = await headWithTimeout(aliasUrl);

  if (aliasResponse.status < 300 || aliasResponse.status >= 400) {
    return {
      asset,
      ok: false,
      reason: `expected a redirect, got HTTP ${aliasResponse.status}`,
    };
  }

  const location = aliasResponse.headers.get("location");
  if (!location) {
    return { asset, ok: false, reason: "redirect had no Location header" };
  }

  const match = TAG_LOCATION_RE.exec(location);
  if (!match) {
    return {
      asset,
      ok: false,
      reason: `redirect target does not look like a latest-<N> tagged asset: ${location}`,
    };
  }

  const [, tag, redirectedAssetName] = match;
  if (decodeURIComponent(redirectedAssetName) !== asset) {
    return {
      asset,
      ok: false,
      reason: `redirect resolved to a different asset name: ${redirectedAssetName}`,
    };
  }

  const taggedResponse = await fetch(location, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!taggedResponse.ok) {
    return {
      asset,
      ok: false,
      reason: `tag ${tag} asset HEAD returned HTTP ${taggedResponse.status}`,
    };
  }

  return { asset, ok: true, tag };
}

async function main() {
  const manifest = await readJsonFileAsync(
    addonCatalogs.luma.outputs.manifest.file,
    "addons/v1/luma.json",
  );
  assertManifestShape(manifest);

  const assets = collectReferencedAssets(manifest);
  console.log(
    `Checking ${assets.length} referenced Luma asset(s) against the upstream release...`,
  );

  const results = [];
  let networkFailure = null;

  await forEachConcurrent(assets, CONCURRENCY, async (asset) => {
    try {
      results.push(await checkAsset(asset));
    } catch (error) {
      if (error instanceof AssetUnavailableError) {
        networkFailure ??= error;
        results.push({ asset, ok: false, reason: error.message, networkIssue: true });
        return;
      }

      throw error;
    }
  });

  if (networkFailure && results.every((result) => result.networkIssue)) {
    console.warn(
      `Skipping asset-availability check -- could not reach GitHub: ${networkFailure.message}`,
    );
    return;
  }

  const failures = results.filter((result) => !result.ok);

  if (failures.length > 0) {
    printIssues(
      `\nFAIL ${failures.length} asset(s) failed to resolve upstream:`,
      failures.map((f) => `${f.asset}: ${f.reason}`),
    );
    process.exitCode = 1;
    return;
  }

  const tags = new Set(results.map((result) => result.tag));
  console.log(
    `OK all ${results.length} referenced Luma assets resolve upstream ` +
      `(current release tag: ${[...tags].join(", ") || "unknown"}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
