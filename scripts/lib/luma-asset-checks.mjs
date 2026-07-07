// Pure helpers for the Luma asset-availability guard.
//
// Kept free of IO and network access so the manifest-shape assertion and
// asset-collection logic is unit-testable. The wrapper script
// (scripts/check-luma-assets.mjs) owns the manifest read, the GitHub HEAD
// loop, the console output, and `main`. Mirrors the split between
// `scripts/check-renodx-slugs.mjs` and `scripts/lib/renodx-slug-checks.mjs`.

import { isPlainObject } from "./common.mjs";

/**
 * Thrown by the guard for network/transport failures during the HEAD loop
 * (timeout, DNS, connection reset). The redirect/tag-resolution cases return
 * structured results rather than throwing, so the caller can aggregate
 * partial successes and only soften to a warning when *every* asset failed
 * due to a network issue. Mirrors `SnapshotUnavailableError` from
 * `scripts/lib/github.mjs`.
 */
export class AssetUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetUnavailableError";
  }
}

/**
 * Asserts `manifest` is a plain object carrying a `titles` array — the
 * minimal shape `collectReferencedAssets` reads. Luma has no `generics`
 * array (unlike RenoDX), so this is intentionally narrower than
 * `assertManifestShape` in `renodx-slug-checks.mjs`.
 */
export function assertManifestShape(manifest) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.titles)) {
    throw new Error("luma_manifest.json must be an object with a titles array");
  }
}

/**
 * Collects the unique, non-empty `title.asset` values referenced by a
 * luma_manifest, returned as a sorted array. The HEAD loop in
 * `check-luma-assets.mjs` walks this list.
 */
export function collectReferencedAssets(manifest) {
  const assets = new Set();

  for (const title of manifest.titles) {
    if (title && typeof title.asset === "string" && title.asset.length > 0) {
      assets.add(title.asset);
    }
  }

  return [...assets].sort((a, b) => a.localeCompare(b));
}
