import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../lib/build-manifest.mjs";

const game = (id, overrides = {}) => {
  const asset = overrides.asset ?? `Luma-${id}.zip`;
  return {
    id,
    name: overrides.name ?? id,
    asset,
    addon_file: overrides.addon_file ?? asset.replace(/\.zip$/u, ".addon"),
    arch: overrides.arch ?? "X64",
    status: overrides.status ?? "working",
    ...overrides,
  };
};

const dgVoodooRequirement = (overrides = {}) => ({
  kind: "dgvoodoo2",
  version: "2.87.3",
  accepted_detected_apis: ["D3D9"],
  reshade_proxy_dll: "dxgi.dll",
  source: {
    url: "https://github.com/dege-diosg/dgVoodoo2/releases/download/v2.87.3/dgVoodoo2_87_3.zip",
    sha256: "6fb954bed55bf70e948c5045a663a9df31ea206faf105e327bafe46c318f867f",
    size: 9082391,
  },
  install_map: [
    {
      source: "MS/x86/D3D9.dll",
      dest: "D3D9.dll",
      sha256: "c13e3c0969d2c70a1a63cf96b83c7cd3bc47f925f28ec92c07d5b72d6df4c240",
      size: 485888,
    },
  ],
  config_file: "dgVoodoo.conf",
  config: [
    {
      section: "General",
      entries: [{ key: "OutputAPI", value: "d3d11_fl11_0" }],
    },
    {
      section: "DirectX",
      entries: [{ key: "VideoCard", value: "geforce_9800_gt" }],
    },
  ],
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

  assert.match(result.manifest.min_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("reshade" in result.manifest, false);
  assert.equal(result.manifest.titles.length, 1);
  const [title] = result.manifest.titles;
  assert.equal(title.id, "dishonored-2");
  assert.equal(title.asset, "Luma-Dishonored_2.zip");
  assert.equal(title.addon_file, "Luma-Dishonored_2.addon");
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

test("buildManifest carries a managed external requirement from the curated game", () => {
  const externalRequirement = dgVoodooRequirement();
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("borderlands-2-and-the-pre-sequel", {
        asset: "Luma-Borderlands_2_and_The_Pre-Sequel-x32.zip",
        arch: "X86",
        external_requirement: externalRequirement,
      }),
    ],
    overlay: { "borderlands-2-and-the-pre-sequel": { appids: ["49520", "261640"] } },
    warn: () => {},
  });

  assert.deepEqual(result.manifest.titles[0].external_requirement, externalRequirement);
});

test("buildManifest rejects non-DirectX APIs in an external requirement", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-wrapper", {
            external_requirement: dgVoodooRequirement({
              accepted_detected_apis: ["Vulkan"],
            }),
          }),
        ],
        overlay: { "bad-wrapper": { appid: "1" } },
        warn: () => {},
      }),
    /must be one of/,
  );
});

test("buildManifest rejects unsafe managed archive paths", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-wrapper", {
            external_requirement: dgVoodooRequirement({
              install_map: [
                {
                  source: "../D3D9.dll",
                  dest: "D3D9.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
            }),
          }),
        ],
        overlay: { "bad-wrapper": { appid: "1" } },
        warn: () => {},
      }),
    /safe relative archive path/,
  );
});

test("buildManifest rejects unsafe managed game-directory filenames", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-wrapper", {
            external_requirement: dgVoodooRequirement({
              install_map: [
                {
                  source: "MS/x86/D3D9.dll",
                  dest: "nested/D3D9.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
            }),
          }),
        ],
        overlay: { "bad-wrapper": { appid: "1" } },
        warn: () => {},
      }),
    /safe game-directory filename/,
  );
});

test("buildManifest rejects duplicate managed install targets", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-wrapper", {
            external_requirement: dgVoodooRequirement({
              install_map: [
                {
                  source: "MS/x86/D3D9.dll",
                  dest: "dgVoodoo.conf",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
            }),
          }),
        ],
        overlay: { "bad-wrapper": { appid: "1" } },
        warn: () => {},
      }),
    /duplicate/,
  );
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

test("buildManifest requires a safe root Luma add-on filename", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("unsafe", { addon_file: "nested/Luma-Unsafe.addon" })],
        overlay: { unsafe: { appid: "1" } },
        warn: () => {},
      }),
    /safe game-directory filename/,
  );
});

test("buildManifest rejects one release asset claiming two payload identities", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("one", { asset: "Luma-Shared.zip", addon_file: "Luma-One.addon" }),
          game("two", { asset: "Luma-Shared.zip", addon_file: "Luma-Two.addon" }),
        ],
        overlay: { one: { appid: "1" }, two: { appid: "2" } },
        warn: () => {},
      }),
    /maps to multiple root add-ons/,
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
