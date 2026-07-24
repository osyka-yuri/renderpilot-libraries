import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  const json = stringifyJsonInternal(value, file, JSON_INDENT);

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

export async function writeTextFileAtomic(file, text, context = file) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await writeFile(temp, text, UTF8);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    fail(context, errorMessage(error), error);
  }
}

export async function writeJsonFileAtomic(file, value) {
  await writeTextFileAtomic(file, stringifyJson(value));
}

async function cleanupBatchTemporaryFiles(prepared, operations) {
  const temporaryFiles = prepared.flatMap((entry) => [entry.stage, entry.rollback]);
  const results = await Promise.allSettled(
    temporaryFiles.map((file) =>
      Promise.resolve().then(() => operations.rm(file, { force: true })),
    ),
  );
  return results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${temporaryFiles[index]}: ${errorMessage(result.reason)}`]
      : [],
  );
}

/**
 * Stages every JSON document before replacing any target. Each rename is
 * atomic on its own; if a later rename fails, already replaced targets are
 * restored from their exact original bytes. This is deliberately not exposed
 * as a cross-file atomic transaction.
 */
export async function writeJsonFilesBatchWithRollback(
  entries,
  { validate = async () => {}, operations = { readFile, rename, rm, writeFile } } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("batch JSON write entries must be a non-empty array");
  }

  const prepared = [];
  const targets = new Set();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.file !== "string" || entry.file.trim() === "") {
      throw new Error(`batch JSON write entry ${index} has no target file`);
    }
    const resolved = path.resolve(entry.file);
    if (targets.has(resolved)) {
      throw new Error(`batch JSON write has duplicate target ${entry.file}`);
    }
    targets.add(resolved);
    await validate(entry.value, entry.file, index);
    prepared.push({
      file: entry.file,
      text: stringifyJson(entry.value),
      stage: path.join(
        path.dirname(entry.file),
        `.${path.basename(entry.file)}.${process.pid}.${randomUUID()}.stage.tmp`,
      ),
      rollback: path.join(
        path.dirname(entry.file),
        `.${path.basename(entry.file)}.${process.pid}.${randomUUID()}.rollback.tmp`,
      ),
      original: null,
      existed: true,
    });
  }

  for (const entry of prepared) {
    try {
      entry.original = await operations.readFile(entry.file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entry.existed = false;
    }
  }

  const stagingResults = await Promise.allSettled(
    prepared.map((entry) =>
      Promise.resolve().then(() => operations.writeFile(entry.stage, entry.text, UTF8)),
    ),
  );
  const stagingErrors = stagingResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${prepared[index].stage}: ${errorMessage(result.reason)}`]
      : [],
  );
  if (stagingErrors.length > 0) {
    const cleanupErrors = await cleanupBatchTemporaryFiles(prepared, operations);
    throw new Error(
      [
        `batch JSON staging failed: ${stagingErrors.join("; ")}`,
        ...(cleanupErrors.length > 0
          ? [`temporary cleanup also failed: ${cleanupErrors.join("; ")}`]
          : []),
      ].join("; "),
      {
        cause: stagingResults.find((result) => result.status === "rejected")?.reason,
      },
    );
  }

  const replaced = [];
  try {
    for (const entry of prepared) {
      await operations.rename(entry.stage, entry.file);
      replaced.push(entry);
    }
  } catch (writeError) {
    const rollbackErrors = [];
    for (const entry of replaced.reverse()) {
      try {
        if (entry.existed) {
          await operations.writeFile(entry.rollback, entry.original);
          await operations.rename(entry.rollback, entry.file);
        } else {
          await operations.rm(entry.file, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.file}: ${errorMessage(rollbackError)}`);
      }
    }
    const cleanupErrors = await cleanupBatchTemporaryFiles(prepared, operations);
    if (rollbackErrors.length > 0) {
      throw new Error(
        [
          `batch JSON write failed: ${errorMessage(writeError)}`,
          `rollback also failed: ${rollbackErrors.join("; ")}`,
          ...(cleanupErrors.length > 0
            ? [`temporary cleanup also failed: ${cleanupErrors.join("; ")}`]
            : []),
        ].join("; "),
        { cause: writeError },
      );
    }
    throw new Error(
      [
        `batch JSON write failed and was rolled back: ${errorMessage(writeError)}`,
        ...(cleanupErrors.length > 0
          ? [`temporary cleanup also failed: ${cleanupErrors.join("; ")}`]
          : []),
      ].join("; "),
      {
        cause: writeError,
      },
    );
  }
}

export async function writeFormattedJsonFile(file, value) {
  await writeTextFileAtomic(file, await stringifyFormattedJson(value, file));
}

export function sortNumericObject(value, context = "object") {
  assertPlainObject(value, context);

  const keys = Object.keys(value);

  for (const key of keys) {
    assertNumericObjectKey(key, context);
  }

  return Object.fromEntries(keys.sort(compareNumericKeys).map((key) => [key, value[key]]));
}
