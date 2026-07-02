import {
  addCaseInsensitiveUnique,
  categoryOf,
  collectMatchedAppids,
  inheritedSplitOverlay,
  normalizeAppid,
  normalizeAppids,
  normalizeCachedExes,
  normalizeExeName,
  normalizeSlug,
  validateOverlay,
} from "./overlay.mjs";
import {
  isPlainObject,
  assertPlainObject,
  requiredNonEmptyString,
  deepFreeze,
} from "../../scripts/lib/common.mjs";

export const SCHEMA_VERSION = 3;
export const RENODX_SOURCE = "https://github.com/clshortfuse/renodx/wiki/Mods";

export const DEFAULT_RISK = deepFreeze({
  anticheat_engine: "none",
  online: "singleplayer",
  severity: "info",
  message_key: "renodx.risk.sp_safe",
  confidence: "medium",
  source: RENODX_SOURCE,
});

export const DEFAULTS = deepFreeze({
  risk: DEFAULT_RISK,
  min_app_version: "1.0.0",
  channel: "stable",
});

export const RESHADE = deepFreeze({
  stable: {
    url: "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
  },
  nightly: {
    url64:
      "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(64-bit).zip",
    url32:
      "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(32-bit).zip",
  },
});

export const GENERICS = deepFreeze([
  {
    engine: "unity",
    slug: "unityengine",
    url64:
      "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon64",
    url32:
      "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon32",
    label_key: "renodx.generic.unity",
  },
  {
    engine: "unreal",
    slug: "unrealengine",
    label_key: "renodx.generic.universal",
  },
]);

const VALID_STATUSES = new Set(["working", "construction", "unknown"]);
const MATCH_TIERS = Object.freeze({
  steamAppid: 100,
  exeName: 70,
});

const MAX_DUPLICATE_DETAILS = 10;
const SOURCE_DATE_EPOCH = "SOURCE_DATE_EPOCH";

export function generatedAtFromEnv(env = process.env) {
  const epoch = parseSourceDateEpoch(env);
  const date = epoch === null ? new Date() : new Date(epoch * 1000);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${SOURCE_DATE_EPOCH} is outside the supported date range`);
  }

  return `${date.toISOString().slice(0, 10)}T00:00:00Z`;
}

export function assertUniqueMatchRules(titles) {
  const ownersByRule = new Map();

  for (const title of titles) {
    for (const rule of title.match) {
      const key = matchRuleKey(rule);
      const owners = ownersByRule.get(key) ?? [];

      owners.push(title.id);
      ownersByRule.set(key, owners);
    }
  }

  const duplicates = [...ownersByRule.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));

  if (duplicates.length === 0) return;

  const details = duplicates
    .slice(0, MAX_DUPLICATE_DETAILS)
    .map(([key, ids]) => `${key} -> ${ids.join(", ")}`)
    .join("; ");

  const suffix =
    duplicates.length > MAX_DUPLICATE_DETAILS
      ? `; ...and ${duplicates.length - MAX_DUPLICATE_DETAILS} more`
      : "";

  throw new Error(`duplicate match rules: ${details}${suffix}`);
}

export function buildManifest({
  wiki,
  overlay = {},
  exeCache = {},
  generatedAt = generatedAtFromEnv(),
  warn = console.warn,
} = {}) {
  const wikiGames = normalizeWikiGames(wiki);
  const overlayById = normalizeOverlayInput(overlay);
  const wikiIds = new Set(wikiGames.map((game) => game.id));

  validateOverlay(overlayById, wikiIds, warn);

  const activeAppids = collectMatchedAppids(wikiGames, overlayById);
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

  const emit = ({ id, name, slug, arch, status, entry, context }) => {
    reserveOutputId(seenOutputIds, id, context);

    const appids = normalizeAppids(entry, context);
    const exe = normalizeExeName(entry.exe, `${context}.exe`);

    if (entry.ignore) {
      // Cleanly skip duplicate or broken wiki entries so they don't clutter pending_match
      return;
    }

    if (appids.length === 0 && !exe) {
      pending.push({ id, name, slug, arch });
      return;
    }

    titles.push(
      makeTitle({
        id,
        name,
        slug,
        arch,
        status,
        appids,
        exe,
        derivedExes: uniqueExesForAppids(appids),
        overlay: entry,
        category: categoryOf(entry, context),
      }),
    );
  };

  for (const game of wikiGames) {
    const entry = overlayById[game.id] ?? {};
    const baseSlug = normalizeSlug(entry.slug ?? game.slug, `overlay "${game.id}".slug`);

    if (Array.isArray(entry.split)) {
      emitSplits({ game, entry, emit });
      continue;
    }

    emit({
      id: game.id,
      name: game.name,
      slug: baseSlug,
      arch: game.arch,
      status: game.status,
      entry,
      context: `overlay "${game.id}"`,
    });
  }

  assertUniqueMatchRules(titles);

  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      reshade: RESHADE,
      generics: GENERICS,
      defaults: DEFAULTS,
      titles,
    },
    pending,
    stats: buildStats(titles, pending, ambiguousDerivedExeKeys),
  };
}

function emitSplits({ game, entry, emit }) {
  for (const [index, split] of entry.split.entries()) {
    const context = `overlay "${game.id}".split[${index}]`;
    const splitOverlay = inheritedSplitOverlay(entry, split);
    const suffix = requiredNonEmptyString(split.suffix, `${context}.suffix`);
    const name = requiredNonEmptyString(split.name, `${context}.name`);
    const slug = normalizeSlug(splitOverlay.slug ?? game.slug, `${context}.slug`);

    emit({
      id: `${game.id}-${suffix}`,
      name,
      slug,
      arch: game.arch,
      status: game.status,
      entry: splitOverlay,
      context,
    });
  }
}

function makeTitle({
  id,
  name,
  slug,
  arch,
  status,
  appids,
  exe,
  derivedExes,
  overlay,
  category,
}) {
  const titleStatus = normalizedStatus(status);
  const title = {
    id,
    name,
    slug,
    arch,
    status: titleStatus,
  };

  if (category) {
    title.category = category;
  }

  title.match = makeMatchRules({ id, appids, exe, derivedExes });

  applyChannel(title, titleStatus);
  applyMinAppVersion(title, overlay);
  applyCompatibility(title, overlay);
  applyRisk(title, overlay);
  applyOptionalOverlayFields(title, overlay);

  return title;
}

function makeMatchRules({ id, appids, exe, derivedExes }) {
  const match = appids.map((appid) => ({
    kind: "steam_appid",
    value: appid,
    tier: MATCH_TIERS.steamAppid,
  }));

  for (const exeName of collectExeNames(exe, derivedExes)) {
    match.push({
      kind: "exe_name",
      value: exeName,
      tier: MATCH_TIERS.exeName,
    });
  }

  if (match.length === 0) {
    throw new Error(`title "${id}" has no match rules`);
  }

  return match;
}

function collectExeNames(exe, derivedExes) {
  const exeNames = [];

  addCaseInsensitiveUnique(exeNames, exe);

  for (const derivedExe of derivedExes) {
    addCaseInsensitiveUnique(exeNames, derivedExe);
  }

  return exeNames;
}

function applyChannel(title, status) {
  const channel = status === "working" ? "stable" : "beta";

  if (channel !== DEFAULTS.channel) {
    title.channel = channel;
  }
}

function applyMinAppVersion(title, overlay) {
  const minAppVersion = overlay.min_app_version ?? DEFAULTS.min_app_version;

  if (minAppVersion !== DEFAULTS.min_app_version) {
    title.min_app_version = minAppVersion;
  }
}

function applyCompatibility(title, overlay) {
  const compatibility = {};

  if (overlay.required_api) {
    compatibility.required_api = overlay.required_api;
  }

  if (overlay.conflicts) {
    compatibility.conflicts = overlay.conflicts;
  }

  if (Object.keys(compatibility).length > 0) {
    title.compatibility = compatibility;
  }
}

function applyRisk(title, overlay) {
  const risk = {
    ...DEFAULT_RISK,
    ...(overlay.risk ?? {}),
  };

  if (!isDefaultRisk(risk)) {
    title.risk = risk;
  }
}

function applyOptionalOverlayFields(title, overlay) {
  if (overlay.proxy_dll_override) {
    title.proxy_dll_override = overlay.proxy_dll_override;
  }

  if (overlay.notes_keys) {
    title.notes_keys = overlay.notes_keys;
  }

  if (overlay.download_url) {
    title.download_url = overlay.download_url.trim();
  }
}

function normalizeExeCache(exeCache, activeAppids) {
  assertPlainObject(exeCache, "appid_exe.json");

  const exeToAppids = new Map();
  const normalizedCache = Object.create(null);

  for (const [appidValue, exes] of Object.entries(exeCache)) {
    const appid = normalizeAppid(appidValue, `appid_exe.json key "${appidValue}"`);

    if (!activeAppids.has(appid)) {
      continue;
    }

    const normalizedExes = normalizeCachedExes(exes, `appid_exe.json.${appid}`);
    normalizedCache[appid] = normalizedExes;

    for (const exe of normalizedExes) {
      const key = exeKey(exe);
      const owners = exeToAppids.get(key) ?? new Set();

      owners.add(appid);
      exeToAppids.set(key, owners);
    }
  }

  return { exeToAppids, exeCache: normalizedCache };
}

function createDerivedExeResolver(normalizedExeCache, exeToAppids) {
  const ambiguousDerivedExeKeys = new Set();

  const uniqueExesForAppids = (appids) => {
    const result = [];
    const appidSet = new Set(appids);

    for (const appid of appids) {
      for (const exe of normalizedExeCache[appid] ?? []) {
        const owners = exeToAppids.get(exeKey(exe)) ?? new Set();

        if (allOwnersAreInSet(owners, appidSet)) {
          addCaseInsensitiveUnique(result, exe);
        } else {
          ambiguousDerivedExeKeys.add(exeKey(exe));
        }
      }
    }

    return result;
  };

  return { uniqueExesForAppids, ambiguousDerivedExeKeys };
}

function allOwnersAreInSet(owners, allowedOwners) {
  for (const owner of owners) {
    if (!allowedOwners.has(owner)) {
      return false;
    }
  }

  return true;
}

function normalizeWikiGames(wiki) {
  if (!Array.isArray(wiki)) {
    throw new Error("wiki_games.json must be an array");
  }

  return wiki.map((game, index) => normalizeWikiGame(game, index));
}

function normalizeWikiGame(game, index) {
  const context = `wiki_games.json[${index}]`;

  assertPlainObject(game, context);

  return {
    ...game,
    id: requiredNonEmptyString(game.id, `${context}.id`),
    name: requiredNonEmptyString(game.name, `${context}.name`),
    slug: normalizeSlug(
      requiredNonEmptyString(game.slug, `${context}.slug`),
      `${context}.slug`,
    ),
    arch: requiredNonEmptyString(game.arch, `${context}.arch`),
  };
}

function normalizeOverlayInput(overlay) {
  assertPlainObject(overlay, "match_overlay.json");
  return overlay;
}

function normalizedStatus(status) {
  if (typeof status !== "string") {
    return "unknown";
  }

  const normalized = status.trim().toLowerCase();
  return VALID_STATUSES.has(normalized) ? normalized : "unknown";
}

function buildStats(titles, pending, ambiguousDerivedExeKeys) {
  return {
    titles: titles.length,
    pending: pending.length,
    generics: GENERICS.length,
    ambiguousDerivedExes: ambiguousDerivedExeKeys.size,
    external: countTitlesByCategoryKind(titles, "external"),
    nativeHdr: countTitlesByCategoryKind(titles, "native_hdr"),
    blacklist: countTitlesByCategoryKind(titles, "blacklist"),
  };
}

function countTitlesByCategoryKind(titles, kind) {
  return titles.filter((title) => title.category?.kind === kind).length;
}

function reserveOutputId(seenIds, id, context) {
  if (seenIds.has(id)) {
    throw new Error(`duplicate title id "${id}" at ${context}`);
  }

  seenIds.add(id);
}

function isDefaultRisk(risk) {
  const defaultKeys = Object.keys(DEFAULT_RISK);
  const riskKeys = Object.keys(risk);

  return (
    riskKeys.length === defaultKeys.length &&
    defaultKeys.every((key) => risk[key] === DEFAULT_RISK[key])
  );
}

function matchRuleKey(rule) {
  return `${rule.kind}:${String(rule.value ?? "").toLowerCase()}`;
}

function exeKey(exe) {
  return exe.toLowerCase();
}

function parseSourceDateEpoch(env) {
  if (!Object.prototype.hasOwnProperty.call(env, SOURCE_DATE_EPOCH)) {
    return null;
  }

  const raw = env[SOURCE_DATE_EPOCH];

  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const value = String(raw).trim();

  if (!/^\d+$/.test(value)) {
    throw new Error(`${SOURCE_DATE_EPOCH} must be a non-negative integer`);
  }

  const seconds = Number(value);

  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${SOURCE_DATE_EPOCH} must be a safe integer`);
  }

  return seconds;
}
