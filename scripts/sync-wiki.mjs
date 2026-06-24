#!/usr/bin/env node
// Pull the RenoDX wiki Mods table into `wiki_games.json` and reconcile per-game
// availability markers in `match_overlay.json`. Run before `generate:renodx`:
//
//   npm run sync:wiki   # this script, then regenerate the served manifest
//
// What it does, per wiki row:
//   - extracts name / add-on slug / arch / test-map status;
//   - preserves the existing stable `id` (by exact name, then stripped-name);
//   - decides whether the add-on is in the official clshortfuse snapshot:
//       • by host of the wiki add-on link, or
//       • by matching the snapshot release asset list (fetched once), or
//       • by a stripped-name fuzzy rescue against the asset list;
//   - updates the overlay accordingly:
//       • official now  -> clear stale `external` / `blacklist` / `download_url`;
//       • off-snapshot, has a direct add-on URL -> set `download_url`;
//       • off-snapshot, Nexus/Discord only      -> set `external`.
// Other overlay fields (risk, conflicts, notes_keys, appid, …) are preserved.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const WIKI_URL = 'https://raw.githubusercontent.com/wiki/clshortfuse/renodx/Mods.md';
const SNAPSHOT_API =
  'https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot';

function githubHeaders() {
  const headers = { 'User-Agent': 'renderpilot-libraries' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

// Strip to lowercase alphanumerics — used both for stable id fallback lookups and
// for the snapshot asset fuzzy rescue.
const stripName = (s) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '') // drop trademark glyphs
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric -> hyphen
    .replace(/^-|-$/g, ''); // trim leading/trailing hyphens
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchSnapshotAssets() {
  try {
    const res = await fetch(SNAPSHOT_API, { headers: githubHeaders() });
    if (!res.ok) return new Set();
    const release = await res.json();
    return new Set((release.assets ?? []).map((a) => a.name));
  } catch {
    return new Set();
  }
}

// Resolve the stable id for a wiki row, preserving the previously assigned one.
function resolveId(name, nameToId, strippedToId) {
  return nameToId.get(name) || strippedToId.get(stripName(name)) || slugify(name);
}

// Is the add-on hosted on the official clshortfuse snapshot? Checks the wiki link
// host, then the live asset list (exact, then stripped/hyphenated fuzzy rescue).
// Mutates `slug`/`arch` when rescued. Returns { isOfficial, slug, arch }.
function resolveOfficial(snapshotUrl, slug, arch, name, officialAssets) {
  let isOfficial = !!snapshotUrl && (
    snapshotUrl.includes('clshortfuse.github.io') ||
    snapshotUrl.includes('github.com/clshortfuse') ||
    snapshotUrl.includes('clshortfuse')
  );

  if (officialAssets.size > 0 && slug) {
    const expected = `renodx-${slug}.${arch === 'X86' ? 'addon32' : 'addon64'}`;
    if (officialAssets.has(expected)) isOfficial = true;
  }

  // Fuzzy rescue: the wiki author may have omitted the badge; probe name-derived
  // slug forms against the asset list (both stripped and hyphenated).
  if (officialAssets.size > 0 && !isOfficial) {
    const stripped = stripName(name);
    const hyphenated = slugify(name);
    for (const candidate of [stripped, hyphenated]) {
      for (const bits of ['32', '64']) {
        if (officialAssets.has(`renodx-${candidate}.addon${bits}`)) {
          return { isOfficial: true, slug: candidate, arch: bits === '32' ? 'X86' : 'X64' };
        }
      }
    }
  }

  return { isOfficial, slug, arch };
}

function parseRow(line) {
  const cols = line.split('|').map((c) => c.trim()).slice(1, -1);
  if (cols.length < 4) return null;

  const rawName = cols[0];
  const name = (rawName.match(/\[(.*?)\]\(/) ?? [, rawName])[1].trim();
  const linksCol = cols[2];
  const statusCol = cols[3];

  const status = statusCol.includes(':white_check_mark:')
    ? 'working'
    : statusCol.includes(':construction:')
      ? 'construction'
      : 'unknown';

  const addonMatch = linksCol.match(/(https?:\/\/[^\s")\]]+\.addon(32|64))/i);
  const snapshotUrl = addonMatch ? addonMatch[1] : null;
  const arch = addonMatch ? (addonMatch[2] === '32' ? 'X86' : 'X64') : 'X64';
  const slugMatch = snapshotUrl
    ? snapshotUrl.match(/renodx-([a-zA-Z0-9_-]+)\.addon(?:32|64)/i)
    : null;
  const snapshotSlug = slugMatch ? slugMatch[1] : null;

  const nexusUrl = (linksCol.match(/(https:\/\/(?:www\.)?nexusmods\.com\/[^\s")\]]+)/i) || [])[1] ?? null;
  const discordUrl = (linksCol.match(/(https:\/\/discord\.com\/invite\/[^\s")\]]+)/i) || [])[1] ?? null;

  return { name, status, snapshotUrl, arch, snapshotSlug, nexusUrl, discordUrl };
}

// Apply the wiki availability verdict to the overlay entry (created if needed).
function applyOverlay(overlay, id, isOfficial, snapshotUrl, nexusUrl, discordUrl) {
  if (isOfficial) {
    if (overlay[id]) {
      delete overlay[id].external;
      delete overlay[id].blacklist;
      delete overlay[id].download_url;
    }
    return;
  }

  if (!overlay[id]) overlay[id] = {};

  if (snapshotUrl) {
    // Off-snapshot but directly downloadable -> a third-party download_url.
    overlay[id].download_url = snapshotUrl;
    delete overlay[id].external;
    delete overlay[id].blacklist;
    return;
  }

  // No direct add-on link -> point at the off-platform distribution page.
  const url = nexusUrl || discordUrl;
  if (url) {
    overlay[id].external = {
      url,
      label_key: nexusUrl ? 'renodx.external.nexus' : 'renodx.external.discord',
    };
    delete overlay[id].blacklist;
    delete overlay[id].download_url;
  }
}

async function main() {
  const wikiPath = path.join(repoRoot, 'renodx_library_manifest', 'wiki_games.json');
  const overlayPath = path.join(repoRoot, 'renodx_library_manifest', 'match_overlay.json');

  const existingWiki = readJsonIfExists(wikiPath) ?? [];
  const overlay = readJsonIfExists(overlayPath) ?? {};

  const nameToId = new Map(existingWiki.map((g) => [g.name, g.id]));
  const strippedToId = new Map(existingWiki.map((g) => [stripName(g.name), g.id]));
  const oldGameById = new Map(existingWiki.map((g) => [g.id, g]));

  console.log('Fetching wiki...');
  const res = await fetch(WIKI_URL);
  if (!res.ok) throw new Error(`Failed to fetch wiki: ${res.status} ${res.statusText}`);
  const text = await res.text();

  console.log('Fetching official snapshot assets...');
  const officialAssets = await fetchSnapshotAssets();
  if (officialAssets.size === 0) console.log('No snapshot assets available — relying on wiki links.');

  const newWiki = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    if (!inTable) {
      if (line.startsWith('| Name') && line.includes('Maintainer')) inTable = true;
      continue;
    }
    if (line.startsWith('| :---')) continue;
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }

    const row = parseRow(line);
    if (!row) continue;

    const id = resolveId(row.name, nameToId, strippedToId);
    const overlaySlug = overlay[id] && overlay[id].slug;
    const oldSlug = oldGameById.get(id)?.slug;
    const slug = overlaySlug || row.snapshotSlug || oldSlug || id;

    const { isOfficial, slug: finalSlug, arch: finalArch } = resolveOfficial(
      row.snapshotUrl,
      slug,
      row.arch,
      row.name,
      officialAssets,
    );

    newWiki.push({ name: row.name, slug: finalSlug, arch: finalArch, status: row.status, id });
    applyOverlay(overlay, id, isOfficial, row.snapshotUrl, row.nexusUrl, row.discordUrl);
  }

  writeFileSync(wikiPath, JSON.stringify(newWiki, null, 2) + '\n');
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + '\n');
  console.log(`Synced! Found ${newWiki.length} games.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
