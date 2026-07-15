#!/usr/bin/env node
// Generate the standalone ReShade host manifest.
//
// This script emits the current standalone v1 source catalogue and the flat
// root compatibility projection. Current tool-v1 catalogues contain no ReShade
// URLs; the RenoDX generator embeds this data only in its legacy v3 projection.

import {
  buildLegacyV1ReshadeManifest,
  buildV1ReshadeManifest,
} from "../catalogs/addons/reshade/build-manifest.mjs";
import { runGenerateManifestMain } from "./lib/generate-manifest-runner.mjs";
import { addonCatalogs, repoRoot } from "./catalog.mjs";

const FILES = Object.freeze({
  outputs: {
    manifest: addonCatalogs.reshade.outputs.manifest.file,
    legacy: addonCatalogs.reshade.outputs.legacy.file,
  },
});

const HELP_TEXT = `Usage: node generate-reshade-manifest.mjs [--check]

Generate the v1 ReShade document and the legacy schema-v1 compatibility
projection from the shared channel source.

  --check   Do not write the file; fail if the generated output differs.
  -h, --help
            Show this help message.`;

runGenerateManifestMain(() => ({
  files: FILES,
  repoRoot,
  helpText: HELP_TEXT,
  build: ({ generatedAt }) => {
    const manifest = buildV1ReshadeManifest({ generatedAt });
    return { outputs: { manifest, legacy: buildLegacyV1ReshadeManifest(manifest) } };
  },
  readInputs: ({ generatedAt }) => ({ generatedAt }),
  printSummary: (_stats, { ok }) => {
    if (ok) {
      console.log("ReShade v1 and schema-v1 legacy projection are up to date");
    }
  },
}));
