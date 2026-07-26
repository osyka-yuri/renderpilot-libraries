#!/usr/bin/env node

import path from "node:path";

import { libraryIndexFile, r2, repoRoot } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { buildLibraryCatalogPlan } from "./lib/library-generation.mjs";
import {
  formatLifecyclePlan,
  loadMicrosoftCatalogState,
  MICROSOFT_PRUNE_HELP,
  parseMicrosoftPruneArgs,
} from "./lib/microsoft-lifecycle.mjs";
import { microsoftPrunePlan } from "./lib/microsoft-nuget.mjs";
import {
  assertPublishedWithdrawalCommitted,
  deleteObjectAndVerifyAbsent,
} from "./lib/microsoft-prune-r2.mjs";
import { createR2Client } from "./lib/r2-client.mjs";

async function main(options) {
  const { lock } = await loadMicrosoftCatalogState();
  const catalogPlan = await buildLibraryCatalogPlan();
  let activeObjectKeys = catalogPlan.activeTransportObjectKeys;
  let s3 = null;
  if (options.execute) {
    s3 = createR2Client(process.env);
    activeObjectKeys = await assertPublishedWithdrawalCommitted(s3, {
      bucket: r2.bucket,
      localIndexFile: path.join(repoRoot, libraryIndexFile),
      packageId: options.packageId,
      packageVersion: options.packageVersion,
    });
  }
  const plan = microsoftPrunePlan(
    lock,
    options.packageId,
    options.packageVersion,
    activeObjectKeys,
  );
  console.log(formatLifecyclePlan(options.execute ? "prune" : "dry_run", plan));
  if (!options.execute) return;

  for (const key of plan.delete_object_keys) {
    await deleteObjectAndVerifyAbsent(s3, { bucket: r2.bucket, key });
    console.log(`  deleted ${key}`);
  }
}

function printHelp() {
  console.error(MICROSOFT_PRUNE_HELP);
}

runCliMain({ parse: parseMicrosoftPruneArgs, help: printHelp, main });
