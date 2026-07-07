import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../lib/build-manifest.mjs";

const game = (id, overrides = {}) => ({
  id,
  name: overrides.name ?? id,
  asset: overrides.asset ?? `Luma-${id}.zip`,
  arch: overrides.arch ?? "X64",
  status: overrides.status ?? "working",
  ...overrides,
});

test("buildManifest emits a title once it has a match identifier", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("dishonored-2", { name: "Dishonored 2", asset: "Luma-Dishonored_2.zip" }),
    ],
    overlay: { "dishonored-2": { appid: "403640" } },
    warn: () => {},
  });

  assert.equal(result.manifest.titles.length, 1);
  const [title] = result.manifest.titles;
  assert.equal(title.id, "dishonored-2");
  assert.equal(title.asset, "Luma-Dishonored_2.zip");
  assert.deepEqual(title.match, [{ kind: "steam_appid", value: "403640", tier: 100 }]);
  assert.deepEqual(result.pending, []);
});

test("buildManifest keeps unmatched rows pending", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("no-match-game", { name: "No Match Game" })],
    overlay: {},
    warn: () => {},
  });

  assert.equal(result.manifest.titles.length, 0);
  assert.deepEqual(result.pending, [
    {
      id: "no-match-game",
      name: "No Match Game",
      asset: "Luma-no-match-game.zip",
      arch: "X64",
    },
  ]);
});

test("buildManifest drops items with the ignore flag entirely (not pending)", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("garbage-game")],
    overlay: { "garbage-game": { ignore: true } },
    warn: () => {},
  });

  assert.equal(result.manifest.titles.length, 0);
  assert.deepEqual(result.pending, []);
});

test("buildManifest rejects duplicate match rules across titles", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("one"), game("two")],
        overlay: {
          one: { appid: "100" },
          two: { appid: "100" },
        },
        warn: () => {},
      }),
    /duplicate match rules/,
  );
});

test("buildManifest lets one title carry multiple Steam AppIDs (e.g. a bundled series asset)", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("bioshock-series", { asset: "Luma-BioShock_Series-x32.zip", arch: "X86" }),
    ],
    overlay: { "bioshock-series": { appids: ["409710", "409720"] } },
    warn: () => {},
  });

  assert.deepEqual(
    result.manifest.titles[0].match.map((rule) => rule.value),
    ["409710", "409720"],
  );
});

test("buildManifest emits a blacklist category from the curated game's own field", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("vanquish", { blacklist: "luma.reason.needs_dgvoodoo" })],
    overlay: { vanquish: { appid: "213670" } },
    warn: () => {},
  });

  assert.deepEqual(result.manifest.titles[0].category, {
    kind: "blacklist",
    reason: "luma.reason.needs_dgvoodoo",
  });
});

test("buildManifest carries generic/launch_args/notes_keys straight from the curated game", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("tekken-7", {
        asset: "Luma-Unreal_Engine.zip",
        generic: true,
        launch_args: ["-nod3d9ex"],
        notes_keys: ["luma.note.generic_mod"],
      }),
    ],
    overlay: { "tekken-7": { appid: "389730" } },
    warn: () => {},
  });

  const [title] = result.manifest.titles;
  assert.equal(title.generic, true);
  assert.deepEqual(title.launch_args, ["-nod3d9ex"]);
  assert.deepEqual(title.notes_keys, ["luma.note.generic_mod"]);
});

test("buildManifest derives channel from status (working -> stable default omitted, else beta)", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("working-game", { status: "working" }),
      game("wip-game", { status: "construction" }),
    ],
    overlay: {
      "working-game": { appid: "1" },
      "wip-game": { appid: "2" },
    },
    warn: () => {},
  });

  const [working, wip] = result.manifest.titles;
  assert.equal(working.channel, undefined);
  assert.equal(wip.channel, "beta");
});

test("buildManifest rejects an asset name that doesn't match Luma's naming convention", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("bad-asset", { asset: "NotLuma.zip" })],
        overlay: { "bad-asset": { appid: "1" } },
        warn: () => {},
      }),
    /must match Luma-<name>\[-x32\]\.zip/,
  );
});

test("buildManifest rejects an -x32 asset suffix that disagrees with arch", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("mismatch", { asset: "Luma-Mismatch-x32.zip", arch: "X64" })],
        overlay: { mismatch: { appid: "1" } },
        warn: () => {},
      }),
    /-x32 suffix must agree with arch/,
  );
});

test("buildManifest derives an exe_name match rule from the steam-appid-exe.json cache", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("stray")],
    overlay: { stray: { appid: "1332010" } },
    exeCache: { 1332010: ["Stray.exe"] },
    warn: () => {},
  });

  assert.deepEqual(
    result.manifest.titles[0].match.map((rule) => rule.kind),
    ["steam_appid", "exe_name"],
  );
});
