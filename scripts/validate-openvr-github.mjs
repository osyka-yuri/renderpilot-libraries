#!/usr/bin/env node

import path from "node:path";

import { openVrLibraryVendor, repoRoot } from "./catalog.mjs";
import { buildVendorSnapshot } from "./lib/library-catalog.mjs";
import { readJsonAtGitRef } from "./lib/git-json.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import {
  assertOpenVrLockExtendsBaseline,
  assertOpenVrLockSemantics,
  buildOpenVrVendorSource,
} from "./lib/openvr-github.mjs";

async function main() {
  const [config, lock, snapshot] = await Promise.all([
    readJsonFileAsync(path.join(repoRoot, openVrLibraryVendor.configFile)),
    readJsonFileAsync(path.join(repoRoot, openVrLibraryVendor.lockFile)),
    readJsonFileAsync(path.join(repoRoot, openVrLibraryVendor.outputFile)),
  ]);
  assertOpenVrLockSemantics(lock, config);
  if (lock.releases.length < config.expected_stable_releases) {
    throw new Error(
      `expected at least ${config.expected_stable_releases} OpenVR releases, got ${lock.releases.length}`,
    );
  }
  const baselineRef = process.env.OPENVR_GITHUB_BASE_REF || "HEAD";
  const baseline = await readJsonAtGitRef(baselineRef, openVrLibraryVendor.lockFile, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (baseline) {
    assertOpenVrLockSemantics(baseline, config);
    assertOpenVrLockExtendsBaseline(lock, baseline);
  } else {
    console.log(`OpenVR lock has no baseline at ${baselineRef} (initial import).`);
  }
  const expected = buildVendorSnapshot(buildOpenVrVendorSource(lock, config));
  if (JSON.stringify(expected) !== JSON.stringify(snapshot)) {
    throw new Error("Valve vendor snapshot does not match its deterministic sources");
  }
  if (snapshot.packages.length !== lock.releases.length * 2) {
    throw new Error("Valve snapshot must contain one X64 and one X86 package per release");
  }
  console.log(
    `OpenVR lock is valid: ${lock.releases.length} releases, ${snapshot.artifacts.length} unique DLLs, ${snapshot.packages.length} packages.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
