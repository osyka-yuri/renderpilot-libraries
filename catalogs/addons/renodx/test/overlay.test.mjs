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
      conflicts: ["SpecialK"],
    },
    { suffix: "child", name: "Child", appid: "200" },
  );

  assert.equal(split.appid, "200");
  assert.equal(split.exe, undefined);
  assert.equal(split.slug, "sharedslug");
  assert.deepEqual(split.conflicts, ["SpecialK"]);
});

test("validateOverlay rejects removed fields that have no publication contract", () => {
  for (const field of ["notes_keys", "min_app_version"]) {
    assert.throws(
      () =>
        validateOverlay(
          {
            game: {
              appid: "100",
              [field]: field === "notes_keys" ? ["note.key"] : "1.0.0",
            },
          },
          new Set(["game"]),
          () => {},
        ),
      new RegExp(`${field}.*no RenoDX publication contract`),
    );
  }

  assert.throws(
    () =>
      validateOverlay(
        {
          collection: {
            split: [
              {
                suffix: "child",
                name: "Child",
                appid: "100",
                notes_keys: ["note.key"],
              },
            ],
          },
        },
        new Set(["collection"]),
        () => {},
      ),
    /split\[0\]\.notes_keys.*no RenoDX publication contract/,
  );
});
