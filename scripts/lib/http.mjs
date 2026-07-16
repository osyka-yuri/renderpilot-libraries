// Shared HTTP helpers for repository tooling (timeout fetch, HEAD/GET probes,
// JSON GET). Network/timeout failures throw `UpstreamNetworkError` so callers
// can map them to soft check outcomes without treating every failure as
// catalogue corruption.
//
// Which helper:
//   fetchWithTimeout      — raw Response; base for everything else
//   probeUrl              — HEAD/GET without body (health checks)
//   fetchJsonWithTimeout  — generic JSON GET → HttpStatusError / UpstreamNetworkError
//   github.fetchJson      — GitHub JSON + Link headers → SnapshotUnavailableError
//                           (RenoDX snapshot soft-skip policy; not a general client)

import { errorMessage, isAbortOrTimeoutError } from "./common.mjs";

/** Default User-Agent for outbound requests from this repository's tooling. */
export const USER_AGENT = "renderpilot-libraries";

/** House default for most probes and JSON GETs. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Wiki markdown / large page fetches. */
export const WIKI_TIMEOUT_MS = 30_000;
/** Steam store search (rate-limited; keep short). */
export const STEAM_TIMEOUT_MS = 10_000;
/** Luma ZIP range reads for payload-layout checks. */
export const PAYLOAD_TIMEOUT_MS = 30_000;

export class UpstreamNetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UpstreamNetworkError";
  }
}

/** Non-2xx HTTP response from a JSON/body fetch (retryable status is caller's policy). */
export class HttpStatusError extends Error {
  /**
   * @param {number} status
   * @param {string} [statusText]
   * @param {string} [url]
   */
  constructor(status, statusText = "", url = "") {
    const suffix = statusText ? ` ${statusText}` : "";
    const where = url ? ` for ${url}` : "";
    super(`HTTP ${status}${suffix}${where}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

/**
 * Best-effort cancel of an unread response body so HEAD/GET probes do not
 * stream large payloads until GC or timeout.
 */
export function cancelResponseBody(response) {
  try {
    response?.body?.cancel?.();
  } catch {
    // ignore cancel failures
  }
}

/**
 * Performs a fetch with abort timeout. Network/timeout failures throw
 * `UpstreamNetworkError` (callers map these to soft check outcomes).
 *
 * `fetchFn` defaults to global `fetch` and is injectable for tests.
 */
export async function fetchWithTimeout(url, options = {}) {
  const {
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    method = "GET",
    redirect = "follow",
    headers = {},
  } = options;

  if (typeof fetchFn !== "function") {
    throw new Error("fetchFn must be a function");
  }

  const mergedHeaders = {
    "User-Agent": USER_AGENT,
    ...headers,
  };

  try {
    return await fetchFn(url, {
      method,
      redirect,
      headers: mergedHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new UpstreamNetworkError(`request timed out after ${timeoutMs}ms: ${url}`, {
        cause: error,
      });
    }
    throw new UpstreamNetworkError(`request failed for ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * HEAD/GET probe that returns `{ ok, status, url, location? }` without
 * reading the body. Network failures throw `UpstreamNetworkError`.
 *
 * Modes:
 * - default: HEAD (or caller-chosen method), `ok` when response.ok
 * - `redirectOk: true`: GET with `redirect: "manual"`; 3xx + Location counts
 *   as ok (used for nightly.link, which 404s HEAD)
 */
export async function probeUrl(url, options = {}) {
  const { redirectOk = false, method, redirect, ...rest } = options;

  const response = await fetchWithTimeout(url, {
    method: method ?? (redirectOk ? "GET" : "HEAD"),
    redirect: redirect ?? (redirectOk ? "manual" : "follow"),
    ...rest,
  });

  try {
    const location = response.headers?.get?.("location") ?? null;
    const isRedirect =
      redirectOk && response.status >= 300 && response.status < 400 && Boolean(location);

    const result = {
      ok: Boolean(response.ok) || isRedirect,
      status: response.status,
      url,
    };
    // Only surface Location for redirect probes (nightly.link); HEAD follow
    // probes intentionally omit it.
    if (redirectOk) {
      result.location = location;
    }
    return result;
  } finally {
    cancelResponseBody(response);
  }
}

/**
 * GET JSON with timeout + User-Agent. Network/timeout → `UpstreamNetworkError`.
 * Non-OK status → `HttpStatusError`. Invalid JSON → generic Error with cause.
 *
 * @param {string} url
 * @param {object} [options] — same as `fetchWithTimeout` (`fetchFn`, `timeoutMs`, `headers`, …)
 */
export async function fetchJsonWithTimeout(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    ...options,
  });

  if (!response.ok) {
    throw new HttpStatusError(response.status, response.statusText ?? "", url);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${errorMessage(error)}`, { cause: error });
  }
}
