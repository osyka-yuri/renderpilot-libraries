import assert from "node:assert/strict";
import test from "node:test";

import { gameExesFromAppinfo, isLikelyGameExeName } from "../lib/steam-appinfo.mjs";

test("appinfo enrichment keeps public Avowed launch exe and drops dev/test branches", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: {
            executable: "Avowed.exe",
            type: "default",
            config: { oslist: "windows" },
            description: "Launch Avowed",
          },
          1: {
            executable: "AvowedDev.exe",
            config: { oslist: "windows", betakey: "latest_mainline" },
            description: "Avowed Development (Recommended for Testing)",
          },
          2: {
            executable: "AvowedTest.exe",
            config: { oslist: "windows", betakey: "latest_mainline" },
            description: "Avowed Test (For Performance Testing)",
          },
        },
      },
    }),
    ["Avowed.exe"],
  );
});

test("appinfo enrichment keeps real alternate renderer entries and drops tools", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: { executable: "CoJ.exe" },
          1: {
            executable: "CoJ_DX10.exe",
            description: "Run Call of Juarez - DirectX 10",
          },
          2: {
            executable: "CoJ.exe",
            arguments: "-server -dedicated -internet",
            description: "Run Call of Juarez dedicated internet server",
          },
          3: {
            executable: "cojdx10_benchmark.exe",
            description: "Run Call of Juarez DirectX 10 benchmark",
          },
          4: { executable: "chromEd.exe", description: "ChromEd" },
        },
      },
    }),
    ["CoJ.exe", "CoJ_DX10.exe"],
  );
});

test("appinfo enrichment ignores branch-only debug submissions when public entry exists", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: { executable: "ds.exe", config: { oslist: "windows" } },
          1: {
            executable: "ds.rtdbg.exe",
            arguments: "-package",
            config: { oslist: "windows", betakey: "qa-rtdbg" },
            description: "RuntimeDebug build",
          },
          2: {
            executable: "NIP.Win64.Submission.DX12.Steam.MiSecure.exe",
            arguments: "-package",
            config: { oslist: "windows", betakey: "qa-rtdbg" },
            description: "Steam Submission MiSecure",
          },
        },
      },
    }),
    ["ds.exe"],
  );
});

test("appinfo enrichment drops multiplayer launch entries", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: {
            executable: "ACRSP.exe",
            description: "Launch Assassin's Creed Revelations - Singleplayer",
          },
          1: {
            executable: "ACRMP.exe",
            description: "Launch Assassin's Creed Revelations - Multiplayer",
          },
        },
      },
    }),
    ["ACRSP.exe"],
  );
});

test("appinfo enrichment treats default betakey entries as public", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: {
            executable: "Spider-Man2.exe",
            config: {
              betakey: "default, latest_dev, internal_qa1",
              osarch: "64",
              oslist: "windows",
            },
            description: "Play Marvel's Spider-Man 2",
          },
          1: {
            executable: "i30_steam_Release.exe",
            config: {
              betakey: "latest_dev, internal_qa1",
              osarch: "64",
              oslist: "windows",
            },
            description: "Launch Release",
          },
          2: {
            executable: "Spider-Man.exe",
            config: { betakey: "disabled", osarch: "64", oslist: "windows" },
            description: "Play Corn Dog (AMD RT workaround)",
          },
        },
      },
    }),
    ["Spider-Man2.exe"],
  );
});

test("appinfo enrichment skips ancillary DLC launch entries", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: { executable: "METAPHOR.exe" },
          1: {
            config: { ownsdlc: "2999630" },
            description: "Metaphor: ReFantazio - Digital Artbook",
            executable: "Artbook/book/metaphor_book.exe",
          },
          2: {
            config: { ownsdlc: "4128470" },
            description: "Metaphor: ReFantazio - Essential Digital Strategy Guide",
            executable: "Artbook/guide/metaphor_guide.exe",
          },
        },
      },
    }),
    ["METAPHOR.exe"],
  );

  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: { executable: "game.exe", type: "default" },
          1: {
            config: { ownsdlc: "1523810" },
            description: "Play Persona 5 Strikers Bonus Content",
            executable: "EXTRAS\\Persona 5 Strikers Bonus Content.exe",
          },
        },
      },
    }),
    [],
  );
});

test("appinfo enrichment prefers default launch entries over tools and profile builds", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: {
            executable: "DyingLightGame.exe",
            type: "default",
            config: { oslist: "windows" },
            description: "Launch Dying Light",
          },
          1: {
            executable: "DevTools/DyingLightPlayer.exe",
            type: "option1",
            config: { oslist: "windows" },
            description: "Dying Light Custom Game",
          },
          2: {
            executable: "SDK/bin_x64/Exodus_SDK.exe",
            type: "editor",
            config: { oslist: "windows" },
            description: "Launch Exodus SDK",
          },
          3: {
            executable: "bin\\profile\\stingray_win64_profile.exe",
            type: "option2",
            config: { oslist: "windows" },
            description: "stingray_win64_profile.exe !THIS PRODUCES A LOT OF DATA!",
          },
        },
      },
    }),
    ["DyingLightGame.exe"],
  );
});

test("appinfo enrichment falls back to branch entries when no public launch exists", () => {
  assert.deepEqual(
    gameExesFromAppinfo({
      config: {
        launch: {
          0: {
            executable: "Game-Win64-Shipping.exe",
            config: { oslist: "windows", betakey: "preview" },
            description: "Play Game",
          },
          1: {
            executable: "Game-Win64-Test.exe",
            config: { oslist: "windows", betakey: "preview" },
            description: "Play Game Test",
          },
        },
      },
    }),
    ["Game-Win64-Shipping.exe"],
  );
});

test("exe-name policy does not blanket-ban Shipping or Release game builds", () => {
  assert.equal(isLikelyGameExeName("OakGame-Win64-Shipping.exe"), true);
  assert.equal(isLikelyGameExeName("forza_x64_release_final.exe"), true);
  assert.equal(isLikelyGameExeName("DevilMayCry5.exe"), true);
  assert.equal(isLikelyGameExeName("GameLauncher.exe"), false);
  assert.equal(isLikelyGameExeName("GameDev.exe"), false);
});

test("exe-name policy rejects overly generic executable names", () => {
  assert.equal(isLikelyGameExeName("game.exe"), false);
  assert.equal(isLikelyGameExeName("startup.exe"), false);
  assert.equal(isLikelyGameExeName("AssassinsCreed_Game.exe"), true);
});
