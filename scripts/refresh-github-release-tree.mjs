#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { githubReleaseTreeVendors, repoRoot } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { UsageError, mapConcurrent } from "./lib/common.mjs";
import {
  assertGitHubReleaseTreeLock,
  assertGitHubReleaseTreeLockExtendsBaseline,
  assertLockedReleaseIdentities,
  listStableGitHubReleases,
  parseRemoteTagIdentities,
  sortGitHubReleaseTreeLock,
} from "./lib/github-release-tree.mjs";
import { constructGitHubReleaseTreeRelease } from "./lib/github-release-tree-importer.mjs";
import { runGitHubReleaseTreeRefreshBatch } from "./lib/github-release-tree-refresh.mjs";
import { appendGithubOutput } from "./lib/github-actions.mjs";
import { readJsonFileAsync, writeJsonFilesBatchWithRollback } from "./lib/json.mjs";
import { parseRefreshArgs } from "./lib/refresh-cli.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  return parseRefreshArgs(argv, {
    allowBackfillSignatures: true,
    allowProduct: false,
    target: "vendor-or-all",
  });
}

async function main(options) {
  const vendors = options.all
    ? githubReleaseTreeVendors
    : [
        githubReleaseTreeVendors.find(
          (candidate) => candidate.vendorId === options.vendorId,
        ),
      ];
  if (vendors.some((vendor) => !vendor)) {
    throw new UsageError(`unknown GitHub release-tree vendor ${options.vendorId}`);
  }

  await runGitHubReleaseTreeRefreshBatch(vendors, options, {
    discoverVendor,
    prepareVendor,
    writeResults,
    reportResults,
  });
}

async function discoverVendor(vendor) {
  const configFile = path.join(repoRoot, vendor.configFile);
  const lockFile = path.join(repoRoot, vendor.lockFile);
  const [config, lock] = await Promise.all([
    readJsonFileAsync(configFile),
    readJsonFileAsync(lockFile),
  ]);
  const tagIdentities = await resolveRemoteTagIdentities(config.repository);
  assertGitHubReleaseTreeLock(lock, config);
  const immutableBaseline = structuredClone(lock);
  const upstream = await listStableGitHubReleases(config, { tagIdentities });
  assertLockedReleaseIdentities(lock, upstream);
  const lockedTags = new Set(lock.releases.map((release) => release.tag));
  const missing = upstream.filter((release) => !lockedTags.has(release.tag));
  return {
    vendor,
    config,
    lock,
    lockFile,
    upstream,
    missing,
    immutableBaseline,
  };
}

async function prepareVendor(discovery, options) {
  const { vendor, config, lock, lockFile, upstream, missing, immutableBaseline } =
    discovery;

  if (options.mode === "materialize-locked" || options.mode === "backfill-signatures") {
    await materializeLocked(vendor, config, lock, upstream, immutableBaseline, {
      allowTimestampBackfill: options.mode === "backfill-signatures",
    });
    return {
      vendor,
      config,
      lockFile,
      lock,
      missingCount: missing.length,
      changed: true,
    };
  }
  if (missing.length === 0) {
    console.log(`${vendor.vendorId} lock is current (${upstream.length} stable releases).`);
    return { vendor, lockFile, lock, missingCount: 0, changed: false };
  }
  console.log(`Missing stable ${vendor.vendorId} releases: ${missing.length}`);
  if (options.mode !== "write") {
    for (const release of missing) console.log(`  ${release.tag}`);
    return {
      vendor,
      lockFile,
      lock,
      missingCount: missing.length,
      changed: false,
    };
  }

  let completed = 0;
  const imported = await mapConcurrent(
    missing,
    vendor.refreshConcurrency,
    async (release) => {
      const result = await constructGitHubReleaseTreeRelease(release, config);
      completed += 1;
      console.log(`[${completed}/${missing.length}] imported ${release.tag}`);
      return result;
    },
  );
  lock.releases.push(...imported);
  sortGitHubReleaseTreeLock(lock);
  assertGitHubReleaseTreeLock(lock, config);
  assertGitHubReleaseTreeLockExtendsBaseline(lock, immutableBaseline);
  return {
    vendor,
    config,
    lockFile,
    lock,
    missingCount: missing.length,
    changed: true,
  };
}

async function writeResults(results) {
  await writeJsonFilesBatchWithRollback(
    results.map(({ lockFile, lock }) => ({ file: lockFile, value: lock })),
    {
      validate(lock, _lockFile, index) {
        assertGitHubReleaseTreeLock(lock, results[index].config);
      },
    },
  );
  for (const result of results) {
    console.log(`Updated ${path.relative(repoRoot, result.lockFile)}.`);
  }
}

async function reportResults(results) {
  const missingCount = results.reduce((sum, result) => sum + result.missingCount, 0);
  await appendGithubOutput({
    status: missingCount === 0 ? "current" : "update_available",
    count: String(missingCount),
  });
}

async function materializeLocked(
  vendor,
  config,
  lock,
  upstream,
  immutableBaseline,
  { allowTimestampBackfill },
) {
  const upstreamByTag = new Map(upstream.map((release) => [release.tag, release]));
  let completed = 0;
  const rebuilt = await mapConcurrent(
    lock.releases,
    vendor.refreshConcurrency,
    async (expected) => {
      const release = upstreamByTag.get(expected.tag);
      if (!release) throw new Error(`${expected.tag}: release disappeared upstream`);
      const result = await constructGitHubReleaseTreeRelease(release, config, expected, {
        allowTimestampBackfill,
      });
      completed += 1;
      console.log(`[${completed}/${lock.releases.length}] materialized ${expected.tag}`);
      return result;
    },
  );
  lock.releases = rebuilt;
  sortGitHubReleaseTreeLock(lock);
  assertGitHubReleaseTreeLock(lock, config);
  assertGitHubReleaseTreeLockExtendsBaseline(lock, immutableBaseline, {
    allowSignatureTimestampBackfill: allowTimestampBackfill,
  });
  console.log(
    allowTimestampBackfill
      ? `Re-verified ${rebuilt.length} releases and backfilled available signature timestamps.`
      : `Materialized ${rebuilt.length} locked ${vendor.vendorId} releases.`,
  );
}

async function resolveRemoteTagIdentities(repository) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-remote", "--tags", `https://github.com/${repository}.git`],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseRemoteTagIdentities(stdout);
}

runCliMain({ parse: parseArgs, main });
