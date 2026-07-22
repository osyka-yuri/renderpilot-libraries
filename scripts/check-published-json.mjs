#!/usr/bin/env node
// Release-safety guard: performs a full-body GET for every served JSON file
// from Cloudflare R2 and compares the SHA-256 of the remote body against the
// local file.  This guarantees the bytes the app will download match the
// committed repo state byte-for-byte.
//
// Exits non-zero when any local JSON differs from the published copy or when
// R2 cannot provide a complete remote body.
//
//   node scripts/check-published-json.mjs           compare all served JSON
//   node scripts/check-published-json.mjs --verbose  print local/remote SHA-256
//   node scripts/check-published-json.mjs --dry-run   list files; no network
//   node scripts/check-published-json.mjs --help

import { readFile } from "node:fs/promises";
import path from "node:path";

import { libraryIndexFile, publishedJsonDocuments, r2, repoRoot } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout } from "./lib/http.mjs";
import { assertLibraryIndex } from "./lib/library-catalog.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import {
  parseCheckArgs,
  loadLocalJson,
  checkOne,
  formatResult,
  formatVerboseLines,
  aggregateResults,
  formatFailureAdvice,
} from "./lib/published-json-check.mjs";

const BUF_READ_FILE = (absPath) => readFile(absPath);
const REAL_FETCH = (url) =>
  fetchWithTimeout(url, { method: "GET", timeoutMs: DEFAULT_TIMEOUT_MS });

const HELP_TEXT = `Usage: node scripts/check-published-json.mjs [--verbose] [--dry-run]

  --verbose, -v   Print local and remote SHA-256 for every file.
  --dry-run       List local files and their SHA-256; no network access.
  --help, -h      Show this help message.

Compares every served JSON file (see catalog.mjs) against its currently
published R2 copy by performing a full-body GET and computing SHA-256 on the
response.  Exits non-zero when any local file differs from the published
version or when R2 cannot provide a complete response — run this after
"pnpm run publish:json" to confirm every byte landed in R2.`;

async function main(options) {
  const index = await readJsonFileAsync(path.join(repoRoot, libraryIndexFile));
  assertLibraryIndex(index);
  const vendorDocuments = index.vendors.map((vendor) => ({
    file: `libraries/v1/vendors/${vendor.vendor_id}.json`,
    r2Key: vendor.snapshot_key,
  }));
  const locals = await Promise.all(
    [...publishedJsonDocuments, ...vendorDocuments].map((document) =>
      loadLocalJson(document, repoRoot, BUF_READ_FILE),
    ),
  );

  if (options.dryRun) {
    console.log(`Dry run — ${locals.length} local JSON files:\n`);
    for (const local of locals) {
      console.log(`  ${local.sha256}  ${local.relPath}`);
    }
    return;
  }

  console.log(`\nR2 published-JSON check against ${r2.publicHost}\n`);

  const results = await Promise.all(
    locals.map((local) => checkOne(local, r2.publicHost, REAL_FETCH)),
  );

  for (const result of results) {
    if (options.verbose) {
      const lines = formatVerboseLines(result);
      console.log(lines.local);
      console.log(lines.remote);
    }
    console.log(formatResult(result));
  }

  const summary = aggregateResults(results);
  const failures = summary.mismatched + summary.unavailable;

  console.log(
    `\n${summary.matched} identical, ` +
      `${summary.mismatched} mismatched, ` +
      `${summary.unavailable} unavailable.`,
  );

  if (failures > 0) {
    console.error(`\n${formatFailureAdvice(summary).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("All served JSON files match their published R2 copies.");
  }
}

runCliMain({
  parse: parseCheckArgs,
  help: () => console.error(HELP_TEXT),
  main,
});
