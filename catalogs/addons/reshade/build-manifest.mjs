import { deepFreeze, generatedAtFromEnv } from "../../../scripts/lib/common.mjs";
import { RESHADE_NIGHTLY, RESHADE_STABLE } from "../../../scripts/lib/reshade-sources.mjs";

export const SCHEMA_VERSION = 1;

export function buildV1ReshadeManifest({ generatedAt = generatedAtFromEnv() } = {}) {
  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    channels: { stable: RESHADE_STABLE, nightly: RESHADE_NIGHTLY },
  });
}

/** Legacy ReShade document retained solely for RenoDX v3 applications. */
export function buildLegacyV1ReshadeManifest(v1Manifest) {
  return deepFreeze({
    schema_version: 1,
    generated_at: v1Manifest.generated_at,
    stable: v1Manifest.channels.stable,
    nightly: v1Manifest.channels.nightly,
  });
}
