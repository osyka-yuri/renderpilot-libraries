// Shared transport, CLI, and persistence for wiki synchronizers.

import { UsageError, errorMessage } from "./common.mjs";

export const WIKI_USER_AGENT = "renderpilot-libraries";
export const DEFAULT_WIKI_TIMEOUT_MS = 30_000;

export function parseWikiSyncArgs(args) {
  const parsed = { check: false, help: false };

  for (const arg of args) {
    if (arg === "--check" || arg === "--dry-run") {
      parsed.check = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function fetchWithTimeout(url, { timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`Request failed for ${url}: ${errorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWikiMarkdown(url, options = {}) {
  try {
    const response = await fetchWithTimeout(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_WIKI_TIMEOUT_MS,
      headers: { "User-Agent": WIKI_USER_AGENT, ...options.headers },
    });
    return await response.text();
  } catch (error) {
    throw new Error(`Could not fetch wiki ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function fetchJsonWithTimeout(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    timeoutMs: options.timeoutMs ?? DEFAULT_WIKI_TIMEOUT_MS,
    headers: { "User-Agent": WIKI_USER_AGENT, ...options.headers },
  });
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${errorMessage(error)}`, { cause: error });
  }
}

export function jsonChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}
