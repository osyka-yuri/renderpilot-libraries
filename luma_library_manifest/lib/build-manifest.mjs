import {
  collectMatchedAppids,
  normalizeAppids,
  normalizeExeName,
  validateOverlay,
} from "./overlay.mjs";
import {
  assertPlainObject,
  deepFreeze,
  requiredNonEmptyString,
} from "../../scripts/lib/common.mjs";
import { RESHADE_NIGHTLY } from "../../scripts/lib/reshade-sources.mjs";
import {
  DEFAULTS,
  VALID_STATUSES,
  applyChannel,
  applyMinAppVersion,
  assertUniqueMatchRules,
  countTitlesByCategoryKind,
  createDerivedExeResolver,
  makeMatchRules,
  normalizeExeCache,
  normalizedStatus,
  reserveOutputId,
} from "../../scripts/lib/build-manifest-shared.mjs";

export const SCHEMA_VERSION = 1;

// Luma always installs the nightly ReShade host (no stable field, unlike
// RenoDX) and the minimum host version its current builds require against a
// reused foreign host (see `addons::luma::types::LumaReshadeConfig`).
export const RESHADE = deepFreeze({
  min_version: "6.7.0",
  nightly: RESHADE_NIGHTLY,
});

const ASSET_PREFIX = "Luma-";
const ASSET_SUFFIX = ".zip";
const ASSET_FORBIDDEN_MARKERS = ["-test", "-dev"];
const ASSET_X32_SUFFIX = "-x32";
const ASSET_NAME_CHAR_RE = /^[A-Za-z0-9._()'-]+$/u;

export function buildManifest({
  curatedGames,
  overlay = {},
  exeCache = {},
  generatedAt,
  warn = console.warn,
} = {}) {
  const games = normalizeCuratedGames(curatedGames);
  const overlayById = assertOverlayShape(overlay);
  const curatedIds = new Set(games.map((game) => game.id));

  validateOverlay(overlayById, curatedIds, warn);

  const activeAppids = collectMatchedAppids(games, overlayById);
  const { exeToAppids, exeCache: normalizedExeCache } = normalizeExeCache(
    exeCache,
    activeAppids,
  );

  const { uniqueExesForAppids, ambiguousDerivedExeKeys } = createDerivedExeResolver(
    normalizedExeCache,
    exeToAppids,
  );

  const titles = [];
  const pending = [];
  const seenOutputIds = new Set();

  for (const game of games) {
    reserveOutputId(seenOutputIds, game.id, `curated_games.json "${game.id}"`);

    const entry = overlayById[game.id] ?? {};

    if (entry.ignore) {
      // Cleanly skip a row (e.g. a duplicate or retired curation entry) so it
      // doesn't clutter pending_match.json.
      continue;
    }

    const appids = normalizeAppids(entry, `overlay "${game.id}"`);
    const exe = normalizeExeName(entry.exe, `overlay "${game.id}".exe`);

    if (appids.length === 0 && !exe) {
      pending.push({ id: game.id, name: game.name, asset: game.asset, arch: game.arch });
      continue;
    }

    titles.push(
      makeTitle({
        game,
        appids,
        exe,
        derivedExes: uniqueExesForAppids(appids),
      }),
    );
  }

  assertUniqueMatchRules(titles);

  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      reshade: RESHADE,
      defaults: DEFAULTS,
      titles,
    },
    pending,
    stats: buildStats(titles, pending, ambiguousDerivedExeKeys),
  };
}

function makeTitle({ game, appids, exe, derivedExes }) {
  const status = normalizedStatus(game.status, VALID_STATUSES);
  const title = {
    id: game.id,
    name: game.name,
    asset: game.asset,
    arch: game.arch,
  };

  if (status !== "unknown") {
    title.status = status;
  }

  if (game.category) {
    title.category = game.category;
  }

  title.match = makeMatchRules({ id: game.id, appids, exe, derivedExes });

  applyChannel(title, status);
  applyMinAppVersion(title, game);

  if (game.launch_args.length > 0) {
    title.launch_args = game.launch_args;
  }

  if (game.generic) {
    title.generic = true;
  }

  if (game.notes_keys.length > 0) {
    title.notes_keys = game.notes_keys;
  }

  return title;
}

function normalizeCuratedGames(curatedGames) {
  if (!Array.isArray(curatedGames)) {
    throw new Error("curated_games.json must be an array");
  }

  return curatedGames.map((game, index) => normalizeCuratedGame(game, index));
}

function normalizeCuratedGame(game, index) {
  const context = `curated_games.json[${index}]`;

  assertPlainObject(game, context);

  const id = requiredNonEmptyString(game.id, `${context}.id`);
  const arch = requiredNonEmptyString(game.arch, `${context}.arch`);

  return {
    id,
    name: requiredNonEmptyString(game.name, `${context}.name`),
    asset: normalizeAsset(
      requiredNonEmptyString(game.asset, `${context}.asset`),
      arch,
      context,
    ),
    arch,
    status: game.status,
    category: normalizeCategory(game.blacklist, context),
    min_app_version: game.min_app_version,
    launch_args: normalizeOptionalStringArray(game.launch_args, `${context}.launch_args`),
    generic: Boolean(game.generic),
    notes_keys: normalizeOptionalStringArray(game.notes_keys, `${context}.notes_keys`),
  };
}

function normalizeAsset(asset, arch, context) {
  const stem = asset.startsWith(ASSET_PREFIX) ? asset.slice(ASSET_PREFIX.length) : null;
  const stemWithoutSuffix =
    stem !== null && stem.endsWith(ASSET_SUFFIX)
      ? stem.slice(0, -ASSET_SUFFIX.length)
      : null;

  if (!stemWithoutSuffix) {
    throw new Error(
      `${context}.asset "${asset}" must match ${ASSET_PREFIX}<name>[-x32]${ASSET_SUFFIX}`,
    );
  }

  const lower = stemWithoutSuffix.toLowerCase();
  if (ASSET_FORBIDDEN_MARKERS.some((marker) => lower.endsWith(marker))) {
    throw new Error(
      `${context}.asset "${asset}" is a non-Publishing build (-Test/-Dev); only Publishing assets are curated`,
    );
  }

  const isX32 = stemWithoutSuffix.endsWith(ASSET_X32_SUFFIX);
  const namePart = isX32
    ? stemWithoutSuffix.slice(0, -ASSET_X32_SUFFIX.length)
    : stemWithoutSuffix;

  if (namePart.length === 0 || !ASSET_NAME_CHAR_RE.test(namePart)) {
    throw new Error(`${context}.asset "${asset}" has an invalid name component`);
  }

  const expectedX32 = arch === "X86";
  if (isX32 !== expectedX32) {
    throw new Error(
      `${context}.asset "${asset}" -x32 suffix must agree with arch (${arch})`,
    );
  }

  return asset;
}

function normalizeCategory(blacklist, context) {
  if (blacklist === undefined) {
    return null;
  }

  return {
    kind: "blacklist",
    reason: requiredNonEmptyString(blacklist, `${context}.blacklist`),
  };
}

function normalizeOptionalStringArray(value, context) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  return value.map((item, index) => requiredNonEmptyString(item, `${context}[${index}]`));
}

function assertOverlayShape(overlay) {
  assertPlainObject(overlay, "match_overlay.json");
  return overlay;
}

function buildStats(titles, pending, ambiguousDerivedExeKeys) {
  return {
    titles: titles.length,
    pending: pending.length,
    ambiguousDerivedExes: ambiguousDerivedExeKeys.size,
    generic: titles.filter((title) => title.generic).length,
    blacklist: countTitlesByCategoryKind(titles, "blacklist"),
  };
}
