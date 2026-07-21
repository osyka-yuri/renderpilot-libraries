import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage, sleep } from "./common.mjs";
import { STEAM_TIMEOUT_MS, fetchWithTimeout } from "./http.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const CACHE_DIR = path.join(REPO_ROOT, "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "steam-search.json");

const STEAM_STORE_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const DEFAULT_STEAM_COUNTRY = "US";
const DEFAULT_STEAM_LANGUAGES = Object.freeze([
  "english",
  "tchinese",
  "japanese",
  "schinese",
  "koreana",
]);

const CACHE_VERSION = 2;
const POSITIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 5_000;

const MAX_ATTEMPTS = 4;
const REQUEST_THROTTLE_MS = 250;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

const HIGH_CONFIDENCE_SCORE = 88;
const DEFAULT_ACCEPT_SCORE = 78;
const AMBIGUITY_MARGIN = 3;

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
const NON_WORD_PATTERN = /[^\p{Letter}\p{Number}]+/gu;

/**
 * Expand only abbreviations whose meaning is sufficiently unambiguous in a
 * game title. Do not add DE/CE/EE/UE: those commonly mean different things.
 */
const TITLE_ABBREVIATION_REPLACEMENTS = Object.freeze([
  Object.freeze([/\bgoty\b/giu, "game of the year"]),
]);

/**
 * Names with no textual relationship cannot be inferred safely. Keep those
 * exceptional equivalences data-driven and reviewable instead of hiding them
 * in fuzzy matching heuristics.
 */
const TITLE_EQUIVALENCE_GROUPS = Object.freeze([
  Object.freeze(["Heaven Burns Red", "ヘブンバーンズレッド", "緋染天空 Heaven Burns Red"]),
]);

const EDITION_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "definitive",
    pattern: /\bdefinitive edition\b/gu,
  }),
  Object.freeze({
    id: "enhanced",
    pattern: /\benhanced(?: edition)?\b/gu,
  }),
  Object.freeze({
    id: "complete",
    pattern: /\bcomplete edition\b/gu,
  }),
  Object.freeze({
    id: "ultimate",
    pattern: /\bultimate edition\b/gu,
  }),
  Object.freeze({
    id: "deluxe",
    pattern: /\bdeluxe edition\b/gu,
  }),
  Object.freeze({
    id: "gold",
    pattern: /\bgold edition\b/gu,
  }),
  Object.freeze({
    id: "game-of-the-year",
    pattern: /\bgame of the year(?: edition)?\b/gu,
  }),
  Object.freeze({
    id: "remaster",
    pattern: /\bremaster(?:ed)?\b/gu,
  }),
  Object.freeze({
    id: "directors-cut",
    pattern: /\bdirectors cut\b/gu,
  }),
]);

/**
 * @typedef {Readonly<{
 *   id: number;
 *   name: string;
 *   type: string;
 * }>} SteamStoreItem
 */

/**
 * @typedef {Readonly<{
 *   score: number;
 *   reason: string;
 *   item: SteamStoreItem;
 *   searchRank: number;
 * }>} RankedSteamMatch
 */

/**
 * @typedef {Readonly<{
 *   item: SteamStoreItem | null;
 *   score: number;
 *   reason: string;
 *   ambiguous: boolean;
 *   alternatives: RankedSteamMatch[];
 * }>} SteamMatchResolution
 */

/**
 * @typedef {Readonly<{
 *   fetchedAt: number;
 *   items: SteamStoreItem[];
 * }>} SteamSearchCacheEntry
 */

/**
 * @typedef {{
 *   version: number;
 *   entries: Record<string, SteamSearchCacheEntry>;
 * }} SteamSearchCache
 */

/** @type {Promise<SteamSearchCache> | undefined} */
let cachePromise;

/** @type {Promise<void>} */
let saveQueue = Promise.resolve();

/** @type {Promise<void>} */
let requestQueue = Promise.resolve();

/** @type {Map<string, Promise<SteamStoreItem[] | null>>} */
const inFlightRequests = new Map();

/** @type {Map<string, string> | undefined} */
let titleAliasIndex;

/**
 * Produces a strict identity key. Edition markers are deliberately preserved,
 * so "Little Nightmares" and "Little Nightmares Enhanced Edition" remain
 * different titles.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalize(name) {
  const phrase = canonicalizeKnownTitleAlias(normalizePhrase(name));
  return phrase.replaceAll(" ", "");
}

/**
 * Produces a looser base-title key for ranking only. Never use this function as
 * the sole condition for accepting a match because it removes edition markers.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeBaseTitle(name) {
  let phrase = canonicalizeKnownTitleAlias(normalizePhrase(name));

  for (const definition of EDITION_DEFINITIONS) {
    phrase = phrase.replace(definition.pattern, " ");
  }

  return collapseWhitespace(phrase).replaceAll(" ", "");
}

/**
 * Scores how likely two names identify the same Steam application.
 *
 * 100: exact canonical title or explicit equivalence group
 * 88+: safe rebrand/localized prefix or suffix
 * 78+: probable renamed/reissued title; inspect ambiguity
 * below 78: do not accept automatically
 *
 * @param {string} expectedName
 * @param {string} actualName
 * @returns {{score: number; reason: string}}
 */
export function scoreTitleMatch(expectedName, actualName) {
  const comparison = createTitleComparison(expectedName, actualName);

  if (comparison.hasEmptyTitle) {
    return matchScore(0, "empty-normalized-title");
  }

  if (comparison.isExactMatch) {
    return matchScore(100, "exact-canonical-title");
  }

  const editionMismatch = scoreEditionMismatch(comparison.editionRelation);
  if (editionMismatch) {
    return editionMismatch;
  }

  return (
    scoreShortAffixMatch(comparison) ??
    scoreOrderedInsertionMatch(comparison) ??
    scoreSameBaseTitle(comparison) ??
    scoreTokenOverlap(comparison)
  );
}

/**
 * @param {string} expectedName
 * @param {string} actualName
 */
function createTitleComparison(expectedName, actualName) {
  const expectedPhrase = canonicalizeKnownTitleAlias(normalizePhrase(expectedName));
  const actualPhrase = canonicalizeKnownTitleAlias(normalizePhrase(actualName));
  const expectedTokens = tokenizePhrase(expectedPhrase);
  const actualTokens = tokenizePhrase(actualPhrase);

  return {
    expectedName,
    actualName,
    expectedPhrase,
    actualPhrase,
    expectedTokens,
    actualTokens,
    hasEmptyTitle: expectedPhrase.length === 0 || actualPhrase.length === 0,
    isExactMatch: expectedPhrase === actualPhrase,
    editionRelation: compareEditionSets(
      getEditionIds(expectedPhrase),
      getEditionIds(actualPhrase),
    ),
  };
}

/**
 * @param {ReturnType<typeof createTitleComparison>["editionRelation"]} relation
 * @returns {{score: number; reason: string} | null}
 */
function scoreEditionMismatch(relation) {
  if (relation === "expected-edition-missing") {
    return matchScore(35, "requested-edition-missing");
  }

  if (relation === "conflicting-editions") {
    return matchScore(20, "conflicting-editions");
  }

  return null;
}

/**
 * @param {ReturnType<typeof createTitleComparison>} comparison
 * @returns {{score: number; reason: string} | null}
 */
function scoreShortAffixMatch(comparison) {
  const { expectedTokens, actualTokens, editionRelation } = comparison;

  const expectedRange = findContiguousTokenRange(expectedTokens, actualTokens);
  if (expectedRange !== null && expectedTokens.length >= 3) {
    const extraCount = actualTokens.length - expectedTokens.length;
    const additionsAreAtEdge =
      expectedRange.start === 0 || expectedRange.end === actualTokens.length;

    if (extraCount <= 3 && additionsAreAtEdge) {
      const editionPenalty = editionRelation === "actual-has-extra-edition" ? 4 : 0;
      return matchScore(
        Math.max(88, 94 - extraCount * 2 - editionPenalty),
        "title-with-short-prefix-or-suffix",
      );
    }
  }

  const actualRange = findContiguousTokenRange(actualTokens, expectedTokens);
  const steamOmitsShortAffix =
    actualRange !== null &&
    actualTokens.length >= 3 &&
    expectedTokens.length - actualTokens.length <= 2 &&
    editionRelation === "same-editions";

  return steamOmitsShortAffix ? matchScore(86, "steam-title-omits-short-affix") : null;
}

/**
 * @param {ReturnType<typeof createTitleComparison>} comparison
 * @returns {{score: number; reason: string} | null}
 */
function scoreOrderedInsertionMatch(comparison) {
  const { expectedTokens, actualTokens, editionRelation } = comparison;
  const extraTokenCount = actualTokens.length - expectedTokens.length;
  const hasSmallOrderedInsertion =
    expectedTokens.length >= 4 &&
    extraTokenCount >= 0 &&
    extraTokenCount <= 3 &&
    getOrderedSubsequenceCoverage(expectedTokens, actualTokens) === 1;

  if (!hasSmallOrderedInsertion) {
    return null;
  }

  const editionPenalty = editionRelation === "actual-has-extra-edition" ? 3 : 0;
  return matchScore(
    Math.max(78, 84 - extraTokenCount - editionPenalty),
    "ordered-title-with-small-insertions",
  );
}

/**
 * @param {ReturnType<typeof createTitleComparison>} comparison
 * @returns {{score: number; reason: string} | null}
 */
function scoreSameBaseTitle(comparison) {
  const { expectedName, actualName, editionRelation } = comparison;
  const sameBaseTitle =
    editionRelation === "same-editions" &&
    normalizeBaseTitle(expectedName) === normalizeBaseTitle(actualName);

  return sameBaseTitle ? matchScore(76, "same-base-title") : null;
}

/**
 * @param {ReturnType<typeof createTitleComparison>} comparison
 * @returns {{score: number; reason: string}}
 */
function scoreTokenOverlap(comparison) {
  const { expectedTokens, actualTokens } = comparison;
  const similarity = getTokenJaccardSimilarity(expectedTokens, actualTokens);

  return similarity >= 0.8 && expectedTokens.length >= 3
    ? matchScore(Math.round(60 + similarity * 15), "high-token-overlap")
    : matchScore(Math.round(similarity * 50), "weak-token-overlap");
}

/**
 * @param {number} score
 * @param {string} reason
 */
function matchScore(score, reason) {
  return { score, reason };
}

/**
 * @param {string} phrase
 * @returns {string[]}
 */
function tokenizePhrase(phrase) {
  return phrase.length === 0 ? [] : phrase.split(" ");
}

/**
 * Ranks Steam results while preserving Steam's own relevance order as the
 * final tie-breaker.
 *
 * @param {string} gameName
 * @param {readonly SteamStoreItem[]} items
 * @returns {RankedSteamMatch[]}
 */
export function rankSteamMatches(gameName, items) {
  return items
    .map((item, searchRank) => ({
      ...scoreTitleMatch(gameName, item.name),
      item,
      searchRank,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        typePriority(right.item.type) - typePriority(left.item.type) ||
        left.searchRank - right.searchRank ||
        left.item.id - right.item.id,
    );
}

/**
 * Resolves the best candidate and reports ambiguity rather than silently
 * pretending that a common title such as "ECHO" is unique.
 *
 * @param {string} gameName
 * @param {readonly SteamStoreItem[]} items
 * @param {{minimumScore?: number; ambiguityMargin?: number}} [options]
 * @returns {SteamMatchResolution}
 */
export function findBestSteamMatch(gameName, items, options = {}) {
  const minimumScore = options.minimumScore ?? DEFAULT_ACCEPT_SCORE;
  const ambiguityMargin = options.ambiguityMargin ?? AMBIGUITY_MARGIN;
  const ranked = rankSteamMatches(gameName, items);
  const best = ranked[0];

  if (!best || best.score < minimumScore) {
    return {
      item: null,
      score: best?.score ?? 0,
      reason: best?.reason ?? "no-candidates",
      ambiguous: false,
      alternatives: ranked.slice(0, 5),
    };
  }

  const second = ranked[1];
  const ambiguous =
    second !== undefined &&
    second.item.id !== best.item.id &&
    best.score - second.score <= ambiguityMargin;

  return {
    item: best.item,
    score: best.score,
    reason: best.reason,
    ambiguous,
    alternatives: ranked.slice(1, 6),
  };
}

/**
 * Searches Steam in a small set of useful locales, merges duplicate App IDs,
 * and returns candidates ordered by title-match quality.
 *
 * This remains backward-compatible with the original one-argument function.
 *
 * @param {string} gameName
 * @param {{country?: string; languages?: readonly string[]}} [options]
 * @returns {Promise<SteamStoreItem[] | null>}
 */
export async function searchSteamStore(gameName, options = {}) {
  assertString(gameName);

  const country = normalizeCountry(options.country ?? DEFAULT_STEAM_COUNTRY);
  const languages = normalizeLanguages(options.languages ?? DEFAULT_STEAM_LANGUAGES);
  const searchTerms = buildSearchTerms(gameName);

  if (searchTerms.length === 0) {
    return [];
  }

  /** @type {Map<number, SteamStoreItem>} */
  const candidatesById = new Map();
  let completedRequest = false;

  for (const language of languages) {
    for (const searchTerm of searchTerms) {
      const items = await searchSteamStoreTerm(searchTerm, language, country);

      if (items === null) {
        continue;
      }

      completedRequest = true;

      for (const item of items) {
        if (!candidatesById.has(item.id)) {
          candidatesById.set(item.id, item);
        }
      }

      const ranked = rankSteamMatches(gameName, [...candidatesById.values()]);
      if (ranked[0]?.score >= HIGH_CONFIDENCE_SCORE) {
        return ranked.map((match) => match.item);
      }
    }
  }

  if (!completedRequest) {
    return null;
  }

  return rankSteamMatches(gameName, [...candidatesById.values()]).map(
    (match) => match.item,
  );
}

/**
 * Convenience API that performs both search and cautious resolution.
 *
 * @param {string} gameName
 * @param {{
 *   country?: string;
 *   languages?: readonly string[];
 *   minimumScore?: number;
 *   ambiguityMargin?: number;
 * }} [options]
 * @returns {Promise<SteamMatchResolution | null>}
 */
export async function resolveSteamStoreGame(gameName, options = {}) {
  const items = await searchSteamStore(gameName, options);
  if (items === null) {
    return null;
  }

  return findBestSteamMatch(gameName, items, options);
}

/**
 * @param {string} searchTerm
 * @param {string} language
 * @param {string} country
 * @returns {Promise<SteamStoreItem[] | null>}
 */
async function searchSteamStoreTerm(searchTerm, language, country) {
  const cacheKey = createCacheKey(searchTerm, language, country);
  const existingRequest = inFlightRequests.get(cacheKey);

  if (existingRequest) {
    return existingRequest;
  }

  const request = searchSteamStoreTermUncached(
    searchTerm,
    language,
    country,
    cacheKey,
  ).finally(() => {
    inFlightRequests.delete(cacheKey);
  });

  inFlightRequests.set(cacheKey, request);
  return request;
}

/**
 * @param {string} searchTerm
 * @param {string} language
 * @param {string} country
 * @param {string} cacheKey
 * @returns {Promise<SteamStoreItem[] | null>}
 */
async function searchSteamStoreTermUncached(searchTerm, language, country, cacheKey) {
  const cache = await loadCache();
  const cachedEntry = cache.entries[cacheKey];

  if (cachedEntry && isCacheEntryFresh(cachedEntry)) {
    return cachedEntry.items;
  }

  const url = buildSteamStoreSearchUrl(searchTerm, language, country);
  const items = await fetchSteamStoreItems(url, searchTerm, language);

  if (items === null) {
    return null;
  }

  await cacheSearchResult(cache, cacheKey, items);
  return items;
}

/**
 * @param {SteamSearchCache} cache
 * @param {string} cacheKey
 * @param {SteamStoreItem[]} items
 * @returns {Promise<void>}
 */
async function cacheSearchResult(cache, cacheKey, items) {
  cache.entries[cacheKey] = { fetchedAt: Date.now(), items };
  pruneCache(cache);
  await saveCache(cache);
}

/**
 * @param {URL} url
 * @param {string} searchTerm
 * @param {string} language
 * @returns {Promise<SteamStoreItem[] | null>}
 */
async function fetchSteamStoreItems(url, searchTerm, language) {
  const label = `${language}:${searchTerm}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await scheduleSteamRequest(() =>
        fetchWithTimeout(url, {
          method: "GET",
          timeoutMs: STEAM_TIMEOUT_MS,
          headers: { Accept: "application/json" },
        }),
      );

      if (isRetriableStatus(response.status) && attempt < MAX_ATTEMPTS) {
        await waitBeforeRetry(label, attempt, response.headers);
        continue;
      }

      if (!response.ok) {
        console.error(
          `[Steam API] HTTP ${response.status} while searching for "${searchTerm}" (${language}).`,
        );
        return null;
      }

      const payload = await response.json();
      return parseSteamSearchPayload(payload);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[Steam API] Failed to search for "${searchTerm}" (${language}) after ${MAX_ATTEMPTS} attempts: ${errorMessage(error)}`,
        );
        return null;
      }

      await waitBeforeRetry(label, attempt);
    }
  }

  return null;
}

/**
 * Serializes requests globally so concurrent game lookups do not create a
 * burst against Steam's store endpoint.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function scheduleSteamRequest(operation) {
  const result = requestQueue.then(operation, operation);

  requestQueue = result.catch(() => undefined).then(() => sleep(REQUEST_THROTTLE_MS));

  return result;
}

/**
 * @param {string} gameName
 * @returns {string[]}
 */
function buildSearchTerms(gameName) {
  const original = normalizeSearchTerm(gameName, false);
  const expanded = normalizeSearchTerm(gameName, true);
  const core = buildCoreSearchTerm(expanded);
  const aliases = buildEquivalenceSearchTerms(gameName);

  return [
    ...new Set([expanded, original, core, ...aliases].filter((term) => term.length > 0)),
  ];
}

/**
 * Collects alternative search terms from TITLE_EQUIVALENCE_GROUPS when the
 * game name matches a known alias group.
 *
 * @param {string} gameName
 * @returns {string[]}
 */
function buildEquivalenceSearchTerms(gameName) {
  const normalized = normalizeSearchTerm(gameName, true);
  if (normalized.length === 0) {
    return [];
  }

  for (const group of TITLE_EQUIVALENCE_GROUPS) {
    const groupTerms = group.map((alias) => normalizeSearchTerm(alias, true));
    const matchIndex = groupTerms.findIndex(
      (term) => term.length > 0 && term.toLowerCase() === normalized.toLowerCase(),
    );

    if (matchIndex !== -1) {
      return group
        .filter((_, i) => i !== matchIndex)
        .map((alias) => normalizeSearchTerm(alias, true))
        .filter((term) => term.length > 0);
    }
  }

  return [];
}

/**
 * @param {string} gameName
 * @param {boolean} expandAbbreviations
 * @returns {string}
 */
function normalizeSearchTerm(gameName, expandAbbreviations) {
  assertString(gameName);

  let result = gameName.replace(TRADEMARK_PATTERN, "").replace(RELEASE_YEAR_PATTERN, " ");

  if (expandAbbreviations) {
    result = expandTitleAbbreviations(result);
  }

  return collapseWhitespace(result);
}

/**
 * Builds one conservative fallback query. It removes a trailing edition label
 * but does not reduce a title to a single generic word.
 *
 * @param {string} searchTerm
 * @returns {string}
 */
function buildCoreSearchTerm(searchTerm) {
  let phrase = normalizePhrase(searchTerm);

  for (const definition of EDITION_DEFINITIONS) {
    phrase = phrase.replace(definition.pattern, " ");
  }

  const tokens = collapseWhitespace(phrase).split(" ").filter(Boolean);
  if (tokens.length < 3) {
    return searchTerm;
  }

  return tokens.slice(0, 8).join(" ");
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizePhrase(name) {
  assertString(name);

  const expanded = expandTitleAbbreviations(name);

  return collapseWhitespace(
    expanded
      // Remove before NFKD; otherwise ™ can decompose into the letters "TM".
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
      .replace(/[’']/gu, "")
      .replace(NON_WORD_PATTERN, " "),
  );
}

/**
 * @param {string} name
 * @returns {string}
 */
function expandTitleAbbreviations(name) {
  let expanded = name;

  for (const [pattern, replacement] of TITLE_ABBREVIATION_REPLACEMENTS) {
    expanded = expanded.replace(pattern, replacement);
  }

  return expanded;
}

/**
 * @param {string} normalizedPhrase
 * @returns {string}
 */
function canonicalizeKnownTitleAlias(normalizedPhrase) {
  titleAliasIndex ??= buildTitleAliasIndex();
  return titleAliasIndex.get(normalizedPhrase) ?? normalizedPhrase;
}

/**
 * @returns {Map<string, string>}
 */
function buildTitleAliasIndex() {
  const index = new Map();

  for (const group of TITLE_EQUIVALENCE_GROUPS) {
    const canonical = normalizePhrase(group[0]);

    for (const alias of group) {
      index.set(normalizePhrase(alias), canonical);
    }
  }

  return index;
}

/**
 * @param {string} phrase
 * @returns {Set<string>}
 */
function getEditionIds(phrase) {
  const editions = new Set();

  for (const definition of EDITION_DEFINITIONS) {
    definition.pattern.lastIndex = 0;
    if (definition.pattern.test(phrase)) {
      editions.add(definition.id);
    }
    definition.pattern.lastIndex = 0;
  }

  return editions;
}

/**
 * @param {Set<string>} expected
 * @param {Set<string>} actual
 * @returns {"same-editions" | "expected-edition-missing" | "actual-has-extra-edition" | "conflicting-editions"}
 */
function compareEditionSets(expected, actual) {
  const expectedMissing = [...expected].some((edition) => !actual.has(edition));
  const actualExtra = [...actual].some((edition) => !expected.has(edition));

  if (expectedMissing && actualExtra) {
    return "conflicting-editions";
  }

  if (expectedMissing) {
    return "expected-edition-missing";
  }

  if (actualExtra) {
    return "actual-has-extra-edition";
  }

  return "same-editions";
}

/**
 * @param {readonly string[]} needle
 * @param {readonly string[]} haystack
 * @returns {{start: number; end: number} | null}
 */
function findContiguousTokenRange(needle, haystack) {
  if (needle.length === 0 || needle.length > haystack.length) {
    return null;
  }

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let equal = true;

    for (let offset = 0; offset < needle.length; offset += 1) {
      if (needle[offset] !== haystack[start + offset]) {
        equal = false;
        break;
      }
    }

    if (equal) {
      return { start, end: start + needle.length };
    }
  }

  return null;
}

/**
 * @param {readonly string[]} expected
 * @param {readonly string[]} actual
 * @returns {number}
 */
function getOrderedSubsequenceCoverage(expected, actual) {
  if (expected.length === 0) {
    return 0;
  }

  let matched = 0;

  for (const token of actual) {
    if (token === expected[matched]) {
      matched += 1;
      if (matched === expected.length) {
        break;
      }
    }
  }

  return matched / expected.length;
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {number}
 */
function getTokenJaccardSimilarity(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);

  if (union.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersectionSize += 1;
    }
  }

  return intersectionSize / union.size;
}

/**
 * @param {string} value
 * @returns {string}
 */
function collapseWhitespace(value) {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * @param {string} searchTerm
 * @param {string} language
 * @param {string} country
 * @returns {string}
 */
function createCacheKey(searchTerm, language, country) {
  return `${country}\u0000${language}\u0000${searchTerm}`;
}

/**
 * @param {SteamSearchCacheEntry} entry
 * @returns {boolean}
 */
function isCacheEntryFresh(entry) {
  const ttl = entry.items.length === 0 ? NEGATIVE_CACHE_TTL_MS : POSITIVE_CACHE_TTL_MS;
  return Date.now() - entry.fetchedAt < ttl;
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
      return createEmptyCache();
    }

    console.warn(`[Steam cache] Ignoring unreadable cache file: ${errorMessage(error)}`);
    return createEmptyCache();
  }
}

/**
 * @returns {SteamSearchCache}
 */
function createEmptyCache() {
  return { version: CACHE_VERSION, entries: {} };
}

/**
 * @param {unknown} value
 * @returns {SteamSearchCache}
 */
function sanitizeCache(value) {
  if (!isPlainObject(value)) {
    return createEmptyCache();
  }

  // Version 1 stored arrays directly by search term and had no language,
  // country, or timestamp. Discard it because negative results could otherwise
  // live forever and collide across locales.
  if (value.version !== CACHE_VERSION || !isPlainObject(value.entries)) {
    return createEmptyCache();
  }

  /** @type {Record<string, SteamSearchCacheEntry>} */
  const entries = {};

  for (const [key, entry] of Object.entries(value.entries)) {
    if (!isPlainObject(entry) || !Number.isFinite(entry.fetchedAt)) {
      continue;
    }

    const items = sanitizeSteamItems(entry.items);
    entries[key] = {
      fetchedAt: Number(entry.fetchedAt),
      items,
    };
  }

  return { version: CACHE_VERSION, entries };
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
 * @param {SteamSearchCache} cache
 * @returns {SteamSearchCache}
 */
function cloneCache(cache) {
  return {
    version: CACHE_VERSION,
    entries: Object.fromEntries(
      Object.entries(cache.entries).map(([key, entry]) => [
        key,
        {
          fetchedAt: entry.fetchedAt,
          items: entry.items.map((item) => ({ ...item })),
        },
      ]),
    ),
  };
}

/**
 * @param {SteamSearchCache} cache
 * @returns {void}
 */
function pruneCache(cache) {
  const entries = Object.entries(cache.entries);

  for (const [key, entry] of entries) {
    if (!isCacheEntryFresh(entry)) {
      delete cache.entries[key];
    }
  }

  const remaining = Object.entries(cache.entries);
  if (remaining.length <= MAX_CACHE_ENTRIES) {
    return;
  }

  remaining
    .sort(([, left], [, right]) => left.fetchedAt - right.fetchedAt)
    .slice(0, remaining.length - MAX_CACHE_ENTRIES)
    .forEach(([key]) => {
      delete cache.entries[key];
    });
}

/**
 * Writes through a temporary file and atomically renames it into place.
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
 * @param {SteamSearchCache} cache
 * @returns {SteamSearchCache}
 */
function sortCache(cache) {
  return {
    version: CACHE_VERSION,
    entries: Object.fromEntries(
      Object.entries(cache.entries).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * @param {string} searchTerm
 * @param {string} language
 * @param {string} country
 * @returns {URL}
 */
function buildSteamStoreSearchUrl(searchTerm, language, country) {
  const url = new URL(STEAM_STORE_SEARCH_URL);
  url.searchParams.set("term", searchTerm);
  url.searchParams.set("l", language);
  url.searchParams.set("cc", country);
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

  return sanitizeSteamItems(payload.items);
}

/**
 * @param {unknown} value
 * @returns {SteamStoreItem[]}
 */
function sanitizeSteamItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
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
    id <= 0 ||
    typeof value.name !== "string" ||
    typeof value.type !== "string"
  ) {
    return null;
  }

  return { id, name: value.name, type: value.type };
}

/**
 * @param {string} type
 * @returns {number}
 */
function typePriority(type) {
  switch (type.toLowerCase()) {
    case "app":
      return 3;
    case "sub":
    case "package":
      return 2;
    case "bundle":
      return 1;
    default:
      return 0;
  }
}

/**
 * @param {readonly string[]} languages
 * @returns {string[]}
 */
function normalizeLanguages(languages) {
  const normalized = languages
    .filter((language) => typeof language === "string")
    .map((language) => language.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized.length > 0 ? normalized : ["english"])];
}

/**
 * @param {string} country
 * @returns {string}
 */
function normalizeCountry(country) {
  assertString(country);
  const normalized = country.trim().toUpperCase();

  if (!/^[A-Z]{2}$/u.test(normalized)) {
    throw new TypeError("Expected Steam country to be a two-letter code.");
  }

  return normalized;
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * @param {string} label
 * @param {number} attempt
 * @param {Headers} [headers]
 * @returns {Promise<void>}
 */
async function waitBeforeRetry(label, attempt, headers) {
  const retryAfterMs = headers ? getRetryAfterMs(headers) : null;
  const waitMs = retryAfterMs ?? getBackoffDelayMs(attempt);

  console.warn(
    `[Steam API] Retrying "${label}" in ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`,
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
    return Math.min(Math.max(seconds * 1_000, 0), RETRY_MAX_DELAY_MS);
  }

  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.min(Math.max(timestamp - Date.now(), 0), RETRY_MAX_DELAY_MS);
}

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function assertString(value) {
  if (typeof value !== "string") {
    throw new TypeError("Expected game name to be a string.");
  }
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
