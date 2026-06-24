#!/usr/bin/env node
// Build-time guard: assert every installable RenoDX title's add-on actually exists
// upstream. The app derives `renodx-<slug>.addon64|32` and fetches it live from the
// clshortfuse snapshot release, so a slug that isn't published there would be a dead
// Install button. This fetches the snapshot asset list once and flags any title whose
// add-on is missing (those should be marked `external` in the overlay, or dropped).
//
// Titles that carry a `download_url` are hosted off the clshortfuse snapshot
// (third-party github.io / GitHub releases) and are therefore skipped here — the
// snapshot gate does not apply to them. `external` and `blacklist` titles are skipped
// too (no direct install). Network-dependent: a missing add-on is a hard failure
// (exit 1); an unreachable GitHub is a soft warning (exit 0) so offline/rate-limited
// runs don't block CI.
//
//   node scripts/check-renodx-slugs.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './catalog.mjs';

const SNAPSHOT_API =
  'https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot';

function githubHeaders() {
  const headers = { 'User-Agent': 'renderpilot-libraries', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function snapshotAssetNames() {
  const res = await fetch(SNAPSHOT_API, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const release = await res.json();
  return new Set((release.assets ?? []).map((a) => a.name));
}

function addonFile(slug, arch) {
  return `renodx-${slug}.${arch === 'X86' ? 'addon32' : 'addon64'}`;
}

// A title is "hosted off-snapshot" when it carries a direct download_url, or when it
// is in a non-installable category. Such titles are not expected in the snapshot.
function isOffSnapshot(title, manifest) {
  if (title.download_url) return true;
  if (manifest.external && manifest.external[title.id]) return true;
  if (manifest.blacklist && manifest.blacklist[title.id]) return true;
  return false;
}

async function main() {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, 'renodx_manifest.json'), 'utf8'),
  );

  let assets;
  try {
    assets = await snapshotAssetNames();
  } catch (err) {
    console.warn(`⚠ skipping slug-availability check — could not reach GitHub: ${err.message}`);
    return; // soft pass: don't block offline/rate-limited runs
  }
  console.log(`Snapshot release: ${assets.size} assets.`);

  const missing = [];
  let checked = 0;
  let skipped = 0;
  for (const t of manifest.titles) {
    if (isOffSnapshot(t, manifest)) {
      skipped++;
      continue;
    }
    checked++;
    if (!assets.has(addonFile(t.slug, t.arch))) {
      missing.push(`${t.id} (${addonFile(t.slug, t.arch)})`);
    }
  }
  // The universal generic must exist too. (Generics with url64/url32 are hosted
  // elsewhere and are not checked against the clshortfuse snapshot.)
  for (const g of manifest.generics) {
    if (g.slug && !assets.has(addonFile(g.slug, 'X64'))) {
      missing.push(`generic:${g.engine} (${addonFile(g.slug, 'X64')})`);
    }
  }

  if (missing.length) {
    console.error(
      `\n✗ ${missing.length} title(s) have no upstream add-on — mark them \`external\` or drop:`,
    );
    for (const m of missing.slice(0, 40)) console.error(`  - ${m}`);
    if (missing.length > 40) console.error(`  …and ${missing.length - 40} more`);
    process.exit(1);
  }
  console.log(
    `✓ all ${checked} snapshot-hosted titles resolve to a published add-on ` +
      `(${skipped} off-snapshot/external skipped; ${manifest.titles.length} total).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
