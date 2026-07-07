import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

function steamAppids(title) {
  return (title.match ?? [])
    .filter((rule) => rule.kind === "steam_appid")
    .map((rule) => rule.value);
}

function appidIndex(manifest) {
  const index = new Map();
  for (const title of manifest.titles) {
    for (const appid of steamAppids(title)) {
      if (!index.has(appid)) {
        index.set(appid, []);
      }
      index.get(appid).push(title);
    }
  }
  return index;
}

async function loadManifests() {
  const [renodx, luma] = await Promise.all(
    ["renodx_manifest.json", "luma_manifest.json"].map(async (file) =>
      JSON.parse(await fs.readFile(path.join(REPO_ROOT, file), "utf-8")),
    ),
  );
  return { renodx, luma };
}

function sharedTitlePairs(renodx, luma) {
  const renodxByAppid = appidIndex(renodx);
  const lumaByAppid = appidIndex(luma);
  // keyed by id-pair so multiple shared appids between the same two titles count once
  const pairs = new Map();

  for (const [appid, lumaTitles] of lumaByAppid) {
    const renodxTitles = renodxByAppid.get(appid);
    if (!renodxTitles) {
      continue;
    }
    for (const renodxTitle of renodxTitles) {
      for (const lumaTitle of lumaTitles) {
        const key = `${renodxTitle.id}|${lumaTitle.id}`;
        pairs.set(key, { renodxTitle, lumaTitle });
      }
    }
  }

  return [...pairs.values()];
}

test("sanity - shared Steam-AppID overlap between renodx and luma manifests", async () => {
  const { renodx, luma } = await loadManifests();

  assert.ok(renodx.titles.length > 0, "renodx_manifest.json has no titles");
  assert.ok(luma.titles.length > 0, "luma_manifest.json has no titles");

  const pairs = sharedTitlePairs(renodx, luma);
  assert.ok(
    pairs.length >= 50,
    `expected at least 50 shared-appid title pairs, found ${pairs.length} — the overlap-detection logic may be broken`,
  );
});
