#!/usr/bin/env node
// Enrich the shared Steam AppID → executable-basename cache from Steam appinfo.
//
// `scripts/steam-appid-exe.json` is the single, tool-agnostic cache consumed by
// BOTH manifest generators (RenoDX and Luma): each generator's `buildManifest`
// already filters the cache down to its own `activeAppids` (the AppIDs its
// `match_overlay.json` actually claims), so a shared superset file is safe and
// avoids fetching the same AppID twice for titles both tools curate.
//
// This script unions the AppIDs from every tool's `match_overlay.json`, fetches
// the ones that are missing (or all of them with `--force`), prunes entries no
// longer claimed by any tool, and writes the result atomically.
//
//   node scripts/enrich-exe.mjs [--force]

import path from "node:path";

import { runEnrichExeMain } from "./lib/enrich-exe-runner.mjs";
import { isMissingFileError } from "./lib/common.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { repoRoot } from "./catalog.mjs";
import { collectOverlayAppids as collectRenoOverlayAppids } from "../renodx_library_manifest/lib/overlay.mjs";
import { collectOverlayAppids as collectLumaOverlayAppids } from "../luma_library_manifest/lib/overlay.mjs";

const SCRIPT_DIR = import.meta.dirname;

const CACHE_FILE = path.join(SCRIPT_DIR, "steam-appid-exe.json");

// Each tool's (overlayFile, collector). RenoDX's collector walks `split`
// recursively; Luma's reads the flat overlay. Unioning both here means one
// fetch covers every AppID either pipeline needs.
const TOOL_OVERLAYS = Object.freeze([
  {
    tool: "renodx",
    overlayFile: path.join(repoRoot, "renodx_library_manifest", "match_overlay.json"),
    collect: collectRenoOverlayAppids,
  },
  {
    tool: "luma",
    overlayFile: path.join(repoRoot, "luma_library_manifest", "match_overlay.json"),
    collect: collectLumaOverlayAppids,
  },
]);

function collectUnionAppids() {
  const appids = new Set();

  for (const { tool, overlayFile, collect } of TOOL_OVERLAYS) {
    try {
      const overlay = readJsonFile(overlayFile, path.relative(repoRoot, overlayFile));
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
