#!/usr/bin/env node

// Pull the RenoDX Mods wiki into wiki_games.json and reconcile availability
// markers in match_overlay.json. The tool-specific transformation is pure in
// lib/renodx-wiki.mjs; this file owns only IO and the command contract.

import { readFile } from "node:fs/promises";
import { addonCatalogs } from "./catalog.mjs";
import { assertPlainObject, errorMessage } from "./lib/common.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { fetchSnapshotAssetNames } from "./lib/github.mjs";
import { writeFormattedJsonFile } from "./lib/json.mjs";
import { jsonChanged, fetchWikiMarkdown, parseWikiSyncArgs } from "./lib/wiki-sync.mjs";
import { parseRenodxWikiRows, reconcileRenodxWiki } from "./lib/renodx-wiki.mjs";

const WIKI_URL = "https://raw.githubusercontent.com/wiki/clshortfuse/renodx/Mods.md";

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
    return await fetchSnapshotAssetNames();
  } catch (error) {
    throw new Error(
      `Could not fetch complete RenoDX snapshot assets: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function main(args) {
  const wikiPath = addonCatalogs.renodx.sources.wiki;
  const overlayPath = addonCatalogs.renodx.sources.overlay;
  const existingWiki = await readJsonOrDefault(wikiPath, []);
  if (!Array.isArray(existingWiki)) throw new Error(`${wikiPath} must be a JSON array.`);
  const overlay = assertPlainObject(await readJsonOrDefault(overlayPath, {}), overlayPath);

  console.log("Fetching RenoDX wiki...");
  const rows = parseRenodxWikiRows(await fetchWikiMarkdown(WIKI_URL));
  console.log("Fetching official snapshot assets...");
  const officialAssets = await fetchSnapshotAssets();
  if (officialAssets.size === 0) {
    throw new Error("RenoDX snapshot contains no assets; refusing an incomplete sync");
  }

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

  await writeFormattedJsonFile(wikiPath, result.wikiGames);
  await writeFormattedJsonFile(overlayPath, result.overlay);
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

runCliMain({
  parse: parseWikiSyncArgs,
  help: usage,
  main,
});
