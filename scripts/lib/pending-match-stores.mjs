import path from "node:path";

import { normalizeMatchRules as normalizeLumaMatchRules } from "../../catalogs/addons/luma/lib/authoring-profile.mjs";
import { collectOverlayAppids as collectRenoOverlayAppIds } from "../../catalogs/addons/renodx/lib/overlay.mjs";
import { MATCH_TIERS } from "./build-manifest-shared.mjs";
import { isMissingFileError } from "./common.mjs";
import { readJsonFileAsync, writeFormattedJsonFile } from "./json.mjs";
import { normalizeAppid } from "./overlay-shared.mjs";

export async function createRenodxPendingStore(files) {
  const matchOverlay = await readOptionalJsonFile(
    files.matchOverlay,
    () => new Map(),
    validateMatchOverlay,
    "No existing match_overlay.json found, starting fresh.",
  );

  return {
    ...createRenodxStoreApi(matchOverlay),
    async save() {
      await writeFormattedJsonFile(files.matchOverlay, mapToSortedObject(matchOverlay));
    },
  };
}

export async function createLumaPendingStore(files) {
  const profiles = await readJsonFile(files.profiles, validateLumaProfiles);

  return {
    ...createLumaStoreApi(profiles),
    async save() {
      await writeFormattedJsonFile(files.profiles, profiles);
    },
  };
}

export function createRenodxStoreApi(matchOverlay) {
  return {
    isResolved(gameId) {
      const target = findRenodxTarget(matchOverlay, gameId);
      return target !== null && hasResolution(target.entry, target.parent);
    },
    claimAppIds() {
      return collectOverlaySteamAppIds(matchOverlay);
    },
    applyMatch(gameId, appid) {
      const target = getOrCreateRenodxTarget(matchOverlay, gameId);
      target.appids = [normalizeAppid(appid, `pending match "${gameId}" AppID`)];
      delete target.appid;
      delete target.ignore;
    },
    applyDuplicateIgnore(gameId) {
      const target = getOrCreateRenodxTarget(matchOverlay, gameId);
      delete target.appid;
      delete target.appids;
      delete target.exe;
      target.ignore = true;
    },
  };
}

function findRenodxTarget(matchOverlay, gameId) {
  const direct = matchOverlay.get(gameId);
  if (direct) return { entry: direct, parent: null };

  for (const [parentId, parent] of matchOverlay) {
    for (const split of Array.isArray(parent.split) ? parent.split : []) {
      if (isRecord(split) && `${parentId}-${split.suffix}` === gameId) {
        return { entry: split, parent };
      }
    }
  }

  return null;
}

function getOrCreateRenodxTarget(matchOverlay, gameId) {
  const existing = findRenodxTarget(matchOverlay, gameId);
  if (existing) return existing.entry;

  const entry = {};
  matchOverlay.set(gameId, entry);
  return entry;
}

function hasResolution(entry, inherited = null) {
  if (entry.ignore === true || inherited?.ignore === true) return true;
  if (nonEmpty(entry.exe) || nonEmpty(entry.appid)) return true;
  if (Array.isArray(entry.appids) && entry.appids.some(nonEmpty)) return true;

  // A split collection is resolved only when every emitted split has a match
  // or an explicit ignore. Metadata such as category alone is not a match.
  return (
    Array.isArray(entry.split) &&
    entry.split.length > 0 &&
    entry.split.every((split) => hasResolution(split, entry))
  );
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function createLumaStoreApi(profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  return {
    isResolved(gameId) {
      const profile = byId.get(gameId);
      return Boolean(
        profile && (profile.match_ignore === true || (profile.match?.length ?? 0) > 0),
      );
    },
    claimAppIds() {
      return collectProfileSteamAppIds(profiles);
    },
    applyMatch(gameId, appid) {
      const profile = requiredProfile(byId, gameId);
      profile.match = [{ kind: "steam_appid", value: appid, tier: MATCH_TIERS.steamAppid }];
      delete profile.match_ignore;
    },
    applyDuplicateIgnore(gameId) {
      const profile = requiredProfile(byId, gameId);
      profile.match_ignore = true;
      if (!Array.isArray(profile.match)) profile.match = [];
    },
  };
}

function requiredProfile(byId, gameId) {
  const profile = byId.get(gameId);
  if (!profile) {
    throw new Error(`curated_games.json has no profile for pending game "${gameId}"`);
  }
  return profile;
}

export function validateMatchOverlay(value, filePath) {
  if (!isRecord(value)) {
    throw new TypeError(`${filePath} must contain an object.`);
  }

  const overlay = new Map();
  for (const [gameId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new TypeError(`match_overlay.json entry "${gameId}" must be an object.`);
    }
    const normalizedEntry = { ...entry };
    if ("appids" in normalizedEntry) {
      if (!Array.isArray(normalizedEntry.appids)) {
        throw new TypeError(
          `match_overlay.json entry "${gameId}".appids must be an array.`,
        );
      }
      normalizedEntry.appids = normalizedEntry.appids.map(String);
    }
    if ("ignore" in normalizedEntry && typeof normalizedEntry.ignore !== "boolean") {
      throw new TypeError(`match_overlay.json entry "${gameId}".ignore must be boolean.`);
    }
    overlay.set(String(gameId), normalizedEntry);
  }
  return overlay;
}

export function collectOverlaySteamAppIds(matchOverlay) {
  const appIds = new Set();
  collectRenoOverlayAppIds(mapToSortedObject(matchOverlay), appIds);
  return appIds;
}

export function collectProfileSteamAppIds(profiles) {
  const appIds = new Set();
  for (const [profileIndex, profile] of profiles.entries()) {
    for (const [ruleIndex, rule] of (profile.match ?? []).entries()) {
      if (isSteamAppIdRule(rule)) {
        appIds.add(
          normalizeAppid(
            rule.value,
            `curated_games.json[${profileIndex}].match[${ruleIndex}].value`,
          ),
        );
      }
    }
  }
  return appIds;
}

async function readJsonFile(filePath, validate) {
  const parsedJson = await readJsonFileAsync(filePath, path.basename(filePath));
  return validate(parsedJson, path.basename(filePath));
}

async function readOptionalJsonFile(filePath, fallback, validate, missingMessage) {
  try {
    return await readJsonFile(filePath, validate);
  } catch (error) {
    if (isMissingFileError(error)) {
      console.log(missingMessage);
      return fallback();
    }
    throw error;
  }
}

function validateLumaProfiles(value, filePath) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${filePath} must contain an array.`);
  }

  const ids = new Set();
  return value.map((profile, index) => {
    if (!isRecord(profile)) {
      throw new TypeError(`curated_games.json item #${index + 1} must be an object.`);
    }
    const id = toNonEmptyString(profile.id);
    if (!id || ids.has(id)) {
      throw new TypeError(
        `curated_games.json contains an invalid or duplicate id at #${index + 1}.`,
      );
    }
    ids.add(id);

    if (profile.match_ignore !== undefined && typeof profile.match_ignore !== "boolean") {
      throw new TypeError(
        `curated_games.json item #${index + 1}.match_ignore must be boolean.`,
      );
    }

    const normalized = { ...profile, id };
    if (profile.match !== undefined) {
      normalized.match = normalizeLumaMatchRules(
        profile.match,
        `${filePath}[${index}].match`,
      );
    }
    return normalized;
  });
}

function mapToSortedObject(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isSteamAppIdRule(value) {
  return isRecord(value) && value.kind === "steam_appid" && value.value != null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value) {
  return value == null ? "" : String(value).trim();
}
