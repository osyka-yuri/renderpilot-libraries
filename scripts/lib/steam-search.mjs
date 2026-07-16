import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage, sleep } from "./common.mjs";
import { STEAM_TIMEOUT_MS, fetchWithTimeout } from "./http.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const CACHE_DIR = path.join(REPO_ROOT, "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "steam-search.json");

const STEAM_STORE_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const STEAM_LANGUAGE = "english";
const STEAM_COUNTRY = "US";

const MAX_ATTEMPTS = 4;
const SUCCESS_THROTTLE_MS = 250;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

const ROMAN_NUMERAL_REPLACEMENTS = new Map([
  ["viii", "8"],
  ["vii", "7"],
  ["vi", "6"],
  ["iv", "4"],
  ["iii", "3"],
  ["ii", "2"],
  ["ix", "9"],
  ["v", "5"],
]);

const ROMAN_NUMERAL_PATTERN = /\b(?:viii|vii|vi|iv|iii|ii|ix|v)\b/gu;
const RELEASE_YEAR_PATTERN = /\((?:19|20)\d{2}\)/gu;
const TRADEMARK_PATTERN = /[™®©]/gu;
const DIACRITIC_PATTERN = /\p{Diacritic}/gu;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/gu;

const MARKETING_SUFFIX_PATTERNS = Object.freeze([
  /\s*(?:-|:|–|—)?\s*definitive edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*enhanced edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*complete edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*ultimate edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*deluxe edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*gold edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*game of the year edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*goty edition\s*$/u,
  /\s*(?:-|:|–|—)?\s*remastered\s*$/u,
  /\s*(?:-|:|–|—)?\s*remaster\s*$/u,
  /\s*(?:-|:|–|—)?\s*director'?s cut\s*$/u,
]);

/**
 * @typedef {Readonly<{
 *   id: number;
 *   name: string;
 *   type: string;
 * }>} SteamStoreItem
 */

/** @typedef {Record<string, SteamStoreItem[]>} SteamSearchCache */

/** @type {Promise<SteamSearchCache> | undefined} */
let cachePromise;

/** @type {Promise<void>} */
let saveQueue = Promise.resolve();

/** @type {Map<string, Promise<SteamStoreItem[] | null>>} */
const inFlightSearches = new Map();

/**
 * Normalizes a game name for strict comparison against Steam search results.
 * Handles trademarks, diacritics, roman numerals, release years, and common
 * marketing suffixes that Steam often omits or formats differently.
 *
 * @param {string} name - The raw game name from the wiki or Steam.
 * @returns {string} The normalized string.
 */
export function normalize(name) {
  if (typeof name !== "string") {
    throw new TypeError("Expected game name to be a string.");
  }

  let normalized = name
    // Important: remove these before NFKD. Otherwise "™" becomes "TM".
    .replace(TRADEMARK_PATTERN, "")
    .normalize("NFKD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase()
    .replace(RELEASE_YEAR_PATTERN, " ")
    .replace(
      ROMAN_NUMERAL_PATTERN,
      (roman) => ROMAN_NUMERAL_REPLACEMENTS.get(roman) ?? roman,
    )
    .replace(/&/gu, " and ")
    .replace(/[’']/gu, "");

  for (const pattern of MARKETING_SUFFIX_PATTERNS) {
    normalized = normalized.replace(pattern, " ");
  }

  return normalized.replace(NON_ALPHANUMERIC_PATTERN, "");
}

/**
 * Searches the Steam Store API for a game name.
 * Uses an on-disk JSON cache, request timeout, exponential backoff, jitter, and
 * request de-duplication for concurrent calls with the same search term.
 *
 * @param {string} gameName - The name of the game to search for.
 * @returns {Promise<SteamStoreItem[] | null>} Matching Steam Store items, or null on failure.
 */
export async function searchSteamStore(gameName) {
  const searchTerm = normalizeSearchTerm(gameName);

  if (searchTerm.length === 0) {
    return [];
  }

  const existingSearch = inFlightSearches.get(searchTerm);
  if (existingSearch) {
    return existingSearch;
  }

  const searchPromise = searchSteamStoreUncached(searchTerm).finally(() => {
    inFlightSearches.delete(searchTerm);
  });

  inFlightSearches.set(searchTerm, searchPromise);
  return searchPromise;
}

/**
 * @param {string} searchTerm
 * @returns {Promise<SteamStoreItem[] | null>}
 */
async function searchSteamStoreUncached(searchTerm) {
  const cache = await loadCache();

  if (Object.hasOwn(cache, searchTerm)) {
    return cache[searchTerm];
  }

  const url = buildSteamStoreSearchUrl(searchTerm);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        timeoutMs: STEAM_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      });

      if (isRetriableStatus(response.status) && attempt < MAX_ATTEMPTS) {
        await waitBeforeRetry(searchTerm, attempt, response.headers);
        continue;
      }

      if (!response.ok) {
        console.error(
          `[Steam API] HTTP ${response.status} while searching for "${searchTerm}".`,
        );
        return null;
      }

      const payload = await response.json();
      const items = parseSteamSearchPayload(payload);

      cache[searchTerm] = items;
      await saveCache(cache);
      await sleep(SUCCESS_THROTTLE_MS);

      return items;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[Steam API] Failed to search for "${searchTerm}" after ${MAX_ATTEMPTS} attempts: ${errorMessage(error)}`,
        );
        return null;
      }

      await waitBeforeRetry(searchTerm, attempt);
    }
  }

  return null;
}

/**
 * @returns {Promise<SteamSearchCache>}
 */
async function loadCache() {
  cachePromise ??= readCacheFile();
  return cachePromise;
}

/**
 * @returns {Promise<SteamSearchCache>}
 */
async function readCacheFile() {
  try {
    const rawCache = await fs.readFile(CACHE_FILE, "utf8");
    return sanitizeCache(JSON.parse(rawCache));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    console.warn(`[Steam cache] Ignoring unreadable cache file: ${errorMessage(error)}`);
    return {};
  }
}

/**
 * @param {SteamSearchCache} cache
 * @returns {Promise<void>}
 */
async function saveCache(cache) {
  const snapshot = cloneCache(cache);

  saveQueue = saveQueue.catch(() => undefined).then(() => writeCacheFile(snapshot));

  try {
    await saveQueue;
  } catch (error) {
    console.error(`[Steam cache] Failed to save cache: ${errorMessage(error)}`);
  }
}

/**
 * Writes the cache through a temporary file and then renames it into place, so a
 * partial write is less likely to corrupt the existing cache.
 *
 * @param {SteamSearchCache} cache
 * @returns {Promise<void>}
 */
async function writeCacheFile(cache) {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const temporaryFile = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(sortCache(cache), null, 2)}\n`;

  try {
    await fs.writeFile(temporaryFile, data, { encoding: "utf8", flush: true });
    await fs.rename(temporaryFile, CACHE_FILE);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

/**
 * @param {string} gameName
 * @returns {string}
 */
function normalizeSearchTerm(gameName) {
  if (typeof gameName !== "string") {
    throw new TypeError("Expected game name to be a string.");
  }

  return gameName.trim().replace(/\s+/gu, " ");
}

/**
 * @param {string} searchTerm
 * @returns {URL}
 */
function buildSteamStoreSearchUrl(searchTerm) {
  const url = new URL(STEAM_STORE_SEARCH_URL);

  url.searchParams.set("term", searchTerm);
  url.searchParams.set("l", STEAM_LANGUAGE);
  url.searchParams.set("cc", STEAM_COUNTRY);

  return url;
}

/**
 * @param {unknown} payload
 * @returns {SteamStoreItem[]}
 */
function parseSteamSearchPayload(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
    throw new Error("Unexpected Steam API response: missing items array.");
  }

  return payload.items.flatMap((item) => {
    const steamItem = toSteamStoreItem(item);
    return steamItem === null ? [] : [steamItem];
  });
}

/**
 * @param {unknown} value
 * @returns {SteamStoreItem | null}
 */
function toSteamStoreItem(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = Number(value.id);

  if (
    !Number.isSafeInteger(id) ||
    typeof value.name !== "string" ||
    typeof value.type !== "string"
  ) {
    return null;
  }

  return {
    id,
    name: value.name,
    type: value.type,
  };
}

/**
 * @param {unknown} value
 * @returns {SteamSearchCache}
 */
function sanitizeCache(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  /** @type {SteamSearchCache} */
  const cache = {};

  for (const [searchTerm, items] of Object.entries(value)) {
    if (typeof searchTerm !== "string" || !Array.isArray(items)) {
      continue;
    }

    const sanitizedItems = items.flatMap((item) => {
      const steamItem = toSteamStoreItem(item);
      return steamItem === null ? [] : [steamItem];
    });

    cache[searchTerm] = sanitizedItems;
  }

  return cache;
}

/**
 * @param {SteamSearchCache} cache
 * @returns {SteamSearchCache}
 */
function cloneCache(cache) {
  return Object.fromEntries(
    Object.entries(cache).map(([key, items]) => [
      key,
      items.map((item) => ({ id: item.id, name: item.name, type: item.type })),
    ]),
  );
}

/**
 * @param {SteamSearchCache} cache
 * @returns {SteamSearchCache}
 */
function sortCache(cache) {
  return Object.fromEntries(
    Object.entries(cache).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * @param {string} searchTerm
 * @param {number} attempt
 * @param {Headers} [headers]
 * @returns {Promise<void>}
 */
async function waitBeforeRetry(searchTerm, attempt, headers) {
  const retryAfterMs = headers ? getRetryAfterMs(headers) : null;
  const waitMs = retryAfterMs ?? getBackoffDelayMs(attempt);

  console.warn(
    `[Steam API] Retrying "${searchTerm}" in ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
  );
  await sleep(waitMs);
}

/**
 * @param {number} attempt
 * @returns {number}
 */
function getBackoffDelayMs(attempt) {
  const exponentialDelay = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    RETRY_MAX_DELAY_MS,
  );
  const jitter = Math.floor(Math.random() * 250);

  return exponentialDelay + jitter;
}

/**
 * @param {Headers} headers
 * @returns {number | null}
 */
function getRetryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds * 1000, 0), RETRY_MAX_DELAY_MS);
  }

  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.min(Math.max(timestamp - Date.now(), 0), RETRY_MAX_DELAY_MS);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
