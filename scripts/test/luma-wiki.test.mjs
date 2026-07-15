import assert from "node:assert/strict";
import test from "node:test";

import {
  lumaWikiNoteFingerprint,
  parseLumaWikiRows,
  reconcileLumaStatuses,
} from "../lib/luma-wiki.mjs";

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
      note: null,
    },
    {
      name: "Planned",
      status: "unknown",
      asset: "Luma-Planned.zip",
      section: "completed",
      note: null,
    },
    {
      name: "Work in Progress",
      status: "construction",
      asset: null,
      section: "wip",
      note: null,
    },
    {
      name: "Unreal Game",
      status: "working",
      asset: "Luma-Unreal_Engine.zip",
      section: "unreal",
      features: { dlss_fsr: "supported", hdr: "unknown" },
      note: null,
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
      profile: "unreal",
      features: { dlss_fsr: "unknown", hdr: "unknown" },
      status: "unknown",
    },
    {
      id: "unreal-two",
      name: "Unreal Two",
      asset: "Luma-Unreal_Engine.zip",
      profile: "unreal",
      features: { dlss_fsr: "unknown", hdr: "unknown" },
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
  assert.equal(result.notInCurated.length, 1);
  assert.equal(result.ambiguous.length, 0);
  assert.equal(
    result.nextCuratedGames.find((game) => game.id === "exact").status,
    "working",
  );
  assert.equal(curatedGames[0].status, "unknown", "input remains immutable");
  assert.deepEqual(
    result.nextCuratedGames.find((game) => game.id === "unreal-one").features,
    { dlss_fsr: "unknown", hdr: "unknown" },
  );
});

test("parseLumaWikiRows maps every explicit feature marker and leaves blank cells unknown", () => {
  const [row] = parseLumaWikiRows(`
| Name | DLSS/FSR | HDR |
| --- | --- | --- |
| Feature Matrix | 🚧 | ⛔ |
`);
  assert.deepEqual(row.features, { dlss_fsr: "experimental", hdr: "unsupported" });
});

test("parseLumaWikiRows accepts a feature table with only an HDR column", () => {
  const [row] = parseLumaWikiRows(`
| Name | HDR |
| --- | --- |
| HDR only | ✅ |
`);

  assert.deepEqual(row.features, { dlss_fsr: "unknown", hdr: "supported" });
});

test("parseLumaWikiRows does not invent features outside the UE matrix", () => {
  const rows = parseLumaWikiRows(`
| Name | Download Link | Status |
| --- | --- | --- |
| No feature columns | Luma-No_Features.zip | ✅ |
`);

  assert.equal(rows[0].features, undefined);
});

test("reconcileLumaStatuses blocks a changed Wiki note without publishing its raw text", () => {
  const result = reconcileLumaStatuses({
    curatedGames: [
      {
        id: "wiki-game",
        name: "Wiki Game",
        asset: "Luma-Unreal_Engine.zip",
        profile: "unreal",
        status: "unknown",
        features: { dlss_fsr: "unknown", hdr: "unknown" },
        wiki_note_reviews: [
          {
            section: "unreal",
            name: "Wiki Game",
            fingerprint: lumaWikiNoteFingerprint("Reviewed instruction"),
            disposition: "published",
            guidance_ids: ["luma.wiki-game.warning"],
          },
        ],
      },
    ],
    wikiRows: [
      {
        name: "Wiki Game",
        section: "unreal",
        asset: "Luma-Unreal_Engine.zip",
        status: "working",
        features: { dlss_fsr: "supported", hdr: "unknown" },
        note: "Changed upstream instruction",
      },
    ],
  });

  assert.deepEqual(result.reviewDrift, [
    { type: "changed", section: "unreal", name: "Wiki Game", game: "Wiki Game" },
  ]);
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
