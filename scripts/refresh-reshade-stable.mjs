#!/usr/bin/env node
// Detect a newer stable ReShade Addon installer and optionally rewrite the
// SSoT pin + regenerate manifests. Never bumps Luma minimum_reshade_version.
//
//   node scripts/refresh-reshade-stable.mjs [--check | --write] [--version=X.Y.Z] [--dry-run]
//
// Exit codes:
//   0  — check completed (up_to_date / pending / unavailable / write no-op / write ok)
//   1  — unexpected hard error (broken SSoT, generate failure, bad --version probe)
//   2  — usage error
//
// For GitHub Actions prints `status=<kind>` and appends status/version/url/current
// to $GITHUB_OUTPUT when that env var is set.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { UsageError, generatedAtFromEnv } from "./lib/common.mjs";
import { parseCliArgs, wantsHelp } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { appendGithubOutput } from "./lib/github-actions.mjs";
import { DEFAULT_TIMEOUT_MS } from "./lib/http.mjs";
import { runInherit } from "./lib/process.mjs";
import {
  RESHADE_NIGHTLY,
  RESHADE_STABLE,
  buildStableAddonUrl,
  currentStableVersion,
  replaceStableUrlInSources,
} from "./lib/reshade-sources.mjs";
import { assertSemver } from "./lib/validators.mjs";
import { isNewerSemver } from "./lib/upstream/semver-triple.mjs";
import {
  DETECT_KIND,
  detectReshadeStableUpdate,
  probeAddon,
} from "./lib/upstream/reshade.mjs";

const SOURCES_REL = path.join("scripts", "lib", "reshade-sources.mjs");
const SOURCES_ABS = path.join(repoRoot, SOURCES_REL);

const MODE = Object.freeze({
  check: "check",
  write: "write",
});

function usage() {
  console.error(
    "Usage: node scripts/refresh-reshade-stable.mjs [--check | --write] [--version=X.Y.Z] [--dry-run]",
  );
  console.error("");
  console.error("Detect (default --check) or apply (--write) a stable ReShade pin bump.");
  console.error("--version with --write applies a known version after a safety Addon HEAD");
  console.error("(skips re-scraping tags/homepage). --dry-run plans without writing.");
}

function parseArgs(argv) {
  if (wantsHelp(argv)) {
    return { mode: MODE.check, dryRun: false, help: true, version: null };
  }

  const { values } = parseCliArgs(argv, {
    check: { type: "boolean" },
    write: { type: "boolean" },
    "dry-run": { type: "boolean" },
    version: { type: "string" },
    help: { type: "boolean", short: "h" },
  });

  if (values.check && values.write) {
    throw new UsageError("--check and --write are mutually exclusive");
  }
  if (values.check && values["dry-run"]) {
    throw new UsageError("--check and --dry-run are mutually exclusive");
  }

  const options = {
    mode: MODE.check,
    dryRun: Boolean(values["dry-run"]),
    help: false,
    version: null,
  };

  // --write or --dry-run plans/applies a pin bump (dry-run skips mutation).
  if (values.write || options.dryRun) {
    options.mode = MODE.write;
  }

  if (values.version !== undefined) {
    options.version = assertSemver(values.version, "--version");
  }

  if (options.version && options.mode !== MODE.write) {
    throw new UsageError("--version requires --write (or --dry-run)");
  }

  return options;
}

/**
 * Emit status for humans, Actions notice annotations, and optional GITHUB_OUTPUT.
 */
async function reportStatus({
  kind,
  version = "",
  url = "",
  current,
  sources = null,
  detail = null,
}) {
  console.log(`status=${kind}`);
  console.log(`::notice::status=${kind}`);

  if (detail) {
    console.log(`Detect: ${detail}`);
  }

  if (sources) {
    if (sources.tagVersion) {
      console.log(`  GitHub tags latest: ${sources.tagVersion}`);
    }
    if (sources.homeVersion) {
      console.log(`  reshade.me latest:  ${sources.homeVersion}`);
    }
    if (sources.tagError) {
      console.warn(`  tags error: ${sources.tagError}`);
    }
    if (sources.homeError) {
      console.warn(`  homepage error: ${sources.homeError}`);
    }
  }

  await appendGithubOutput({
    status: kind,
    version,
    url,
    current,
  });
}

async function applyUpdate(version, { dryRun }) {
  const nextUrl = buildStableAddonUrl(version);
  const previous = currentStableVersion();

  console.log(`Plan: bump ReShade stable ${previous} → ${version}`);
  console.log(`  ${RESHADE_STABLE.url}`);
  console.log(`  → ${nextUrl}`);
  console.log(`  nightly unchanged: ${RESHADE_NIGHTLY.url64}`);

  if (dryRun) {
    console.log("Dry run: no files written.");
    return { wrote: false, version, url: nextUrl };
  }

  const original = await readFile(SOURCES_ABS, "utf8");
  const { text, changed, previousUrl } = replaceStableUrlInSources(original, nextUrl);

  if (!changed) {
    console.log("SSoT already points at the target URL; regenerating manifests only.");
  } else {
    await writeFile(SOURCES_ABS, text, "utf8");
    console.log(`Updated ${SOURCES_REL} (${previousUrl} → ${nextUrl})`);
  }

  // Same UTC-midnight contract as every manifest generator.
  const epoch = String(Math.floor(Date.parse(generatedAtFromEnv()) / 1000));
  const env = { SOURCE_DATE_EPOCH: epoch };
  console.log(`Regenerating manifests with SOURCE_DATE_EPOCH=${epoch}...`);

  await runInherit("pnpm", ["run", "generate:reshade"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  await runInherit("pnpm", ["run", "check:reshade-generated"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });

  console.log(`OK ReShade stable is now ${version}`);
  return { wrote: true, version, url: nextUrl };
}

/**
 * Apply a known version from detect outputs without re-scraping upstream.
 * Still HEAD-probes the Addon installer before rewriting.
 */
async function applyExplicitVersion(version, { dryRun, currentVersion }) {
  if (!isNewerSemver(version, currentVersion)) {
    console.log(
      `No write: --version=${version} is not newer than current pin ${currentVersion}`,
    );
    await reportStatus({
      kind: DETECT_KIND.upToDate,
      version: "",
      url: buildStableAddonUrl(currentVersion),
      current: currentVersion,
    });
    return;
  }

  const probe = await probeAddon(version, {
    fetchFn: globalThis.fetch,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (!probe.ok) {
    const reason = probe.networkError ? probe.networkError : `HTTP ${probe.status}`;
    throw new Error(
      `refusing to write --version=${version}: Addon probe failed (${reason}) for ${probe.url}`,
    );
  }

  await reportStatus({
    kind: DETECT_KIND.updateAvailable,
    version,
    url: probe.url,
    current: currentVersion,
  });

  console.log(`Safety probe OK for ${version} (HTTP ${probe.status})`);
  await applyUpdate(version, { dryRun });
}

async function main(args) {
  const pinned = currentStableVersion();
  console.log(`Current stable pin: ${pinned} (${RESHADE_STABLE.url})`);

  // Explicit --version write path (used by CI after detect).
  if (args.mode === MODE.write && args.version) {
    await applyExplicitVersion(args.version, {
      dryRun: args.dryRun,
      currentVersion: pinned,
    });
    return;
  }

  const detection = await detectReshadeStableUpdate({ currentVersion: pinned });
  await reportStatus({
    kind: detection.kind,
    version: detection.preferredVersion ?? "",
    url: detection.url ?? "",
    current: detection.currentVersion,
    sources: detection.sources,
    detail: detection.detail,
  });

  if (args.mode !== MODE.write) {
    return;
  }

  if (detection.kind !== DETECT_KIND.updateAvailable) {
    console.log(`No write: detect kind is ${detection.kind}`);
    return;
  }

  await applyUpdate(detection.preferredVersion, { dryRun: args.dryRun });
}

runCliMain({
  parse: parseArgs,
  help: usage,
  main,
});
