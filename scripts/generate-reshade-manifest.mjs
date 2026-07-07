#!/usr/bin/env node
// Generate the standalone `reshade_manifest.json` (repo root) from
// `scripts/lib/reshade-sources.mjs` — the single published source of truth
// for ReShade host URLs both the RenoDX and Luma manifests overlay onto their
// own embedded (legacy-compat) `reshade` blocks at runtime.
//
// This has no curated authoring inputs: the whole document is derived from
// constants, so `--check` reuses the committed file's own `generated_at` and
// diffs through the shared generated-output runner.

import path from "node:path";

import { buildReshadeManifest } from "./lib/reshade-manifest.mjs";
import { runGenerateManifestMain } from "./lib/generate-manifest-runner.mjs";
import { repoRoot } from "./catalog.mjs";

const FILES = Object.freeze({
  manifest: path.join(repoRoot, "reshade_manifest.json"),
});

const HELP_TEXT = `Usage: node generate-reshade-manifest.mjs [--check]

Generate reshade_manifest.json from scripts/lib/reshade-sources.mjs.

  --check   Do not write the file; fail if the generated output differs.
  -h, --help
            Show this help message.`;

runGenerateManifestMain(() => ({
  files: FILES,
  repoRoot,
  helpText: HELP_TEXT,
  build: ({ generatedAt }) => ({
    manifest: buildReshadeManifest({ generatedAt }),
  }),
  readInputs: ({ generatedAt }) => ({ generatedAt }),
  printSummary: (_stats, { ok }) => {
    if (ok) {
      console.log("reshade_manifest.json: stable present, nightly url64/url32 set");
    }
  },
}));
