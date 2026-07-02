import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMarkdownTables,
  getModsTableHeaderColumns,
  parseWikiRow,
  parseStatus,
} from "../lib/sync-wiki-parsing.mjs";

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
