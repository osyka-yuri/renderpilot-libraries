// Shared CLI/IO runner for generated manifest scripts (RenoDX, Luma, and the
// standalone ReShade host manifest). The scripts differ only in which inputs
// they read, how they build their documents, how many generated files they
// emit, and the shape of their summary output. Everything else — argument
// parsing, the `--check` vs write flow, the `generated_at` round-trip for
// reproducible checks, output formatting, and exit-code plumbing — lives here.
//
//   await runGenerateManifest({
//     files: {
//       outputs: { manifest, legacy?, pending? },
//       exeCache?,
//     },
//     build: (inputs) => ({ outputs, stats? }),
//     readInputs,
//     printSummary,
//     helpText,
//   })
//
// `files.outputs.manifest` is the primary document used for `generated_at`
// round-trips under `--check`.

import { existsSync } from "node:fs";
import path from "node:path";

import { errorMessage, generatedAtFromEnv, assertPlainObject } from "./common.mjs";
import {
  readJsonFile,
  readTextFile,
  stringifyFormattedJson,
  writeTextFileAtomic,
} from "./json.mjs";

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

function primaryManifestFile(files) {
  const manifest = files.outputs?.manifest;
  if (!manifest) {
    throw new Error("files.outputs.manifest is required (primary generated document path)");
  }
  return manifest;
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
  if (!files.outputs || typeof files.outputs !== "object") {
    throw new Error("files.outputs must map output keys to absolute file paths");
  }

  const specs = Object.entries(files.outputs).map(([key, file]) => ({
    key,
    file,
    value: result.outputs?.[key],
  }));

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

async function writeGeneratedOutputs(outputs, repoRoot) {
  for (const output of outputs) {
    await writeGeneratedOutput(output, repoRoot);
  }

  return true;
}

async function writeGeneratedOutput({ file, text }, repoRoot) {
  try {
    await writeTextFileAtomic(file, text);
  } catch (error) {
    throw new Error(`${relativeFile(file, repoRoot)}: ${errorMessage(error)}`);
  }
}

/**
 * @param {object} opts
 * @param {object}    opts.files       — { outputs: { manifest, ... }, exeCache? }
 * @param {function}  opts.build       — ({ ...inputs }) => { outputs, stats? }
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
  const generatedAt = readGeneratedAtForRun(args.check, primaryManifestFile(files));
  const inputs = readInputs({ exeCache, generatedAt });

  const result = build(inputs);

  const outputs = await formatGeneratedOutputs(result, files);

  const ok = args.check
    ? checkGeneratedOutputs(outputs, repoRoot)
    : await writeGeneratedOutputs(outputs, repoRoot);

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
