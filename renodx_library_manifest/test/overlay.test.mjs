import test from "node:test";
import assert from "node:assert/strict";

import { categoryOf, inheritedSplitOverlay, validateOverlay } from "../lib/overlay.mjs";

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
      notes_keys: ["note.key"],
    },
    { suffix: "child", name: "Child", appid: "200" },
  );

  assert.equal(split.appid, "200");
  assert.equal(split.exe, undefined);
  assert.equal(split.slug, "sharedslug");
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
