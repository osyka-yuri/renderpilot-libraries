import {
  VALID_STATUSES,
  assertUniqueMatchRules,
  normalizedStatus,
  reserveOutputId,
} from "../../../../scripts/lib/build-manifest-shared.mjs";
import { normalizeCuratedGames } from "./authoring-profile.mjs";
import { SCHEMA_VERSION } from "./v1.mjs";

// Luma's add-on-loader compatibility floor for reusing an already-present
// ReShade host. Download URLs live in the standalone ReShade v1 catalogue.
export const MIN_RESHADE_VERSION = "6.7.0";

/** Builds the public Luma v1 wire document from normalized authoring profiles. */
export function buildManifest({ curatedGames, generatedAt } = {}) {
  const profiles = normalizeCuratedGames(curatedGames);
  const games = [];
  const pending = [];
  const seenOutputIds = new Set();

  for (const profile of profiles) {
    reserveOutputId(seenOutputIds, profile.id, `curated_games.json "${profile.id}"`);

    if (profile.match_ignore) continue;

    if (profile.match.length === 0) {
      pending.push({
        id: profile.id,
        name: profile.name,
        asset: profile.asset,
        arch: profile.arch,
      });
      continue;
    }

    games.push(assembleGame(profile));
  }

  assertUniqueMatchRules(games);
  assertAssetPayloadIdentity(games);
  assertUniqueGuidanceIds(games);

  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      minimum_reshade_version: MIN_RESHADE_VERSION,
      games,
    },
    pending,
    stats: buildStats(games, pending),
  };
}

function assembleGame(profile) {
  const requirements = {};
  if (profile.launch_args.length > 0) {
    requirements.launch_arguments = profile.launch_args;
  }
  if (profile.external_requirement) {
    requirements.managed_dependency = profile.external_requirement;
  }

  const game = {
    id: profile.id,
    name: profile.name,
    architecture: profile.arch,
    status: normalizedStatus(profile.status, VALID_STATUSES),
    match: profile.match,
    package: {
      release_asset: profile.asset,
      addon_file: profile.addon_file,
    },
    profile: profile.profile,
  };

  if (profile.blacklist) {
    game.availability = {
      kind: "blocked",
      message: {
        id: profile.blacklist,
        fallback_text: "This Luma profile is unavailable.",
      },
    };
  }

  if (profile.features) game.features = profile.features;
  if (Object.keys(requirements).length > 0) game.requirements = requirements;
  if (profile.guidance.length > 0) game.guidance = profile.guidance;
  return game;
}

function assertAssetPayloadIdentity(games) {
  const payloadByAsset = new Map();
  for (const game of games) {
    const asset = game.package.release_asset;
    const addonFile = game.package.addon_file;
    const previous = payloadByAsset.get(asset);
    if (previous !== undefined && previous !== addonFile) {
      throw new Error(
        `asset "${asset}" maps to multiple root add-ons: "${previous}" and "${addonFile}"`,
      );
    }
    payloadByAsset.set(asset, addonFile);
  }
}

function assertUniqueGuidanceIds(games) {
  const seen = new Map();
  for (const game of games) {
    for (const guidance of game.guidance ?? []) {
      const existing = seen.get(guidance.id);
      if (existing) {
        throw new Error(
          `guidance id "${guidance.id}" is used by both "${existing}" and "${game.id}"`,
        );
      }
      seen.set(guidance.id, game.id);
    }
  }
}

function buildStats(games, pending) {
  return {
    games: games.length,
    pending: pending.length,
    engineProfiles: games.filter((game) => game.profile !== "game").length,
    blacklist: games.filter((game) => game.availability?.kind === "blocked").length,
  };
}
