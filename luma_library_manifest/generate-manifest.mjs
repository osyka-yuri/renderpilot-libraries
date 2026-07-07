#!/usr/bin/env node
// Generate the Luma Framework overrides manifest (schema v1) from authoritative
// inputs.
//
// The app fetches the Luma add-on live from a single upstream rolling GitHub
// Release, so this manifest carries no artifacts or hashes. The authoring
// inputs stay in this folder; the served manifest is written to the
// repository root.

import path from "node:path";

import { buildManifest } from "./lib/build-manifest.mjs";
import { readJsonFile } from "../scripts/lib/json.mjs";
import { runGenerateManifestMain } from "../scripts/lib/generate-manifest-runner.mjs";
import { repoRoot } from "../scripts/catalog.mjs";

const SCRIPT_DIR = import.meta.dirname;

const FILES = Object.freeze({
  curatedGames: path.join(SCRIPT_DIR, "curated_games.json"),
  overlay: path.join(SCRIPT_DIR, "match_overlay.json"),
  exeCache: path.join(repoRoot, "scripts", "steam-appid-exe.json"),
  pending: path.join(SCRIPT_DIR, "pending_match.json"),
  manifest: path.join(repoRoot, "luma_manifest.json"),
});

const HELP_TEXT = `Usage: node generate-manifest.mjs [--check]

Generate luma_manifest.json from curated_games.json, match_overlay.json, and
the optional steam-appid-exe.json cache.

  --check   Do not write files; fail if generated outputs differ.
  -h, --help
            Show this help message.`;

runGenerateManifestMain(() => ({
  files: FILES,
  repoRoot,
  helpText: HELP_TEXT,
  build: (inputs) => buildManifest(inputs),
  readInputs: ({ exeCache, generatedAt }) => ({
    curatedGames: readJsonFile(FILES.curatedGames, path.basename(FILES.curatedGames)),
    overlay: readJsonFile(FILES.overlay, path.basename(FILES.overlay)),
    exeCache,
    generatedAt,
  }),
  printSummary: (stats) => {
    console.log(
      `manifest: ${stats.titles} titles (${stats.generic} generic, ${stats.blacklist} blacklist)`,
    );

    if (stats.ambiguousDerivedExes > 0) {
      console.log(`skipped ambiguous derived exe names: ${stats.ambiguousDerivedExes}`);
    }

    console.log(
      `pending (no AppID/exe yet): ${stats.pending} -> ${path.basename(FILES.pending)}`,
    );
  },
}));
