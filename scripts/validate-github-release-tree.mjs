#!/usr/bin/env node

import path from "node:path";

import { githubReleaseTreeVendors, repoRoot } from "./catalog.mjs";
import {
  assertGitHubReleaseTreeLock,
  assertGitHubReleaseTreeLockExtendsBaseline,
  buildGitHubReleaseTreeVendorSource,
} from "./lib/github-release-tree.mjs";
import { buildVendorSnapshot } from "./lib/library-catalog.mjs";
import { readJsonAtGitRef } from "./lib/git-json.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";

async function main() {
  const baselineRef = process.env.LIBRARIES_GITHUB_BASE_REF || "HEAD";
  for (const vendor of githubReleaseTreeVendors) {
    const [config, lock, overlay, snapshot] = await Promise.all([
      readJsonFileAsync(path.join(repoRoot, vendor.configFile)),
      readJsonFileAsync(path.join(repoRoot, vendor.lockFile)),
      vendor.overlayFile
        ? readJsonFileAsync(path.join(repoRoot, vendor.overlayFile))
        : Promise.resolve(null),
      readJsonFileAsync(path.join(repoRoot, vendor.outputFile)),
    ]);
    assertGitHubReleaseTreeLock(lock, config);
    if (lock.releases.length < config.expected_stable_releases) {
      throw new Error(
        `${vendor.vendorId}: expected at least ${config.expected_stable_releases} releases, got ${lock.releases.length}`,
      );
    }
    const baseline = await readJsonAtGitRef(baselineRef, vendor.lockFile, {
      cwd: repoRoot,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (
      baseline?.schema_version === lock.schema_version &&
      baseline?.profile === lock.profile
    ) {
      assertGitHubReleaseTreeLockExtendsBaseline(lock, baseline);
    } else if (baseline) {
      console.log(
        `${vendor.vendorId} lock starts a new append-only baseline after a reviewed contract migration.`,
      );
    } else {
      console.log(
        `${vendor.vendorId} lock has no baseline at ${baselineRef} (initial import).`,
      );
    }
    const expected = buildVendorSnapshot(
      buildGitHubReleaseTreeVendorSource(lock, config, overlay),
    );
    if (JSON.stringify(expected) !== JSON.stringify(snapshot)) {
      throw new Error(
        `${vendor.vendorId} snapshot does not match its deterministic sources`,
      );
    }
    const imported = lock.releases.filter(
      (release) => release.disposition === "imported",
    ).length;
    const excluded = lock.releases.length - imported;
    console.log(
      `${vendor.vendorId} GitHub lock is valid: ${lock.releases.length} releases (${imported} imported, ${excluded} excluded), ${snapshot.artifacts.length} unique DLLs, ${snapshot.packages.length} packages, ${snapshot.legal_documents.length} legal documents.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
