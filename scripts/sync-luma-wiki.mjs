#!/usr/bin/env node

// Synchronise Luma's curated status and UE feature fields from its upstream
// wiki. Free-form notes are manually reviewed and never copied to the public
// manifest without curation.

import { addonCatalogs } from "./catalog.mjs";
import { UsageError, errorMessage } from "./lib/common.mjs";
import { readJsonFile, writeFormattedJsonFile } from "./lib/json.mjs";
import { parseLumaWikiRows, reconcileLumaStatuses } from "./lib/luma-wiki.mjs";
import { fetchWikiMarkdown, parseWikiSyncArgs } from "./lib/wiki-sync.mjs";

const WIKI_URL = "https://raw.githubusercontent.com/wiki/Filoppi/Luma-Framework/Home.md";

function usage() {
  console.error("Usage: node scripts/sync-luma-wiki.mjs [--check]");
  console.error("");
  console.error("Synchronise Luma wiki statuses and UE features into curated_games.json.");
  console.error("--check also verifies catalogue completeness and note reviews.");
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

  const curatedPath = addonCatalogs.luma.sources.curatedGames;
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
  console.log(`\nFeature changes: ${result.featureChanges.length}`);
  for (const change of result.featureChanges.slice(0, 10)) {
    console.log(`  ${change.name}`);
  }
  console.log(`\nUnchanged: ${result.unchanged.length}`);
  printRows("Unmatched curated games", result.unmatched, (name) => name);
  printRows("Wiki rows not in curated_games.json", result.notInCurated, (row) => {
    return `${row.name} (${row.status})`;
  });
  printRows("Ambiguous wiki matches", result.ambiguous, (item) => {
    return `${item.row?.name ?? item.game}: ${item.reason}`;
  });
  printRows("Wiki note review drift", result.reviewDrift, (item) => {
    return `${item.section ?? "catalogue"} ${item.name ?? item.game}: ${item.type}`;
  });
  printRows("Catalogue completeness issues", result.completenessIssues, (item) => {
    return `${item.name}: ${item.type}${item.reason ? ` (${item.reason})` : ""}`;
  });

  const hasBlockingIssues =
    result.reviewDrift.length > 0 || result.completenessIssues.length > 0;

  if (args.check) {
    if (
      result.changes.length > 0 ||
      result.featureChanges.length > 0 ||
      hasBlockingIssues
    ) {
      console.error(
        "\nLuma wiki drift, incomplete catalogue, or unreviewed note detected; review and run sync:luma-wiki.",
      );
      process.exitCode = 1;
    } else {
      console.log("\nNo status or feature changes needed.");
    }
    return;
  }

  if (hasBlockingIssues) {
    console.error("\nRefusing to write while curation review or completeness checks fail.");
    process.exitCode = 1;
    return;
  }

  if (result.changes.length > 0 || result.featureChanges.length > 0) {
    await writeFormattedJsonFile(curatedPath, result.nextCuratedGames);
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
