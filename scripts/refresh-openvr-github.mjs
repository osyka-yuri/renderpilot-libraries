#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { openVrLibraryVendor, repoRoot } from "./catalog.mjs";
import { errorMessage, mapConcurrent } from "./lib/common.mjs";
import { appendGithubOutput } from "./lib/github-actions.mjs";
import { readJsonFileAsync, writeJsonFileAtomic } from "./lib/json.mjs";
import {
  assertOpenVrLockBackfillsTimestamps,
  assertOpenVrLockExtendsBaseline,
  assertOpenVrLockSemantics,
  listedStableOpenVrReleases,
  parseRemoteTagCommits,
  sortOpenVrLock,
} from "./lib/openvr-github.mjs";
import { constructOpenVrRelease } from "./lib/openvr-importer.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = path.join(repoRoot, openVrLibraryVendor.configFile);
const LOCK_FILE = path.join(repoRoot, openVrLibraryVendor.lockFile);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [config, lock, tagCommits] = await Promise.all([
    readJsonFileAsync(CONFIG_FILE),
    readJsonFileAsync(LOCK_FILE),
    resolveRemoteTagCommits(),
  ]);
  assertOpenVrLockSemantics(lock, config);
  const immutableBaseline = structuredClone(lock);
  const upstream = await listedStableOpenVrReleases(config, { tagCommits });
  assertLockedReleaseIdentities(lock, upstream);

  const lockedTags = new Set(lock.releases.map((release) => release.tag));
  const missing = upstream.filter((release) => !lockedTags.has(release.tag));
  await appendGithubOutput({
    status: missing.length === 0 ? "current" : "update_available",
    count: String(missing.length),
  });

  if (options.materializeLocked || options.backfillSignatures) {
    await materializeLocked(lock, config, upstream, immutableBaseline, {
      allowTimestampBackfill: options.backfillSignatures,
    });
    return;
  }
  if (missing.length === 0) {
    console.log(`OpenVR lock is current (${upstream.length} stable releases).`);
    return;
  }
  console.log(`Missing stable OpenVR releases: ${missing.length}`);
  if (!options.write) {
    for (const release of missing) console.log(`  ${release.tag}`);
    return;
  }

  let completed = 0;
  const imported = await mapConcurrent(missing, 4, async (release) => {
    const result = await constructOpenVrRelease(release, config);
    completed += 1;
    console.log(`[${completed}/${missing.length}] imported ${release.tag}`);
    return result;
  });
  lock.releases.push(...imported);
  sortOpenVrLock(lock);
  assertOpenVrLockSemantics(lock, config);
  assertOpenVrLockExtendsBaseline(lock, immutableBaseline);
  await writeJsonFileAtomic(LOCK_FILE, lock);
  console.log(`Updated ${path.relative(repoRoot, LOCK_FILE)}.`);
}

async function resolveRemoteTagCommits() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-remote", "--tags", "https://github.com/ValveSoftware/openvr.git"],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return parseRemoteTagCommits(stdout);
}

function assertLockedReleaseIdentities(lock, upstream) {
  const upstreamByTag = new Map(upstream.map((release) => [release.tag, release]));
  for (const locked of lock.releases) {
    const current = upstreamByTag.get(locked.tag);
    if (!current) throw new Error(`${locked.tag}: locked release disappeared upstream`);
    if (
      locked.release_id !== current.releaseId ||
      locked.version !== current.version ||
      locked.label !== current.label ||
      locked.published_at !== current.publishedAt ||
      locked.commit_sha !== current.commitSha
    ) {
      throw new Error(`${locked.tag}: immutable GitHub release identity changed`);
    }
  }
}

async function materializeLocked(
  lock,
  config,
  upstream,
  immutableBaseline,
  { allowTimestampBackfill },
) {
  const upstreamByTag = new Map(upstream.map((release) => [release.tag, release]));
  let completed = 0;
  const rebuilt = await mapConcurrent(lock.releases, 4, async (expected) => {
    const release = upstreamByTag.get(expected.tag);
    if (!release) throw new Error(`${expected.tag}: release disappeared upstream`);
    const result = await constructOpenVrRelease(release, config, expected, {
      allowTimestampBackfill,
    });
    completed += 1;
    console.log(`[${completed}/${lock.releases.length}] materialized ${expected.tag}`);
    return result;
  });
  lock.releases = rebuilt;
  sortOpenVrLock(lock);
  assertOpenVrLockSemantics(lock, config);
  const backfilled = allowTimestampBackfill
    ? assertOpenVrLockBackfillsTimestamps(lock, immutableBaseline)
    : 0;
  if (!allowTimestampBackfill) {
    assertOpenVrLockExtendsBaseline(lock, immutableBaseline);
  }
  await writeJsonFileAtomic(LOCK_FILE, lock);
  console.log(
    allowTimestampBackfill
      ? `Backfilled ${backfilled} OpenVR Authenticode timestamps.`
      : `Materialized ${rebuilt.length} locked OpenVR releases.`,
  );
}

function parseArgs(argv) {
  const options = {
    write: false,
    materializeLocked: false,
    backfillSignatures: false,
  };
  for (const argument of argv) {
    if (argument === "--write") options.write = true;
    else if (argument === "--check") options.write = false;
    else if (argument === "--materialize-locked") options.materializeLocked = true;
    else if (argument === "--backfill-signatures") options.backfillSignatures = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (
    [options.write, options.materializeLocked, options.backfillSignatures].filter(Boolean)
      .length > 1
  ) {
    throw new Error(
      "--write, --materialize-locked, and --backfill-signatures are mutually exclusive",
    );
  }
  return options;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
