import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectOverlaySteamAppIds,
  collectProfileSteamAppIds,
  createLumaPendingStore,
  createLumaStoreApi,
  createRenodxStoreApi,
  validateMatchOverlay,
} from "../lib/pending-match-stores.mjs";
import { UsageError } from "../lib/common.mjs";
import { filesForTool, parseToolArg } from "../match-pending.mjs";

test("parseToolArg defaults to renodx and selects luma explicitly", () => {
  assert.deepEqual(parseToolArg([]), { help: false, tool: "renodx" });
  assert.deepEqual(parseToolArg(["--tool=luma"]), { help: false, tool: "luma" });
  assert.deepEqual(parseToolArg(["--help"]), { help: true, tool: "renodx" });
  assert.throws(() => parseToolArg(["--tool=unknown"]), /Unknown --tool/);
  assert.throws(() => parseToolArg(["--wat"]), UsageError);
  assert.throws(() => parseToolArg(["--tool=luma", "extra"]), UsageError);
});

test("filesForTool resolves the requested tool's authoring files", () => {
  const luma = filesForTool("luma");
  const renodx = filesForTool("renodx");

  assert.ok(
    luma.pendingMatch.endsWith(
      path.join("catalogs", "addons", "luma", "pending_match.json"),
    ),
  );
  assert.ok(luma.manifest.endsWith(path.join("addons", "v1", "luma.json")));
  assert.ok(
    luma.profiles.endsWith(path.join("catalogs", "addons", "luma", "curated_games.json")),
  );
  assert.equal(luma.matchOverlay, null);
  assert.ok(
    renodx.pendingMatch.endsWith(
      path.join("catalogs", "addons", "renodx", "pending_match.json"),
    ),
  );
  assert.ok(renodx.manifest.endsWith(path.join("addons", "v1", "renodx.json")));
});

test("collectProfileSteamAppIds reads Luma's direct match rules", () => {
  assert.deepEqual(
    [
      ...collectProfileSteamAppIds([
        { id: "one", match: [{ kind: "steam_appid", value: 100, tier: 100 }] },
        { id: "two", match: [{ kind: "steam_appid", value: "200", tier: 100 }] },
      ]),
    ].sort(),
    ["100", "200"],
  );

  assert.throws(
    () =>
      collectProfileSteamAppIds([
        { id: "invalid", match: [{ kind: "steam_appid", value: "0", tier: 100 }] },
      ]),
    /positive Steam AppID/,
  );
});

test("Luma pending store validates match values through the authoring contract", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "luma-pending-store-"));
  const profiles = path.join(directory, "curated_games.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const invalidRules = [
    [{ kind: "steam_appid", value: "0", tier: 100 }, /positive Steam AppID/],
    [{ kind: "exe_name", value: "bin\\Game.exe", tier: 70 }, /\.exe basename/],
    [{ kind: "exe_sha256", value: "A".repeat(64), tier: 80 }, /lowercase SHA-256 digest/],
  ];

  for (const [rule, expectedError] of invalidRules) {
    await fs.writeFile(
      profiles,
      JSON.stringify([{ id: "invalid", match: [rule] }]),
      "utf8",
    );
    await assert.rejects(createLumaPendingStore({ profiles }), expectedError);
  }
});

test("collectOverlaySteamAppIds uses the RenoDX split-aware collector", () => {
  const overlay = validateMatchOverlay(
    {
      collection: {
        appid: "299",
        split: [
          { suffix: "one", name: "One", appid: "300" },
          { suffix: "two", name: "Two", appids: ["301"] },
        ],
      },
    },
    "match_overlay.json",
  );

  assert.deepEqual([...collectOverlaySteamAppIds(overlay)].sort(), ["299", "300", "301"]);
});

test("Luma store persists match_ignore for duplicate AppIDs", () => {
  const profiles = [
    { id: "claimed", match: [{ kind: "steam_appid", value: "10", tier: 100 }] },
    { id: "pending", match: [] },
  ];
  const store = createLumaStoreApi(profiles);

  assert.equal(store.isResolved("claimed"), true);
  assert.equal(store.isResolved("pending"), false);
  assert.ok(store.claimAppIds().has("10"));

  store.applyDuplicateIgnore("pending");
  assert.equal(profiles[1].match_ignore, true);
  assert.equal(store.isResolved("pending"), true);
});

test("Luma store writes steam match rules and clears match_ignore", () => {
  const profiles = [{ id: "pending", match: [], match_ignore: true }];
  const store = createLumaStoreApi(profiles);

  store.applyMatch("pending", "42");
  assert.deepEqual(profiles[0].match, [{ kind: "steam_appid", value: "42", tier: 100 }]);
  assert.equal("match_ignore" in profiles[0], false);
  assert.equal(store.isResolved("pending"), true);
});

test("RenoDX store persists direct matches and duplicate ignores", () => {
  const overlay = new Map([["claimed", { appids: ["10"] }]]);
  const store = createRenodxStoreApi(overlay);

  assert.equal(store.isResolved("claimed"), true);
  assert.equal(store.isResolved("pending"), false);

  store.applyDuplicateIgnore("pending");
  assert.deepEqual(overlay.get("pending"), { ignore: true });
  assert.equal(store.isResolved("pending"), true);

  store.applyMatch("fresh", "99");
  assert.deepEqual(overlay.get("fresh"), { appids: ["99"] });
});

test("RenoDX store preserves category metadata when resolving direct entries", () => {
  const overlay = new Map([
    [
      "pending",
      {
        external: {
          url: "https://example.com/mod",
          label_key: "renodx.external.nexus",
        },
      },
    ],
  ]);

  const store = createRenodxStoreApi(overlay);
  assert.equal(store.isResolved("pending"), false);

  store.applyMatch("pending", "42");
  assert.deepEqual(overlay.get("pending"), {
    external: {
      url: "https://example.com/mod",
      label_key: "renodx.external.nexus",
    },
    appids: ["42"],
  });
  assert.equal(store.isResolved("pending"), true);
});

test("RenoDX store preserves category metadata when ignoring direct entries", () => {
  const overlay = new Map([
    [
      "pending",
      {
        external: {
          url: "https://example.com/mod",
          label_key: "renodx.external.nexus",
        },
        appids: [],
      },
    ],
  ]);

  const store = createRenodxStoreApi(overlay);
  store.applyDuplicateIgnore("pending");

  assert.deepEqual(overlay.get("pending"), {
    external: {
      url: "https://example.com/mod",
      label_key: "renodx.external.nexus",
    },
    ignore: true,
  });
  assert.equal(store.isResolved("pending"), true);
});

test("RenoDX store updates split children without creating orphan root entries", () => {
  const parent = {
    slug: "collection",
    split: [
      { suffix: "one", name: "One" },
      { suffix: "two", name: "Two" },
    ],
  };
  const overlay = new Map([["collection", parent]]);
  const store = createRenodxStoreApi(overlay);

  store.applyMatch("collection-one", "101");
  store.applyDuplicateIgnore("collection-two");

  assert.deepEqual(parent.split, [
    { suffix: "one", name: "One", appids: ["101"] },
    { suffix: "two", name: "Two", ignore: true },
  ]);
  assert.equal(overlay.has("collection-one"), false);
  assert.equal(overlay.has("collection-two"), false);
  assert.equal(store.isResolved("collection-one"), true);
  assert.equal(store.isResolved("collection-two"), true);
  assert.equal(store.isResolved("collection"), true);
});
