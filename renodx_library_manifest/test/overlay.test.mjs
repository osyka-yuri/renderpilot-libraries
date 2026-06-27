import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryOf,
  inheritedSplitOverlay,
  normalizeAppid,
  normalizeAppids,
  normalizeExeName,
  validateOverlay,
} from "../lib/overlay.mjs";

test("normalizes appids and exe basenames", () => {
  assert.equal(normalizeAppid(123, "appid"), "123");
  assert.equal(normalizeAppid(" 456 ", "appid"), "456");
  assert.deepEqual(normalizeAppids({ appid: "100", appids: ["100", "200"] }, "overlay"), [
    "100",
    "200",
  ]);
  assert.equal(normalizeExeName(" Game.EXE ", "exe"), "Game.EXE");

  assert.throws(() => normalizeAppid("0", "appid"), /positive Steam AppID/);
  assert.throws(() => normalizeExeName("bin/Game.exe", "exe"), /basename/);
});

test("rejects category conflicts and category plus download_url", () => {
  assert.deepEqual(
    categoryOf(
      {
        external: {
          url: "https://discord.gg/example",
          label_key: "renodx.external.discord",
        },
      },
      "overlay",
    ),
    {
      kind: "external",
      url: "https://discord.gg/example",
      label_key: "renodx.external.discord",
    },
  );

  assert.throws(
    () => categoryOf({ external: {}, blacklist: "reason" }, "overlay"),
    /conflicting categories/,
  );
  assert.throws(
    () =>
      categoryOf(
        {
          external: {
            url: "https://discord.gg/example",
            label_key: "renodx.external.discord",
          },
          download_url: "https://example.test/renodx.addon64",
        },
        "overlay",
      ),
    /cannot combine a category with download_url/,
  );
});

test("split overlays inherit metadata but not parent match identifiers", () => {
  const split = inheritedSplitOverlay(
    {
      appid: "100",
      exe: "Parent.exe",
      slug: "sharedslug",
      risk: { severity: "warn" },
      notes_keys: ["note.key"],
    },
    { suffix: "child", name: "Child", appid: "200" },
  );

  assert.equal(split.appid, "200");
  assert.equal(split.exe, undefined);
  assert.equal(split.slug, "sharedslug");
  assert.deepEqual(split.risk, { severity: "warn" });
  assert.deepEqual(split.notes_keys, ["note.key"]);
});

test("validateOverlay catches empty arrays before generation", () => {
  assert.throws(
    () =>
      validateOverlay(
        {
          game: {
            appid: "100",
            notes_keys: [],
          },
        },
        new Set(["game"]),
      ),
    /notes_keys must not be empty/,
  );
});
