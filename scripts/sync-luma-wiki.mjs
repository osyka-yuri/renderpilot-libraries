#!/usr/bin/env node

// Synchronise only Luma's curated status fields from its upstream wiki. Game
// inclusion and all install metadata remain hand-curated.

import path from "node:path";

import { UsageError, errorMessage } from "./lib/common.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { parseLumaWikiRows, reconcileLumaStatuses } from "./lib/luma-wiki.mjs";
import {
  fetchWikiMarkdown,
  parseWikiSyncArgs,
  writeFormattedJsonAtomic,
} from "./lib/wiki-sync.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WIKI_URL = "https://raw.githubusercontent.com/wiki/Filoppi/Luma-Framework/Home.md";

function usage() {
  console.error("Usage: node scripts/sync-luma-wiki.mjs [--check]");
  console.error("");
  console.error("Synchronise Luma wiki statuses into curated_games.json.");
  console.error("--check reports status drift without writing files.");
}

function printRows(header, rows, format) {
  if (rows.length === 0) return;
  console.log(`\n${header}: ${rows.length}`);
  for (const row of rows.slice(0, 10)) console.log(`  ${format(row)}`);
  if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);
}

async function main() {
  const args = parseWikiSyncArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const curatedPath = path.join(REPO_ROOT, "luma_library_manifest", "curated_games.json");
  const curatedGames = readJsonFile(curatedPath, "curated_games.json");

  console.log("Fetching Luma wiki...");
  const markdown = await fetchWikiMarkdown(WIKI_URL);
  const wikiRows = parseLumaWikiRows(markdown);
  const counts = Object.fromEntries(
    ["completed", "wip", "unreal"].map((section) => [
      section,
      wikiRows.filter((row) => row.section === section).length,
    ]),
  );
  console.log(
    `Found ${wikiRows.length} wiki entries ` +
      `(${counts.completed} completed, ${counts.wip} wip, ${counts.unreal} unreal).`,
  );

  const result = reconcileLumaStatuses({ curatedGames, wikiRows });
  console.log(`\nStatus changes: ${result.changes.length}`);
  for (const change of result.changes) {
    console.log(`  ${change.name} (${change.from} → ${change.to})`);
  }
  console.log(`\nUnchanged: ${result.unchanged.length}`);
  printRows("Unmatched curated games", result.unmatched, (name) => name);
  printRows("Wiki rows not in curated_games.json", result.notInCurated, (row) => {
    return `${row.name} (${row.status})`;
  });
  printRows("Ambiguous wiki matches", result.ambiguous, (item) => {
    return `${item.row?.name ?? item.game}: ${item.reason}`;
  });

  if (args.check) {
    if (result.changes.length > 0) {
      console.error("\nLuma wiki status drift detected; run sync:luma-wiki.");
      process.exitCode = 1;
    } else {
      console.log("\nNo status changes needed.");
    }
    return;
  }

  if (result.changes.length > 0) {
    await writeFormattedJsonAtomic(curatedPath, result.nextCuratedGames);
    console.log(`\nWrote ${curatedPath}`);
  } else {
    console.log("\nNo changes written.");
  }
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
