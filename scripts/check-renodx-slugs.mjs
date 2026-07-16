#!/usr/bin/env node
// Build-time guard: assert every installable RenoDX game's add-on exists
// in the clshortfuse snapshot release.
//
// Reads the canonical v1 catalogue (`addons/v1/renodx.json`).
//
// Snapshot-hosted:
//   - normal installable games without `addon.source`;
//   - engine_profiles with `addon.slug` and without `addon.sources`.
//
// Off-snapshot / non-installable:
//   - games with `addon.source`;
//   - games with availability external / native_hdr / blocked;
//   - engine_profiles with explicit addon.sources.
//
// Missing add-ons are hard failures.
// GitHub/network/API availability problems are soft warnings so offline or
// rate-limited runs do not block CI.
//
//   node scripts/check-renodx-slugs.mjs

import { addonCatalogs } from "./catalog.mjs";
import { errorMessage } from "./lib/common.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import { printIssues } from "./lib/checks.mjs";
import {
  assertManifestShape,
  checkExplicitAddonNames,
  checkGames,
  checkProfiles,
} from "./lib/renodx-slug-checks.mjs";
import { fetchSnapshotAssetNames, SnapshotUnavailableError } from "./lib/github.mjs";

function printMissingAndFail(missing) {
  printIssues(
    `\nFAIL ${missing.length} add-on(s) are missing upstream — mark them ` +
      "`external`/`blocked`, add an explicit source URL, or drop them:",
    missing,
  );

  process.exitCode = 1;
}

function printExplicitCheckErrorsAndFail({ structural, mismatches }) {
  const total = structural.length + mismatches.length;

  console.error(`\nFAIL ${total} explicit add-on URL problem(s) found:`);

  printIssues("  structural:", structural);
  printIssues("  basename mismatches:", mismatches);

  process.exitCode = 1;
}

async function main() {
  const manifest = await readJsonFileAsync(
    addonCatalogs.renodx.outputs.manifest.file,
    "addons/v1/renodx.json",
  );
  assertManifestShape(manifest);

  const explicitResult = checkExplicitAddonNames(manifest);

  if (explicitResult.structural.length > 0 || explicitResult.mismatches.length > 0) {
    printExplicitCheckErrorsAndFail(explicitResult);
    return;
  }

  console.log(
    `OK explicit RenoDX add-on URLs match canonical local names ` +
      `(${explicitResult.checked} URLs checked, ` +
      `${explicitResult.skipped} entries skipped).`,
  );

  let assets;

  try {
    assets = await fetchSnapshotAssetNames();
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) {
      console.warn(
        `SKIP slug-availability check — could not reach GitHub: ${errorMessage(err)}`,
      );
      return;
    }

    throw err;
  }

  console.log(`Snapshot release: ${assets.size} assets.`);

  const gameResult = checkGames(manifest.games, manifest.engine_profiles, assets);
  const profileResult = checkProfiles(manifest.engine_profiles, assets);

  const missing = [...gameResult.missing, ...profileResult.missing];

  if (missing.length > 0) {
    printMissingAndFail(missing);
    return;
  }

  console.log(
    `OK all snapshot-hosted RenoDX add-ons resolve to published assets ` +
      `(${gameResult.checked} games, ${profileResult.checked} engine profiles checked; ` +
      `${gameResult.skipped} games, ${profileResult.skipped} profiles skipped; ` +
      `${manifest.games.length} games total).`,
  );
}

runCliMain({
  parse: () => ({}),
  main,
});
