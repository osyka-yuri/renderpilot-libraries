#!/usr/bin/env node
// Build-time guard: assert every installable RenoDX title's add-on exists
// in the clshortfuse snapshot release.
//
// Snapshot-hosted entries derive `renodx-<slug>.addon64|32` and fetch it live
// from the snapshot release, so a slug that is not published there would create
// a dead Install button. Entries with explicit URL overrides can still carry a
// slug as their canonical local identity; their URL basename must match that
// local identity so a user-downloaded add-on is the same file the app manages.
//
// Snapshot-hosted:
//   - normal installable titles without `download_url`;
//   - generics with `slug` and without explicit url64/url32/download_url.
//
// Off-snapshot / non-installable:
//   - titles with `download_url`;
//   - titles in external/native_hdr/blacklist categories;
//   - generics with url64/url32/download_url.
//
// Missing add-ons are hard failures.
// GitHub/network/API availability problems are soft warnings so offline or
// rate-limited runs do not block CI.
//
//   node scripts/check-renodx-slugs.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./catalog.mjs";
import {
  MAX_ISSUES_TO_PRINT,
  assertManifestShape,
  checkExplicitAddonNames,
  checkGenerics,
  checkTitles,
} from "./lib/renodx-slug-checks.mjs";

import { fetchSnapshotRelease, SnapshotUnavailableError } from "./lib/github.mjs";

async function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  const contents = await readFile(filePath, "utf8");

  try {
    return JSON.parse(contents);
  } catch (err) {
    throw new Error(`Could not parse ${relativePath}: ${err.message}`, {
      cause: err,
    });
  }
}

async function snapshotAssetNames() {
  const release = await fetchSnapshotRelease();

  if (!Array.isArray(release.assets)) {
    throw new SnapshotUnavailableError(
      "GitHub API response did not contain an assets array",
    );
  }

  return new Set(
    release.assets
      .map((asset) => asset?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );
}

function printIssues(header, issues) {
  if (issues.length === 0) {
    return;
  }

  console.error(header);

  for (const item of issues.slice(0, MAX_ISSUES_TO_PRINT)) {
    console.error(`  - ${item}`);
  }

  if (issues.length > MAX_ISSUES_TO_PRINT) {
    console.error(`  …and ${issues.length - MAX_ISSUES_TO_PRINT} more`);
  }
}

function printMissingAndFail(missing) {
  printIssues(
    `\n✗ ${missing.length} add-on(s) are missing upstream — mark them ` +
      "`external`, add an explicit download URL, or drop them:",
    missing,
  );

  process.exitCode = 1;
}

function printExplicitCheckErrorsAndFail({ structural, mismatches }) {
  const total = structural.length + mismatches.length;

  console.error(`\n✗ ${total} explicit add-on URL problem(s) found:`);

  printIssues("  structural:", structural);
  printIssues("  basename mismatches:", mismatches);

  process.exitCode = 1;
}

async function main() {
  const manifest = await readJson("renodx_manifest.json");
  assertManifestShape(manifest);

  const explicitResult = checkExplicitAddonNames(manifest);

  if (explicitResult.structural.length > 0 || explicitResult.mismatches.length > 0) {
    printExplicitCheckErrorsAndFail(explicitResult);
    return;
  }

  console.log(
    `✓ explicit RenoDX add-on URLs match canonical local names ` +
      `(${explicitResult.checked} URLs checked, ` +
      `${explicitResult.skipped} entries skipped).`,
  );

  let assets;

  try {
    assets = await snapshotAssetNames();
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) {
      console.warn(
        `⚠ skipping slug-availability check — could not reach GitHub: ${err.message}`,
      );
      return;
    }

    throw err;
  }

  console.log(`Snapshot release: ${assets.size} assets.`);

  const titleResult = checkTitles(manifest.titles, manifest.generics, assets);
  const genericResult = checkGenerics(manifest.generics, assets);

  const missing = [...titleResult.missing, ...genericResult.missing];

  if (missing.length > 0) {
    printMissingAndFail(missing);
    return;
  }

  console.log(
    `✓ all snapshot-hosted RenoDX add-ons resolve to published assets ` +
      `(${titleResult.checked} titles, ${genericResult.checked} generics checked; ` +
      `${titleResult.skipped} titles, ${genericResult.skipped} generics skipped; ` +
      `${manifest.titles.length} titles total).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
