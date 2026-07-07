import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  collectOverlaySteamAppIds,
  filesForTool,
  parseToolArg,
  validateMatchOverlay,
} from "../match-pending.mjs";
import { collectOverlayAppids as collectRenoOverlayAppids } from "../../renodx_library_manifest/lib/overlay.mjs";
import { collectOverlayAppids as collectLumaOverlayAppids } from "../../luma_library_manifest/lib/overlay.mjs";

test("parseToolArg defaults to renodx and selects luma explicitly", () => {
  assert.equal(parseToolArg([]), "renodx");
  assert.equal(parseToolArg(["--tool=luma"]), "luma");
  assert.throws(() => parseToolArg(["--tool=unknown"]), /Unknown --tool/);
});

test("filesForTool resolves the requested tool's authoring files", () => {
  const luma = filesForTool("luma");
  const renodx = filesForTool("renodx");

  assert.ok(
    luma.pendingMatch.endsWith(path.join("luma_library_manifest", "pending_match.json")),
  );
  assert.ok(luma.manifest.endsWith("luma_manifest.json"));
  assert.ok(
    renodx.pendingMatch.endsWith(
      path.join("renodx_library_manifest", "pending_match.json"),
    ),
  );
  assert.ok(renodx.manifest.endsWith("renodx_manifest.json"));
});

test("collectOverlaySteamAppIds handles singular appid and plural appids", () => {
  const overlay = validateMatchOverlay(
    {
      one: { appid: 100 },
      two: { appids: ["200", 201] },
    },
    "match_overlay.json",
  );

  assert.deepEqual(
    [...collectOverlaySteamAppIds(overlay, collectLumaOverlayAppids)].sort(),
    ["100", "200", "201"],
  );
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

  assert.deepEqual(
    [...collectOverlaySteamAppIds(overlay, collectRenoOverlayAppids)].sort(),
    ["299", "300", "301"],
  );
});
