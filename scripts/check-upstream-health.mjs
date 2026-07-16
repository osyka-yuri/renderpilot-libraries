#!/usr/bin/env node
// Live health checks for version-pinned upstream archives referenced by the
// published catalogues. Soft-fails on network problems so offline runs do not
// look like catalogue corruption; hard-fails on contract breaks and HTTP
// missing pins.
//
//   node scripts/check-upstream-health.mjs [--suite=reshade|pinned|all]
//
// Not part of default `pnpm check` (schedule / explicit use only).

import { addonCatalogs } from "./catalog.mjs";
import { UsageError } from "./lib/common.mjs";
import { parseCliArgs, wantsHelp } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { printIssues } from "./lib/checks.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import {
  checkPinnedDependencyUrls,
  collectManagedDependencySourceUrls,
} from "./lib/upstream/pinned-deps.mjs";
import { checkReshadeChannelHealth } from "./lib/upstream/reshade.mjs";
import {
  formatCheckResults,
  hardFailureMessages,
  hasHardFailure,
  softFailureMessages,
} from "./lib/upstream/result.mjs";

const SUITES = Object.freeze({
  reshade: {
    title: "Checking ReShade channel pins...",
    run: async () => checkReshadeChannelHealth(),
  },
  pinned: {
    title: "Checking Luma managed-dependency archive pins...",
    run: runPinnedSuite,
  },
});

const SUITE_NAMES = Object.freeze(["reshade", "pinned", "all"]);

function usage() {
  console.error(
    "Usage: node scripts/check-upstream-health.mjs [--suite=reshade|pinned|all]",
  );
  console.error("");
  console.error(
    "Live-check committed ReShade channel pins and Luma managed-dependency archives.",
  );
  console.error(
    "Exit 0 when no hard failures (soft warnings allowed); 1 on hard failure; 2 on usage.",
  );
}

function parseArgs(argv) {
  if (wantsHelp(argv)) {
    return { help: true, suite: "all" };
  }

  const { values } = parseCliArgs(argv, {
    suite: { type: "string", default: "all" },
    help: { type: "boolean", short: "h" },
  });

  const suite = String(values.suite ?? "all").trim();
  if (!SUITE_NAMES.includes(suite)) {
    throw new UsageError(
      `invalid --suite=${suite}; expected one of ${SUITE_NAMES.join(", ")}`,
    );
  }

  return { help: false, suite };
}

async function runPinnedSuite() {
  const manifest = await readJsonFileAsync(
    addonCatalogs.luma.outputs.manifest.file,
    "addons/v1/luma.json",
  );
  const urls = collectManagedDependencySourceUrls(manifest);
  console.log(`  ${urls.length} unique source URL(s)`);
  if (urls.length === 0) {
    return [];
  }
  return checkPinnedDependencyUrls(urls);
}

async function runAndPrint(title, runFn) {
  console.log(title);
  const results = await runFn();
  for (const line of formatCheckResults(results)) {
    console.log(`  ${line}`);
  }
  return results;
}

function suiteKeysFor(suite) {
  return suite === "all" ? Object.keys(SUITES) : [suite];
}

async function main(args) {
  const results = [];
  for (const key of suiteKeysFor(args.suite)) {
    const suite = SUITES[key];
    results.push(...(await runAndPrint(suite.title, suite.run)));
  }

  const soft = softFailureMessages(results);
  if (soft.length > 0) {
    printIssues("\nSoft warnings (network / flaky hosts):", soft);
  }

  if (hasHardFailure(results)) {
    printIssues("\nFAIL hard upstream health problems:", hardFailureMessages(results));
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nOK upstream health suite=${args.suite} (${results.length} check(s), ${soft.length} soft warning(s)).`,
  );
}

runCliMain({
  parse: parseArgs,
  help: usage,
  main,
});
