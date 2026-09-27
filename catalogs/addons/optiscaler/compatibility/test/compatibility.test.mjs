import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildCompatibilityCatalog } from "../lib/build-catalog.mjs";
import { parseOptiScalerWiki } from "../lib/parse-wiki.mjs";
import { auditCompatibilityReview } from "../lib/reconcile-wiki.mjs";
import {
  assertJsonSchema,
  compileJsonSchema,
} from "../../../../../scripts/lib/json-schema-validation.mjs";
import { createMatchRegistry } from "../../../../../scripts/lib/match-registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const EXPECTED_PUBLISHED_ENTRY_COUNT = 690;
const CURRENT_WIKI_SNAPSHOT = {
  revision: "2026-09-25",
  sha256: "3d45f35a349fbdb69e45b3000009f97acf11068cc752336c77716a276c44a6d6",
  rows: 706,
};
const SHIFTED_MAIN_SOURCE_KEYS = Array.from(
  { length: 175 },
  (_, index) => `main:${String(490 + index).padStart(4, "0")}`,
);
const EXPECTED_REFRAMEWORK_FAMILY = [
  {
    id: "onimusha-way-of-the-sword",
    sourceKey: "main:0396",
    inputs: ["dlss2_plus", "fsr2_plus"],
    steamAppId: "2638890",
    messageId: "optiscaler-onimusha-way-of-the-sword-reframework",
    fallbackText: "REFramework is required for this game to work.",
  },
  {
    id: "resident-evil-2-remake",
    sourceKey: "upscaler_mods:0011",
    inputs: ["dlss2_plus", "xess"],
    steamAppId: "883710",
    messageId: "optiscaler-resident-evil-2-remake-reframework-upscalerbase-plugin",
    fallbackText:
      "REFramework (pd-upscaler branch) and PureDark's UpscalerBasePlugin version 1.1.2 are required for this game to work.",
  },
  {
    id: "resident-evil-3-remake",
    sourceKey: "upscaler_mods:0012",
    inputs: ["dlss2_plus", "xess"],
    steamAppId: "952060",
    messageId: "optiscaler-resident-evil-3-remake-reframework-upscalerbase-plugin",
    fallbackText:
      "REFramework (pd-upscaler branch) and PureDark's UpscalerBasePlugin version 1.1.2 are required for this game to work.",
  },
  {
    id: "resident-evil-4-remake",
    sourceKey: "upscaler_mods:0013",
    inputs: ["dlss2_plus", "xess"],
    steamAppId: "2050650",
    messageId: "optiscaler-resident-evil-4-remake-reframework-upscalerbase-plugin",
    fallbackText:
      "REFramework (pd-upscaler branch) and PureDark's UpscalerBasePlugin version 1.1.2 are required for this game to work.",
  },
  {
    id: "resident-evil-7",
    sourceKey: "upscaler_mods:0014",
    inputs: ["dlss2_plus", "xess"],
    steamAppId: "418370",
    messageId: "optiscaler-resident-evil-7-reframework-upscalerbase-plugin",
    fallbackText:
      "REFramework (pd-upscaler branch) and PureDark's UpscalerBasePlugin version 1.1.2 are required for this game to work.",
  },
  {
    id: "resident-evil-requiem",
    sourceKey: "main:0446",
    inputs: ["dlss2_plus", "fsr2_plus"],
    steamAppId: "3764200",
    messageId: "optiscaler-resident-evil-requiem-reframework",
    fallbackText: "REFramework is required for this game to work.",
  },
];
const EXPECTED_EXTERNAL_MOD_GUIDANCE_FAMILY = [
  {
    id: "assassins-creed-origins",
    sourceKey: "upscaler_mods:0001",
    messageId: "optiscaler-assassins-creed-origins-dlss-mod",
    fallbackText:
      "A third-party DLSS mod is required for this game to work with OptiScaler.",
  },
  {
    id: "devil-may-cry-5",
    sourceKey: "upscaler_mods:0002",
    messageId: "optiscaler-devil-may-cry-5-reframework-pdperfplugin",
    fallbackText:
      "REFramework (pd-upscaler branch) and PDPerfPlugin are required for this game to work.",
  },
  {
    id: "elden-ring",
    sourceKey: "upscaler_mods:0004",
    messageId: "optiscaler-elden-ring-erss-fg-mod",
    fallbackText:
      "The ERSS-FG mod is required as a basis for upscaling and Frame Generation.",
  },
  {
    id: "sekiro-shadows-die-twice",
    sourceKey: "upscaler_mods:0016",
    messageId: "optiscaler-sekiro-shadows-die-twice-sekirotsr-mod",
    fallbackText: "The SekiroTSR mod is required as a basis for DLSS inputs.",
  },
  {
    id: "ghost-recon-wildlands",
    sourceKey: "upscaler_mods:0017",
    messageId: "optiscaler-ghost-recon-wildlands-dlss-mod",
    fallbackText:
      "A third-party DLSS mod is required for this game to work with OptiScaler.",
  },
  {
    id: "total-war-warhammer-3",
    sourceKey: "upscaler_mods:0018",
    messageId: "optiscaler-total-war-warhammer-3-warhammer3dlss-mod",
    fallbackText:
      "The Warhammer3DLSS mod is required for this game to work with OptiScaler.",
  },
];
const GENERIC_PENDING_IDENTITY_REASON = "An exact runtime identity has not been curated.";
const EXPECTED_PENDING_IDENTITY_REASONS = {
  "main:0013":
    "The Epic launcher AppName is not verified; CatalogItemId alone is not a reachable runtime identity.",
  "main:0014": "No verified exact Epic Games Store identity is available.",
  "main:0190": "This is a mod distribution, not a game runtime target identity.",
  "main:0316":
    "Multiple distinct official Steam apps and demos share this title, so no exact identity can be selected.",
  "main:0363": "The UWP/Windows edition has no supported exact identity binding.",
  "main:0365": "No supported exact runtime or store identity is available.",
  "main:0415":
    "An Epic-only candidate exists, but no verified exact Epic Games Store identity is available.",
  "main:0459":
    "Store results are different products and do not establish an exact title binding.",
  "main:0464": "The upstream source deliberately provides no bindable identity.",
  "main:0479": "No exact verifiable store identity is available.",
  "main:0489":
    "Unreleased game; no verified runtime executable or match target is available.",
  "main:0541":
    "An Epic candidate exists, but no verified exact Epic Games Store identity is available.",
  "main:0583":
    "The prior Steam AppID 3763780 is no longer a current app; other Rift results are distinct games.",
  "main:0605": "No verified exact match target or executable observation is available.",
};
const EXPECTED_REAUDITED_BINDINGS = {
  "main:0029": {
    entryId: "armatus-demo",
    targetId: "armatus",
    identity: { kind: "steam_appid", value: "3660710" },
  },
  "main:0154": {
    entryId: "diablo-ii-resurrected",
    targetId: "diablo-ii-resurrected",
    identity: { kind: "steam_appid", value: "2536520" },
  },
  "main:0195": {
    entryId: "everwind-demo",
    targetId: "everwind",
    identity: { kind: "steam_appid", value: "2253100" },
  },
  "main:0390": {
    entryId: "norse-oath-of-blood-demo",
    targetId: "norse-oath-of-blood",
    identity: { kind: "steam_appid", value: "3054690" },
  },
  "main:0397": {
    entryId: "online-404-demo",
    targetId: "online-404",
    identity: { kind: "steam_appid", value: "4094350" },
  },
  "main:0428": {
    entryId: "protocol-terminate-demo",
    targetId: "protocol-terminate",
    identity: { kind: "steam_appid", value: "3710560" },
  },
  "main:0527": {
    entryId: "stygian-outer-gods",
    targetId: "stygian-outer-gods",
    identity: { kind: "steam_appid", value: "2581410" },
  },
  "main:0569": {
    entryId: "the-last-oricru",
    targetId: "the-last-oricru",
    identity: { kind: "steam_appid", value: "1663640" },
  },
  "main:0578": {
    entryId: "the-other-side",
    targetId: "the-other-side",
    identity: { kind: "steam_appid", value: "2764750" },
  },
  "main:0612": {
    entryId: "undertaker",
    targetId: "undertaker",
    identity: { kind: "steam_appid", value: "4030360" },
  },
  "main:0651": {
    entryId: "wonder-ball",
    targetId: "wonder-ball",
    identity: { kind: "steam_appid", value: "2640030" },
  },
};
const EXPECTED_LAUNCH_POLICIES = {
  "psychonauts-2": ["-dx11", "required"],
  "redout-enhanced-edition": ["-dx11", "required"],
  "bright-memory-infinite": ["-dx12", "required"],
  chernobylite: ["-dx12", "required"],
  "clash-artifacts-of-chaos": ["-dx12", "required"],
  "enotria-the-last-song": ["-dx12", "required"],
  "evil-west": ["-dx12", "required"],
  ghostrunner: ["-dx12", "required"],
  "ghostrunner-2": ["-dx12", "required"],
  soulstice: ["-dx12", "required"],
  supraland: ["-dx12", "required"],
  "the-ascent": ["-dx12", "required"],
  trepang2: ["-dx12", "recommended"],
  "ad-infinitum": ["-dx12", "required"],
  "black-one-blood-brothers": ["-dx12", "required"],
  "bleak-faith-forsaken": ["-dx12", "required"],
  "alone-in-the-dark-2024": ["-dx12", "required"],
  bloodhound: ["-dx12", "required"],
  "bottle-pilgrim-redux": ["-dx12", "required"],
  "bright-memory": ["-dx12", "required"],
  "broken-pieces": ["-dx12", "required"],
  capes: ["-dx12", "required"],
  "car-dealer-simulator": ["-dx12", "required"],
  chionophile: ["-dx12", "required"],
  "cions-of-vega": ["-dx12", "required"],
  "dawn-break-demo": ["-dx12", "required"],
  deathbound: ["-dx12", "required"],
  "dream-cycle": ["-dx12", "required"],
  "echoes-of-yi-samsara": ["-dx12", "required"],
  "faraday-protocol": ["-dx12", "required"],
  "final-fantasy-vii-remake-intergrade": ["-dx11", "required"],
  "fobia-st-dinfna-hotel": ["-dx12", "required"],
  "forgive-me-father-2": ["-dx12", "required"],
  "gangs-of-sherwood": ["-dx12", "required"],
  "ikonei-island-an-earthlock-adventure": ["-dx12", "required"],
  "land-of-the-vikings": ["-dx12", "required"],
  "last-train-home": ["-dx12", "required"],
  "lunacy-saint-rhodes": ["-dx12", "required"],
  "mechwarrior-5-mercenaries": ["-dx12", "required"],
  "mr-photographer-into-the-light": ["-dx11", "required"],
  "outcast-a-new-beginning": ["-dx12", "required"],
  "paradise-killer": ["-dx12", "required"],
  "twin-stones-the-journey-of-bukka": ["-dx12", "required"],
  voin: ["-dx12", "required"],
  "of-ash-and-steel-demo": ["-dx12", "required"],
  romancelvania: ["-dx12", "required"],
  "sands-of-aura": ["-dx12", "required"],
  scathe: ["-dx12", "required"],
  "season-a-letter-to-the-future": ["-dx12", "required"],
  "shadow-warrior-3": ["-dx12", "required"],
  sprawl: ["-dx12", "required"],
  "testament-the-order-of-high-human": ["-dx12", "required"],
  "scp-secret-files": ["-dx12", "required"],
  "tainted-grail-the-fall-of-avalon": ["-force-d3d12", "recommended"],
  "glaciered-demo": ["-force-d3d12", "required"],
  "jump-space": ["-force-d3d12", "required"],
  "project-station-demo": ["-force-d3d12", "required"],
};
const TEXT_ONLY_LAUNCH_WARNING_IDS = new Set([
  "car-mechanic-simulator-2026-single-player-demo",
  "tormented-souls-2",
  "oddroom",
  "the-orville-interactive-fan-experience",
  "system-shock-remake",
]);
const NO_ACTION_LAUNCH_NOTE_IDS = new Set(["assetto-corsa-competizione"]);
const EXPECTED_RETAINED_LAUNCH_MESSAGES = {
  "car-mechanic-simulator-2026-single-player-demo": [
    "optiscaler-car-mechanic-simulator-2026-single-player-demo-fsr3-mode",
    "FSR 3 mode is unavailable.",
  ],
  "evil-west": [
    "optiscaler-evil-west-dx12",
    "DirectX 11 can have lower performance and severe shimmer.",
  ],
  "ghostrunner-2": [
    "optiscaler-ghostrunner-2-dx12-performance",
    "For better performance, prefer FSR or XeSS mode, or use OptiPatcher.",
  ],
  trepang2: [
    "optiscaler-trepang2-dx12-preset",
    "At launch, the game can reset the selected preset to Performance. Check the preset in the OptiScaler overlay. If this happens, select another preset, then select the desired one again.",
  ],
  "tormented-souls-2": [
    "optiscaler-tormented-souls-2-dx11",
    "Use the default DirectX 11 mode. Forcing DirectX 12 with -dx12 crashes at startup.",
  ],
  "alone-in-the-dark-2024": [
    "optiscaler-alone-in-the-dark-2024-dx12-dlss",
    "In the game settings, change the DLSS mode and apply the change.",
  ],
  "bright-memory": [
    "optiscaler-bright-memory-dx12-ray-tracing",
    "To use a DLSS input, enable ray tracing and NVIDIA spoofing.",
  ],
  chionophile: ["optiscaler-chionophile-dx12", "DirectX 11 can shimmer."],
  "cions-of-vega": ["optiscaler-cions-of-vega-dx12", "DirectX 11 can shimmer."],
  "dawn-break-demo": [
    "optiscaler-dawn-break-demo-dx12-motion-blur-color-space",
    "Disable motion blur. With FSR 4, select Non-Linear PQ Input to prevent flicker.",
  ],
  "forgive-me-father-2": [
    "optiscaler-forgive-me-father-2-dx12-fsr4",
    "With FSR 4, select Non-Linear sRGB Input if the screen flickers.",
  ],
  "land-of-the-vikings": [
    "optiscaler-land-of-the-vikings-dx12-model-5",
    "Use Model 5 to reduce shimmer on trees.",
  ],
  "mr-photographer-into-the-light": [
    "optiscaler-mr-photographer-dx11",
    "XeSS input is unavailable in DirectX 11 mode.",
  ],
  oddroom: [
    "optiscaler-oddroom-dx12",
    "If the DLSS input does not work, launch the game with -dx12.",
  ],
  "the-orville-interactive-fan-experience": [
    "optiscaler-the-orville-interactive-fan-experience-dx12-launch-option",
    "Run the game in DirectX 12 mode.",
  ],
  romancelvania: ["optiscaler-romancelvania-dx12", "DirectX 11 has lower performance."],
  scathe: ["optiscaler-scathe-dx12-fsr-input", "FSR mode can crash the game."],
  "shadow-warrior-3": [
    "optiscaler-shadow-warrior-3-dx12",
    "DirectX 11 has lower performance and severe shimmer.",
  ],
  "system-shock-remake": [
    "optiscaler-system-shock-remake-dx11",
    "Keep the default DirectX 11 mode. Forcing DirectX 12 with -dx12 can cause random crashes in specific areas.",
  ],
  "scp-secret-files": [
    "optiscaler-scp-secret-files-dx12",
    "Do not select an FSR 2 input; it can crash. DirectX 11 has lower performance and severe shimmer.",
  ],
  "tainted-grail-the-fall-of-avalon": [
    "optiscaler-tainted-grail-dx12-skybox",
    "With FSR 4, select Non-Linear PQ Input if you encounter rare skybox issues.",
  ],
  "project-station-demo": [
    "optiscaler-project-station-demo-dx12",
    "FSR 3 input and XeSS Frame Generation output are unavailable. Do not enable Allow Async with FSR Frame Generation; it can crash the game.",
  ],
};

const EXPECTED_RUSSIAN_TECHNICAL_TERMS = {
  "optiscaler-automate-it-fsr-detection":
    "Один раз измените внутриигровую настройку FSR, чтобы OptiScaler смог перехватить режим FSR.",
  "optiscaler-cyberpunk-fsr4-input":
    "Режим FSR 4 можно использовать с OptiScaler на любой видеокарте.",
  "optiscaler-ghostrunner-2-dx12-performance":
    "Для лучшей производительности выберите режим FSR или XeSS либо используйте OptiPatcher.",
  "optiscaler-tainted-grail-dx12-skybox":
    "Если при FSR 4 возникают редкие проблемы с небом, выберите входное цветовое пространство Non-Linear PQ.",
  "optiscaler-bright-memory-dx12-ray-tracing":
    "Чтобы использовать режим DLSS, включите трассировку лучей и спуфинг NVIDIA.",
  "optiscaler-dawn-break-demo-dx12-motion-blur-color-space":
    "Отключите размытие в движении. При FSR 4 выберите входное цветовое пространство Non-Linear PQ, чтобы избежать мерцания.",
  "optiscaler-dream-eaters-fsr4-color-space":
    "При использовании FSR 4 в режиме DLSS выберите входное цветовое пространство Non-Linear.",
  "optiscaler-forgive-me-father-2-dx12-fsr4":
    "Если при FSR 4 экран мерцает, выберите входное цветовое пространство Non-Linear sRGB.",
  "optiscaler-flipscapes-input-detection":
    "Измените внутриигровую настройку FSR, чтобы OptiScaler перехватил режим FSR 3.1. При выборе режима DLSS перезапустите игру после изменения настройки.",
  "optiscaler-funko-fusion-fsr4-color-space":
    "Используйте режим FSR. Если FSR 4 мерцает с пресетом Balanced, выберите входное цветовое пространство Non-Linear sRGB.",
  "optiscaler-lunar-eclipse-frame-generation":
    "Не используйте генерацию кадров FSR. При использовании FSR 4 в режиме DLSS выберите входное цветовое пространство Non-Linear.",
  "optiscaler-mr-photographer-dx11": "В DirectX 11 режим XeSS недоступен.",
  "optiscaler-oddroom-dx12":
    "Если режим DLSS не работает, запустите игру с параметром -dx12.",
  "optiscaler-pax-autocratica-prologue-dlss-input":
    "Используйте режим DLSS: режим FSR недоступен.",
  "optiscaler-planet-coaster-2-dlss-input":
    "Используйте режим DLSS: режим FSR 3 недоступен.",
  "optiscaler-project-station-demo-dx12":
    "Режим FSR 3 и режим генерации кадров XeSS недоступны. Не включайте Allow Async вместе с генерацией кадров FSR: игра может завершиться сбоем.",
  "optiscaler-quarantine-zone-the-last-check-fsr4-input-color-space":
    "Для FSR 4 выберите входное цветовое пространство Non-Linear, чтобы избежать артефактов на небе.",
  "optiscaler-robocop-rogue-city-unfinished-business-fsr4-balanced-flicker":
    "При FSR 4 режим DLSS Balanced может мерцать. Попробуйте другой пресет или режим. Входное цветовое пространство Non-Linear sRGB может помочь, но способно усилить гостинг.",
  "optiscaler-scathe-dx12-fsr-input": "Режим FSR может вызвать сбой игры.",
  "optiscaler-scp-secret-files-dx12":
    "Не выбирайте режим FSR 2: он может вызвать сбой. В DirectX 11 ниже производительность и заметно сильное мерцание.",
  "optiscaler-terratech-legion-fsr4-non-linear-color-space":
    "Режим FSR 3.1 недоступен. Для FSR 4 выберите входное цветовое пространство Non-Linear, чтобы избежать чёрного экрана и артефактов DLSS.",
  "optiscaler-car-mechanic-simulator-2026-single-player-demo-fsr3-mode":
    "Режим FSR 3 недоступен.",
};

async function readJson(...parts) {
  return JSON.parse(await readFile(path.join(ROOT, ...parts), "utf8"));
}

async function fixture() {
  const [snapshot, ledger, curatedGames, messages, releaseSource, registrySource] =
    await Promise.all([
      readJson(
        "catalogs",
        "addons",
        "optiscaler",
        "compatibility",
        "upstream-snapshot.json",
      ),
      readJson("catalogs", "addons", "optiscaler", "compatibility", "review-ledger.json"),
      readJson("catalogs", "addons", "optiscaler", "compatibility", "curated-games.json"),
      readJson("catalogs", "addons", "optiscaler", "compatibility", "messages.json"),
      readJson("catalogs", "addons", "optiscaler", "manifest-source.json"),
      readJson("catalogs", "games", "match-registry.json"),
    ]);
  return {
    snapshot,
    ledger,
    curatedGames,
    messages,
    releaseSource,
    registry: createMatchRegistry(registrySource),
  };
}

test("wiki parser preserves main, upscaler mods, and Luma rows and fingerprints duplicate upstream rows", () => {
  const markdown = `## Main
| Game | Compatibility | Upscaler <br>Inputs | OptiPatcher <br>Support | Notes | Images |
| --- | --- | --- | --- | --- | --- |
| [Example](example) | ✅ | DLSS, FSR2 | ✨ | Use \`dxgi.dll\` | |
| Example | ✅ | DLSS | | | |
## Upscaler mods support
| Game | Compatibility | Upscaler <br>Inputs | Notes | Images |
| --- | --- | --- | --- | --- |
| [Modded Game](modded) | ✅ | DLSS | Requires mod | |
## Luma Unreal Engine
| Game | Compatibility | Upscaler <br>Inputs | Notes | Images |
| --- | --- | --- | --- | --- |
| [UE Example](ue) | ✅ | DLSS | Install Luma first | |`;
  const rows = parseOptiScalerWiki(markdown);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].declared_inputs, ["dlss2_plus", "fsr2_plus"]);
  assert.equal(rows[1].duplicate_of, "main:0001");
  assert.equal(rows[2].section, "upscaler_mods");
  assert.equal(rows[2].source_key, "upscaler_mods:0001");
  assert.equal(rows[3].section, "luma_unreal");
  assert.equal(rows[3].source_key, "luma_unreal:0001");
  assert.ok(rows[0].note_fingerprint);
  assert.ok(rows[2].note_fingerprint);
});

test("runtime projection is title-free and has an exact message-contract bijection", async () => {
  const inputs = await fixture();
  const { catalog, messageContract } = buildCompatibilityCatalog(inputs);
  const guidance = catalog.entries.flatMap((entry) =>
    entry.guidance.map((item) => item.message.id),
  );
  assert.deepEqual(
    [...new Set(guidance)].sort(),
    messageContract.messages.map((message) => message.id).sort(),
  );
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes("STAR WARS Jedi: Survivor"), false);
  assert.equal(serialized.includes("Fullscreen Windowed mode. May need"), false);
  assert.equal(serialized.includes("source_ref"), false);
  for (const forbidden of [".dll", ".ini"]) {
    assert.equal(
      messageContract.messages.some((message) =>
        message.fallback_text.toLocaleLowerCase("en-US").includes(forbidden),
      ),
      false,
      `guidance must not expose a technical directive (${forbidden})`,
    );
  }
  for (const row of inputs.snapshot.rows) {
    assert.equal(
      serialized.includes(JSON.stringify(row.title)),
      false,
      `runtime leaked upstream title ${row.source_key}`,
    );
    if (row.note) {
      assert.equal(
        serialized.includes(JSON.stringify(row.note)),
        false,
        `runtime leaked upstream note ${row.source_key}`,
      );
    }
  }
});

test("authoring fails closed on fuzzy identities, collisions, variants, and locale drift", async () => {
  const unknownTarget = await fixture();
  unknownTarget.curatedGames.entries[0].game_target_id = "missing-target";
  assert.throws(() => buildCompatibilityCatalog(unknownTarget), /unknown target/u);

  const collision = await fixture();
  const pendingRow = collision.ledger.rows.find(
    (row) => row.disposition.kind === "pending_identity",
  );
  assert.ok(pendingRow, "fixture must retain a pending upstream row");
  collision.curatedGames.entries.push({
    ...structuredClone(collision.curatedGames.entries[0]),
    id: "duplicate-identity",
    source_ref: pendingRow.source_key,
  });
  pendingRow.disposition = {
    kind: "published",
    entry_id: "duplicate-identity",
  };
  assert.throws(
    () => buildCompatibilityCatalog(collision),
    /duplicate compatibility identity/u,
  );

  const overlap = await fixture();
  overlap.curatedGames.entries[0].variants.push({
    when: { launcher: "steam" },
    proxy: { kind: "automatic" },
    ini_overrides: [],
    restricted_modules: [],
    optipatcher: "supported",
    prerequisite: "none",
  });
  overlap.curatedGames.entries[0].variants.push({
    when: { launcher: "steam", executable: "SwGame-Win64-Shipping.exe" },
    proxy: { kind: "automatic" },
    ini_overrides: [],
    restricted_modules: [],
    optipatcher: "supported",
    prerequisite: "none",
  });
  assert.throws(
    () => buildCompatibilityCatalog(overlap),
    /overlapping conditional policies/u,
  );

  const locale = await fixture();
  delete locale.messages.messages[0].translations.ru;
  assert.throws(() => buildCompatibilityCatalog(locale), /exact locale coverage/u);

  const providerDerivedId = await fixture();
  providerDerivedId.curatedGames.entries[0].id = "steam-1086940-baldurs-gate-3";
  providerDerivedId.ledger.rows.find(
    (row) => row.source_key === providerDerivedId.curatedGames.entries[0].source_ref,
  ).disposition.entry_id = "steam-1086940-baldurs-gate-3";
  assert.throws(
    () => buildCompatibilityCatalog(providerDerivedId),
    /source-neutral game or edition slug/u,
  );

  const unsafeLaunch = await fixture();
  unsafeLaunch.curatedGames.entries[0].variants[0].launch = {
    arguments: ["-dx12;unsafe"],
    requirement: "required",
  };
  assert.throws(() => buildCompatibilityCatalog(unsafeLaunch), /safe launch token/u);

  const repeatedLaunch = await fixture();
  repeatedLaunch.curatedGames.entries[0].variants[0].launch = {
    arguments: ["-dx12", "-dx12"],
    requirement: "required",
  };
  assert.throws(
    () => buildCompatibilityCatalog(repeatedLaunch),
    /launch\.arguments has duplicates/u,
  );
});

test("reviewed launch notes project only typed policy or bounded text", async () => {
  const inputs = await fixture();
  const { catalog, messageContract } = buildCompatibilityCatalog(inputs);
  const authoredById = new Map(
    inputs.curatedGames.entries.map((entry) => [entry.id, entry]),
  );
  const runtimeById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const ledgerBySource = new Map(inputs.ledger.rows.map((row) => [row.source_key, row]));
  const messagesById = new Map(
    inputs.messages.messages.map((message) => [message.id, message]),
  );

  assert.equal(Object.keys(EXPECTED_LAUNCH_POLICIES).length, 57);
  for (const [entryId, [argument, requirement]] of Object.entries(
    EXPECTED_LAUNCH_POLICIES,
  )) {
    const authored = authoredById.get(entryId);
    const runtime = runtimeById.get(entryId);
    assert.deepEqual(authored?.variants[0]?.launch, { arguments: [argument], requirement });
    assert.deepEqual(runtime?.variants[0]?.launch, { arguments: [argument], requirement });
    const note = ledgerBySource.get(authored?.source_ref)?.notes?.[0]?.disposition;
    assert.equal(note?.kind, "typed_policy", `${entryId} must retain typed provenance`);
    assert.match(note?.reason ?? "", /typed launch policy/u);
  }

  for (const entryId of TEXT_ONLY_LAUNCH_WARNING_IDS) {
    const entry = authoredById.get(entryId);
    assert.equal(entry?.variants[0]?.launch, undefined);
    assert.equal(entry?.guidance.length, 1);
    assert.equal(
      ledgerBySource.get(entry?.source_ref)?.notes?.[0]?.disposition?.kind,
      "guidance",
    );
  }
  for (const entryId of NO_ACTION_LAUNCH_NOTE_IDS) {
    const entry = authoredById.get(entryId);
    assert.equal(entry?.variants[0]?.launch, undefined);
    assert.deepEqual(entry?.guidance, []);
    assert.equal(
      ledgerBySource.get(entry?.source_ref)?.notes?.[0]?.disposition?.kind,
      "omitted",
    );
  }

  assert.equal(Object.keys(EXPECTED_RETAINED_LAUNCH_MESSAGES).length, 22);
  for (const [entryId, [messageId, fallbackText]] of Object.entries(
    EXPECTED_RETAINED_LAUNCH_MESSAGES,
  )) {
    const entry = authoredById.get(entryId);
    assert.deepEqual(
      entry?.guidance.map((guidance) => guidance.message_id),
      [messageId],
    );
    assert.equal(messagesById.get(messageId)?.fallback_text, fallbackText);
  }

  for (const message of messageContract.messages) {
    assert.equal(
      /^(?:Start|Use|Launch) the game with (?:the )?-(?:dx11|dx12|force-d3d12)\b/iu.test(
        message.fallback_text,
      ),
      false,
      `raw unconditional command remained in ${message.id}`,
    );
  }
});

test("Russian compatibility guidance names technology modes and input color spaces precisely", async () => {
  const inputs = await fixture();
  const messagesById = new Map(
    inputs.messages.messages.map((message) => [message.id, message]),
  );

  for (const [messageId, expected] of Object.entries(EXPECTED_RUSSIAN_TECHNICAL_TERMS)) {
    assert.equal(messagesById.get(messageId)?.translations.ru, expected, messageId);
  }

  for (const message of inputs.messages.messages) {
    const russian = message.translations.ru;
    assert.doesNotMatch(
      russian,
      /(?:вход(?:а|ом|е|ной)?\s+(?:DLSS|FSR|XeSS)|(?:DLSS|FSR|XeSS)\s+вход|входной режим)/iu,
      `${message.id} must name DLSS, FSR, and XeSS as modes`,
    );
  }

  const isInputColorSpaceMessage = (message) =>
    /(?:Non-Linear|(?:sRGB|PQ) Input|input color space)/iu.test(message.fallback_text);
  const isTechnologyInputMessage = (message) =>
    /(?:(?:DLSS|FSR|XeSS)[^.!?]{0,48}input|input[^.!?]{0,48}(?:DLSS|FSR|XeSS))/iu.test(
      message.fallback_text,
    );

  const inputColorSpaceMessages = inputs.messages.messages.filter(isInputColorSpaceMessage);
  assert.equal(inputColorSpaceMessages.length, 33);
  for (const message of inputColorSpaceMessages) {
    assert.match(
      message.translations.ru,
      /входное цветовое пространство/iu,
      `${message.id} must identify the selected color space as an input color space`,
    );
  }

  const technologyModeMessages = inputs.messages.messages.filter(
    (message) => isTechnologyInputMessage(message) && !isInputColorSpaceMessage(message),
  );
  assert.equal(technologyModeMessages.length, 39);
  for (const message of technologyModeMessages) {
    assert.match(
      message.translations.ru,
      /режим/iu,
      `${message.id} must name the selected DLSS, FSR, or XeSS technology as a mode`,
    );
  }
});

test("frame-generation guidance uses the localized term in every published locale", async () => {
  const inputs = await fixture();
  const localizedTerms = {
    de: /Frame-Erstellung/u,
    es: /generación de fotogramas/iu,
    fr: /génération d’images/iu,
    ja: /フレーム生成/u,
    "pt-BR": /geração de quadros/iu,
    ru: /генерац(?:ия|ии|ию) кадров/iu,
    "zh-Hans": /帧生成/u,
    "zh-Hant": /畫格生成/u,
  };
  const frameGenerationMessages = inputs.messages.messages.filter((message) =>
    /frame generation/iu.test(message.fallback_text),
  );

  assert.equal(frameGenerationMessages.length, 11);
  for (const message of frameGenerationMessages) {
    for (const [locale, term] of Object.entries(localizedTerms)) {
      const translation = message.translations[locale];
      assert.doesNotMatch(
        translation,
        /frame generation/iu,
        `${message.id}: ${locale} must not leak the English term`,
      );
      assert.match(
        translation,
        term,
        `${message.id}: ${locale} must use the localized frame-generation term`,
      );
    }
  }
});

test("reviewed game-setting literals and quality warnings preserve their exact meaning", async () => {
  const inputs = await fixture();
  const messagesById = new Map(
    inputs.messages.messages.map((message) => [message.id, message]),
  );
  const cityGlowIds = [
    "optiscaler-gta-san-andreas-definitive-city-glow",
    "optiscaler-gta-vice-city-definitive-city-glow",
    "optiscaler-gta-iii-definitive-city-glow",
  ];
  const cityGlowLiteralByLocale = {
    de: "Stadtbeleuchtungseffekt",
    es: "City Glow Effect",
    fr: "City Glow Effect",
    ja: "City Glow Effect",
    "pt-BR": "City Glow Effect",
    ru: "Эффект свечения города",
    "zh-Hans": "City Glow Effect",
    "zh-Hant": "City Glow Effect",
  };

  for (const messageId of cityGlowIds) {
    const message = messagesById.get(messageId);
    assert.equal(message?.fallback_text, "Disable City Glow Effect in the game settings.");
    for (const [locale, literal] of Object.entries(cityGlowLiteralByLocale)) {
      assert.equal(message?.translations[locale].includes(literal), true, messageId);
    }
    assert.equal(
      message?.translations.ru,
      "Отключите параметр «Эффект свечения города» в настройках игры.",
    );
  }

  assert.equal(
    messagesById.get("optiscaler-shatterline-dx11-upscaler-quality")?.translations.ja,
    "DX11 では、アップスケーラーの画質がネイティブより低下する場合があります。",
  );
});

test("authoring delegates every published identity to one central target", async () => {
  const inputs = await fixture();
  assert.doesNotThrow(() => buildCompatibilityCatalog(inputs));
  assert.equal(
    inputs.curatedGames.entries.every(
      (entry) => typeof entry.game_target_id === "string" && !("identity_refs" in entry),
    ),
    true,
  );
});

test("every OptiScaler entry preserves its authored default proxy policy", async () => {
  const inputs = await fixture();
  const { catalog } = buildCompatibilityCatalog(inputs);
  assert.equal(inputs.curatedGames.entries.length, EXPECTED_PUBLISHED_ENTRY_COUNT);
  assert.equal(catalog.entries.length, EXPECTED_PUBLISHED_ENTRY_COUNT);

  const emittedById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  for (const authored of inputs.curatedGames.entries) {
    const authoredDefaults = authored.variants.filter(
      (variant) => variant.when === undefined,
    );
    assert.equal(
      authoredDefaults.length,
      1,
      `${authored.id} must have one authored default`,
    );
    const emitted = emittedById.get(authored.id);
    assert.deepEqual(
      emitted?.variants.find((variant) => variant.when === undefined),
      authoredDefaults[0],
      `${authored.id} default proxy policy changed during projection`,
    );
  }
});

test("Guardians of the Galaxy projects its exact source-bound Spoofing override", async () => {
  const inputs = await fixture();
  const authored = inputs.curatedGames.entries.find(
    (entry) => entry.source_ref === "main:0258",
  );
  assert.ok(authored, "Guardians source entry must remain authored");
  assert.deepEqual(authored.declared_inputs, ["dlss2_plus"]);

  const expectedOverride = {
    section: "Spoofing",
    key: "Dxgi",
    value: "false",
  };
  const authoredDefaults = authored.variants.filter(
    (variant) => variant.when === undefined,
  );
  assert.equal(authoredDefaults.length, 1);
  assert.deepEqual(authoredDefaults[0].ini_overrides, [expectedOverride]);

  const { catalog } = buildCompatibilityCatalog(inputs);
  const runtime = catalog.entries.find((entry) => entry.id === authored.id);
  assert.ok(runtime, "Guardians entry must be present in runtime output");
  const runtimeDefaults = runtime.variants.filter((variant) => variant.when === undefined);
  assert.equal(runtimeDefaults.length, 1);
  assert.deepEqual(runtimeDefaults[0].ini_overrides, [expectedOverride]);
});

test("variant launcher conditions cover every Windows MatchFacts launcher only", async () => {
  const [authoringSchema, runtimeSchema] = await Promise.all([
    readJson("catalogs", "addons", "optiscaler", "compatibility", "authoring.schema.json"),
    readJson("catalogs", "addons", "optiscaler", "compatibility", "runtime-v1.schema.json"),
  ]);
  const validateAuthoring = compileJsonSchema(authoringSchema);
  const validateRuntime = compileJsonSchema(runtimeSchema);
  const supported = [
    "steam",
    "epic",
    "gog",
    "ubisoft",
    "ea",
    "battle_net",
    "xbox",
    "manual",
  ];
  for (const launcher of supported) {
    const inputs = await fixture();
    inputs.curatedGames.entries[0].variants.push({
      when: { launcher },
      proxy: { kind: "automatic" },
      ini_overrides: [],
      restricted_modules: [],
      optipatcher: "supported",
      prerequisite: "none",
    });
    assert.doesNotThrow(() => buildCompatibilityCatalog(inputs), launcher);
    assert.doesNotThrow(() =>
      assertJsonSchema(inputs.curatedGames, validateAuthoring, "authoring"),
    );
    assert.doesNotThrow(() =>
      assertJsonSchema(
        buildCompatibilityCatalog(inputs).catalog,
        validateRuntime,
        "runtime catalog",
      ),
    );
  }

  for (const launcher of ["proton", "crossover", "whisky"]) {
    const inputs = await fixture();
    inputs.curatedGames.entries[0].variants.push({
      when: { launcher },
      proxy: { kind: "automatic" },
      ini_overrides: [],
      restricted_modules: [],
      optipatcher: "supported",
      prerequisite: "none",
    });
    assert.throws(() => buildCompatibilityCatalog(inputs), /launcher is invalid/u);
    assert.throws(
      () => assertJsonSchema(inputs.curatedGames, validateAuthoring, "authoring"),
      /failed JSON Schema validation/u,
    );
  }
});

test("ledger rejects source drift and every checked-in row is accounted for", async () => {
  const inputs = await fixture();
  const audit = auditCompatibilityReview(inputs);
  assert.ok(audit.publishedEntryIds.size > 0);
  assert.equal(audit.publishedEntryIds.size, inputs.curatedGames.entries.length);
  assert.equal(inputs.ledger.rows.length, inputs.snapshot.rows.length);
  inputs.ledger.rows.pop();
  assert.throws(
    () => auditCompatibilityReview(inputs),
    /missing row|removed or duplicate/u,
  );
});

test("current Wiki refresh preserves the verified ordinal rekey and exact Zero Company policy", async () => {
  const inputs = await fixture();
  const { catalog, messageContract } = buildCompatibilityCatalog(inputs);
  const snapshotBySource = new Map(
    inputs.snapshot.rows.map((row) => [row.source_key, row]),
  );
  const ledgerBySource = new Map(inputs.ledger.rows.map((row) => [row.source_key, row]));
  const entriesById = new Map(
    inputs.curatedGames.entries.map((entry) => [entry.id, entry]),
  );

  assert.equal(inputs.snapshot.snapshot_revision, CURRENT_WIKI_SNAPSHOT.revision);
  assert.equal(inputs.snapshot.snapshot_sha256, CURRENT_WIKI_SNAPSHOT.sha256);
  assert.equal(inputs.snapshot.rows.length, CURRENT_WIKI_SNAPSHOT.rows);
  assert.equal(inputs.ledger.snapshot_sha256, CURRENT_WIKI_SNAPSHOT.sha256);
  assert.equal(inputs.curatedGames.snapshot_sha256, CURRENT_WIKI_SNAPSHOT.sha256);

  const onimusha = snapshotBySource.get("main:0396");
  assert.equal(onimusha?.title, "Onimusha: Way of the Sword");
  assert.deepEqual(ledgerBySource.get("main:0396")?.disposition, {
    kind: "published",
    entry_id: "onimusha-way-of-the-sword",
  });
  assert.deepEqual(ledgerBySource.get("main:0396")?.notes?.[0]?.disposition, {
    kind: "guidance",
    message_ids: ["optiscaler-onimusha-way-of-the-sword-reframework"],
  });
  assert.equal(entriesById.has("onimusha-way-of-the-sword-demo"), false);
  assert.deepEqual(entriesById.get("onimusha-way-of-the-sword"), {
    id: "onimusha-way-of-the-sword",
    source_ref: "main:0396",
    status: "working",
    declared_inputs: ["dlss2_plus", "fsr2_plus"],
    guidance: [
      {
        kind: "compatibility",
        message_id: "optiscaler-onimusha-way-of-the-sword-reframework",
      },
    ],
    variants: [
      {
        proxy: { kind: "automatic" },
        ini_overrides: [],
        restricted_modules: [],
        optipatcher: "unspecified",
        prerequisite: "none",
      },
    ],
    game_target_id: "onimusha-way-of-the-sword",
  });
  assert.deepEqual(
    inputs.registry.targetsById
      .get("onimusha-way-of-the-sword")
      ?.rules.map(({ kind, value }) => ({ kind, value })),
    [{ kind: "steam_appid", value: "2638890" }],
  );

  assert.deepEqual(
    SHIFTED_MAIN_SOURCE_KEYS.map((sourceKey) => ledgerBySource.get(sourceKey)?.source_key),
    SHIFTED_MAIN_SOURCE_KEYS,
  );
  const stableShiftedPayloads = SHIFTED_MAIN_SOURCE_KEYS.map((sourceKey) => {
    const {
      source_key: _source_key,
      row_fingerprint: _row_fingerprint,
      note_fingerprint: _note_fingerprint,
      ...payload
    } = snapshotBySource.get(sourceKey);
    return JSON.stringify(payload);
  });
  assert.equal(
    new Set(stableShiftedPayloads).size,
    SHIFTED_MAIN_SOURCE_KEYS.length,
    "every rekeyed source row must retain one unique stable payload",
  );
  for (const sourceKey of SHIFTED_MAIN_SOURCE_KEYS) {
    assert.equal(
      ledgerBySource.get(sourceKey)?.row_fingerprint,
      snapshotBySource.get(sourceKey)?.row_fingerprint,
      `${sourceKey} must retain its exact post-rekey source binding`,
    );
  }
  assert.equal(snapshotBySource.get("main:0664")?.title, "Zouhri: The Cursed Blood Demo");

  const zero = entriesById.get("star-wars-zero-company");
  assert.deepEqual(zero, {
    id: "star-wars-zero-company",
    source_ref: "main:0517",
    status: "working",
    declared_inputs: ["dlss2_plus", "fsr2_plus", "xess"],
    guidance: [
      {
        kind: "compatibility",
        message_id: "optiscaler-star-wars-zero-company-vendor-options",
      },
    ],
    variants: [
      {
        proxy: { kind: "automatic" },
        ini_overrides: [],
        restricted_modules: [],
        optipatcher: "unspecified",
        prerequisite: "none",
      },
    ],
    game_target_id: "star-wars-zero-company",
  });
  assert.deepEqual(ledgerBySource.get("main:0517")?.disposition, {
    kind: "published",
    entry_id: "star-wars-zero-company",
  });
  assert.deepEqual(ledgerBySource.get("main:0517")?.notes?.[0]?.disposition, {
    kind: "guidance",
    message_ids: ["optiscaler-star-wars-zero-company-vendor-options"],
  });
  assert.deepEqual(
    inputs.registry.targetsById
      .get("star-wars-zero-company")
      ?.rules.map(({ id, kind, value, provenance }) => ({ id, kind, value, provenance })),
    [
      {
        id: "steam-2075800",
        kind: "steam_appid",
        value: "2075800",
        provenance: {
          source: "renodx-match-overlay",
          locator: "catalogs/addons/renodx/match_overlay.json#star-wars-zero-companytm",
        },
      },
    ],
  );
  assert.equal(
    JSON.stringify(inputs.registry.targetsById.get("star-wars-zero-company")).includes(
      "pending:renodx",
    ),
    false,
  );
  assert.deepEqual(
    catalog.entries.find((entry) => entry.id === "star-wars-zero-company")?.identities,
    [{ kind: "steam_appid", value: "2075800" }],
  );
  assert.deepEqual(
    messageContract.messages.find(
      (message) => message.id === "optiscaler-star-wars-zero-company-vendor-options",
    ),
    {
      id: "optiscaler-star-wars-zero-company-vendor-options",
      fallback_text: "Frame Generation and Low Latency options depend on the GPU vendor.",
      guidance_kind: "compatibility",
      context: "compatibility",
    },
  );
});

test("REFramework compatibility warnings preserve exact external requirements without installer authority", async () => {
  const inputs = await fixture();
  const { catalog, messageContract } = buildCompatibilityCatalog(inputs);
  const ledgerBySource = new Map(inputs.ledger.rows.map((row) => [row.source_key, row]));
  const entriesById = new Map(
    inputs.curatedGames.entries.map((entry) => [entry.id, entry]),
  );
  const messagesById = new Map(
    messageContract.messages.map((message) => [message.id, message]),
  );

  assert.equal(EXPECTED_REFRAMEWORK_FAMILY.length, 6);
  const reframeworkOnly = EXPECTED_REFRAMEWORK_FAMILY.filter(
    ({ fallbackText }) => fallbackText === "REFramework is required for this game to work.",
  ).map(({ id }) => id);
  const upscalerBasePlugin = EXPECTED_REFRAMEWORK_FAMILY.filter(({ fallbackText }) =>
    fallbackText.includes("UpscalerBasePlugin version 1.1.2"),
  ).map(({ id }) => id);
  assert.deepEqual(reframeworkOnly, ["onimusha-way-of-the-sword", "resident-evil-requiem"]);
  assert.deepEqual(upscalerBasePlugin, [
    "resident-evil-2-remake",
    "resident-evil-3-remake",
    "resident-evil-4-remake",
    "resident-evil-7",
  ]);
  for (const expected of EXPECTED_REFRAMEWORK_FAMILY) {
    const entry = entriesById.get(expected.id);
    assert.deepEqual(entry?.source_ref, expected.sourceKey);
    assert.deepEqual(entry?.status, "working");
    assert.deepEqual(entry?.declared_inputs, expected.inputs);
    assert.deepEqual(entry?.guidance, [
      { kind: "compatibility", message_id: expected.messageId },
    ]);
    assert.deepEqual(entry?.variants, [
      {
        proxy: { kind: "automatic" },
        ini_overrides: [],
        restricted_modules: [],
        optipatcher: "unspecified",
        prerequisite: "none",
      },
    ]);
    assert.deepEqual(ledgerBySource.get(expected.sourceKey)?.disposition, {
      kind: "published",
      entry_id: expected.id,
    });
    assert.deepEqual(ledgerBySource.get(expected.sourceKey)?.notes?.[0]?.disposition, {
      kind: "guidance",
      message_ids: [expected.messageId],
    });
    assert.deepEqual(messagesById.get(expected.messageId), {
      id: expected.messageId,
      fallback_text: expected.fallbackText,
      guidance_kind: "compatibility",
      context: "compatibility",
    });
    assert.deepEqual(
      inputs.registry.targetsById
        .get(expected.id)
        ?.rules.find((rule) => rule.kind === "steam_appid")?.value,
      expected.steamAppId,
    );
    assert.equal(
      catalog.entries.find((entry) => entry.id === expected.id) !== undefined,
      true,
    );
  }
});

test("upscaler mods external requirements preserve exact user guidance messages", async () => {
  const inputs = await fixture();
  const { catalog, messageContract } = buildCompatibilityCatalog(inputs);
  const ledgerBySource = new Map(inputs.ledger.rows.map((row) => [row.source_key, row]));
  const entriesById = new Map(
    inputs.curatedGames.entries.map((entry) => [entry.id, entry]),
  );
  const messagesById = new Map(
    messageContract.messages.map((message) => [message.id, message]),
  );

  assert.equal(EXPECTED_EXTERNAL_MOD_GUIDANCE_FAMILY.length, 6);
  for (const expected of EXPECTED_EXTERNAL_MOD_GUIDANCE_FAMILY) {
    const entry = entriesById.get(expected.id);
    assert.deepEqual(entry?.source_ref, expected.sourceKey);
    assert.deepEqual(entry?.status, "working");
    assert.deepEqual(entry?.guidance, [
      { kind: "compatibility", message_id: expected.messageId },
    ]);
    assert.deepEqual(ledgerBySource.get(expected.sourceKey)?.disposition, {
      kind: "published",
      entry_id: expected.id,
    });
    assert.deepEqual(ledgerBySource.get(expected.sourceKey)?.notes?.[0]?.disposition, {
      kind: "guidance",
      message_ids: [expected.messageId],
    });
    assert.deepEqual(messagesById.get(expected.messageId), {
      id: expected.messageId,
      fallback_text: expected.fallbackText,
      guidance_kind: "compatibility",
      context: "compatibility",
    });
    assert.equal(
      catalog.entries.find((entry) => entry.id === expected.id) !== undefined,
      true,
    );
  }
});

test("pending identities retain their reviewed, specific withholding reasons", async () => {
  const inputs = await fixture();
  const pendingRows = inputs.ledger.rows.filter(
    (row) => row.disposition.kind === "pending_identity",
  );

  assert.deepEqual(
    pendingRows.map((row) => row.source_key).sort(),
    Object.keys(EXPECTED_PENDING_IDENTITY_REASONS).sort(),
  );
  for (const row of pendingRows) {
    const reason = row.disposition.reason;
    assert.equal(typeof reason, "string", `${row.source_key} must have a reason`);
    assert.ok(reason.trim().length > 0, `${row.source_key} must have a nonempty reason`);
    assert.notEqual(
      reason,
      GENERIC_PENDING_IDENTITY_REASON,
      `${row.source_key} must retain its reviewed withholding reason`,
    );
    assert.equal(reason, EXPECTED_PENDING_IDENTITY_REASONS[row.source_key]);
  }
});

test("re-audited identities are explicit source-to-target bindings", async () => {
  const inputs = await fixture();
  const { catalog } = buildCompatibilityCatalog(inputs);
  const entriesBySource = new Map(
    inputs.curatedGames.entries.map((entry) => [entry.source_ref, entry]),
  );
  const runtimeById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const ledgerBySource = new Map(
    inputs.ledger.rows.map((entry) => [entry.source_key, entry]),
  );

  for (const [sourceKey, expected] of Object.entries(EXPECTED_REAUDITED_BINDINGS)) {
    assert.deepEqual(ledgerBySource.get(sourceKey)?.disposition, {
      kind: "published",
      entry_id: expected.entryId,
    });
    const authored = entriesBySource.get(sourceKey);
    assert.equal(authored?.id, expected.entryId);
    assert.equal(authored?.game_target_id, expected.targetId);
    assert.deepEqual(
      inputs.registry.targetsById.get(expected.targetId)?.rules.map(({ kind, value }) => ({
        kind,
        value,
      })),
      [expected.identity],
    );
    const rule = inputs.registry.targetsById.get(expected.targetId)?.rules[0];
    assert.deepEqual(rule?.provenance, {
      source: "optiscaler-reviewed-match",
      locator: sourceKey,
    });
    assert.deepEqual(runtimeById.get(expected.entryId)?.identities, [expected.identity]);
  }

  const online = entriesBySource.get("main:0397");
  assert.deepEqual(online?.guidance, [
    {
      kind: "game_setting",
      message_id: "optiscaler-online-404-reselect-upscaler",
    },
  ]);
  assert.deepEqual(ledgerBySource.get("main:0397")?.notes[0]?.disposition, {
    kind: "guidance",
    message_ids: ["optiscaler-online-404-reselect-upscaler"],
  });
});

test("OptiScaler compatibility authoring has no stale Steam-only unmatched artifact", async () => {
  await assert.rejects(
    access(
      path.join(
        ROOT,
        "catalogs",
        "addons",
        "optiscaler",
        "compatibility",
        "unmatched.json",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("published entry identifiers are unique source-neutral game or edition slugs", async () => {
  const inputs = await fixture();
  const ids = inputs.curatedGames.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    ids.some((id) => /^(?:steam-\d+-|gog-\d+(?:-|$)|epic-[0-9a-f]{8,}(?:-|$))/u.test(id)),
    false,
  );
});
