import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { buildLegacyV3Manifest } from "../lib/legacy-v3.mjs";

const LEGACY_DEFAULTS = { min_app_version: "1.0.0", channel: "stable" };

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

async function readJson(...segments) {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, ...segments), "utf8"));
}

test("legacy RenoDX v3 is a deterministic projection of the v1 catalogue", async () => {
  const [v1, legacy] = await Promise.all([
    readJson("addons", "v1", "renodx.json"),
    readJson("renodx_manifest.json"),
  ]);

  assert.equal(legacy.schema_version, 3);
  assert.deepEqual(buildLegacyV3Manifest(v1), legacy);
  assert.equal(legacy.titles.length, v1.games.length);
  assert.equal(legacy.titles.length, 829);
  assert.equal(legacy.generics.length, v1.engine_profiles.length);
  assert.deepEqual(legacy.defaults, LEGACY_DEFAULTS);

  const legacyById = new Map(legacy.titles.map((title) => [title.id, title]));
  for (const game of v1.games) {
    const title = legacyById.get(game.id);
    assert.ok(title, `v3 projection is missing ${game.id}`);
    assert.equal(title.name, game.name);
    assert.equal(title.slug, game.addon.slug);
    assert.equal(title.arch, game.architecture);
    assert.equal(title.status, game.status);
    assert.deepEqual(title.match, game.match);
  }
});

test("legacy v3 re-derives channel: beta for non-working titles", async () => {
  const v1 = await readJson("addons", "v1", "renodx.json");
  const legacy = buildLegacyV3Manifest(v1);

  assert.equal(legacy.defaults.channel, "stable");

  let betaCount = 0;
  for (const title of legacy.titles) {
    if (title.status === "working") {
      assert.equal(
        title.channel,
        undefined,
        `${title.id}: working titles must omit channel (defaults.channel applies)`,
      );
    } else {
      assert.equal(
        title.channel,
        "beta",
        `${title.id}: non-working titles must emit channel beta`,
      );
      betaCount++;
    }
  }

  assert.ok(betaCount > 0, "expected at least one non-working title with channel beta");
});

test("legacy v3 unit fixture applies channel from status only", () => {
  const v1 = {
    schema_version: 1,
    generated_at: "2026-01-01T00:00:00Z",
    games: [
      {
        id: "working-game",
        name: "Working",
        architecture: "X64",
        status: "working",
        match: [{ kind: "steam_appid", value: "1", tier: 100 }],
        addon: { slug: "working" },
      },
      {
        id: "wip-game",
        name: "WIP",
        architecture: "X64",
        status: "construction",
        match: [{ kind: "steam_appid", value: "2", tier: 100 }],
        addon: { slug: "wip" },
      },
    ],
    engine_profiles: [],
  };

  const legacy = buildLegacyV3Manifest(v1);
  assert.equal(legacy.titles[0].channel, undefined);
  assert.equal(legacy.titles[1].channel, "beta");
  assert.deepEqual(legacy.defaults, LEGACY_DEFAULTS);
});
