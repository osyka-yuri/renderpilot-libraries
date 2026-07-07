// Shared runner for the Steam AppID → executable-basename enrichment step.
// Both manifest pipelines (RenoDX and Luma) consume the same shared cache
// (`scripts/steam-appid-exe.json`), so the thin `scripts/enrich-exe.mjs`
// entry point just supplies the cache path + per-tool AppID collectors; this
// module owns all the mechanics: CLI parsing, Steam appinfo fetch with
// retry, cache prune, atomic write.
//
//   runEnrichExeMain({
//     cacheFile,       // path to the shared appid→exe cache
//     collectAppids,   // () => iterable<string>  — union of every tool's overlay
//   })

import { rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  UsageError,
  assertPlainObject,
  errorMessage,
  forEachConcurrent,
  hasOwn,
  isMissingFileError,
} from "./common.mjs";
import { readJsonFile, sortNumericObject, writeFormattedJsonFile } from "./json.mjs";
import { gameExesFromAppinfo } from "./steam-appinfo.mjs";
import { normalizeAppid, normalizeCachedExes } from "./overlay-shared.mjs";

const STEAMCMD_INFO_API = (appid) => `https://api.steamcmd.net/v1/info/${appid}`;

const CONFIG = Object.freeze({
  concurrency: 4,
  retries: 2,
  requestTimeoutMs: 15_000,
  retryBaseDelayMs: 500,
});

const FETCH_HEADERS = Object.freeze({
  "User-Agent": "renderpilot-libraries",
});

class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HttpError";
    this.status = status;
  }
}

const HELP_TEXT = `Usage: node enrich-exe.mjs [--force]

Fetch public Windows launch executable basenames for every Steam AppID claimed
by any tool's match_overlay.json and update the shared appid→exe cache.

  --force   Refetch AppIDs that are already present in the cache.
  -h, --help
            Show this help message.`;

function parseArgs(argv) {
  const options = {
    force: false,
    help: false,
  };

  let endOfOptions = false;

  for (const arg of argv) {
    if (endOfOptions) {
      throw new UsageError(`Unexpected argument: ${arg}`);
    }

    switch (arg) {
      case "--":
        endOfOptions = true;
        break;

      case "--force":
        options.force = true;
        break;

      case "-h":
      case "--help":
        options.help = true;
        break;

      default:
        throw new UsageError(`Unknown flag: ${arg}`);
    }
  }

  return options;
}

function ensureFetchAvailable() {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable; use Node.js 18+.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  return CONFIG.retryBaseDelayMs * 2 ** attempt;
}

function isRetryableError(error) {
  if (error instanceof HttpError) {
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  return true;
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new HttpError(response.status, response.statusText);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`invalid JSON response: ${errorMessage(error)}`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${CONFIG.requestTimeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractAppinfo(apiResponse, appid) {
  assertPlainObject(apiResponse, `Steam appinfo response for ${appid}`);
  assertPlainObject(apiResponse.data, `Steam appinfo response for ${appid}.data`);

  if (!hasOwn(apiResponse.data, appid)) {
    throw new Error("missing appinfo in API response");
  }

  return apiResponse.data[appid];
}

async function fetchGameExes(appid) {
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    try {
      const apiResponse = await fetchJsonWithTimeout(STEAMCMD_INFO_API(appid));
      const appinfo = extractAppinfo(apiResponse, appid);
      const exes = gameExesFromAppinfo(appinfo);

      return normalizeCachedExes(exes, `Steam appinfo ${appid}`);
    } catch (error) {
      const lastAttempt = attempt === CONFIG.retries;

      if (lastAttempt || !isRetryableError(error)) {
        console.warn(`Warning: ${appid}: ${errorMessage(error)}`);
        return null;
      }

      await sleep(retryDelayMs(attempt));
    }
  }

  return null;
}

function readCache(cacheFile) {
  let cache;

  try {
    cache = readJsonFile(cacheFile, "steam-appid-exe.json");
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }

  assertPlainObject(cache, "steam-appid-exe.json");

  const normalized = {};

  for (const [rawAppid, rawExes] of Object.entries(cache)) {
    const appid = normalizeAppid(rawAppid, `steam-appid-exe.json key "${rawAppid}"`);
    const exes = normalizeCachedExes(rawExes, `steam-appid-exe.json.${appid}`);

    normalized[appid] = normalizeCachedExes(
      [...(normalized[appid] ?? []), ...exes],
      `steam-appid-exe.json.${appid}`,
    );
  }

  return normalized;
}

function pruneCache(cache, allowedAppids) {
  let removed = 0;

  for (const appid of Object.keys(cache)) {
    if (!allowedAppids.has(appid)) {
      delete cache[appid];
      removed++;
    }
  }

  return removed;
}

async function writeFormattedJsonFileAtomically(file, value) {
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFormattedJsonFile(tempFile, value);
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function enrichCache({ cacheFile, collectAppids, force }) {
  const appids = [...collectAppids()].sort((a, b) => Number(a) - Number(b));
  const appidSet = new Set(appids);

  const cache = readCache(cacheFile);
  const pruned = pruneCache(cache, appidSet);

  const todo = force ? appids : appids.filter((appid) => !hasOwn(cache, appid));

  console.log(
    `AppIDs to cover: ${appids.length}; fetching: ${todo.length}` +
      `${force ? " (force)" : ""}` +
      `${pruned > 0 ? `; pruned: ${pruned}` : ""}`,
  );

  if (todo.length > 0) {
    ensureFetchAvailable();
  }

  const stats = {
    withExes: 0,
    withoutExes: 0,
    failed: 0,
  };

  await forEachConcurrent(todo, CONFIG.concurrency, async (appid) => {
    const exes = await fetchGameExes(appid);

    if (exes === null) {
      stats.failed++;
      return;
    }

    cache[appid] = exes;

    if (exes.length > 0) {
      stats.withExes++;
    } else {
      stats.withoutExes++;
    }
  });

  const sorted = sortNumericObject(cache);
  await writeFormattedJsonFileAtomically(cacheFile, sorted);

  console.log(
    `cache: ${Object.keys(sorted).length} AppIDs ` +
      `(${stats.withExes} with exes, ` +
      `${stats.withoutExes} none, ` +
      `${stats.failed} failed) -> ${path.basename(cacheFile)}`,
  );
}

/**
 * @param {object} opts
 * @param {string}   opts.cacheFile     — path to the shared appid→exe cache
 * @param {function} opts.collectAppids — () => iterable<string> (union of every tool's overlay)
 * @param {string[]} [opts.argv]        — defaults to `process.argv.slice(2)`
 * @param {boolean}  [opts.force]       — overrides `--force` from argv when set explicitly
 * @returns {Promise<number>} exit code (0 ok, 1 failure)
 */
export async function runEnrichExe({ cacheFile, collectAppids, argv, force }) {
  if (typeof collectAppids !== "function") {
    throw new Error("runEnrichExe: collectAppids must be a function");
  }

  const cliOptions = parseArgs(argv ?? process.argv.slice(2));

  if (cliOptions.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    await enrichCache({
      cacheFile,
      collectAppids,
      force: force ?? cliOptions.force,
    });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error("");
      console.log(HELP_TEXT);
    } else {
      console.error(errorMessage(error));
    }
    return 1;
  }
}

/**
 * Thin entry-point wrapper: invokes `runEnrichExe` and propagates the
 * returned exit code to `process.exitCode`. Mirrors `runGenerateManifestMain`
 * so both runners share the same exit-code contract (return code, wrapper
 * sets `process.exitCode`).
 */
export function runEnrichExeMain(options) {
  runEnrichExe(options).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    },
  );
}
