// Shared runner for the Steam AppID → executable-basename enrichment step.
// The thin `scripts/enrich-exe.mjs` entry point supplies the cache path and
// AppID collector; this module owns CLI parsing, Steam appinfo fetch/retry,
// cache pruning, and atomic persistence.
//
//   runEnrichExeMain({
//     cacheFile,       // path to the shared appid→exe cache
//     collectAppids,   // () => iterable<string>
//   })

import path from "node:path";

import {
  UsageError,
  assertPlainObject,
  errorMessage,
  forEachConcurrent,
  hasOwn,
  isMissingFileError,
  sleep,
} from "./common.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";
import { applyExitCode } from "./cli-main.mjs";
import { DEFAULT_TIMEOUT_MS, HttpStatusError, fetchJsonWithTimeout } from "./http.mjs";
import { readJsonFile, sortNumericObject, writeFormattedJsonFile } from "./json.mjs";
import { gameExesFromAppinfo } from "./steam-appinfo.mjs";
import { normalizeAppid, normalizeCachedExes } from "./overlay-shared.mjs";

const STEAMCMD_INFO_API = (appid) => `https://api.steamcmd.net/v1/info/${appid}`;

const CONFIG = Object.freeze({
  concurrency: 4,
  retries: 2,
  requestTimeoutMs: DEFAULT_TIMEOUT_MS,
  retryBaseDelayMs: 500,
});

const HELP_TEXT = `Usage: node enrich-exe.mjs [--force]

Fetch public Windows launch executable basenames for every Steam AppID claimed
by the RenoDX match overlay and update its appid→exe cache.

  --force   Refetch AppIDs that are already present in the cache.
  -h, --help
            Show this help message.`;

function parseArgs(argv) {
  if (wantsHelp(argv)) {
    return { force: false, help: true };
  }

  const { values } = parseCliArgs(argv, {
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  return {
    force: Boolean(values.force),
    help: false,
  };
}

function retryDelayMs(attempt) {
  return CONFIG.retryBaseDelayMs * 2 ** attempt;
}

function isRetryableError(error) {
  if (error instanceof HttpStatusError) {
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  return true;
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
      const apiResponse = await fetchJsonWithTimeout(STEAMCMD_INFO_API(appid), {
        timeoutMs: CONFIG.requestTimeoutMs,
      });
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
  await writeFormattedJsonFile(cacheFile, sorted);

  console.log(
    `cache: ${Object.keys(sorted).length} AppIDs ` +
      `(${stats.withExes} with exes, ` +
      `${stats.withoutExes} none, ` +
      `${stats.failed} failed) -> ${path.basename(cacheFile)}`,
  );
}

/**
 * Single CLI implementation. Returns exit code (0 ok, 1 failure, 2 usage).
 * Process entrypoints call `runEnrichExeMain`, which only applies the code.
 *
 * @param {object} opts
 * @param {string}   opts.cacheFile
 * @param {function} opts.collectAppids
 * @param {string[]} [opts.argv]
 * @param {boolean}  [opts.force]
 * @returns {Promise<number>}
 */
export async function runEnrichExe({ cacheFile, collectAppids, argv, force }) {
  if (typeof collectAppids !== "function") {
    throw new Error("runEnrichExe: collectAppids must be a function");
  }

  try {
    const cliOptions = parseArgs(argv ?? process.argv.slice(2));

    if (cliOptions.help) {
      console.error(HELP_TEXT);
      return 0;
    }

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
      console.error(HELP_TEXT);
      return 2;
    }
    console.error(errorMessage(error));
    return 1;
  }
}

/**
 * Process entry-point: runs `runEnrichExe` and assigns `process.exitCode`.
 */
export function runEnrichExeMain(options) {
  const { cacheFile, collectAppids, argv, force } = options;
  if (typeof collectAppids !== "function") {
    console.error("runEnrichExeMain: collectAppids must be a function");
    applyExitCode(1);
    return;
  }

  runEnrichExe({ cacheFile, collectAppids, argv, force }).then(
    (code) => applyExitCode(code),
    (error) => {
      console.error(errorMessage(error));
      applyExitCode(1);
    },
  );
}
