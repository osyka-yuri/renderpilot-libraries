// Builds the standalone `reshade_manifest.json` document — the single
// published source of truth for ReShade host URLs, read by both the RenoDX
// and Luma manifest overlays at runtime (see the app's
// `addons::reshade::manifest_store`). Pulls its values from
// `reshade-sources.mjs`, the same constants each tool's own manifest embeds,
// so this document and the embedded blocks can never disagree.

import { deepFreeze, generatedAtFromEnv } from "./common.mjs";
import { RESHADE_STABLE, RESHADE_NIGHTLY } from "./reshade-sources.mjs";

export const SCHEMA_VERSION = 1;

/** Builds the `reshade_manifest.json` document. No file/network I/O. */
export function buildReshadeManifest({ generatedAt = generatedAtFromEnv() } = {}) {
  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    stable: RESHADE_STABLE,
    nightly: RESHADE_NIGHTLY,
  });
}
