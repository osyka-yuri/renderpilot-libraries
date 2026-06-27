#!/usr/bin/env node
// Build-time guard: assert every installable RenoDX title's add-on exists
// in the clshortfuse snapshot release.
//
// The app derives `renodx-<slug>.addon64|32` and fetches it live from the
// snapshot release, so a slug that is not published there would create a dead
// Install button.
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

const SNAPSHOT_API =
  "https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot";

const USER_AGENT = "renderpilot-libraries";
const MAX_MISSING_TO_PRINT = 40;

const OFF_SNAPSHOT_TITLE_KINDS = new Set(["external", "native_hdr", "blacklist"]);

const ADDON_EXTENSION_BY_ARCH = new Map([
  ["X64", "addon64"],
  ["X86", "addon32"],
]);

class SnapshotUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotUnavailableError";
  }
}

function githubHeaders() {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

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

async function fetchSnapshotRelease() {
  let res;

  try {
    res = await fetch(SNAPSHOT_API, { headers: githubHeaders() });
  } catch (err) {
    throw new SnapshotUnavailableError(`request failed: ${err.message}`, {
      cause: err,
    });
  }

  if (!res.ok) {
    throw new SnapshotUnavailableError(
      `GitHub API returned ${res.status} ${res.statusText}`,
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new SnapshotUnavailableError(`GitHub API returned invalid JSON: ${err.message}`, {
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function assertManifestShape(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("renodx_manifest.json must contain a JSON object");
  }

  if (!Array.isArray(manifest.titles)) {
    throw new Error("renodx_manifest.json must contain a `titles` array");
  }

  if (!Array.isArray(manifest.generics)) {
    throw new Error("renodx_manifest.json must contain a `generics` array");
  }
}

function assertTitle(title, index) {
  if (!isRecord(title)) {
    throw new Error(`titles[${index}] must be an object`);
  }
}

function assertGeneric(generic, index) {
  if (!isRecord(generic)) {
    throw new Error(`generics[${index}] must be an object`);
  }
}

function titleLabel(title, index) {
  return typeof title.id === "string" && title.id.trim() !== ""
    ? title.id.trim()
    : `titles[${index}]`;
}

function genericLabel(generic, index) {
  return typeof generic.engine === "string" && generic.engine.trim() !== ""
    ? `generic:${generic.engine.trim()}`
    : `generics[${index}]`;
}

function isOffSnapshotTitle(title) {
  if (title.download_url) {
    return true;
  }

  return OFF_SNAPSHOT_TITLE_KINDS.has(title.category?.kind);
}

function isSnapshotHostedGeneric(generic) {
  return Boolean(generic.slug) && !generic.url64 && !generic.url32 && !generic.download_url;
}

function addonFile(slug, arch) {
  const extension = ADDON_EXTENSION_BY_ARCH.get(arch);

  if (!extension) {
    throw new Error(
      `Unsupported RenoDX architecture "${arch}". Expected one of: ${[
        ...ADDON_EXTENSION_BY_ARCH.keys(),
      ].join(", ")}`,
    );
  }

  return `renodx-${slug}.${extension}`;
}

function expectedTitleAddon(title, index) {
  const label = titleLabel(title, index);
  const slug = requiredString(title.slug, `${label}.slug`);
  const arch = requiredString(title.arch, `${label}.arch`);

  return addonFile(slug, arch);
}

function expectedGenericAddon(generic, index) {
  const label = genericLabel(generic, index);
  const slug = requiredString(generic.slug, `${label}.slug`);

  return addonFile(slug, "X64");
}

function checkTitles(titles, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, title] of titles.entries()) {
    assertTitle(title, index);

    if (isOffSnapshotTitle(title)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedTitleAddon(title, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${titleLabel(title, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

function checkGenerics(generics, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, generic] of generics.entries()) {
    assertGeneric(generic, index);

    if (!isSnapshotHostedGeneric(generic)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedGenericAddon(generic, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${genericLabel(generic, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

function printMissingAndFail(missing) {
  console.error(
    `\n✗ ${missing.length} add-on(s) are missing upstream — mark them ` +
      "`external`, add an explicit download URL, or drop them:",
  );

  for (const item of missing.slice(0, MAX_MISSING_TO_PRINT)) {
    console.error(`  - ${item}`);
  }

  if (missing.length > MAX_MISSING_TO_PRINT) {
    console.error(`  …and ${missing.length - MAX_MISSING_TO_PRINT} more`);
  }

  process.exitCode = 1;
}

async function main() {
  const manifest = await readJson("renodx_manifest.json");
  assertManifestShape(manifest);

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

  const titleResult = checkTitles(manifest.titles, assets);
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
