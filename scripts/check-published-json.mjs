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

import { errorMessage, UsageError } from "./lib/common.mjs";
import { r2, repoRoot, servedJson } from "./catalog.mjs";
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
const REAL_FETCH = (url) => fetch(url);

const HELP_TEXT = `Usage: node scripts/check-published-json.mjs [--verbose] [--dry-run]

  --verbose, -v   Print local and remote SHA-256 for every file.
  --dry-run       List local files and their SHA-256; no network access.
  --help, -h      Show this help message.

Compares every served JSON file (see catalog.mjs) against its currently
published R2 copy by performing a full-body GET and computing SHA-256 on the
response.  Exits non-zero when any local file differs from the published
version or when R2 cannot provide a complete response — run this after
"pnpm run publish:json" to confirm every byte landed in R2.`;

async function main(argv = process.argv.slice(2)) {
  const options = parseCheckArgs(argv);

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const locals = await Promise.all(
    servedJson.map((rel) => loadLocalJson(rel, repoRoot, BUF_READ_FILE)),
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

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`Usage error: ${error.message}`);
    console.error("Run with --help for usage.");
  } else {
    console.error(errorMessage(error));
  }
  process.exitCode = 1;
});
