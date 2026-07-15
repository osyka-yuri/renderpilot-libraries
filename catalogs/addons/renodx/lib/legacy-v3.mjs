// Legacy projection for pre-v1 RenderPilot builds. Do not consume this in new
// code: v3 is intentionally an output-only compatibility boundary.
//
// v3-only wire fields re-derived here:
//   - top-level `defaults` and per-title `channel` (from game status)
//   - vocabulary renames (games→title, availability→category, constraints→
//     compatibility, architecture→arch, addon.slug→slug, etc.)
//
// Legacy-only defaults such as `min_app_version` are derived here rather than
// accepted as per-game overlay fields.

import { deepFreeze } from "../../../../scripts/lib/common.mjs";
import {
  RESHADE_NIGHTLY,
  RESHADE_STABLE,
} from "../../../../scripts/lib/reshade-sources.mjs";

const DEFAULTS = deepFreeze({
  min_app_version: "1.0.0",
  channel: "stable",
});

const RESHADE = deepFreeze({
  stable: RESHADE_STABLE,
  nightly: RESHADE_NIGHTLY,
});

function applyLegacyChannel(title, status) {
  const channel = status === "working" ? "stable" : "beta";
  if (channel !== DEFAULTS.channel) title.channel = channel;
}

function legacyCategory(availability) {
  switch (availability?.kind) {
    case "external":
      return {
        kind: "external",
        url: availability.url,
        label_key: availability.message.id,
      };
    case "native_hdr":
      return { kind: "native_hdr" };
    case "blocked":
      return { kind: "blacklist", reason: availability.message.id };
    default:
      return undefined;
  }
}

function legacyTitle(game) {
  const title = {
    id: game.id,
    name: game.name,
    slug: game.addon.slug,
    arch: game.architecture,
    status: game.status,
    match: game.match,
  };
  const category = legacyCategory(game.availability);
  if (category) title.category = category;
  if (game.constraints) title.compatibility = game.constraints;
  if (game.proxy_dll) title.proxy_dll_override = game.proxy_dll;
  if (game.addon.source) title.download_url = game.addon.source;
  // v1 has no channel field; older clients merge defaults and need beta for
  // non-working titles (same rule as the historical generator).
  applyLegacyChannel(title, title.status);
  return title;
}

function legacyGeneric(profile) {
  const generic = {
    engine: profile.engine,
    label_key: profile.message.id,
  };
  if (profile.addon.slug) generic.slug = profile.addon.slug;
  if (profile.addon.sources) {
    generic.url64 = profile.addon.sources.x64;
    generic.url32 = profile.addon.sources.x86;
  }
  return generic;
}

/** Generates the exact v3 wire vocabulary expected by older applications. */
export function buildLegacyV3Manifest(v1Manifest) {
  return {
    schema_version: 3,
    generated_at: v1Manifest.generated_at,
    reshade: RESHADE,
    generics: v1Manifest.engine_profiles.map(legacyGeneric),
    defaults: { ...DEFAULTS },
    titles: v1Manifest.games.map(legacyTitle),
  };
}
