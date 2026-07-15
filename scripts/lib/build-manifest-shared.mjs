// Shared building blocks for the add-on manifest builders
// (`catalogs/addons/renodx/lib/build-manifest.mjs` and
// `catalogs/addons/luma/lib/build-manifest.mjs`). The pipelines emit different
// public shapes, but the low-level machinery — match-rule uniqueness, the
// exe-cache → derived-exe resolver, match-rule construction, id reservation,
// and id reservation — is identical and lives here.
//
// Tool-specific `buildManifest` / assemble / normalize / `buildStats` stay in
// each catalogue's own `build-manifest.mjs`.

import { addCaseInsensitiveUnique } from "./common.mjs";
import { normalizeAppid, normalizeCachedExes } from "./overlay-shared.mjs";

export const MATCH_TIERS = Object.freeze({
  steamAppid: 100,
  exeName: 70,
});

export const VALID_STATUSES = Object.freeze(
  new Set(["working", "construction", "unknown"]),
);

export function assertUniqueMatchRules(titles, maxDuplicateDetails = 10) {
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
    .slice(0, maxDuplicateDetails)
    .map(([key, ids]) => `${key} -> ${ids.join(", ")}`)
    .join("; ");

  const suffix =
    duplicates.length > maxDuplicateDetails
      ? `; ...and ${duplicates.length - maxDuplicateDetails} more`
      : "";

  throw new Error(`duplicate match rules: ${details}${suffix}`);
}

function matchRuleKey(rule) {
  return `${rule.kind}:${String(rule.value ?? "").toLowerCase()}`;
}

function exeKey(exe) {
  return exe.toLowerCase();
}

export function normalizeExeCache(exeCache, activeAppids) {
  const exeToAppids = new Map();
  const normalizedCache = Object.create(null);

  for (const [appidValue, exes] of Object.entries(exeCache)) {
    const appid = normalizeAppid(appidValue, `steam-appid-exe.json key "${appidValue}"`);

    if (!activeAppids.has(appid)) {
      continue;
    }

    const normalizedExes = normalizeCachedExes(exes, `steam-appid-exe.json.${appid}`);
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

export function createDerivedExeResolver(normalizedExeCache, exeToAppids) {
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

function collectExeNames(exe, derivedExes) {
  const exeNames = [];

  addCaseInsensitiveUnique(exeNames, exe);

  for (const derivedExe of derivedExes) {
    addCaseInsensitiveUnique(exeNames, derivedExe);
  }

  return exeNames;
}

export function makeMatchRules({ id, appids, exe, derivedExes }) {
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

export function normalizedStatus(status, validStatuses) {
  if (typeof status !== "string") {
    return "unknown";
  }

  const normalized = status.trim().toLowerCase();
  return validStatuses.has(normalized) ? normalized : "unknown";
}

export function reserveOutputId(seenIds, id, context) {
  if (seenIds.has(id)) {
    throw new Error(`duplicate title id "${id}" at ${context}`);
  }

  seenIds.add(id);
}
