// Shared CLI/IO runner for generated manifest scripts (RenoDX, Luma, and the
// standalone ReShade host manifest). The scripts differ only in which inputs
// they read, how they build their manifest object, how many generated files
// they emit, and the shape of their summary output. Everything else — argument
// parsing, the `--check` vs write flow, the `generated_at` round-trip for
// reproducible checks, output formatting, and exit-code plumbing — lives here.
//
//   await runGenerateManifest({
//     files:   { manifest, pending?, exeCache? },
//     build:   (inputs) => buildManifest(inputs),  // tool-specific
//     readInputs,                                    // tool-specific input reader
//     printSummary,                                  // tool-specific stats printer
//     helpText,                                      // tool-specific usage string
//   })
//
// `readInputs({ exeCache })` returns the remaining `buildManifest` args
// (e.g. `{ wiki, overlay, exeCache, generatedAt }` for RenoDX,
// `{ curatedGames, overlay, exeCache, generatedAt }` for Luma, or just
// `{ generatedAt }` for ReShade), so each tool owns how its authoring files map
// onto its `buildManifest` signature.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { errorMessage, generatedAtFromEnv, assertPlainObject } from "./common.mjs";
import { readJsonFile, readTextFile, stringifyFormattedJson } from "./json.mjs";

const FLAGS = Object.freeze({
  check: "--check",
  help: "--help",
  helpShort: "-h",
});

const KNOWN_FLAGS = new Set(Object.values(FLAGS));

/**
 * Parses the shared `--check` / `-h` / `--help` flag set used by every
 * generator script. Returns `{ help, check, error }`; `error` is `null` on
 * success or a ready-to-print string on unknown flags. Help wins over an
 * invalid argument so callers can short-circuit to the usage banner.
 */
export function parseCheckStyleArgs(argv) {
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

function readExeCache(exeCacheFile) {
  if (!exeCacheFile) {
    return {};
  }

  if (!existsSync(exeCacheFile)) {
    console.warn(
      "Warning: steam-appid-exe.json missing -- run enrich-exe.mjs for cross-launcher exe rules",
    );
    return {};
  }

  const cache = readJsonFile(exeCacheFile, path.basename(exeCacheFile));
  assertPlainObject(cache, path.basename(exeCacheFile));
  return cache;
}

function readGeneratedAtForRun(check, manifestFile) {
  if (!check || !existsSync(manifestFile)) {
    return generatedAtFromEnv();
  }

  const label = path.basename(manifestFile);
  const manifest = readJsonFile(manifestFile, label);
  const generatedAt = manifest?.generated_at;

  if (typeof generatedAt !== "string" || generatedAt.trim() === "") {
    throw new Error(`${label}.generated_at must be present for --check`);
  }

  return generatedAt;
}

function generatedOutputSpecs(result, files) {
  const specs = [
    {
      key: "manifest",
      file: files.manifest,
      value: result.manifest,
    },
  ];

  if (files.pending) {
    specs.push({
      key: "pending",
      file: files.pending,
      value: result.pending,
    });
  }

  return specs;
}

async function formatGeneratedOutputs(result, files) {
  const outputs = [];

  for (const spec of generatedOutputSpecs(result, files)) {
    if (!spec.file) {
      throw new Error(`generated output "${spec.key}" is missing a file path`);
    }

    if (spec.value === undefined) {
      throw new Error(`generated output "${spec.key}" was not returned by build()`);
    }

    outputs.push({
      file: spec.file,
      text: await stringifyFormattedJson(spec.value, spec.file),
    });
  }

  return outputs;
}

function relativeFile(file, repoRoot) {
  return path.relative(repoRoot, file);
}

function checkGeneratedOutputs(outputs, repoRoot) {
  let ok = true;

  for (const output of outputs) {
    ok = checkGeneratedOutput(output, repoRoot) && ok;
  }

  return ok;
}

function checkGeneratedOutput({ file, text }, repoRoot) {
  const label = relativeFile(file, repoRoot);

  let actual;
  try {
    actual = readTextFile(file, label);
  } catch (error) {
    console.error(`FAIL ${label} is missing or unreadable: ${errorMessage(error)}`);
    return false;
  }

  if (actual !== text) {
    console.error(`FAIL ${label} is not up to date`);
    return false;
  }

  console.log(`OK ${label} is up to date`);
  return true;
}

function writeGeneratedOutputs(outputs, repoRoot) {
  for (const output of outputs) {
    writeGeneratedOutput(output, repoRoot);
  }

  return true;
}

function writeGeneratedOutput({ file, text }, repoRoot) {
  try {
    writeFileSync(file, text);
  } catch (error) {
    throw new Error(`${relativeFile(file, repoRoot)}: ${errorMessage(error)}`);
  }
}

/**
 * @param {object} opts
 * @param {object}    opts.files       — { manifest, pending?, exeCache? } paths
 * @param {function}  opts.build       — ({ ...inputs }) => manifest-build result
 * @param {function}  opts.readInputs  — ({ exeCache, generatedAt }) => inputs for `build`
 * @param {function} [opts.printSummary] — (stats, context) => void
 * @param {string}    opts.helpText
 * @param {string}    opts.repoRoot    — absolute repo root, for relative labels
 * @param {string[]} [opts.argv]       — defaults to `process.argv.slice(2)`
 * @returns {Promise<number>} exit code (0 ok, 1 failure)
 */
export async function runGenerateManifest({
  files,
  build,
  readInputs,
  printSummary = () => {},
  helpText,
  repoRoot,
  argv = process.argv.slice(2),
}) {
  const args = parseCheckStyleArgs(argv);

  if (args.help) {
    console.log(helpText);
    return 0;
  }

  if (args.error) {
    console.error(args.error);
    console.error("");
    console.log(helpText);
    return 1;
  }

  const exeCache = readExeCache(files.exeCache);
  const generatedAt = readGeneratedAtForRun(args.check, files.manifest);
  const inputs = readInputs({ exeCache, generatedAt });

  const result = build(inputs);

  const outputs = await formatGeneratedOutputs(result, files);

  const ok = args.check
    ? checkGeneratedOutputs(outputs, repoRoot)
    : writeGeneratedOutputs(outputs, repoRoot);

  printSummary(result.stats, { check: args.check, ok });
  return ok ? 0 : 1;
}

/**
 * Thin entry-point wrapper: invokes `factory()` to build the options object,
 * then runs `runGenerateManifest` and propagates the returned exit code to
 * `process.exitCode`. Mirrors `runEnrichExeMain` so both runners share the
 * same exit-code contract.
 */
export function runGenerateManifestMain(factory) {
  runGenerateManifest(factory()).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    },
  );
}
