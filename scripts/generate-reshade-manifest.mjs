#!/usr/bin/env node
// Generate the standalone ReShade host manifest (`addons/v1/reshade.json`).
//
// Current tool-v1 catalogues (Luma/RenoDX) contain no ReShade download URLs;
// they consume this document separately.

import { buildManifest } from "../catalogs/addons/reshade/lib/build-manifest.mjs";
import { runGenerateManifestMain } from "./lib/generate-manifest-runner.mjs";
import { addonCatalogs, repoRoot } from "./catalog.mjs";

const FILES = Object.freeze({
  outputs: {
    manifest: addonCatalogs.reshade.outputs.manifest.file,
  },
});

const HELP_TEXT = `Usage: node generate-reshade-manifest.mjs [--check]

Generate the v1 ReShade source catalogue from the shared channel source.

  --check   Do not write the file; fail if the generated output differs.
  -h, --help
            Show this help message.`;

runGenerateManifestMain(() => ({
  files: FILES,
  repoRoot,
  helpText: HELP_TEXT,
  build: ({ generatedAt }) => {
    const manifest = buildManifest({ generatedAt });
    return { outputs: { manifest } };
  },
  readInputs: ({ generatedAt }) => ({ generatedAt }),
  printSummary: (_stats, { ok }) => {
    if (ok) {
      console.log("ReShade v1 catalogue is up to date");
    }
  },
}));
