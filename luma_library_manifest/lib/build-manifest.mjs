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
import {
  SEMVER_RE,
  DIRECTX_GRAPHICS_APIS,
  RESHADE_PROXY_DLLS,
  assertSemver,
  assertSingleLineString,
  assertOptionalSingleLineString,
  assertOptionalNonEmptyStringArray,
  assertAllowedValue,
  assertAllowedValues,
  assertUniqueStringValues,
} from "../../scripts/lib/validators.mjs";

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
const EXTERNAL_REQUIREMENT_KIND = "dgvoodoo2";

// ── Layer 1: buildManifest – orchestrate normalize → validate → assemble ──

/**
 * Orchestrates the three-layer manifest build:
 *  1. Normalize & validate every authoring input.
 *  2. Ensure structural invariants (unique match rules, output ids).
 *  3. Assemble the public wire-shape objects.
 *
 * Returns `{ manifest, pending, stats }` for the shared runner to format/write.
 */
export function buildManifest({
  curatedGames,
  overlay = {},
  exeCache = {},
  generatedAt,
  warn = console.warn,
} = {}) {
  // ── Layer 1: normalize and validate ──

  const games = normalizeCuratedGames(curatedGames);
  const overlayById = assertPlainObject(overlay, "match_overlay.json");
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

  // ── Layer 2: assemble wire-shape ──

  const titles = [];
  const pending = [];
  const seenOutputIds = new Set();

  for (const game of games) {
    reserveOutputId(seenOutputIds, game.id, `curated_games.json "${game.id}"`);

    const entry = overlayById[game.id] ?? {};

    if (entry.ignore) {
      continue;
    }

    const appids = normalizeAppids(entry, `overlay "${game.id}"`);
    const exe = normalizeExeName(entry.exe, `overlay "${game.id}".exe`);

    if (appids.length === 0 && !exe) {
      pending.push({ id: game.id, name: game.name, asset: game.asset, arch: game.arch });
      continue;
    }

    titles.push(
      assembleTitle({
        game,
        appids,
        exe,
        derivedExes: uniqueExesForAppids(appids),
      }),
    );
  }

  // ── Layer 3: validate cross-title invariants ──

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

// ── Layer 2: assemble a single title wire-shape ──

function assembleTitle({ game, appids, exe, derivedExes }) {
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

  if (game.external_requirement) {
    title.external_requirement = game.external_requirement;
  }

  if (game.generic) {
    title.generic = true;
  }

  if (game.notes_keys.length > 0) {
    title.notes_keys = game.notes_keys;
  }

  return title;
}

// ── Layer 1: normalize + validate ──

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
    launch_args: assertOptionalNonEmptyStringArray(
      game.launch_args,
      `${context}.launch_args`,
    ),
    external_requirement: normalizeExternalRequirement(
      game.external_requirement,
      `${context}.external_requirement`,
    ),
    generic: Boolean(game.generic),
    notes_keys: assertOptionalNonEmptyStringArray(game.notes_keys, `${context}.notes_keys`),
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

// ── Layer 1a: normalize external_requirement (Luma-specific) ──

function normalizeExternalRequirement(value, context) {
  if (value === undefined) {
    return null;
  }

  assertPlainObject(value, context);

  const kind = requiredNonEmptyString(value.kind, `${context}.kind`);
  if (kind !== EXTERNAL_REQUIREMENT_KIND) {
    throw new Error(`${context}.kind must be "${EXTERNAL_REQUIREMENT_KIND}"`);
  }

  const version = assertSemver(
    requiredNonEmptyString(value.version, `${context}.version`),
    `${context}.version`,
  );

  return {
    kind,
    version,
    accepted_detected_apis: normalizeAcceptedDetectedApis(
      value.accepted_detected_apis,
      `${context}.accepted_detected_apis`,
    ),
    proxy_dll: normalizeExternalProxyDll(value.proxy_dll, `${context}.proxy_dll`),
    config: normalizeExternalConfig(value.config, `${context}.config`),
  };
}

function normalizeAcceptedDetectedApis(value, context) {
  const apis = assertOptionalNonEmptyStringArray(value, context);
  if (apis.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }
  assertAllowedValues(apis, DIRECTX_GRAPHICS_APIS, context);
  return assertUniqueStringValues(apis, context);
}

function normalizeExternalProxyDll(value, context) {
  return assertAllowedValue(
    requiredNonEmptyString(value, context).toLowerCase(),
    RESHADE_PROXY_DLLS,
    context,
  );
}

function normalizeExternalConfig(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  return value.map((section, index) =>
    normalizeExternalConfigSection(section, `${context}[${index}]`),
  );
}

function normalizeExternalConfigSection(value, context) {
  assertPlainObject(value, context);
  return {
    section: assertSingleLineString(value.section, `${context}.section`),
    entries: normalizeExternalConfigEntries(value.entries, `${context}.entries`),
  };
}

function normalizeExternalConfigEntries(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  return value.map((entry, index) =>
    normalizeExternalConfigEntry(entry, `${context}[${index}]`),
  );
}

function normalizeExternalConfigEntry(value, context) {
  assertPlainObject(value, context);
  const entry = {
    key: assertSingleLineString(value.key, `${context}.key`),
    value: assertSingleLineString(value.value, `${context}.value`),
  };

  if (value.comment !== undefined) {
    entry.comment = assertOptionalSingleLineString(value.comment, `${context}.comment`);
  }

  return entry;
}

// ── Layer 3: stats ──

function buildStats(titles, pending, ambiguousDerivedExeKeys) {
  return {
    titles: titles.length,
    pending: pending.length,
    ambiguousDerivedExes: ambiguousDerivedExeKeys.size,
    generic: titles.filter((title) => title.generic).length,
    blacklist: countTitlesByCategoryKind(titles, "blacklist"),
  };
}
