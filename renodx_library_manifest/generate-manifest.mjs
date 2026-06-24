#!/usr/bin/env node
// Generate the RenoDX overrides manifest (schema v3) from authoritative inputs.
//
// The app fetches RenoDX add-ons LIVE from upstream (clshortfuse.github.io and the
// engine-generic repos), so this manifest carries NO artifacts/hashes — only the
// game→slug catalogue, match rules, per-game overrides, the global ReShade sources,
// the engine-generic fallbacks, and shared defaults. Reproducible offline (no network).
//
//   wiki_games.json    one row per RenoDX game: name, add-on `slug` (= upstream
//                      src/games folder = add-on file name), `arch`, and wiki
//                      test-map `status` (working / construction / unknown).
//   match_overlay.json per-game metadata the wiki lacks: Steam AppID(s) / exe,
//                      risk overrides, conflicts, note keys, `split`, and category
//                      markers (`external`, `native_hdr`, `blacklist`).
//
// A title is emitted only when it has a usable match identifier (an AppID or exe);
// games still lacking one — and games in a non-installable category — go to
// pending_match.json (categories are excluded: they are intentional, not pending).
//
// Schema v3 hoists the identical per-title boilerplate into a top-level `defaults`
// block; a title only carries `risk` / `min_app_version` / `channel` / `compatibility`
// when it deviates from those defaults. The app merges `defaults` with each title.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const read = (name) => JSON.parse(readFileSync(path.join(here, name), 'utf8'));
// Authoring inputs (pending list) stay beside the generator; the served manifest
// is written to the repo root next to the other served documents.
const write = (name, data) =>
  writeFileSync(path.join(here, name), `${JSON.stringify(data, null, 2)}\n`);
const writeServed = (name, data) =>
  writeFileSync(path.join(repoRoot, name), `${JSON.stringify(data, null, 2)}\n`);

const SCHEMA_VERSION = 3;
const RENODX_SOURCE = 'https://github.com/clshortfuse/renodx/wiki/Mods';

// Shared title defaults — emitted once at the top level; the app merges these onto
// every title that omits the corresponding field. Keeps the titles array compact.
const DEFAULT_RISK = {
  anticheat_engine: 'none',
  online: 'singleplayer',
  severity: 'info',
  message_key: 'renodx.risk.sp_safe',
  confidence: 'medium',
  source: RENODX_SOURCE,
};
const DEFAULTS = {
  risk: DEFAULT_RISK,
  min_app_version: '1.0.0',
  channel: 'stable',
};
const DEFAULT_RISK_JSON = JSON.stringify(DEFAULT_RISK);

// Global add-on-enabled ReShade host sources (confirmed from RHI / upstream):
//   stable  — scraped from reshade.me for ReShade_Setup_<ver>_Addon.exe
//   nightly — crosire CI build proxied by nightly.link (a plain .zip)
const RESHADE = {
  reshade_me_base: 'https://reshade.me',
  nightly: {
    url64: 'https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(64-bit).zip',
    url32: 'https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(32-bit).zip',
  },
};

// Engine-detected fallbacks, tried when no per-game title matches (lowest tiers).
// The Unity generic is hosted in a separate repo; the universal add-on covers the
// Unreal / last-resort case from clshortfuse's host.
const GENERICS = [
  {
    engine: 'unity',
    url64:
      'https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon64',
    url32:
      'https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon32',
    label_key: 'renodx.generic.unity',
  },
  { engine: 'unreal', slug: 'unrealengine', label_key: 'renodx.generic.universal' },
];

const VALID_STATUS = new Set(['working', 'construction', 'unknown']);

// Overlay field names the generator understands. Anything else is likely a typo —
// warn so a silent unknown key can't drop a title's risk/conflicts/etc.
const KNOWN_OVERLAY_FIELDS = new Set([
  'appid',
  'appids',
  'exe',
  'slug',
  'risk',
  'conflicts',
  'required_api',
  'notes_keys',
  'proxy_dll_override',
  'download_url',
  'min_app_version',
  'external',
  'native_hdr',
  'blacklist',
  'split',
]);

function normalizedStatus(status) {
  return VALID_STATUS.has(status) ? status : 'unknown';
}

// One title. Only emits fields that deviate from the top-level defaults, so the
// common case (a verified singleplayer game with no overrides) is six keys.
function makeTitle(id, name, slug, arch, status, { appids = [], exe = null, ov = {} } = {}) {
  const match = appids.map((a) => ({ kind: 'steam_appid', value: String(a), tier: 100 }));
  if (exe) match.push({ kind: 'exe_name', value: exe, tier: 70 });

  const title = {
    id,
    name,
    slug,
    arch,
    status: normalizedStatus(status),
    match,
  };

  // Channel: stable for verified titles, beta otherwise; emit only if non-default.
  const channel = status === 'working' ? 'stable' : 'beta';
  if (channel !== DEFAULTS.channel) title.channel = channel;

  const minAppVersion = ov.min_app_version ?? DEFAULTS.min_app_version;
  if (minAppVersion !== DEFAULTS.min_app_version) title.min_app_version = minAppVersion;

  // Compatibility: required_arch always equals `arch` (never emitted — the app
  // derives it). Only emit when required_api or conflicts are present.
  if (ov.required_api || ov.conflicts) {
    const compatibility = {};
    if (ov.required_api) compatibility.required_api = ov.required_api;
    if (ov.conflicts) compatibility.conflicts = ov.conflicts;
    title.compatibility = compatibility;
  }

  // Risk: defaults merged with overrides; emit only when it differs from default.
  const risk = { ...DEFAULT_RISK, ...(ov.risk ?? {}) };
  if (JSON.stringify(risk) !== DEFAULT_RISK_JSON) title.risk = risk;

  if (ov.proxy_dll_override) title.proxy_dll_override = ov.proxy_dll_override;
  if (ov.notes_keys) title.notes_keys = ov.notes_keys;
  if (ov.download_url) title.download_url = ov.download_url;
  return title;
}

// Reproducible timestamp: honor SOURCE_DATE_EPOCH (UTC midnight) when set, else
// today's date at UTC midnight. Date-only granularity keeps rebuilds stable.
function generatedAt() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const date = epoch ? new Date(Number(epoch) * 1000) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`SOURCE_DATE_EPOCH is not a valid number`);
  return date.toISOString().replace(/T.*$/, 'T00:00:00Z');
}

function main() {
  const wiki = read('wiki_games.json');
  const overlay = read('match_overlay.json');

  const wikiIds = new Set(wiki.map((g) => g.id));
  for (const id of Object.keys(overlay)) {
    if (!wikiIds.has(id)) console.warn(`⚠ overlay: "${id}" has no matching wiki entry (orphan)`);
    for (const key of Object.keys(overlay[id])) {
      if (!KNOWN_OVERLAY_FIELDS.has(key)) {
        console.warn(`⚠ overlay: "${id}" has unknown field "${key}" (typo? ignored)`);
      }
    }
  }

  const titles = [];
  const pending = [];
  const external = {};
  const nativeHdr = [];
  const blacklist = {};
  const seenIds = new Set();

  // Records a game's non-standard category; returns the category name when the game
  // is NOT a regular installable title (so the caller skips emitting one AND skips
  // pending — categories are intentional, not "awaiting a match identifier").
  const categorize = (id, ov) => {
    if (ov.native_hdr) {
      nativeHdr.push(id);
      return 'native_hdr';
    }
    if (ov.blacklist) {
      blacklist[id] = ov.blacklist;
      return 'blacklist';
    }
    if (ov.external) {
      external[id] = ov.external; // { url, label_key }
      return 'external';
    }
    return null;
  };

  const pushTitle = (id, name, slug, arch, status, opts) => {
    if (seenIds.has(id)) throw new Error(`duplicate title id "${id}"`);
    seenIds.add(id);
    titles.push(makeTitle(id, name, slug, arch, status, opts));
  };

  for (const g of wiki) {
    const { id, slug, arch, status } = g;
    const ov = overlay[id] ?? {};

    if (categorize(id, ov)) continue;

    // A "split" row expands one wiki entry (shared slug) into one title per game.
    if (ov.split) {
      for (const sub of ov.split) {
        const sid = `${id}-${sub.suffix}`;
        const subOv = { ...ov, ...sub }; // inherit parent properties, override with sub
        if (categorize(sid, subOv)) continue;
        pushTitle(sid, sub.name, slug, arch, status, {
          appids: sub.appids ?? (sub.appid ? [sub.appid] : []),
          exe: sub.exe ?? null,
          ov: subOv,
        });
      }
      continue;
    }

    const appids = ov.appids ?? (ov.appid ? [ov.appid] : []);
    const exe = ov.exe ?? null;

    if (appids.length === 0 && !exe) {
      pending.push({ id, name: g.name, slug, arch });
      continue;
    }

    pushTitle(id, g.name, slug, arch, status, { appids, exe, ov });
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt(),
    reshade: RESHADE,
    generics: GENERICS,
    defaults: DEFAULTS,
    titles,
  };
  if (Object.keys(external).length) manifest.external = external;
  if (nativeHdr.length) manifest.native_hdr = [...new Set(nativeHdr)].sort();
  if (Object.keys(blacklist).length) manifest.blacklist = blacklist;

  writeServed('renodx_manifest.json', manifest);
  write('pending_match.json', pending);

  console.log(
    `manifest: ${titles.length} titles, ${GENERICS.length} generics, ` +
      `${Object.keys(external).length} external, ${nativeHdr.length} native-hdr, ` +
      `${Object.keys(blacklist).length} blacklist`,
  );
  console.log(`pending (no AppID/exe yet): ${pending.length} -> pending_match.json`);
}

main();
