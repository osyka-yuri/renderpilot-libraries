#!/usr/bin/env node
// Generate the RenoDX overrides manifest (schema v3) from authoritative inputs.
//
// The app fetches RenoDX add-ons live from upstream, so this manifest carries no
// artifacts or hashes. The authoring inputs stay in this folder; the served
// manifest is written to the repository root.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildManifest, generatedAtFromEnv } from "./lib/build-manifest.mjs";
import {
  assertPlainObject,
  readJsonFile,
  readTextFile,
  stringifyFormattedJson,
} from "./lib/json.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.join(SCRIPT_DIR, "..");

const FILES = Object.freeze({
  wiki: path.join(SCRIPT_DIR, "wiki_games.json"),
  overlay: path.join(SCRIPT_DIR, "match_overlay.json"),
  exeCache: path.join(SCRIPT_DIR, "appid_exe.json"),
  pending: path.join(SCRIPT_DIR, "pending_match.json"),
  manifest: path.join(REPO_ROOT, "renodx_manifest.json"),
});

const FLAGS = Object.freeze({
  check: "--check",
  help: "--help",
  helpShort: "-h",
});

const KNOWN_FLAGS = new Set(Object.values(FLAGS));

const HELP_TEXT = `Usage: node generate-manifest.mjs [--check]

Generate renodx_manifest.json from wiki_games.json, match_overlay.json, and the
optional appid_exe.json cache.

  --check   Do not write files; fail if generated outputs differ.`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.error) {
    console.error(args.error);
    console.error("");
    printHelp();
    return 1;
  }

  const result = buildManifest({
    wiki: readJsonFile(FILES.wiki, fileName(FILES.wiki)),
    overlay: readJsonFile(FILES.overlay, fileName(FILES.overlay)),
    exeCache: readExeCache(),
    generatedAt: readGeneratedAtForRun(args.check),
  });

  const outputs = await formatGeneratedOutputs(result);

  const ok = args.check ? checkGeneratedOutputs(outputs) : writeGeneratedOutputs(outputs);

  printSummary(result.stats);
  return ok ? 0 : 1;
}

function parseArgs(argv) {
  const help = argv.includes(FLAGS.help) || argv.includes(FLAGS.helpShort);

  // Preserve common CLI behavior: help wins even if another argument is invalid.
  if (help) {
    return { help: true, check: false, error: null };
  }

  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));

  if (unknown.length > 0) {
    return {
      help: false,
      check: false,
      error: `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    };
  }

  return {
    help: false,
    check: argv.includes(FLAGS.check),
    error: null,
  };
}

function printHelp() {
  console.log(HELP_TEXT);
}

function readExeCache() {
  if (!existsSync(FILES.exeCache)) {
    console.warn(
      "⚠ appid_exe.json missing — run enrich-exe.mjs for cross-launcher exe rules",
    );
    return {};
  }

  const cache = readJsonFile(FILES.exeCache, fileName(FILES.exeCache));
  assertPlainObject(cache, fileName(FILES.exeCache));
  return cache;
}

function readGeneratedAtForRun(check) {
  if (!check || !existsSync(FILES.manifest)) {
    return generatedAtFromEnv();
  }

  const manifest = readJsonFile(FILES.manifest, fileName(FILES.manifest));
  const generatedAt = manifest?.generated_at;

  if (typeof generatedAt !== "string" || generatedAt.trim() === "") {
    throw new Error(`${fileName(FILES.manifest)}.generated_at must be present for --check`);
  }

  return generatedAt;
}

async function formatGeneratedOutputs(result) {
  return [
    {
      file: FILES.manifest,
      text: await stringifyFormattedJson(result.manifest, FILES.manifest),
    },
    {
      file: FILES.pending,
      text: await stringifyFormattedJson(result.pending, FILES.pending),
    },
  ];
}

function checkGeneratedOutputs(outputs) {
  let ok = true;

  for (const output of outputs) {
    ok = checkGeneratedOutput(output) && ok;
  }

  return ok;
}

function checkGeneratedOutput({ file, text }) {
  const label = relativeFile(file);

  let actual;
  try {
    actual = readTextFile(file, label);
  } catch (error) {
    console.error(`✗ ${label} is missing or unreadable: ${errorMessage(error)}`);
    return false;
  }

  if (actual !== text) {
    console.error(`✗ ${label} is not up to date`);
    return false;
  }

  console.log(`✓ ${label} is up to date`);
  return true;
}

function writeGeneratedOutputs(outputs) {
  for (const output of outputs) {
    writeGeneratedOutput(output);
  }

  return true;
}

function writeGeneratedOutput({ file, text }) {
  try {
    writeFileSync(file, text);
  } catch (error) {
    throw new Error(`${relativeFile(file)}: ${errorMessage(error)}`);
  }
}

function printSummary(stats) {
  console.log(
    `manifest: ${stats.titles} titles (${stats.external} external, ` +
      `${stats.nativeHdr} native-hdr, ${stats.blacklist} blacklist), ` +
      `${stats.generics} generics`,
  );

  if (stats.ambiguousDerivedExes > 0) {
    console.log(`skipped ambiguous derived exe names: ${stats.ambiguousDerivedExes}`);
  }

  console.log(`pending (no AppID/exe yet): ${stats.pending} -> ${fileName(FILES.pending)}`);
}

function relativeFile(file) {
  return path.relative(REPO_ROOT, file) || fileName(file);
}

function fileName(file) {
  return path.basename(file);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);
