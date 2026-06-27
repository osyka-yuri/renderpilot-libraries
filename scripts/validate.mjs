#!/usr/bin/env node
// Validates every JSON manifest against its JSON Schema (draft 2020-12) using
// Ajv. Exits non-zero if any file fails. Run locally (`npm run validate`) and
// in CI before publishing — the file -> schema map lives in catalog.mjs.

import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { repoRoot, schemaChecks } from "./catalog.mjs";

const STATUS = {
  check: "•",
  pass: "✓",
  fail: "✗",
};

function formatCaughtError(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveRepoPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`invalid repo-relative path: ${JSON.stringify(relPath)}`);
  }

  if (path.isAbsolute(relPath)) {
    throw new Error(`expected repo-relative path, got absolute path: ${relPath}`);
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relPath);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes repo root: ${relPath}`);
  }

  return resolved;
}

async function readTextFile(relPath) {
  return readFile(resolveRepoPath(relPath), "utf8");
}

async function loadJson(relPath) {
  const text = await readTextFile(relPath);

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relPath}: invalid JSON — ${formatCaughtError(error)}`);
  }
}

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,

    // Kept intentionally for compatibility with existing schemas. Once the
    // schemas are strict-clean, this can be changed to `true`.
    strict: false,
  });

  addFormats(ajv);
  return ajv;
}

function assertSchemaChecks(checks) {
  if (!Array.isArray(checks)) {
    throw new Error("catalog.mjs: schemaChecks must be an array");
  }

  if (checks.length === 0) {
    throw new Error("catalog.mjs: schemaChecks is empty");
  }

  for (const [index, check] of checks.entries()) {
    if (!check || typeof check !== "object") {
      throw new Error(`catalog.mjs: schemaChecks[${index}] must be an object`);
    }

    if (typeof check.file !== "string" || check.file.length === 0) {
      throw new Error(
        `catalog.mjs: schemaChecks[${index}].file must be a non-empty string`,
      );
    }

    if (typeof check.schema !== "string" || check.schema.length === 0) {
      throw new Error(
        `catalog.mjs: schemaChecks[${index}].schema must be a non-empty string`,
      );
    }
  }
}

function formatAjvParams(params) {
  if (!params || Object.keys(params).length === 0) {
    return "";
  }

  return ` — ${JSON.stringify(params)}`;
}

function formatValidationError(error) {
  const location = error.instancePath || "/";
  const message = error.message || "schema validation failed";
  return `${location} ${message}${formatAjvParams(error.params)}`;
}

async function getValidator(schemaRelPath, validators) {
  const cached = validators.get(schemaRelPath);

  if (cached) {
    return cached;
  }

  const schema = await loadJson(schemaRelPath);
  const validate = createAjv().compile(schema);

  validators.set(schemaRelPath, validate);
  return validate;
}

async function validateJsonFile({ file, schema }, validators) {
  console.log(`${STATUS.check} ${file}  ⇐  ${schema}`);

  const validate = await getValidator(schema, validators);
  const data = await loadJson(file);

  if (validate(data)) {
    console.log(`  ${STATUS.pass} valid`);
    return { file, ok: true };
  }

  for (const error of validate.errors ?? []) {
    console.error(`  ${STATUS.fail} ${formatValidationError(error)}`);
  }

  return { file, ok: false };
}

async function main() {
  assertSchemaChecks(schemaChecks);

  const validators = new Map();
  const failures = [];

  for (const check of schemaChecks) {
    try {
      const result = await validateJsonFile(check, validators);

      if (!result.ok) {
        failures.push(result.file);
      }
    } catch (error) {
      failures.push(check.file);
      console.error(`  ${STATUS.fail} ${formatCaughtError(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed validation: ${failures.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nAll JSON manifests passed schema validation.");
}

main().catch((error) => {
  console.error(formatCaughtError(error));
  process.exitCode = 1;
});
