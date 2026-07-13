import assert from "node:assert/strict";
import test from "node:test";

import { parseLumaWikiRows, reconcileLumaStatuses } from "../lib/luma-wiki.mjs";

test("parseLumaWikiRows extracts Completed, WIP, and Unreal status tables", () => {
  const rows = parseLumaWikiRows(`
| Name | Download Link | Status |
| --- | --- | --- |
| [Exact Game](https://example.test) | Luma-Exact.zip | ✅ |
| Planned | Luma-Planned.zip | 💡 |

| Name | Author | Status |
| --- | --- | --- |
| Work in Progress | Maintainer | 🚧 |

| Name | DLSS/FSR | HDR |
| --- | --- | --- |
| Unreal Game | ✅ | |
`);

  assert.deepEqual(rows, [
    {
      name: "Exact Game",
      status: "working",
      asset: "Luma-Exact.zip",
      section: "completed",
    },
    { name: "Work in Progress", status: "construction", asset: null, section: "wip" },
    {
      name: "Unreal Game",
      status: "working",
      asset: "Luma-Unreal_Engine.zip",
      section: "unreal",
    },
  ]);
});

test("reconcileLumaStatuses uses unique asset, normalized names, and explicit aliases only", () => {
  const curatedGames = [
    { id: "exact", name: "Exact Game", asset: "Luma-Exact.zip", status: "unknown" },
    {
      id: "alias",
      name: "Dying Light 2 Stay Human",
      asset: "Luma-Dying_Light_2.zip",
      wiki_aliases: ["Dying Light 2"],
      status: "unknown",
    },
    {
      id: "unreal-one",
      name: "Unreal One",
      asset: "Luma-Unreal_Engine.zip",
      status: "unknown",
    },
    {
      id: "unreal-two",
      name: "Unreal Two",
      asset: "Luma-Unreal_Engine.zip",
      status: "unknown",
    },
  ];
  const result = reconcileLumaStatuses({
    curatedGames,
    wikiRows: [
      {
        name: "Different display name",
        status: "working",
        asset: "Luma-Exact.zip",
        section: "completed",
      },
      { name: "Dying Light 2", status: "construction", asset: null, section: "wip" },
      {
        name: "Unreal One",
        status: "working",
        asset: "Luma-Unreal_Engine.zip",
        section: "unreal",
      },
      {
        name: "Unknown",
        status: "working",
        asset: "Luma-Unreal_Engine.zip",
        section: "unreal",
      },
    ],
  });

  assert.deepEqual(
    result.changes.map(({ id, from, to }) => ({ id, from, to })),
    [
      { id: "exact", from: "unknown", to: "working" },
      { id: "alias", from: "unknown", to: "construction" },
      { id: "unreal-one", from: "unknown", to: "working" },
    ],
  );
  assert.deepEqual(result.unmatched, ["Unreal Two"]);
  assert.equal(result.notInCurated.length, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(
    result.nextCuratedGames.find((game) => game.id === "exact").status,
    "working",
  );
  assert.equal(curatedGames[0].status, "unknown", "input remains immutable");
});

test("reconcileLumaStatuses rejects conflicting asset and name matches", () => {
  const result = reconcileLumaStatuses({
    curatedGames: [
      { id: "asset", name: "Asset Match", asset: "Luma-Asset.zip", status: "unknown" },
      { id: "name", name: "Name Match", asset: "Luma-Name.zip", status: "unknown" },
    ],
    wikiRows: [
      {
        name: "Name Match",
        status: "working",
        asset: "Luma-Asset.zip",
        section: "completed",
      },
    ],
  });

  assert.deepEqual(result.changes, []);
  assert.equal(result.ambiguous.length, 1);
  assert.deepEqual(result.unmatched, ["Asset Match", "Name Match"]);
});
