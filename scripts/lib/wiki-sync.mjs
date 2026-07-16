// Shared transport, CLI, and persistence for wiki synchronizers.

import { errorMessage } from "./common.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";
import { UpstreamNetworkError, WIKI_TIMEOUT_MS, fetchWithTimeout } from "./http.mjs";

const WIKI_SYNC_OPTIONS = Object.freeze({
  check: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

export function parseWikiSyncArgs(args) {
  if (wantsHelp(args)) {
    return { check: false, help: true };
  }

  const { values } = parseCliArgs(args, WIKI_SYNC_OPTIONS);
  return {
    check: Boolean(values.check || values["dry-run"]),
    help: false,
  };
}

async function fetchOk(url, { timeoutMs, headers = {}, fetchFn } = {}) {
  try {
    const response = await fetchWithTimeout(url, {
      fetchFn,
      timeoutMs: timeoutMs ?? WIKI_TIMEOUT_MS,
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  } catch (error) {
    if (error instanceof UpstreamNetworkError) {
      throw error;
    }
    throw new UpstreamNetworkError(`Request failed for ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function fetchWikiMarkdown(url, options = {}) {
  try {
    const response = await fetchOk(url, {
      timeoutMs: options.timeoutMs ?? WIKI_TIMEOUT_MS,
      headers: options.headers,
      fetchFn: options.fetchFn,
    });
    return await response.text();
  } catch (error) {
    if (error instanceof UpstreamNetworkError) {
      throw new UpstreamNetworkError(`Could not fetch wiki ${url}: ${error.message}`, {
        cause: error,
      });
    }
    throw new Error(`Could not fetch wiki ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function jsonChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}
