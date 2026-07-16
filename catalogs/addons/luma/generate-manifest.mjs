#!/usr/bin/env node
// Generate the Luma Framework v1 manifest from its single curated profile
// document.
//
// The app fetches the Luma add-on live from a single upstream rolling GitHub
// Release, so this manifest carries no artifacts or hashes. The authoring
// inputs stay in this folder; the served manifest is written under addons/v1/.

import { buildManifest } from "./lib/build-manifest.mjs";
import { readJsonFile } from "../../../scripts/lib/json.mjs";
import { runGenerateManifestMain } from "../../../scripts/lib/generate-manifest-runner.mjs";
import { addonCatalogs, repoRoot } from "../../../scripts/catalog.mjs";

const FILES = Object.freeze({
  curatedGames: addonCatalogs.luma.sources.curatedGames,
  outputs: {
    manifest: addonCatalogs.luma.outputs.manifest.file,
    pending: addonCatalogs.luma.sources.pending,
  },
});

const HELP_TEXT = `Usage: node generate-manifest.mjs [--check]

Generate the v1 Luma document from curated_games.json.

  --check   Do not write files; fail if generated outputs differ.
  -h, --help
            Show this help message.`;

runGenerateManifestMain(() => ({
  files: FILES,
  repoRoot,
  helpText: HELP_TEXT,
  build: (inputs) => {
    const result = buildManifest(inputs);
    return {
      outputs: { manifest: result.manifest, pending: result.pending },
      stats: result.stats,
    };
  },
  readInputs: ({ generatedAt }) => ({
    curatedGames: readJsonFile(FILES.curatedGames, "curated_games.json"),
    generatedAt,
  }),
  printSummary: (stats) => {
    console.log(
      `manifest: ${stats.games} games (${stats.engineProfiles} engine profiles, ${stats.blacklist} blacklist)`,
    );

    console.log(`pending (no AppID/exe yet): ${stats.pending} -> pending_match.json`);
  },
}));
