#!/usr/bin/env node
// Enrich the RenoDX overlay with canonical launch executable basenames derived
// from Steam appinfo. The generated appid_exe.json cache lets the manifest match
// non-Steam installs by exe_name without making generate-manifest.mjs networked.

import { rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { gameExesFromAppinfo } from "./lib/steam-appinfo.mjs";
import {
  collectOverlayAppids,
  normalizeAppid,
  normalizeCachedExes,
} from "./lib/overlay.mjs";
import {
  assertPlainObject,
  readJsonFile,
  sortNumericObject,
  writeFormattedJsonFile,
} from "./lib/json.mjs";

const OVERLAY_FILE = fileURLToPath(new URL("./match_overlay.json", import.meta.url));
const CACHE_FILE = fileURLToPath(new URL("./appid_exe.json", import.meta.url));

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

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HttpError";
    this.status = status;
  }
}

function printHelp() {
  console.log(`Usage: node enrich-exe.mjs [--force]

Fetch public Windows launch executable basenames for every Steam AppID in
match_overlay.json and update appid_exe.json.

  --force   Refetch AppIDs that are already present in the cache.
  -h, --help
            Show this help message.`);
}

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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
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
      throw new Error(`invalid JSON response: ${formatError(error)}`);
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
        console.warn(`warn ${appid}: ${formatError(error)}`);
        return null;
      }

      await sleep(retryDelayMs(attempt));
    }
  }

  return null;
}

function isMissingFileError(error) {
  return /\bENOENT\b/.test(formatError(error));
}

function readCache() {
  let cache;

  try {
    cache = readJsonFile(CACHE_FILE, "appid_exe.json");
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }

  assertPlainObject(cache, "appid_exe.json");

  const normalized = {};

  for (const [rawAppid, rawExes] of Object.entries(cache)) {
    const appid = normalizeAppid(rawAppid, `appid_exe.json key "${rawAppid}"`);
    const exes = normalizeCachedExes(rawExes, `appid_exe.json.${appid}`);

    normalized[appid] = normalizeCachedExes(
      [...(normalized[appid] ?? []), ...exes],
      `appid_exe.json.${appid}`,
    );
  }

  return normalized;
}

function readOverlayAppids() {
  const overlay = readJsonFile(OVERLAY_FILE, "match_overlay.json");
  assertPlainObject(overlay, "match_overlay.json");

  const appids = new Set();
  collectOverlayAppids(overlay, appids);

  return [...appids].sort((a, b) => Number(a) - Number(b));
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

async function forEachConcurrent(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`invalid concurrency: ${concurrency}`);
  }

  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      await worker(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
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

async function enrichCache({ force }) {
  const appids = readOverlayAppids();
  const appidSet = new Set(appids);

  const cache = readCache();
  const pruned = pruneCache(cache, appidSet);

  const todo = force ? appids : appids.filter((appid) => !hasOwn(cache, appid));

  console.log(
    `overlay AppIDs: ${appids.length}; fetching: ${todo.length}` +
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
  await writeFormattedJsonFileAtomically(CACHE_FILE, sorted);

  console.log(
    `cache: ${Object.keys(sorted).length} AppIDs ` +
      `(${stats.withExes} with exes, ` +
      `${stats.withoutExes} none, ` +
      `${stats.failed} failed) -> appid_exe.json`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  await enrichCache(options);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    printHelp();
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
