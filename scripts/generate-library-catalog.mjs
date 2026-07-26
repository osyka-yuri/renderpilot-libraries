#!/usr/bin/env node

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { buildLibraryCatalogPlan } from "./lib/library-generation.mjs";
import { writeJsonFilesBatchWithRollback } from "./lib/json.mjs";

async function main() {
  const check = process.argv.slice(2).includes("--check");
  const { outputs } = await buildLibraryCatalogPlan();

  if (check) {
    for (const output of outputs) {
      const current = await readFile(output.file);
      if (!current.equals(output.body)) {
        throw new Error(
          `${path.relative(repoRoot, output.file)} is stale; run pnpm run libraries:generate`,
        );
      }
    }
    console.log("Library v1 index and vendor snapshots are deterministic and current.");
    return;
  }

  await Promise.all(
    [...new Set(outputs.map(({ file }) => path.dirname(file)))].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await writeJsonFilesBatchWithRollback(outputs.map(({ file, body }) => ({ file, body })));
  console.log(`Generated ${outputs.length - 1} vendor snapshots and library index v1.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
