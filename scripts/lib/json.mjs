import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";

import { assertPlainObject, errorMessage } from "./common.mjs";

const JSON_INDENT = 2;
const UTF8 = "utf8";

function fail(context, message, cause) {
  throw new Error(`${context}: ${message}`, { cause });
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function stringifyJsonInternal(value, context, space) {
  let text;

  try {
    text = JSON.stringify(value, null, space);
  } catch (error) {
    fail(context, `cannot stringify JSON - ${errorMessage(error)}`, error);
  }

  if (text === undefined) {
    fail(context, "value is not JSON-serializable");
  }

  return text;
}

function writeTextFile(file, text, context = file) {
  try {
    writeFileSync(file, text, UTF8);
  } catch (error) {
    fail(context, errorMessage(error), error);
  }
}

async function loadPrettier(context) {
  try {
    return await import("prettier");
  } catch (error) {
    fail(context, `cannot load prettier - ${errorMessage(error)}`, error);
  }
}

async function resolvePrettierConfig(prettier, file) {
  try {
    return (await prettier.resolveConfig(file)) ?? {};
  } catch (error) {
    fail(file, `cannot resolve prettier config - ${errorMessage(error)}`, error);
  }
}

function assertNumericObjectKey(key, context) {
  if (key.trim() === "" || !Number.isFinite(Number(key))) {
    fail(context, `expected numeric object keys, got ${JSON.stringify(key)}`);
  }
}

function compareNumericKeys(a, b) {
  return Number(a) - Number(b);
}

function stringifyJson(value) {
  return `${stringifyJsonInternal(value, "JSON", JSON_INDENT)}\n`;
}

export async function stringifyFormattedJson(value, file) {
  const prettier = await loadPrettier(file);
  const config = await resolvePrettierConfig(prettier, file);
  const json = stringifyJsonInternal(value, file, undefined);

  try {
    return ensureTrailingNewline(
      await prettier.format(json, {
        ...config,
        filepath: file,
        parser: "json",
      }),
    );
  } catch (error) {
    fail(file, `cannot format JSON - ${errorMessage(error)}`, error);
  }
}

export function readTextFile(file, context = file) {
  try {
    return readFileSync(file, UTF8);
  } catch (error) {
    fail(context, errorMessage(error), error);
  }
}

export function readJsonFile(file, context = file) {
  const text = readTextFile(file, context);

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(context, `invalid JSON - ${errorMessage(error)}`, error);
  }
}

/**
 * Async counterpart of `readJsonFile` for scripts that already run in an
 * async context (`check-renodx-slugs.mjs`, `check-luma-assets.mjs`). Reads
 * `file` from disk, parses it, and rethrows a wrapped error with the shared
 * `invalid JSON - …` wording on a parse failure.
 */
export async function readJsonFileAsync(file, context = file) {
  let text;
  try {
    text = await readFile(file, UTF8);
  } catch (error) {
    fail(context, errorMessage(error), error);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(context, `invalid JSON - ${errorMessage(error)}`, error);
  }
}

export async function writeFormattedJsonFile(file, value) {
  writeTextFile(file, await stringifyFormattedJson(value, file));
}

export function sortNumericObject(value, context = "object") {
  assertPlainObject(value, context);

  const keys = Object.keys(value);

  for (const key of keys) {
    assertNumericObjectKey(key, context);
  }

  return Object.fromEntries(keys.sort(compareNumericKeys).map((key) => [key, value[key]]));
}
