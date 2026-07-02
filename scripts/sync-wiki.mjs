#!/usr/bin/env node

// Pull the RenoDX wiki Mods table into `wiki_games.json` and reconcile per-game
// availability markers in `match_overlay.json`. Run before `generate:renodx`:
//
//   npm run sync:wiki
//
// Per wiki row:
//   - extract name / add-on slug / arch / test-map status;
//   - preserve the existing stable `id` by exact name, then stripped-name;
//   - decide whether the add-on is in the official clshortfuse snapshot:
//       • by host of the wiki add-on link;
//       • by exact snapshot release asset match;
//       • by stripped/hyphenated fuzzy rescue against snapshot assets;
//   - update the overlay accordingly:
//       • official now  -> clear stale `external` / `blacklist` / `download_url`;
//       • off-snapshot direct add-on URL -> set `download_url`;
//       • off-snapshot Nexus/Discord only -> set `external`.
// Other overlay fields are preserved.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject, assertPlainObject } from "./lib/common.mjs";
import {
  extractMarkdownTables,
  getModsTableHeaderColumns,
  parseWikiRow,
} from "./lib/sync-wiki-parsing.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const WIKI_URL = "https://raw.githubusercontent.com/wiki/clshortfuse/renodx/Mods.md";
const SNAPSHOT_API =
  "https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot";

const HTTP_TIMEOUT_MS = 30_000;
const USER_AGENT = "renderpilot-libraries";

const ADDON_URL_RE = /\b(https?:\/\/[^\s<>"')\]]+?\.addon(32|64))\b/i;
const NEXUS_URL_RE = /\b(https:\/\/(?:www\.)?nexusmods\.com\/[^\s<>"')\]]+)/i;
const DISCORD_URL_RE = /\b(https:\/\/(?:discord\.com\/invite|discord\.gg)\/[^\s<>"')\]]+)/i;

const EXTERNAL_LABELS = Object.freeze({
  nexus: "renodx.external.nexus",
  discord: "renodx.external.discord",
});

function baseHeaders() {
  return {
    "User-Agent": USER_AGENT,
  };
}

function githubApiHeaders() {
  const headers = {
    ...baseHeaders(),
    Accept: "application/vnd.github+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

function stripName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array.`);
  }

  return value;
}

async function readJsonOrDefault(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return fallback;
    }

    throw new Error(`Failed to read valid JSON from ${file}: ${err.message}`);
  }
}

async function writeJsonAtomic(file, value) {
  const tmpFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmpFile, file);
  } catch (err) {
    await rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms: ${url}`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const res = await fetchWithTimeout(url, options);

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  return res.text();
}

async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, options);

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchSnapshotAssets() {
  try {
    const release = await fetchJson(SNAPSHOT_API, {
      headers: githubApiHeaders(),
    });

    if (!Array.isArray(release?.assets)) {
      throw new Error("snapshot release response does not contain an assets array");
    }

    return new Set(
      release.assets
        .map((asset) => asset?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  } catch (err) {
    console.warn(`Warning: could not fetch snapshot assets: ${err.message}`);
    console.warn("Continuing with wiki-link based official detection only.");
    return new Set();
  }
}

function parseWikiRows(markdown) {
  const tables = extractMarkdownTables(markdown);
  const rows = [];
  let sawModsTable = false;

  for (const table of tables) {
    const columnsMapping = getModsTableHeaderColumns(table.headers);
    if (!columnsMapping) {
      continue;
    }

    sawModsTable = true;
    for (const cells of table.rows) {
      const row = parseWikiRow(cells, columnsMapping, table.engineContext);
      if (row) {
        rows.push(row);
      }
    }
  }

  if (!sawModsTable) {
    throw new Error("Could not find the Mods table in the RenoDX wiki.");
  }

  if (rows.length === 0) {
    throw new Error("Found the Mods table, but parsed zero game rows.");
  }

  return rows;
}

function buildIdLookups(existingWiki) {
  const nameToId = new Map();
  const strippedNameToId = new Map();
  const gameById = new Map();

  for (const game of existingWiki) {
    if (
      !isPlainObject(game) ||
      typeof game.name !== "string" ||
      typeof game.id !== "string"
    ) {
      continue;
    }

    nameToId.set(game.name, game.id);

    const stripped = stripName(game.name);
    if (stripped && !strippedNameToId.has(stripped)) {
      strippedNameToId.set(stripped, game.id);
    }

    gameById.set(game.id, game);
  }

  return {
    nameToId,
    strippedNameToId,
    gameById,
  };
}

function resolveId(name, lookups) {
  const id =
    lookups.nameToId.get(name) ??
    lookups.strippedNameToId.get(stripName(name)) ??
    slugify(name);

  if (!id) {
    throw new Error(`Could not resolve a non-empty id for game name: ${name}`);
  }

  return id;
}

function getOverlayEntry(overlay, id) {
  const entry = overlay[id];

  if (entry === undefined) {
    return undefined;
  }

  if (!isPlainObject(entry)) {
    throw new Error(`Overlay entry "${id}" must be a JSON object.`);
  }

  return entry;
}

function preferredSlugForGame({ id, row, overlayEntry, oldGame }) {
  const slug = overlayEntry?.slug ?? row.addonSlug ?? oldGame?.slug ?? id;

  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Could not resolve a non-empty slug for "${row.name}" (${id}).`);
  }

  return slug;
}

function addonAssetName(slug, arch) {
  return `renodx-${slug}.${arch === "X86" ? "addon32" : "addon64"}`;
}

function isOfficialAddonUrl(addonUrl) {
  if (!addonUrl) {
    return false;
  }

  try {
    const url = new URL(addonUrl);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    return (
      host === "clshortfuse.github.io" ||
      (host === "github.com" && pathname.startsWith("/clshortfuse/renodx/"))
    );
  } catch {
    return false;
  }
}

function uniqueNonEmpty(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value.length > 0)),
  ];
}

function resolveOfficialAddon({ addonUrl, slug, arch, name, officialAssets }) {
  let isOfficial = isOfficialAddonUrl(addonUrl);

  if (officialAssets.size > 0 && officialAssets.has(addonAssetName(slug, arch))) {
    isOfficial = true;
  }

  if (officialAssets.size === 0 || isOfficial) {
    return {
      isOfficial,
      slug,
      arch,
    };
  }

  const candidates = uniqueNonEmpty([stripName(name), slugify(name)]);

  for (const candidateSlug of candidates) {
    for (const bits of ["32", "64"]) {
      const candidateAsset = `renodx-${candidateSlug}.addon${bits}`;

      if (officialAssets.has(candidateAsset)) {
        return {
          isOfficial: true,
          slug: candidateSlug,
          arch: bits === "32" ? "X86" : "X64",
        };
      }
    }
  }

  return {
    isOfficial: false,
    slug,
    arch,
  };
}

function deleteIfEmpty(overlay, id) {
  if (overlay[id] && Object.keys(overlay[id]).length === 0) {
    delete overlay[id];
  }
}

function clearAvailabilityMarkers(overlay, id) {
  const entry = getOverlayEntry(overlay, id);

  if (!entry) {
    return "official";
  }

  delete entry.external;
  delete entry.blacklist;
  delete entry.download_url;
  deleteIfEmpty(overlay, id);

  return "official";
}

function ensureOverlayEntry(overlay, id) {
  const existing = getOverlayEntry(overlay, id);

  if (existing) {
    return existing;
  }

  overlay[id] = {};
  return overlay[id];
}

function applyOverlayAvailability({
  overlay,
  id,
  isOfficial,
  addonUrl,
  nexusUrl,
  discordUrl,
}) {
  if (isOfficial) {
    return clearAvailabilityMarkers(overlay, id);
  }

  if (addonUrl) {
    const entry = ensureOverlayEntry(overlay, id);

    entry.download_url = addonUrl;
    delete entry.external;
    delete entry.blacklist;

    return "download_url";
  }

  const externalUrl = nexusUrl ?? discordUrl;

  if (externalUrl) {
    const entry = ensureOverlayEntry(overlay, id);
    const isNexus = externalUrl === nexusUrl;

    entry.external = {
      url: externalUrl,
      label_key: isNexus ? EXTERNAL_LABELS.nexus : EXTERNAL_LABELS.discord,
    };

    delete entry.blacklist;
    delete entry.download_url;

    return "external";
  }

  return "unchanged";
}

function reconcileWikiRows({ rows, existingWiki, overlay, officialAssets }) {
  const lookups = buildIdLookups(existingWiki);
  const newWiki = [];
  const seenIds = new Set();

  const stats = {
    official: 0,
    download_url: 0,
    external: 0,
    unchanged: 0,
  };

  for (const row of rows) {
    const id = resolveId(row.name, lookups);

    if (seenIds.has(id)) {
      console.warn(
        `Wiki produced duplicate id "${id}" while processing "${row.name}", skipping duplicate row.`,
      );
      continue;
    }

    seenIds.add(id);

    const overlayEntry = getOverlayEntry(overlay, id);
    const oldGame = lookups.gameById.get(id);
    const preferredSlug = preferredSlugForGame({
      id,
      row,
      overlayEntry,
      oldGame,
    });

    const resolved = resolveOfficialAddon({
      addonUrl: row.addonUrl,
      slug: preferredSlug,
      arch: row.arch,
      name: row.name,
      officialAssets,
    });

    newWiki.push({
      name: row.name,
      slug: resolved.slug,
      arch: resolved.arch,
      status: row.status,
      id,
    });

    const availability = applyOverlayAvailability({
      overlay,
      id,
      isOfficial: resolved.isOfficial,
      addonUrl: row.addonUrl,
      nexusUrl: row.nexusUrl,
      discordUrl: row.discordUrl,
    });

    stats[availability] += 1;
  }

  return {
    newWiki,
    stats,
  };
}

async function main() {
  const wikiPath = path.join(REPO_ROOT, "renodx_library_manifest", "wiki_games.json");
  const overlayPath = path.join(REPO_ROOT, "renodx_library_manifest", "match_overlay.json");

  const existingWiki = assertArray(await readJsonOrDefault(wikiPath, []), wikiPath);

  const overlay = assertPlainObject(await readJsonOrDefault(overlayPath, {}), overlayPath);

  console.log("Fetching wiki...");
  const wikiMarkdown = await fetchText(WIKI_URL, {
    headers: baseHeaders(),
  });

  console.log("Fetching official snapshot assets...");
  const officialAssets = await fetchSnapshotAssets();

  if (officialAssets.size === 0) {
    console.warn("Warning: no snapshot assets available.");
  }

  const rows = parseWikiRows(wikiMarkdown);
  const { newWiki, stats } = reconcileWikiRows({
    rows,
    existingWiki,
    overlay,
    officialAssets,
  });

  await writeJsonAtomic(wikiPath, newWiki);
  await writeJsonAtomic(overlayPath, overlay);

  console.log(
    [
      `Synced ${newWiki.length} games.`,
      `official=${stats.official}`,
      `download_url=${stats.download_url}`,
      `external=${stats.external}`,
      `unchanged=${stats.unchanged}`,
    ].join(" "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
