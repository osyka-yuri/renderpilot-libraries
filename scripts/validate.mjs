#!/usr/bin/env node
// Validates every JSON manifest against its JSON Schema (draft 2020-12) using
// ajv. Exits non-zero if any file fails. Run locally (`npm run validate`) and
// in CI before publishing — the file -> schema map lives in catalog.mjs.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { repoRoot, schemaChecks } from './catalog.mjs';

async function loadJson(rel) {
  const text = await readFile(path.join(repoRoot, rel), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${rel}: invalid JSON — ${err.message}`);
  }
}

async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  // Compile each schema once and reuse it — several files share a schema, and
  // re-adding a schema with the same $id would otherwise throw.
  const validators = new Map();
  const failures = [];

  for (const { file, schema } of schemaChecks) {
    console.log(`• ${file}  ⇐  ${schema}`);
    try {
      if (!validators.has(schema)) {
        validators.set(schema, ajv.compile(await loadJson(schema)));
      }
      const validate = validators.get(schema);
      const data = await loadJson(file);

      if (validate(data)) {
        console.log('  ✓ valid');
      } else {
        failures.push(file);
        for (const e of validate.errors) {
          console.error(`  ✗ ${e.instancePath || '/'} ${e.message}`);
        }
      }
    } catch (err) {
      failures.push(file);
      console.error(`  ✗ ${err.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} file(s) failed validation: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll JSON manifests passed schema validation.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
