import path from "node:path";

import { errorMessage, isMissingFileError } from "./common.mjs";
import { readJsonFileAsync, writeFormattedJsonFile } from "./json.mjs";
import { normalize, searchSteamStore } from "./steam-search.mjs";

const UNMATCHED_REASON = Object.freeze({
  apiFailed: "API Request Failed",
  noExactMatch: "No exact match found in Steam Store search",
});

export async function runPendingMatching({ tool, files, createStore }) {
  console.log(`Resolving pending matches for: ${tool}`);

  const pendingGames = await readRequiredJson(files.pendingMatch, validatePendingGames);
  const store = await createStore(files);
  const globallyClaimedAppIds = await readOptionalJson(
    files.manifest,
    () => new Set(),
    collectManifestSteamAppIds,
    `No existing ${path.basename(files.manifest)} found. Skipping global duplicate check.`,
  );
  const locallyClaimedAppIds = store.claimAppIds();
  const unmatchedGames = [];
  let matchCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;

  for (const [index, game] of pendingGames.entries()) {
    if (store.isResolved(game.id)) {
      skippedCount++;
      continue;
    }

    console.log(`[${index + 1}/${pendingGames.length}] Checking ${game.name}...`);
    const searchResult = await findExactSteamApp(game.name);

    if (searchResult.kind === "error") {
      console.warn(`  -> Steam search failed: ${errorMessage(searchResult.error)}`);
      unmatchedGames.push({
        id: game.id,
        name: game.name,
        reason: UNMATCHED_REASON.apiFailed,
      });
      continue;
    }
    if (searchResult.kind === "not-found") {
      console.log("  -> No exact match found.");
      unmatchedGames.push({
        id: game.id,
        name: game.name,
        reason: UNMATCHED_REASON.noExactMatch,
      });
      continue;
    }

    const appid = String(searchResult.item.id);
    console.log(`  -> Matched Steam AppID ${appid} (${searchResult.item.name})`);

    if (locallyClaimedAppIds.has(appid) || globallyClaimedAppIds.has(appid)) {
      duplicateCount++;
      console.warn(
        `  -> Warning: AppID ${appid} is already mapped to another title. Marking as ignored duplicate.`,
      );
      store.applyDuplicateIgnore(game.id);
      continue;
    }

    store.applyMatch(game.id, appid);
    locallyClaimedAppIds.add(appid);
    matchCount++;
  }

  await store.save();
  await writeFormattedJsonFile(files.unmatched, unmatchedGames);

  console.log(`\nSuccessfully mapped ${matchCount} Steam games.`);
  console.log(`Skipped ${skippedCount} games that already have a match.`);
  console.log(`Ignored ${duplicateCount} duplicate Steam AppID mappings.`);
  console.log(`Failed to map ${unmatchedGames.length} games (logged to unmatched.json).`);
}

export function collectManifestSteamAppIds(manifest, filePath) {
  const appIds = new Set();
  const label = path.basename(filePath);
  if (!isRecord(manifest)) throw new TypeError(`${label} must contain an object.`);

  const games = manifest.games;
  if (games == null) return appIds;
  if (!Array.isArray(games)) throw new TypeError(`${label} games must be an array.`);

  for (const game of games) {
    for (const rule of isRecord(game) && Array.isArray(game.match) ? game.match : []) {
      if (isSteamAppIdRule(rule)) appIds.add(String(rule.value));
    }
  }
  return appIds;
}

async function findExactSteamApp(gameName) {
  let items;
  try {
    items = await searchSteamStore(gameName);
  } catch (error) {
    return { kind: "error", error };
  }
  if (!Array.isArray(items)) {
    return {
      kind: "error",
      error: new TypeError("Steam search returned a non-array response."),
    };
  }

  const normalizedTarget = normalize(gameName);
  const item = items.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.type === "app" &&
      candidate.id != null &&
      typeof candidate.name === "string" &&
      normalize(candidate.name) === normalizedTarget,
  );
  return item ? { kind: "match", item } : { kind: "not-found" };
}

async function readRequiredJson(filePath, validate) {
  const value = await readJsonFileAsync(filePath, path.basename(filePath));
  return validate(value, filePath);
}

async function readOptionalJson(filePath, fallback, validate, missingMessage) {
  try {
    return await readRequiredJson(filePath, validate);
  } catch (error) {
    if (isMissingFileError(error)) {
      console.log(missingMessage);
      return fallback();
    }
    throw error;
  }
}

function validatePendingGames(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("pending_match.json must contain an array.");
  }
  const seenIds = new Set();
  return value.map((game, index) => {
    if (!isRecord(game)) {
      throw new TypeError(`pending_match.json item #${index + 1} must be an object.`);
    }
    const id = toNonEmptyString(game.id);
    const name = toNonEmptyString(game.name);
    if (!id)
      throw new TypeError(`pending_match.json item #${index + 1} has an invalid id.`);
    if (!name) {
      throw new TypeError(`pending_match.json item #${index + 1} has an invalid name.`);
    }
    if (seenIds.has(id)) {
      throw new TypeError(`pending_match.json contains duplicate id: ${id}`);
    }
    seenIds.add(id);
    return { ...game, id, name };
  });
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
