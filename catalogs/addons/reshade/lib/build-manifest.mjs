import { deepFreeze, generatedAtFromEnv } from "../../../../scripts/lib/common.mjs";
import {
  RESHADE_NIGHTLY,
  RESHADE_STABLE,
} from "../../../../scripts/lib/reshade-sources.mjs";
import { SCHEMA_VERSION } from "./v1.mjs";

export { SCHEMA_VERSION };

export function buildManifest({ generatedAt = generatedAtFromEnv() } = {}) {
  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    channels: { stable: RESHADE_STABLE, nightly: RESHADE_NIGHTLY },
  });
}
