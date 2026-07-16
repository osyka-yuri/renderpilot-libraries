import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ISSUES_TO_PRINT } from "../lib/checks.mjs";
import {
  OFF_SNAPSHOT_AVAILABILITY_KINDS,
  assertGame,
  assertManifestShape,
  assertProfile,
  checkExplicitAddonNames,
  checkExplicitGameAddonNames,
  checkExplicitProfileAddonNames,
  checkGames,
  checkProfiles,
  expectedGameAddon,
  expectedProfileAddon,
  gameLabel,
  isOffSnapshotGame,
  isSnapshotHostedProfile,
  profileLabel,
} from "../lib/renodx-slug-checks.mjs";
import {
  ADDON_EXTENSION_BY_ARCH,
  addonBasenameFromUrl,
  addonFile,
  sameFileName,
} from "../lib/addon-naming.mjs";

test("ADDON_EXTENSION_BY_ARCH maps X64 and X86", () => {
  assert.equal(ADDON_EXTENSION_BY_ARCH.get("X64"), "addon64");
  assert.equal(ADDON_EXTENSION_BY_ARCH.get("X86"), "addon32");
});

test("OFF_SNAPSHOT_AVAILABILITY_KINDS covers external, native_hdr, blocked", () => {
  assert.ok(OFF_SNAPSHOT_AVAILABILITY_KINDS.has("external"));
  assert.ok(OFF_SNAPSHOT_AVAILABILITY_KINDS.has("native_hdr"));
  assert.ok(OFF_SNAPSHOT_AVAILABILITY_KINDS.has("blocked"));
  assert.ok(!OFF_SNAPSHOT_AVAILABILITY_KINDS.has("installable"));
});

test("MAX_ISSUES_TO_PRINT is a positive integer", () => {
  assert.equal(Number.isInteger(MAX_ISSUES_TO_PRINT), true);
  assert.ok(MAX_ISSUES_TO_PRINT > 0);
});

test("addonFile builds renodx-<slug>.addon<arch>", () => {
  assert.equal(addonFile("cp2077", "X64"), "renodx-cp2077.addon64");
  assert.equal(addonFile("ryza", "X86"), "renodx-ryza.addon32");
});

test("addonFile throws on unsupported architecture", () => {
  assert.throws(() => addonFile("cp2077", "ARM"), /Unsupported RenoDX architecture/);
});

test("addonBasenameFromUrl extracts the trailing file name", () => {
  assert.equal(
    addonBasenameFromUrl("https://example.com/path/renodx-cp2077.addon64", "u"),
    "renodx-cp2077.addon64",
  );
});

test("addonBasenameFromUrl strips the query string", () => {
  assert.equal(
    addonBasenameFromUrl("https://example.com/p/renodx-x.addon32?v=2", "u"),
    "renodx-x.addon32",
  );
});

test("addonBasenameFromUrl throws on an invalid URL", () => {
  assert.throws(() => addonBasenameFromUrl("not-a-url", "u"), /must be a valid URL/);
});

test("addonBasenameFromUrl throws on a URL without a file name", () => {
  assert.throws(
    () => addonBasenameFromUrl("https://example.com/", "u"),
    /must end with an add-on file name/,
  );
});

test("addonBasenameFromUrl throws on a non-string", () => {
  assert.throws(() => addonBasenameFromUrl(undefined, "u"), /must be a non-empty string/);
  assert.throws(() => addonBasenameFromUrl("  ", "u"), /must be a non-empty string/);
});

test("sameFileName is case-insensitive", () => {
  assert.equal(sameFileName("Renodx-CP2077.Addon64", "renodx-cp2077.addon64"), true);
  assert.equal(sameFileName("a.addon64", "b.addon64"), false);
});

test("expectedGameAddon combines slug and architecture", () => {
  const game = { id: "cp2077", architecture: "X64", addon: { slug: "cp2077" } };
  assert.equal(expectedGameAddon(game, 0), "renodx-cp2077.addon64");
});

test("expectedGameAddon throws when slug is missing", () => {
  assert.throws(
    () => expectedGameAddon({ architecture: "X64", addon: {} }, 0),
    /games\[0\]\.addon\.slug/,
  );
});

test("expectedGameAddon throws when architecture is missing", () => {
  assert.throws(
    () => expectedGameAddon({ id: "x", addon: { slug: "x" } }, 0),
    /\.architecture/,
  );
});

test("expectedGameAddon uses game id in the label when present", () => {
  assert.throws(
    () => expectedGameAddon({ id: "mygame", architecture: "X64", addon: {} }, 0),
    /mygame\.addon\.slug/,
  );
});

test("expectedProfileAddon builds the X64 add-on name", () => {
  assert.equal(
    expectedProfileAddon({ engine: "unity", addon: { slug: "unityengine" } }, 0),
    "renodx-unityengine.addon64",
  );
});

test("expectedProfileAddon throws when slug is missing", () => {
  assert.throws(
    () => expectedProfileAddon({ engine: "unity", addon: {} }, 0),
    /engine_profile:unity\.addon\.slug/,
  );
});

test("gameLabel prefers game.id, falls back to games[index]", () => {
  assert.equal(gameLabel({ id: "cp2077" }, 3), "cp2077");
  assert.equal(gameLabel({ id: "  " }, 3), "games[3]");
  assert.equal(gameLabel({}, 3), "games[3]");
});

test("profileLabel prefers profile.engine, falls back to engine_profiles[index]", () => {
  assert.equal(profileLabel({ engine: "unity" }, 3), "engine_profile:unity");
  assert.equal(profileLabel({ engine: "  " }, 3), "engine_profiles[3]");
  assert.equal(profileLabel({}, 3), "engine_profiles[3]");
});

test("isOffSnapshotGame is true for addon.source", () => {
  assert.equal(isOffSnapshotGame({ addon: { source: "https://x/y.addon64" } }), true);
});

test("isOffSnapshotGame is true for off-snapshot availability", () => {
  for (const kind of ["external", "native_hdr", "blocked"]) {
    assert.equal(isOffSnapshotGame({ availability: { kind } }), true);
  }
});

test("isOffSnapshotGame is false for a plain installable game", () => {
  assert.equal(isOffSnapshotGame({ architecture: "X64", addon: { slug: "x" } }), false);
});

test("isSnapshotHostedProfile is true for slug-only profiles", () => {
  assert.equal(isSnapshotHostedProfile({ addon: { slug: "unrealengine" } }), true);
});

test("isSnapshotHostedProfile is false when sources are present", () => {
  assert.equal(
    isSnapshotHostedProfile({
      addon: { slug: "x", sources: { x64: "https://x", x86: "https://y" } },
    }),
    false,
  );
  assert.equal(isSnapshotHostedProfile({ engine: "unity" }), false);
});

test("assertManifestShape accepts a well-formed v1 manifest", () => {
  assert.doesNotThrow(() =>
    assertManifestShape({ schema_version: 1, games: [], engine_profiles: [] }),
  );
});

test("assertManifestShape rejects non-objects and missing arrays", () => {
  assert.throws(() => assertManifestShape(null), /JSON object/);
  assert.throws(() => assertManifestShape({ games: [] }), /`engine_profiles` array/);
  assert.throws(() => assertManifestShape({ engine_profiles: [] }), /`games` array/);
  assert.throws(
    () => assertManifestShape({ games: "x", engine_profiles: [] }),
    /`games` array/,
  );
});

test("assertGame and assertProfile reject non-records", () => {
  assert.throws(() => assertGame(null, 0), /games\[0\]/);
  assert.throws(() => assertProfile("x", 1), /engine_profiles\[1\]/);
  assert.doesNotThrow(() => assertGame({ id: "x" }, 0));
  assert.doesNotThrow(() => assertProfile({ engine: "x" }, 0));
});

test("checkGames reports missing snapshot assets and skips off-snapshot games", () => {
  const games = [
    { id: "present", architecture: "X64", addon: { slug: "present" } },
    { id: "absent", architecture: "X64", addon: { slug: "absent" } },
    {
      id: "external",
      architecture: "X64",
      addon: { slug: "external" },
      availability: { kind: "external" },
    },
    {
      id: "with-url",
      architecture: "X64",
      addon: { slug: "withurl", source: "https://x/y.addon64" },
    },
  ];
  const assets = new Set(["renodx-present.addon64"]);

  const result = checkGames(games, [], assets);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.missing, ["absent (renodx-absent.addon64)"]);
});

test("checkProfiles reports missing snapshot profiles and skips explicit-hosted ones", () => {
  const profiles = [
    { engine: "unreal", addon: { slug: "unrealengine" } },
    {
      engine: "unity",
      addon: {
        slug: "unityengine",
        sources: { x64: "https://x", x86: "https://y" },
      },
    },
    { engine: "missing", addon: { slug: "missingengine" } },
  ];
  const assets = new Set(["renodx-unrealengine.addon64"]);

  const result = checkProfiles(profiles, assets);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.missing, [
    "engine_profile:missing (renodx-missingengine.addon64)",
  ]);
});

test("checkExplicitGameAddonNames detects basename mismatches", () => {
  const games = [
    {
      id: "good",
      architecture: "X64",
      addon: { slug: "good", source: "https://x/renodx-good.addon64" },
    },
    {
      id: "bad",
      architecture: "X64",
      addon: { slug: "bad", source: "https://x/renodx-wrong.addon64" },
    },
    { id: "skipped", architecture: "X64", addon: { slug: "skipped" } },
  ];

  const result = checkExplicitGameAddonNames(games);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, [
    "bad: renodx-wrong.addon64 should be renodx-bad.addon64",
  ]);
});

test("checkExplicitGameAddonNames is case-insensitive on the basename", () => {
  const games = [
    {
      id: "ok",
      architecture: "X64",
      addon: { slug: "ok", source: "https://x/RENODX-OK.ADDON64" },
    },
  ];

  const result = checkExplicitGameAddonNames(games);

  assert.equal(result.checked, 1);
  assert.deepEqual(result.mismatches, []);
});

test("checkExplicitProfileAddonNames reports a structural error when only one url is set", () => {
  const profiles = [
    { engine: "unity", addon: { slug: "unityengine", sources: { x64: "https://x" } } },
  ];

  const result = checkExplicitProfileAddonNames(profiles);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.structural, [
    "engine_profile:unity: addon.sources.x64 and x86 must be provided together",
  ]);
  assert.deepEqual(result.mismatches, []);
});

test("checkExplicitProfileAddonNames skips basename check when slug is absent", () => {
  const profiles = [
    {
      engine: "unity",
      addon: {
        sources: {
          x64: "https://x/renodx-unityengine.addon64",
          x86: "https://x/renodx-unityengine.addon32",
        },
      },
    },
  ];

  const result = checkExplicitProfileAddonNames(profiles);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitProfileAddonNames skips snapshot-hosted profiles without sources", () => {
  const profiles = [{ engine: "unreal", addon: { slug: "unrealengine" } }];

  const result = checkExplicitProfileAddonNames(profiles);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitProfileAddonNames detects basename mismatches for both arches", () => {
  const profiles = [
    {
      engine: "unity",
      addon: {
        slug: "unityengine",
        sources: {
          x64: "https://x/renodx-wrong.addon64",
          x86: "https://x/renodx-wrong.addon32",
        },
      },
    },
  ];

  const result = checkExplicitProfileAddonNames(profiles);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.mismatches, [
    "engine_profile:unity.addon.sources.x64: renodx-wrong.addon64 should be renodx-unityengine.addon64",
    "engine_profile:unity.addon.sources.x86: renodx-wrong.addon32 should be renodx-unityengine.addon32",
  ]);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitProfileAddonNames accepts matching urls case-insensitively", () => {
  const profiles = [
    {
      engine: "unity",
      addon: {
        slug: "unityengine",
        sources: {
          x64: "https://x/RENODX-UNITYENGINE.ADDON64",
          x86: "https://x/renodx-unityengine.addon32",
        },
      },
    },
  ];

  const result = checkExplicitProfileAddonNames(profiles);

  assert.equal(result.checked, 2);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitAddonNames aggregates games and engine profiles", () => {
  const manifest = {
    games: [
      {
        id: "t-bad",
        architecture: "X64",
        addon: { slug: "tbad", source: "https://x/renodx-wrong.addon64" },
      },
    ],
    engine_profiles: [
      {
        engine: "unity",
        addon: {
          slug: "unityengine",
          sources: {
            x64: "https://x/renodx-wrong.addon64",
            x86: "https://x/renodx-wrong.addon32",
          },
        },
      },
    ],
  };

  const result = checkExplicitAddonNames(manifest);

  assert.equal(result.checked, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.mismatches.length, 3);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitAddonNames separates structural errors from mismatches", () => {
  const manifest = {
    games: [],
    engine_profiles: [
      { engine: "unity", addon: { slug: "x", sources: { x64: "https://x" } } },
    ],
  };

  const result = checkExplicitAddonNames(manifest);

  assert.equal(result.structural.length, 1);
  assert.equal(result.mismatches.length, 0);
});
