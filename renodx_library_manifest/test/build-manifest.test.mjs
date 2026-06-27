import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../lib/build-manifest.mjs";

const game = (id, name = id) => ({
  id,
  name,
  slug: id,
  arch: "X64",
  status: "working",
});

test("buildManifest promotes matched split entries and preserves inherited metadata", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("collection", "Collection")],
    overlay: {
      collection: {
        slug: "shared",
        notes_keys: ["note.collection"],
        split: [
          { suffix: "one", name: "One", appid: "100" },
          { suffix: "two", name: "Two", exe: "Two.exe" },
        ],
      },
    },
    exeCache: { 100: ["One.exe"] },
    warn: () => {},
  });

  assert.equal(result.manifest.titles.length, 2);
  assert.deepEqual(
    result.manifest.titles.map((title) => title.id),
    ["collection-one", "collection-two"],
  );
  assert.deepEqual(result.manifest.titles[0].notes_keys, ["note.collection"]);
  assert.deepEqual(
    result.manifest.titles[0].match.map((rule) => rule.kind),
    ["steam_appid", "exe_name"],
  );
  assert.deepEqual(result.pending, []);
});

test("buildManifest keeps unmatched categorized rows pending", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("external-game", "External Game")],
    overlay: {
      "external-game": {
        external: {
          url: "https://www.nexusmods.com/example/mods/1",
          label_key: "renodx.external.nexus",
        },
      },
    },
    warn: () => {},
  });

  assert.equal(result.manifest.titles.length, 0);
  assert.deepEqual(result.pending, [
    { id: "external-game", name: "External Game", slug: "external-game", arch: "X64" },
  ]);
});

test("buildManifest rejects duplicate match rules across titles", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-06-27T00:00:00Z",
        wiki: [game("one"), game("two")],
        overlay: {
          one: { appid: "100" },
          two: { appid: "100" },
        },
        warn: () => {},
      }),
    /duplicate match rules/,
  );
});
