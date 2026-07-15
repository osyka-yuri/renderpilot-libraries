// Pure logic for comparing locally-served JSON files against their published
// R2 counterparts.  All I/O is injectable so the module is unit-testable
// without touching disk or network.
//
//   loadLocalJson  → accepts a `readFile` factory
//   fetchRemoteJson → accepts a `fetchFn`
//   checkOne        → accepts a `publicHost` string + a `fetchFn`
//
// The CLI (`scripts/check-published-json.mjs`) injects real `node:fs/promises`
// and the global `fetch`.  Tests inject mocks.

import { createHash } from "node:crypto";
import path from "node:path";

import { errorMessage, UsageError } from "./common.mjs";

const KNOWN_FLAGS = new Map([
  ["--verbose", "verbose"],
  ["-v", "verbose"],
  ["--dry-run", "dryRun"],
  ["--help", "help"],
  ["-h", "help"],
]);

export function parseCheckArgs(argv) {
  const options = { verbose: false, dryRun: false, help: false };
  const unknown = [];

  for (const arg of argv) {
    const name = KNOWN_FLAGS.get(arg);
    if (!name) {
      unknown.push(arg);
      continue;
    }
    options[name] = true;
  }

  if (unknown.length > 0) {
    throw new UsageError(`unknown option(s): ${unknown.join(", ")}`);
  }

  return options;
}

// ── hashing ──

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── local loading ──

/**
 * Reads a publication-registry entry (`{ file, r2Key }`) and returns the
 * local digest together with its explicit remote key.
 *
 * `readFile` is `(absPath: string) => Promise<Buffer>`.
 */
export async function loadLocalJson(document, repoRoot, readFile) {
  const { file, r2Key } = document;
  const abs = path.resolve(repoRoot, file);
  let body;
  try {
    body = await readFile(abs);
  } catch (error) {
    throw new Error(`failed to read ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  return {
    key: r2Key,
    relPath: file,
    size: body.length,
    sha256: sha256Hex(body),
  };
}

// ── remote fetching ──

/**
 * Fetches the full body of `key` from the R2 public host, then computes its
 * SHA-256. Returns `{ status: "available", sha256, size }` on success or
 * `{ status: "unavailable", reason }` when R2 cannot provide the full body.
 *
 * `fetchFn` is `(url: string) => Promise<Response>`.
 */
export async function fetchRemoteJson(key, publicHost, fetchFn) {
  const url = `https://${publicHost}/${key}`;

  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    return { status: "unavailable", reason: `network error: ${errorMessage(error)}` };
  }

  if (!response.ok) {
    return {
      status: "unavailable",
      reason: `HTTP ${response.status} ${response.statusText ?? ""}`.trim(),
    };
  }

  let body;
  try {
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return {
      status: "unavailable",
      reason: `failed to read response body: ${errorMessage(error)}`,
    };
  }

  return {
    status: "available",
    sha256: sha256Hex(body),
    size: body.length,
  };
}

// ── comparison ──

/**
 * Pure comparison of two SHA-256 strings.
 * Returns `{ status: "match" | "mismatch", reason }`.
 */
export function compareHashes(localSha256, remoteSha256) {
  if (remoteSha256 === localSha256) {
    return { status: "match", reason: null };
  }

  return {
    status: "mismatch",
    reason: `SHA-256 mismatch (local ${localSha256}, remote ${remoteSha256})`,
  };
}

// ── check one ──

/**
 * Loads a local file, fetches its remote counterpart, and compares their
 * SHA-256 hashes.  Returns a structured result object.
 */
export async function checkOne(local, publicHost, fetchFn) {
  const remote = await fetchRemoteJson(local.key, publicHost, fetchFn);

  if (remote.status === "unavailable") {
    return {
      key: local.key,
      localSha256: local.sha256,
      remoteSha256: null,
      status: "unavailable",
      reason: remote.reason,
      localSize: local.size,
      remoteSize: null,
    };
  }

  const comparison = compareHashes(local.sha256, remote.sha256);

  return {
    key: local.key,
    localSha256: local.sha256,
    remoteSha256: remote.sha256,
    status: comparison.status,
    reason: comparison.reason,
    localSize: local.size,
    remoteSize: remote.size,
  };
}

// ── formatting ──

/**
 * Formats a single check result as a one-line status string.
 */
export function formatResult(result) {
  if (result.status === "match") {
    return `  OK   ${result.key}`;
  }

  if (result.status === "mismatch") {
    return `  MISMATCH  ${result.key}  (${result.reason})`;
  }

  if (result.status === "unavailable") {
    return `  UNAVAILABLE  ${result.key}  (${result.reason})`;
  }

  throw new Error(`unknown published JSON check status: ${result.status}`);
}

/**
 * Formats verbose per-file hash lines: `local: <sha256>  <key>` and
 * `remote: <sha256>  <key>`.
 */
export function formatVerboseLines(result) {
  const local = `  local:  ${result.localSha256}  ${result.key}`;
  const remote = result.remoteSha256
    ? `  remote: ${result.remoteSha256}  ${result.key}`
    : `  remote: <${result.reason}>  ${result.key}`;
  return { local, remote };
}

/**
 * Aggregates an array of results into summary counts.
 */
export function aggregateResults(results) {
  const summary = { matched: 0, mismatched: 0, unavailable: 0 };

  for (const r of results) {
    if (r.status === "match") {
      summary.matched++;
    } else if (r.status === "mismatch") {
      summary.mismatched++;
    } else if (r.status === "unavailable") {
      summary.unavailable++;
    } else {
      throw new Error(`unknown published JSON check status: ${r.status}`);
    }
  }

  return summary;
}

/**
 * Formats actionable failure advice for the CLI footer.
 */
export function formatFailureAdvice(summary) {
  const lines = [];

  if (summary.mismatched > 0) {
    const label = summary.mismatched === 1 ? "file differs" : "files differ";
    lines.push(
      `${summary.mismatched} served JSON ${label} from R2. ` +
        "Run `pnpm run publish:json` to publish the latest local copies, " +
        "then re-run this check.",
    );
  }

  if (summary.unavailable > 0) {
    const label =
      summary.unavailable === 1 ? "file was unavailable" : "files were unavailable";
    lines.push(
      `${summary.unavailable} served JSON ${label} from R2. ` +
        "Re-run the check; if it still fails, verify network connectivity and R2 availability.",
    );
  }

  return lines;
}
