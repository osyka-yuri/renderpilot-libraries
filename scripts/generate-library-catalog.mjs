#!/usr/bin/env node

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  curatedLibraryVendors,
  generatedLibraryVendors,
  libraryIndexFile,
  repoRoot,
} from "./catalog.mjs";
import {
  buildLibraryIndex,
  buildVendorSnapshot,
  jsonDocument,
} from "./lib/library-catalog.mjs";
import {
  assertGeneratedLibraryVendorAdapters,
  buildGeneratedLibraryVendorSource,
} from "./lib/library-source-adapters.mjs";
import { readJsonFileAsync, writeTextFileAtomic } from "./lib/json.mjs";

async function main() {
  const check = process.argv.slice(2).includes("--check");
  assertGeneratedLibraryVendorAdapters(generatedLibraryVendors);
  const [curatedSources, generatedSources] = await Promise.all([
    Promise.all(
      curatedLibraryVendors.map(async (vendor) => ({
        vendor,
        source: await readJsonFileAsync(path.join(repoRoot, vendor.sourceFile)),
      })),
    ),
    Promise.all(generatedLibraryVendors.map(loadGeneratedVendorSource)),
  ]);

  const registeredSources = [...curatedSources, ...generatedSources];
  const vendorDocuments = registeredSources.map(({ vendor, source }) => {
    if (source?.vendor?.id !== vendor.vendorId) {
      throw new Error(
        `${vendor.sourceFile ?? vendor.lockFile}: expected vendor ${vendor.vendorId}, got ${source?.vendor?.id ?? "missing"}`,
      );
    }
    const snapshot = buildVendorSnapshot(source);
    return { vendor, snapshot, body: jsonDocument(snapshot) };
  });
  const index = buildLibraryIndex(vendorDocuments);
  const outputs = [
    ...vendorDocuments.map(({ vendor, body }) => ({
      file: path.join(repoRoot, vendor.outputFile),
      body,
    })),
    { file: path.join(repoRoot, libraryIndexFile), body: jsonDocument(index) },
  ];

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
  await Promise.all(
    outputs.map((output) =>
      writeTextFileAtomic(output.file, output.body, path.relative(repoRoot, output.file)),
    ),
  );
  console.log(`Generated ${vendorDocuments.length} vendor snapshots and library index v1.`);
}

async function loadGeneratedVendorSource(vendor) {
  const [lock, config] = await Promise.all([
    readJsonFileAsync(path.join(repoRoot, vendor.lockFile)),
    readJsonFileAsync(path.join(repoRoot, vendor.configFile)),
  ]);
  return {
    vendor,
    source: buildGeneratedLibraryVendorSource(vendor, lock, config),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
