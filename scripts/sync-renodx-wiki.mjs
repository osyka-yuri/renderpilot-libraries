#!/usr/bin/env node

// Pull the RenoDX Mods wiki into wiki_games.json and reconcile availability
// markers in match_overlay.json. The tool-specific transformation is pure in
// lib/renodx-wiki.mjs; this file owns only IO and the command contract.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { UsageError, assertPlainObject, errorMessage } from "./lib/common.mjs";
import { githubHeaders } from "./lib/github.mjs";
import {
  jsonChanged,
  fetchJsonWithTimeout,
  fetchWikiMarkdown,
  parseWikiSyncArgs,
  writeJsonAtomic,
} from "./lib/wiki-sync.mjs";
import { parseRenodxWikiRows, reconcileRenodxWiki } from "./lib/renodx-wiki.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WIKI_URL = "https://raw.githubusercontent.com/wiki/clshortfuse/renodx/Mods.md";
const SNAPSHOT_API =
  "https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot";

function usage() {
  console.error("Usage: node scripts/sync-renodx-wiki.mjs [--check]");
  console.error("");
  console.error("Synchronise the RenoDX wiki and availability overlay.");
  console.error("--check reports catalogue/overlay drift without writing files.");
}

async function readJsonOrDefault(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Failed to read valid JSON from ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function fetchSnapshotAssets() {
  try {
    const release = await fetchJsonWithTimeout(SNAPSHOT_API, { headers: githubHeaders() });
    if (!Array.isArray(release?.assets)) {
      throw new Error("snapshot release response does not contain an assets array");
    }
    return new Set(
      release.assets
        .map((asset) => asset?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  } catch (error) {
    console.warn(`Warning: could not fetch snapshot assets: ${errorMessage(error)}`);
    console.warn("Continuing with wiki-link based official detection only.");
    return new Set();
  }
}

async function main() {
  const args = parseWikiSyncArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const wikiPath = path.join(REPO_ROOT, "renodx_library_manifest", "wiki_games.json");
  const overlayPath = path.join(REPO_ROOT, "renodx_library_manifest", "match_overlay.json");
  const existingWiki = await readJsonOrDefault(wikiPath, []);
  if (!Array.isArray(existingWiki)) throw new Error(`${wikiPath} must be a JSON array.`);
  const overlay = assertPlainObject(await readJsonOrDefault(overlayPath, {}), overlayPath);

  console.log("Fetching RenoDX wiki...");
  const rows = parseRenodxWikiRows(await fetchWikiMarkdown(WIKI_URL));
  console.log("Fetching official snapshot assets...");
  const officialAssets = await fetchSnapshotAssets();
  if (officialAssets.size === 0) console.warn("Warning: no snapshot assets available.");

  const result = reconcileRenodxWiki({ rows, existingWiki, overlay, officialAssets });
  for (const warning of result.warnings) console.warn(warning);
  const changed =
    jsonChanged(existingWiki, result.wikiGames) || jsonChanged(overlay, result.overlay);

  if (args.check) {
    if (changed) {
      console.error("RenoDX wiki or overlay drift detected; run sync:renodx-wiki.");
      process.exitCode = 1;
    } else {
      console.log("No RenoDX wiki or overlay changes needed.");
    }
    return;
  }

  await writeJsonAtomic(wikiPath, result.wikiGames);
  await writeJsonAtomic(overlayPath, result.overlay);
  console.log(
    [
      `Synced ${result.wikiGames.length} games.`,
      `official=${result.stats.official}`,
      `download_url=${result.stats.download_url}`,
      `external=${result.stats.external}`,
      `unchanged=${result.stats.unchanged}`,
    ].join(" "),
  );
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    usage();
  } else {
    console.error(errorMessage(error));
  }
  process.exitCode = 1;
});
