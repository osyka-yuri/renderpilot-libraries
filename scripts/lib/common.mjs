export function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Returns `error.message` for Errors, otherwise `String(error)`. */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Promise that resolves after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for aborts from `AbortController` (`AbortError`) and from
 * `AbortSignal.timeout` (`TimeoutError` DOMException).
 */
export function isAbortOrTimeoutError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

/** True when `error` is (or wraps) a Node `ENOENT` missing-file error. */
export function isMissingFileError(error) {
  return /\bENOENT\b/.test(errorMessage(error));
}

/**
 * Thrown by shared CLI parsers for unknown flags / bad usage. Runners print
 * the message + help text (no stack) when they catch it, distinct from
 * unexpected runtime errors that dump the full error.
 *
 * Exit-code contract for repository CLIs:
 *   0 — success / help
 *   1 — operational failure
 *   2 — usage / bad flags (`UsageError`)
 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function assertPlainObject(value, context) {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }

  return value;
}

export function requiredNonEmptyString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }

  return value.trim();
}

export function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

export function assertNonEmptyArray(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }

  return value;
}

export function deepFreeze(obj) {
  const propNames = Reflect.ownKeys(obj);
  for (const name of propNames) {
    const value = obj[name];
    if ((value && typeof value === "object") || typeof value === "function") {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/** Pushes `value` onto `out` unless it (case-insensitively) is already there. */
export function addCaseInsensitiveUnique(out, value) {
  if (value === null || value === undefined || value === "") return;

  if (typeof value !== "string") {
    throw new Error("value must be a string");
  }

  const normalized = value.toLowerCase();

  if (!out.some((existing) => existing.toLowerCase() === normalized)) {
    out.push(value);
  }
}

const SOURCE_DATE_EPOCH = "SOURCE_DATE_EPOCH";

function parseSourceDateEpoch(env) {
  if (!Object.hasOwn(env, SOURCE_DATE_EPOCH)) {
    return null;
  }

  const raw = env[SOURCE_DATE_EPOCH];

  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const value = String(raw).trim();

  if (!/^\d+$/.test(value)) {
    throw new Error(`${SOURCE_DATE_EPOCH} must be a non-negative integer`);
  }

  const seconds = Number(value);

  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${SOURCE_DATE_EPOCH} must be a safe integer`);
  }

  return seconds;
}

/**
 * Reproducible `generated_at` timestamp (UTC midnight, date-only granularity):
 * honors `SOURCE_DATE_EPOCH` when set, otherwise today. Shared by every
 * manifest generator (RenoDX, Luma, the ReShade sources manifest, …) so a
 * fixed epoch pins every document's timestamp identically in one env var.
 */
export function generatedAtFromEnv(env = process.env) {
  const epoch = parseSourceDateEpoch(env);
  const date = epoch === null ? new Date() : new Date(epoch * 1000);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${SOURCE_DATE_EPOCH} is outside the supported date range`);
  }

  return `${date.toISOString().slice(0, 10)}T00:00:00Z`;
}

/**
 * Runs an async `worker` over `items` with a bounded concurrency. `worker`
 * receives `(item, index)`; callers that don't need the index can ignore it.
 * Throws on a non-integer or sub-1 `concurrency`. Used by the manifest
 * enrichment fetcher and the Luma asset-availability HEAD loop so they share
 * the same bounded-parallel shape.
 */
export async function forEachConcurrent(items, concurrency, worker) {
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

/**
 * Concurrent equivalent of `Array.prototype.map`. Results retain input order
 * even when workers complete out of order.
 */
export async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  await forEachConcurrent(items, concurrency, async (item, index) => {
    results[index] = await mapper(item, index);
  });
  return results;
}
