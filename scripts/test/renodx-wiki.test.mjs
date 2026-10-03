import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../../catalogs/addons/renodx/lib/build-manifest.mjs";
import { extractMarkdownTables } from "../lib/wiki-markdown.mjs";
import {
  getModsTableHeaderColumns,
  parseRenodxWikiRows,
  parseStatus,
  parseWikiRow,
  reconcileRenodxWiki,
  shouldReplaceExistingUeGeneric,
  slugify,
} from "../lib/renodx-wiki.mjs";
import { createMatchRegistry } from "../lib/match-registry.mjs";
import { deepFreeze } from "../lib/common.mjs";

test("extractMarkdownTables captures tables and their preceding context", () => {
  const markdown = `
# Some header
Some text.

### Unity Engine
| Name | Status | Notes |
|:---|:---|:---|
| Tainted Grail: The Fall of Avalon | :white_check_mark: | Works |

### Unreal Engine
| Name | Status | Notes |
|:---|:---|:---|
| Some Unreal Game | :construction: | WIP |

### Other stuff
| Name | Maintainer |
|:---|:---|
| Other Game | User |
  `;

  const tables = extractMarkdownTables(markdown);

  assert.equal(tables.length, 3);

  assert.equal(tables[0].engineContext, "unity");
  assert.deepEqual(tables[0].headers, ["name", "status", "notes"]);
  assert.equal(tables[0].rows[0][0], "Tainted Grail: The Fall of Avalon");

  assert.equal(tables[1].engineContext, "unreal");
  assert.deepEqual(tables[1].headers, ["name", "status", "notes"]);

  assert.equal(tables[2].engineContext, null);
  assert.deepEqual(tables[2].headers, ["name", "maintainer"]);
});

test("marks Deprecated and Related Mods tables as excluded", () => {
  const tables = extractMarkdownTables(`
### Related Mods
| Name | Maintainer |
| --- | --- |
| Third-party HDR tool | Someone |

### Deprecated mods
| Name | Maintainer |
| --- | --- |
| Old title | Someone |

### Unity Engine
| Name | Status | Notes |
| --- | --- | --- |
| Active title | ✅ | Reviewed note |
`);

  assert.equal(tables[0].isExcluded, true);
  assert.equal(tables[1].isExcluded, true);
  assert.equal(tables[2].isExcluded, false);
  assert.equal(
    parseRenodxWikiRows(`
### Related Mods
| Name | Maintainer |
| --- | --- |
| Third-party HDR tool | Someone |
### Unity Engine
| Name | Status | Notes |
| --- | --- | --- |
| Active title | ✅ | Reviewed note |
`).length,
    1,
  );
});

test("parseWikiRow parses Unity game without custom link", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: -1, notesIndex: 2 };
  const row = parseWikiRow(
    ["[Tainted Grail](url)", ":white_check_mark:", "Works"],
    columnsMapping,
    "unity",
  );

  assert.ok(row);
  assert.equal(row.name, "Tainted Grail");
  assert.equal(row.status, "working");
  assert.equal(row.addonSlug, "unityengine");
  assert.equal(row.arch, "X64");
  assert.equal(row.notes, "Works");
});

test("parseWikiRow retains a status-cell hover note for manual disposition", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: -1, notesIndex: 2 };
  const row = parseWikiRow(
    ["Game", `:white_check_mark:](# \"Check the mod thread for notes.\")`, ""],
    columnsMapping,
    null,
  );
  assert.equal(row.notes, "Check the mod thread for notes.");
});

test("parseWikiRow parses Unreal game without custom link", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: -1, notesIndex: 2 };
  const row = parseWikiRow(
    ["[Game](url)", ":construction:", "WIP 32-bit"],
    columnsMapping,
    "unreal",
  );

  assert.ok(row);
  assert.equal(row.name, "Game");
  assert.equal(row.status, "construction");
  assert.equal(row.addonSlug, "unrealengine");
  assert.equal(row.arch, "X86"); // Should pick up 32-bit from notes
});

test("parseWikiRow respects custom link slug if provided", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: 2, notesIndex: 3 };
  const row = parseWikiRow(
    [
      "Game",
      "✅",
      "https://github.com/foo/renodx-bar/releases/download/v1/renodx-customslug.addon64",
      "Notes",
    ],
    columnsMapping,
    "unity",
  );

  assert.ok(row);
  assert.equal(row.addonSlug, "customslug");
});

test("parseStatus correctly translates emoji to status", () => {
  assert.equal(parseStatus(":white_check_mark:"), "working");
  assert.equal(parseStatus("✅"), "working");
  assert.equal(parseStatus(":construction:"), "construction");
  assert.equal(parseStatus("🚧"), "construction");
  assert.equal(parseStatus("something else"), "unknown");
});

test("slugify preserves Latin letters with combining marks", () => {
  assert.equal(slugify("ABZÛ"), "abzu");
});

function assertStyledTitlePreservesIdentity({ existingId, existingName, incomingName }) {
  const registry = createMatchRegistry({
    targets: [
      {
        id: existingId,
        rules: [
          {
            id: "steam-384190",
            kind: "steam_appid",
            value: "384190",
            provenance: { source: "test", locator: "steam:384190" },
          },
        ],
      },
    ],
  });
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: incomingName,
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [
      {
        id: existingId,
        name: existingName,
        slug: "unrealengine",
        arch: "X64",
        status: "working",
      },
    ],
    overlay: { [existingId]: { game_target_ids: [existingId] } },
    officialAssets: new Set(["renodx-unrealengine.addon64"]),
  });

  assert.equal(result.wikiGames[0].id, existingId);
  assert.deepEqual(result.overlay, { [existingId]: { game_target_ids: [existingId] } });

  const generated = buildManifest({
    wiki: result.wikiGames,
    overlay: result.overlay,
    registry,
    generatedAt: "2026-08-24T00:00:00Z",
    warn: () => {},
  });
  assert.equal(generated.manifest.games[0].id, existingId);
  assert.deepEqual(generated.manifest.games[0].match, [
    { kind: "steam_appid", value: "384190", tier: 100 },
  ]);
  assert.deepEqual(generated.pending, []);
}

test("reconciliation preserves identity when a title gains combining marks", () => {
  assertStyledTitlePreservesIdentity({
    existingId: "abzu",
    existingName: "ABZU",
    incomingName: "ABZÛ",
  });
});

test("reconciliation preserves identity when a title loses combining marks", () => {
  assertStyledTitlePreservesIdentity({
    existingId: "caf",
    existingName: "Café",
    incomingName: "Cafe",
  });
});

test("reconciliation does not reuse an ambiguous canonical title id", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Resumé",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unityengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [
      { id: "resume-a", name: "Résumé", slug: "unityengine", arch: "X64" },
      { id: "resume-b", name: "Resume", slug: "unityengine", arch: "X64" },
    ],
    overlay: {},
    officialAssets: new Set(["renodx-unityengine.addon64"]),
  });

  assert.equal(result.wikiGames[0].id, "resume");
});

test("a stripped-name collision cannot bypass canonical ambiguity", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Cafè",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unityengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [
      { id: "cafe-a", name: "Café", slug: "unityengine", arch: "X64" },
      { id: "cafe-b", name: "Cafê", slug: "unityengine", arch: "X64" },
    ],
    overlay: {},
    officialAssets: new Set(["renodx-unityengine.addon64"]),
  });

  assert.equal(result.wikiGames[0].id, "cafe");
});

test("getModsTableHeaderColumns maps all known columns correctly", () => {
  const headers = ["name", "maintainer", "links", "status", "notes"];
  const mapping = getModsTableHeaderColumns(headers);
  assert.deepEqual(mapping, {
    nameIndex: 0,
    maintainerIndex: 1,
    linksIndex: 2,
    statusIndex: 3,
    notesIndex: 4,
  });
});

test("getModsTableHeaderColumns handles missing columns gracefully", () => {
  const headers = ["name", "maintainer", "links"];
  const mapping = getModsTableHeaderColumns(headers);
  assert.deepEqual(mapping, {
    nameIndex: 0,
    maintainerIndex: 1,
    linksIndex: 2,
    statusIndex: -1,
    notesIndex: -1,
  });
});

test("getModsTableHeaderColumns rejects invalid tables", () => {
  assert.equal(getModsTableHeaderColumns(["status", "notes"]), null); // Missing name
  assert.equal(getModsTableHeaderColumns(["name", "random1", "random2"]), null); // Missing supporting columns
});

test("parseWikiRow handles out of bounds column access gracefully", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 3, linksIndex: -1, notesIndex: -1 };
  // Only 2 columns provided
  const row = parseWikiRow(["Game", "Maintainer"], columnsMapping, "unity");

  assert.ok(row);
  assert.equal(row.name, "Game");
  assert.equal(row.status, "unknown"); // statusIndex is 3, out of bounds
});

test("parseRenodxWikiRows preserves the existing Mods-table parser contract", () => {
  const rows = parseRenodxWikiRows(`
### Unity
| Name | Maintainer | Status | Links | Notes |
| --- | --- | --- | --- |
| Game | Owner | ✅ | | |
`);
  assert.deepEqual(rows, [
    {
      name: "Game",
      section: "unity",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "unityengine",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "unity:game",
    },
  ]);
});

test("reconcileRenodxWiki keeps the established catalogue and overlay result", () => {
  const existingWiki = [{ id: "known", name: "Known Game", slug: "known", arch: "X64" }];
  const overlay = {
    known: { slug: "known", external: { url: "https://old.example", label_key: "old" } },
  };
  const rows = [
    {
      name: "Known Game",
      status: "working",
      addonUrl:
        "https://clshortfuse.github.io/games/renodx-known/releases/download/v1/renodx-known.addon64",
      arch: "X64",
      addonSlug: "known",
      nexusUrl: null,
      discordUrl: null,
    },
    {
      name: "External Game",
      status: "construction",
      addonUrl: null,
      arch: "X64",
      addonSlug: null,
      nexusUrl: "https://www.nexusmods.com/game/mods/1",
      discordUrl: null,
    },
  ];

  const result = reconcileRenodxWiki({
    rows,
    existingWiki,
    overlay,
    officialAssets: new Set(),
  });
  assert.deepEqual(result.wikiGames, [
    { id: "known", name: "Known Game", slug: "known", arch: "X64", status: "working" },
    {
      id: "external-game",
      name: "External Game",
      slug: "external-game",
      arch: "X64",
      status: "construction",
    },
  ]);
  assert.deepEqual(result.overlay, {
    known: { slug: "known" },
    "external-game": {
      external: {
        url: "https://www.nexusmods.com/game/mods/1",
        label_key: "renodx.external.nexus",
      },
    },
  });
  assert.deepEqual(overlay.known.external, {
    url: "https://old.example",
    label_key: "old",
  });
});

test("parseWikiRow captures 32-bit architecture from addon32 URL", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: 2, notesIndex: 3 };
  const row = parseWikiRow(
    [
      "Game32",
      "✅",
      "https://github.com/foo/renodx-bar/releases/download/v1/renodx-game32.addon32",
      "",
    ],
    columnsMapping,
    "unity",
  );

  assert.ok(row);
  assert.equal(row.addonSlug, "game32");
  assert.equal(row.arch, "X86");
});

test("reconcileRenodxWiki prefers X64 asset when game default is X64 and both 32 and 64 assets exist", () => {
  const existingWiki = [];
  const overlay = {};
  const rows = [
    {
      name: "Dual Arch Game",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: null,
      nexusUrl: null,
      discordUrl: null,
    },
  ];

  const result = reconcileRenodxWiki({
    rows,
    existingWiki,
    overlay,
    officialAssets: new Set(["renodx-dualarchgame.addon32", "renodx-dualarchgame.addon64"]),
  });

  assert.equal(result.wikiGames[0].slug, "dualarchgame");
  assert.equal(result.wikiGames[0].arch, "X64");
});

test("parseWikiRow extracts query-based Nexus Mods URL", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 1, linksIndex: 2, notesIndex: 3 };
  const row = parseWikiRow(
    [
      "LOTR War in the North",
      "✅",
      "[Nexus](https://www.nexusmods.com/mods/3?game_id=9856)",
      "",
    ],
    columnsMapping,
    null,
  );

  assert.ok(row);
  assert.equal(row.nexusUrl, "https://www.nexusmods.com/mods/3?game_id=9856");
});

test("reconcileRenodxWiki resolves official addon architecture when preferred slug has opposite bitness", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Assassin's Creed™: Director's Cut Edition (DX10)",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: null,
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [
      {
        id: "assassin-s-creed-director-s-cut-edition",
        name: "Assassin's Creed™: Director's Cut Edition (DX10)",
        slug: "asscreed1",
        arch: "X64",
      },
    ],
    overlay: {},
    officialAssets: new Set(["renodx-asscreed1.addon32"]),
  });

  assert.equal(result.wikiGames[0].arch, "X86");
  assert.equal(result.wikiGames[0].slug, "asscreed1");
  assert.equal(result.stats.official, 1);
});

test("reconcileRenodxWiki preserves explicit third-party addon when only opposite-arch official asset exists", () => {
  const gameId = "borderlands-2-the-pre-sequel";
  const addonUrl =
    "https://github.com/steve161803/renodx/releases/download/snapshot/renodx-borderlands2.addon32";
  const row = parseWikiRow(
    ["Borderlands 2 & The Pre-Sequel", "✅", addonUrl, ""],
    { nameIndex: 0, statusIndex: 1, linksIndex: 2, notesIndex: 3 },
    null,
    "main",
  );

  assert.equal(row.addonUrl, addonUrl);
  assert.equal(row.addonSlug, "borderlands2");
  assert.equal(row.arch, "X86");

  const overlay = {
    [gameId]: { game_target_ids: ["borderlands-2", "borderlands-the-pre-sequel"] },
  };
  const result = reconcileRenodxWiki({
    rows: [row],
    existingWiki: [],
    overlay,
    officialAssets: new Set(["renodx-borderlands2.addon64"]),
  });

  assert.equal(result.wikiGames[0].slug, "borderlands2");
  assert.equal(result.wikiGames[0].arch, "X86");
  assert.equal(result.overlay[gameId].download_url, addonUrl);
  assert.deepEqual(result.overlay[gameId].game_target_ids, [
    "borderlands-2",
    "borderlands-the-pre-sequel",
  ]);
});

test("reconcileRenodxWiki prefers matching official asset over explicit third-party addon URL", () => {
  const gameId = "borderlands-2-the-pre-sequel";
  const addonUrl =
    "https://github.com/steve161803/renodx/releases/download/snapshot/renodx-borderlands2.addon32";
  const row = parseWikiRow(
    ["Borderlands 2 & The Pre-Sequel", "✅", addonUrl, ""],
    { nameIndex: 0, statusIndex: 1, linksIndex: 2, notesIndex: 3 },
    null,
    "main",
  );

  const overlay = {
    [gameId]: {
      download_url: addonUrl,
      game_target_ids: ["borderlands-2", "borderlands-the-pre-sequel"],
    },
  };
  const result = reconcileRenodxWiki({
    rows: [row],
    existingWiki: [],
    overlay,
    officialAssets: new Set(["renodx-borderlands2.addon32"]),
  });

  assert.equal(result.wikiGames[0].slug, "borderlands2");
  assert.equal(result.wikiGames[0].arch, "X86");
  assert.equal(Object.hasOwn(result.overlay[gameId], "download_url"), false);
  assert.deepEqual(result.overlay[gameId], {
    game_target_ids: ["borderlands-2", "borderlands-the-pre-sequel"],
  });
});

test("extractMarkdownTables resets engineContext on # and ## headings", () => {
  const markdown = `
### Unity Engine
| Name | Status | Notes |
|:---|:---|:---|
| Unity Game | :white_check_mark: | Works |

### Unreal Engine
| Name | Status | Notes |
|:---|:---|:---|
| UE Game | :white_check_mark: | Works |

# Related Mods
| Name | Maintainer | Links | Status |
|:---|:---|:---|:---|
| External Mod | Author | [Nexus](https://nexusmods.com/1) | :white_check_mark: |

## Other Section
| Name | Maintainer | Links | Status |
|:---|:---|:---|:---|
| Standalone Game | Author | https://github.com/foo/releases/download/v1/renodx-foo.addon64 | :white_check_mark: |
  `;

  const tables = extractMarkdownTables(markdown);
  assert.equal(tables.length, 4);
  assert.equal(tables[0].engineContext, "unity");
  assert.equal(tables[1].engineContext, "unreal");
  assert.equal(tables[2].engineContext, null);
  assert.equal(tables[3].engineContext, null);
});

test("parseWikiRow matches github.io addon URLs", () => {
  const columnsMapping = { nameIndex: 0, statusIndex: 3, linksIndex: 2, notesIndex: -1 };
  const row = parseWikiRow(
    [
      "Wuchang: Fallen Feathers",
      "OopyDoopy (Jon)",
      "[Snapshot](https://oopydoopy.github.io/renodx/renodx-wuchang.addon64)",
      "Superseded by Generic Unreal Engine mod",
    ],
    columnsMapping,
    null,
  );

  assert.ok(row);
  assert.equal(row.name, "Wuchang: Fallen Feathers");
  assert.equal(row.addonUrl, "https://oopydoopy.github.io/renodx/renodx-wuchang.addon64");
  assert.equal(row.addonSlug, "wuchang");
  assert.equal(row.arch, "X64");
  assert.equal(row.status, "unknown");
});

test("reconcileRenodxWiki discards poisoned generic engine slug for external/standalone game", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Dark Souls 2 - DS2LightingEngine SotFS",
        status: "construction",
        addonUrl: null,
        arch: "X64",
        addonSlug: null,
        nexusUrl: "https://www.nexusmods.com/darksouls2/mods/1146",
        discordUrl: null,
      },
    ],
    existingWiki: [
      {
        id: "dark-souls-2-ds2lightingengine-sotfs",
        name: "Dark Souls 2 - DS2LightingEngine SotFS",
        slug: "unityengine",
        arch: "X64",
        status: "construction",
      },
    ],
    overlay: {
      "dark-souls-2-ds2lightingengine-sotfs": {
        external: {
          url: "https://www.nexusmods.com/darksouls2/mods/1146",
          label_key: "renodx.external.nexus",
        },
      },
    },
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames[0].slug, "dark-souls-2-ds2lightingengine-sotfs");
  assert.notEqual(result.wikiGames[0].slug, "unityengine");
});

test("extractMarkdownTables detects isDeprecated and ue-extended engine context", () => {
  const markdown = `
### UE Extended
| Name | Status | Notes |
|:---|:---|:---|
| Extended Game | :white_check_mark: | Works |

### Deprecated mods
| Name | Status | Notes |
|:---|:---|:---|
| Old Broken Mod | :x: | Broken |
  `;

  const tables = extractMarkdownTables(markdown);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].engineContext, "ue-extended");
  assert.equal(tables[0].isDeprecated, false);
  assert.equal(tables[1].isDeprecated, true);
});

test("parseRenodxWikiRows skips tables flagged with isDeprecated", () => {
  const markdown = `
### UE Extended
| Name | Status | Notes |
|:---|:---|:---|
| Extended Game | :white_check_mark: | Works |

### Deprecated mods
| Name | Status | Notes |
|:---|:---|:---|
| Deprecated Game | :x: | Old |
  `;

  const rows = parseRenodxWikiRows(markdown);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Extended Game");
  assert.equal(rows[0].addonSlug, "ue-extended");
});

test("reconcileRenodxWiki upgrades unrealengine to ue-extended when encountered", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Some Game",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "Some Game",
        status: "working",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "ue-extended");
  assert.equal(result.wikiGames[0].status, "working");
});

test("reconcileRenodxWiki preserves working unrealengine when ue-extended is construction", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "It Takes Two",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "It Takes Two",
        status: "construction",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "unrealengine");
  assert.equal(result.wikiGames[0].status, "working");
});

test("reconcileRenodxWiki upgrades construction unrealengine when ue-extended is working", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Scorn",
        status: "construction",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "Scorn",
        status: "working",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "ue-extended");
  assert.equal(result.wikiGames[0].status, "working");
});

test("reconcileRenodxWiki preserves working unrealengine when ue-extended is encountered first as construction", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "ABZÛ",
        status: "construction",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "ABZÛ",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "unrealengine");
  assert.equal(result.wikiGames[0].status, "working");
});

test("reconcileRenodxWiki keeps working ue-extended when unrealengine is encountered second as working", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "It Takes Two",
        status: "working",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "It Takes Two",
        status: "working",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "ue-extended");
  assert.equal(result.wikiGames[0].status, "working");
});

test("reconcileRenodxWiki keeps ue-extended when both are construction and ue-extended is encountered first", () => {
  const result = reconcileRenodxWiki({
    rows: [
      {
        name: "Astroneer",
        status: "construction",
        addonUrl: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
        arch: "X64",
        addonSlug: "ue-extended",
        nexusUrl: null,
        discordUrl: null,
      },
      {
        name: "Astroneer",
        status: "construction",
        addonUrl: null,
        arch: "X64",
        addonSlug: "unrealengine",
        nexusUrl: null,
        discordUrl: null,
      },
    ],
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].slug, "ue-extended");
  assert.equal(result.wikiGames[0].status, "construction");
});

test("shouldReplaceExistingUeGeneric satisfies complete priority matrix across ordering", () => {
  const cases = [
    // existingSlug, existingStatus, rowSlug, rowStatus, expected
    ["unrealengine", "working", "ue-extended", "construction", false],
    ["unrealengine", "construction", "ue-extended", "working", true],
    ["unrealengine", "working", "ue-extended", "working", true],
    ["unrealengine", "construction", "ue-extended", "construction", true],

    ["ue-extended", "working", "unrealengine", "construction", false],
    ["ue-extended", "construction", "unrealengine", "working", true],
    ["ue-extended", "working", "unrealengine", "working", false],
    ["ue-extended", "construction", "unrealengine", "construction", false],
  ];

  for (const [eSlug, eStatus, rSlug, rStatus, expected] of cases) {
    const actual = shouldReplaceExistingUeGeneric(
      { slug: eSlug, status: eStatus },
      { addonSlug: rSlug, status: rStatus },
    );
    assert.equal(
      actual,
      expected,
      `Failed for ${eSlug} (${eStatus}) vs ${rSlug} (${rStatus})`,
    );
  }

  assert.equal(
    shouldReplaceExistingUeGeneric(
      { slug: "unityengine", status: "working" },
      { addonSlug: "ue-extended", status: "working" },
    ),
    null,
  );
});

test("parseRenodxWikiRows disambiguates duplicate titles with occurrence suffix", () => {
  const markdown = `
### Unity
| Name | Status |
|:---|:---|
| Clone Game | :white_check_mark: |
| Clone Game | :construction: |
| Clone Game | :question: |
`;

  const rows = parseRenodxWikiRows(markdown);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sourceKey, "unity:clone-game");
  assert.equal(rows[1].sourceKey, "unity:clone-game:2");
  assert.equal(rows[2].sourceKey, "unity:clone-game:3");
});

test("reconcileRenodxWiki creates messages and handles duplicate notes cleanly", () => {
  const rows = [
    {
      name: "Duplicate Game",
      section: "ue-extended",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "ue-extended:duplicate-game",
    },
    {
      name: "Duplicate Game",
      section: "ue-extended",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "ue-extended:duplicate-game:2",
      notes: "Second row note",
    },
  ];

  const result = reconcileRenodxWiki({
    rows,
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].notes, "Second row note");
  assert.equal(result.wikiGames[0].source_key, "ue-extended:duplicate-game:2");
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0], {
    source_key: "ue-extended:duplicate-game:2",
    game_id: "duplicate-game",
    title: "Duplicate Game",
    section: "ue-extended",
    profile_source: "ue-extended",
    note: "Second row note",
  });
});

test("reconcileRenodxWiki accumulates additional_source_keys when both duplicate rows have notes", () => {
  const rows = [
    {
      name: "Multi Note Game",
      section: "main",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "game",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "main:multi-note-game",
      notes: "First note",
    },
    {
      name: "Multi Note Game",
      section: "main",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "game",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "main:multi-note-game:2",
      notes: "Second note",
    },
  ];

  const result = reconcileRenodxWiki({
    rows,
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].notes, "First note");
  assert.equal(result.wikiGames[0].source_key, "main:multi-note-game");
  assert.deepEqual(result.wikiGames[0].additional_source_keys, ["main:multi-note-game:2"]);
  assert.equal(result.messages.length, 2);
});

test("reconcileRenodxWiki enforces referential immutability and never mutates inputs", () => {
  const rows = deepFreeze([
    {
      name: "Frozen Game",
      section: "ue-extended",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "ue-extended:frozen-game",
      notes: "Frozen note",
    },
    {
      name: "Frozen Game",
      section: "ue-extended",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "ue-extended:frozen-game:2",
      notes: "Additional frozen note",
    },
  ]);

  const existingWiki = deepFreeze([
    {
      id: "frozen-game",
      name: "Frozen Game",
      slug: "ue-extended",
      arch: "X64",
      status: "working",
    },
  ]);

  const overlay = deepFreeze({
    "frozen-game": {
      download_url: "https://example.com/mod.addon64",
      external: "nexus",
    },
  });

  const officialAssets = deepFreeze(new Set(["renodx-frozen-game.addon64"]));

  // If reconcileRenodxWiki mutates any of the inputs, Object.freeze will throw a TypeError in strict mode.
  const result = reconcileRenodxWiki({
    rows,
    existingWiki,
    overlay,
    officialAssets,
  });

  assert.ok(result);
  assert.equal(result.wikiGames.length, 1);
  assert.equal(result.wikiGames[0].id, "frozen-game");
  assert.notEqual(result.overlay, overlay);
  assert.notEqual(result.overlay["frozen-game"], overlay["frozen-game"]);
});

test("reconcileRenodxWiki preserves every active note in messages across duplicates and is idempotent", () => {
  const rows = [
    {
      name: "S.T.A.L.K.E.R. 2: Heart of Chornobyl",
      section: "main",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "main:s-t-a-l-k-e-r-2-heart-of-chornobyl",
      notes: "Set gamma to 50%",
    },
    {
      name: "S.T.A.L.K.E.R. 2: Heart of Chornobyl",
      section: "ue-extended",
      status: "working",
      addonUrl: null,
      arch: "X64",
      addonSlug: "ue-extended",
      nexusUrl: null,
      discordUrl: null,
      sourceKey: "ue-extended:s-t-a-l-k-e-r-2-heart-of-chornobyl",
      notes: "Native HDR",
    },
  ];

  const firstPass = reconcileRenodxWiki({
    rows,
    existingWiki: [],
    overlay: {},
    officialAssets: new Set(),
  });

  // Both notes must be in messages for complete audit/ledger coverage
  assert.equal(firstPass.messages.length, 2);
  assert.equal(firstPass.messages[0].source_key, "main:s-t-a-l-k-e-r-2-heart-of-chornobyl");
  assert.equal(
    firstPass.messages[1].source_key,
    "ue-extended:s-t-a-l-k-e-r-2-heart-of-chornobyl",
  );
  assert.equal(firstPass.wikiGames.length, 1);
  assert.equal(
    firstPass.wikiGames[0].source_key,
    "main:s-t-a-l-k-e-r-2-heart-of-chornobyl",
  );
  assert.deepEqual(firstPass.wikiGames[0].additional_source_keys, [
    "ue-extended:s-t-a-l-k-e-r-2-heart-of-chornobyl",
  ]);

  // Idempotence: running second pass with first pass output as existingWiki
  const secondPass = reconcileRenodxWiki({
    rows,
    existingWiki: firstPass.wikiGames,
    overlay: firstPass.overlay,
    officialAssets: new Set(),
  });

  assert.deepEqual(secondPass.wikiGames, firstPass.wikiGames);
  assert.deepEqual(secondPass.messages, firstPass.messages);
  assert.deepEqual(secondPass.overlay, firstPass.overlay);
  assert.deepEqual(secondPass.stats, firstPass.stats);
});
