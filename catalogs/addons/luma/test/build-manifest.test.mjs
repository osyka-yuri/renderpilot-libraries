import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../lib/build-manifest.mjs";
import { authoringGame as game } from "./helpers.mjs";

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

test("buildManifest emits a v1 game once it has a match identifier", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("dishonored-2", {
        name: "Dishonored 2",
        asset: "Luma-Dishonored_2.zip",
        match: [{ kind: "steam_appid", value: "403640", tier: 100 }],
      }),
    ],
  });

  assert.equal(result.manifest.schema_version, 1);
  assert.match(result.manifest.minimum_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("host" in result.manifest, false);
  assert.equal(result.manifest.games.length, 1);
  const [published] = result.manifest.games;
  assert.equal(published.id, "dishonored-2");
  assert.equal(published.architecture, "X64");
  assert.equal(published.package.release_asset, "Luma-Dishonored_2.zip");
  assert.equal(published.package.addon_file, "Luma-Dishonored_2.addon");
  assert.deepEqual(published.match, [{ kind: "steam_appid", value: "403640", tier: 100 }]);
  assert.equal(published.profile, "game");
  assert.equal("features" in published, false);
  assert.deepEqual(result.pending, []);
});

test("buildManifest requires both Luma feature statuses", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("missing-features", {
            asset: "Luma-Unreal_Engine.zip",
            profile: "unreal",
            features: { hdr: "supported" },
          }),
        ],
      }),
    /features\.dlss_fsr/,
  );
});

test("buildManifest rejects an unknown Luma feature status", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("invalid-features", {
            asset: "Luma-Unreal_Engine.zip",
            profile: "unreal",
            features: { dlss_fsr: "enabled", hdr: "supported" },
          }),
        ],
      }),
    /features\.dlss_fsr.*must be one of/i,
  );
});

test("buildManifest rejects incompatible profile and shared asset combinations", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("explicit-game-profile", { profile: " game " })],
      }),
    /profile must be omitted for a game-specific payload/,
  );
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("wrong-unity", {
            profile: "unity",
            asset: "Luma-Unreal_Engine.zip",
          }),
        ],
      }),
    /asset must be Luma-Unity_Engine\.zip/,
  );
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("implicit-shared", { asset: "Luma-Unity_Engine.zip" })],
      }),
    /profile is required for shared asset/,
  );
});

test("buildManifest keeps unmatched rows pending", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("no-match-game", { name: "No Match Game", match: [] })],
  });

  assert.equal(result.manifest.games.length, 0);
  assert.deepEqual(result.pending, [
    {
      id: "no-match-game",
      name: "No Match Game",
      asset: "Luma-no-match-game.zip",
      arch: "X64",
    },
  ]);
});

test("buildManifest skips match_ignore profiles from pending and output", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("ignored-dup", { name: "Ignored", match: [], match_ignore: true })],
  });

  assert.equal(result.manifest.games.length, 0);
  assert.deepEqual(result.pending, []);
});

test("buildManifest rejects duplicate match rules across titles", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("one", { match: [{ kind: "steam_appid", value: "100", tier: 100 }] }),
          game("two", { match: [{ kind: "steam_appid", value: "100", tier: 100 }] }),
        ],
      }),
    /duplicate match rules/,
  );
});

test("buildManifest lets one title carry multiple Steam AppIDs", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("bioshock-series", {
        asset: "Luma-BioShock_Series-x32.zip",
        arch: "X86",
        match: [
          { kind: "steam_appid", value: "409710", tier: 100 },
          { kind: "steam_appid", value: "409720", tier: 100 },
        ],
      }),
    ],
  });

  assert.deepEqual(
    result.manifest.games[0].match.map((rule) => rule.value),
    ["409710", "409720"],
  );
});

test("buildManifest emits blocked availability from the curated blacklist field", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("vanquish", { blacklist: "luma.reason.needs_dgvoodoo" })],
  });

  assert.deepEqual(result.manifest.games[0].availability, {
    kind: "blocked",
    message: {
      id: "luma.reason.needs_dgvoodoo",
      fallback_text: "This Luma profile is unavailable.",
    },
  });
});

test("buildManifest carries engine profile, launch arguments, and reviewed guidance", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("tekken-7", {
        asset: "Luma-Unreal_Engine.zip",
        profile: "unreal",
        features: { dlss_fsr: "unknown", hdr: "unknown" },
        launch_args: ["-nod3d9ex"],
        guidance: [
          {
            id: "luma.tekken-7.launch",
            kind: "launch_argument",
            fallback_text: "Add the argument in the game's launcher.",
            code: "-nod3d9ex",
          },
        ],
      }),
    ],
  });

  const [published] = result.manifest.games;
  assert.equal(published.profile, "unreal");
  assert.deepEqual(published.requirements.launch_arguments, ["-nod3d9ex"]);
  assert.deepEqual(published.guidance, [
    {
      id: "luma.tekken-7.launch",
      kind: "launch_argument",
      fallback_text: "Add the argument in the game's launcher.",
      code: "-nod3d9ex",
    },
  ]);
  assert.equal("generic" in published, false);
  assert.equal("launch_args" in published, false);
});

test("buildManifest carries a managed external requirement under requirements", () => {
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
  });

  assert.deepEqual(
    result.manifest.games[0].requirements.managed_dependency,
    externalRequirement,
  );
  assert.equal("external_requirement" in result.manifest.games[0], false);
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
      }),
    /duplicate/,
  );
});

test("buildManifest leaves channel out of the v1 authoring path", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("working-game", { status: "working" }),
      game("wip-game", { status: "construction" }),
    ],
  });

  const [working, wip] = result.manifest.games;
  assert.equal(working.channel, undefined);
  assert.equal(wip.channel, undefined);
});

test("buildManifest rejects an asset name that doesn't match Luma's naming convention", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [game("bad-asset", { asset: "NotLuma.zip" })],
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
      }),
    /maps to multiple root add-ons/,
  );
});

test("buildManifest preserves an explicit executable-name match rule", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("stray", {
        match: [
          { kind: "steam_appid", value: "1332010", tier: 100 },
          { kind: "exe_name", value: "Stray.exe", tier: 70 },
        ],
      }),
    ],
  });

  assert.deepEqual(
    result.manifest.games[0].match.map((rule) => rule.kind),
    ["steam_appid", "exe_name"],
  );
});

test("buildManifest normalizes valid match-rule values by kind", () => {
  const match = [
    { kind: "steam_appid", value: " 42 ", tier: 100 },
    { kind: "epic_id", value: " epic-catalog-id ", tier: 90 },
    { kind: "gog_id", value: " gog-product-id ", tier: 90 },
    { kind: "exe_sha256", value: ` ${"a".repeat(64)} `, tier: 80 },
    { kind: "exe_name", value: " Game.EXE ", tier: 70 },
  ];
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [game("match-values", { match })],
  });

  assert.deepEqual(result.manifest.games[0].match, [
    { kind: "steam_appid", value: "42", tier: 100 },
    { kind: "epic_id", value: "epic-catalog-id", tier: 90 },
    { kind: "gog_id", value: "gog-product-id", tier: 90 },
    { kind: "exe_sha256", value: "a".repeat(64), tier: 80 },
    { kind: "exe_name", value: "Game.EXE", tier: 70 },
  ]);
});

test("buildManifest rejects malformed match-rule values by kind", () => {
  const invalidRules = [
    [{ kind: "steam_appid", value: "0", tier: 100 }, /positive Steam AppID/],
    [{ kind: "steam_appid", value: "12x", tier: 100 }, /positive Steam AppID/],
    [{ kind: "exe_name", value: "Game", tier: 70 }, /\.exe basename/],
    [{ kind: "exe_name", value: "bin\\Game.exe", tier: 70 }, /\.exe basename/],
    [{ kind: "exe_sha256", value: "A".repeat(64), tier: 80 }, /lowercase SHA-256 digest/],
    [{ kind: "exe_sha256", value: "a".repeat(63), tier: 80 }, /lowercase SHA-256 digest/],
  ];

  for (const [rule, expectedError] of invalidRules) {
    assert.throws(
      () =>
        buildManifest({
          generatedAt: "2026-07-05T00:00:00Z",
          curatedGames: [game("invalid-match-value", { match: [rule] })],
        }),
      expectedError,
    );
  }
});
