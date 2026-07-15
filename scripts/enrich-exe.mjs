#!/usr/bin/env node
// Enrich the shared Steam AppID → executable-basename cache from Steam appinfo.
//
// `scripts/steam-appid-exe.json` is the single, tool-agnostic cache consumed by
// the RenoDX generator. Luma stores reviewed executable rules directly in its
// curated profile document, so it no longer derives them from this cache.
//
// This script collects RenoDX overlay AppIDs, fetches the ones that are missing
// (or all of them with `--force`), prunes entries no longer claimed, and writes
// the result atomically.
//
//   node scripts/enrich-exe.mjs [--force]

import { addonCatalogs, sharedFiles } from "./catalog.mjs";
import { runEnrichExeMain } from "./lib/enrich-exe-runner.mjs";
import { isMissingFileError } from "./lib/common.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { collectOverlayAppids as collectRenoOverlayAppids } from "../catalogs/addons/renodx/lib/overlay.mjs";

const CACHE_FILE = sharedFiles.steamExeCache;

// RenoDX's collector walks `split` recursively.
const TOOL_OVERLAYS = Object.freeze([
  {
    tool: "renodx",
    overlayFile: addonCatalogs.renodx.sources.overlay,
    collect: collectRenoOverlayAppids,
  },
]);

function collectUnionAppids() {
  const appids = new Set();

  for (const { tool, overlayFile, collect } of TOOL_OVERLAYS) {
    try {
      const overlay = readJsonFile(overlayFile, "match_overlay.json");
      collect(overlay, appids);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      console.warn(`Warning: ${tool} match_overlay.json missing -- skipping`);
    }
  }

  return appids;
}

runEnrichExeMain({
  cacheFile: CACHE_FILE,
  collectAppids: collectUnionAppids,
});
