import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { guidanceForWikiGame, verifyCurationLedger } from "../lib/curation.mjs";
import {
  normalizeEngineIniRecipe,
  renderEngineIniRecipe,
  UE_HDR_ENGINE_INI_RECIPE,
} from "../lib/engine-ini.mjs";
import { normalizeGuidance, resourceValue } from "../lib/build-v2.mjs";

const wiki = JSON.parse(readFileSync(new URL("../wiki_games.json", import.meta.url)));
const messages = JSON.parse(
  readFileSync(new URL("../wiki_messages.json", import.meta.url)),
);
const wikiSource = JSON.parse(
  readFileSync(new URL("../wiki_source.json", import.meta.url)),
);
const manifest = JSON.parse(
  readFileSync(new URL("../../../../addons/v2/renodx.json", import.meta.url)),
);
const ledger = JSON.parse(readFileSync(new URL("../review-ledger.json", import.meta.url)));
const schema = JSON.parse(
  readFileSync(new URL("../manifest-v2.schema.json", import.meta.url)),
);

function compileV2Schema() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

const emptyManifest = () => ({
  schema_version: 2,
  generated_at: "2026-09-15T00:00:00Z",
  games: [],
  engine_profiles: [],
  page_guidance: [],
});

const validRecipe = () => ({
  schema_version: 1,
  revision: 1,
  sections: [
    {
      name: "SystemSettings",
      entries: [{ key: "r.AllowHDR", value: "1" }],
    },
  ],
});

const validEngineIniGuidance = () => ({
  id: "recipe",
  kind: "engine_ini",
  message_id: "recipe",
  fallback_text: "Apply this Engine.ini recipe.",
  code: "[SystemSettings]\nr.AllowHDR=1",
  engine_ini: validRecipe(),
});

test("v2 schema publishes a closed structured Engine.ini recipe contract", () => {
  const validate = compileV2Schema();
  const accepted = emptyManifest();
  accepted.page_guidance.push(validEngineIniGuidance());
  assert.equal(validate(accepted), true, JSON.stringify(validate.errors, null, 2));

  const wrongKind = emptyManifest();
  wrongKind.page_guidance.push({ ...validEngineIniGuidance(), kind: "warning" });
  assert.equal(validate(wrongKind), false);

  const unknownRecipeField = emptyManifest();
  unknownRecipeField.page_guidance.push({
    ...validEngineIniGuidance(),
    engine_ini: { ...validRecipe(), unexpected: true },
  });
  assert.equal(validate(unknownRecipeField), false);

  const nullRecipe = emptyManifest();
  nullRecipe.page_guidance.push({ ...validEngineIniGuidance(), engine_ini: null });
  assert.equal(validate(nullRecipe), false);

  const maxRevision = emptyManifest();
  maxRevision.page_guidance.push({
    ...validEngineIniGuidance(),
    engine_ini: { ...validRecipe(), revision: 4294967295 },
  });
  assert.equal(validate(maxRevision), true, JSON.stringify(validate.errors, null, 2));

  const overflowingRevision = emptyManifest();
  overflowingRevision.page_guidance.push({
    ...validEngineIniGuidance(),
    engine_ini: { ...validRecipe(), revision: 4294967296 },
  });
  assert.equal(validate(overflowingRevision), false);

  const invalidScalar = emptyManifest();
  invalidScalar.page_guidance.push({
    ...validEngineIniGuidance(),
    engine_ini: {
      ...validRecipe(),
      sections: [{ ...validRecipe().sections[0], name: "System\nSettings" }],
    },
  });
  assert.equal(validate(invalidScalar), false);
});

test("v2 schema publishes a closed RenoDX configuration contract", () => {
  const validate = compileV2Schema();
  const accepted = emptyManifest();
  accepted.games.push({
    id: "gothic",
    name: "Gothic",
    architecture: "X64",
    status: "working",
    match: [{ kind: "exe_name", value: "gothic.exe", tier: 1 }],
    addon: { slug: "gothic" },
    profile_id: "unreal_legacy",
    renodx_config: {
      settings: [{ key: "Upgrade_R10G10B10A2_UNORM", value: 1 }],
    },
  });
  assert.equal(validate(accepted), true, JSON.stringify(validate.errors, null, 2));

  const unknownKey = structuredClone(accepted);
  unknownKey.games[0].renodx_config.settings[0].key = "Set_Path";
  assert.equal(validate(unknownKey), false);

  const misspelledResourceKey = structuredClone(accepted);
  misspelledResourceKey.games[0].renodx_config.settings[0].key =
    "Upgrade_R8G8R8A8_TYPELESS";
  assert.equal(validate(misspelledResourceKey), false);

  const invalidValue = structuredClone(accepted);
  invalidValue.games[0].renodx_config.settings[0].value = 99;
  assert.equal(validate(invalidValue), false);

  const profileless = structuredClone(accepted);
  delete profileless.games[0].profile_id;
  assert.equal(validate(profileless), false);

  const representativeValues = structuredClone(accepted);
  representativeValues.games[0].profile_id = "unity";
  representativeValues.games[0].renodx_config.settings = [
    { key: "Upgrade_R10G10B10A2_UNORM", value: 3 },
    { key: "Upgrade_CopyDestinations", value: 2 },
    { key: "Swapchain_Encoding", value: 1 },
    { key: "Scaling_Offset", value: 8 },
    { key: "ColorGradeContrast", value: 100 },
    { key: "Force_Pipeline_Cloning", value: 1 },
  ];
  assert.equal(validate(representativeValues), true, JSON.stringify(validate.errors));

  const duplicateKey = structuredClone(accepted);
  duplicateKey.games[0].renodx_config.settings.push({
    key: "Upgrade_R10G10B10A2_UNORM",
    value: 2,
  });
  assert.equal(validate(duplicateKey), false);

  const incompatibleProfile = structuredClone(accepted);
  incompatibleProfile.games[0].profile_id = "ue_extended";
  incompatibleProfile.games[0].renodx_config.settings[0].key = "ForceBorderless";
  assert.equal(validate(incompatibleProfile), false);

  const incompatiblePipelineCloning = structuredClone(accepted);
  incompatiblePipelineCloning.games[0].profile_id = "ue_extended";
  incompatiblePipelineCloning.games[0].renodx_config.settings[0] = {
    key: "Force_Pipeline_Cloning",
    value: 1,
  };
  assert.equal(validate(incompatiblePipelineCloning), false);

  const invalidPipelineCloningValue = structuredClone(accepted);
  invalidPipelineCloningValue.games[0].profile_id = "unity";
  invalidPipelineCloningValue.games[0].renodx_config.settings[0] = {
    key: "Force_Pipeline_Cloning",
    value: 2,
  };
  assert.equal(validate(invalidPipelineCloningValue), false);

  const unknownField = structuredClone(accepted);
  unknownField.games[0].renodx_config.settings[0].unsafe = "[renodx]";
  assert.equal(validate(unknownField), false);
});

test("RenoDX resource values use an exact closed mapping", () => {
  const accepted = [
    ["Any Size (optional)", null],
    ["Output Size at 100% render resolution", 2],
    ["Output Ratio at other render resolutions", 2],
    ["Output Size at 100% render resolution; Output Ratio otherwise", 2],
    ["Output Ratio or Any Size", 2],
    ["Output Ratio or higher", 2],
    ["Upgrade", 1],
    ["Upgrade when using FSR 1", 1],
    ["Output Size", 1],
    ["Output Size (automatic)", 1],
    ["Output Ratio", 2],
    ["Output Ratio (automatic)", 2],
    ["Output Ratio (optional)", 2],
    ["Any Size", 3],
  ];
  for (const [value, expected] of accepted) {
    assert.equal(resourceValue("R8G8B8A8_TYPELESS", value, "sample-game"), expected, value);
  }

  for (const value of [
    "prefix Any Size (optional)",
    "Any Size (optional) suffix",
    "Output Ratio or higher (reviewed)",
    "output ratio",
  ]) {
    assert.throws(
      () => resourceValue("R8G8B8A8_TYPELESS", value, "sample-game"),
      /Unrecognized RenoDX resource value for sample-game: R8G8B8A8_TYPELESS=/,
    );
  }
  assert.throws(
    () => resourceValue("R10G10B10A2_UNORM", "Unknown value", "sample-game"),
    /Unrecognized RenoDX resource value for sample-game: R10G10B10A2_UNORM="Unknown value"/,
  );
});

test("Engine.ini recipe helper is deterministic, strict, and canonical", () => {
  assert.equal(
    renderEngineIniRecipe({
      schema_version: 1,
      revision: 4,
      sections: [
        { name: "First", entries: [{ key: "a", value: "1" }] },
        { name: "Second", entries: [{ key: "b", value: "2" }] },
      ],
    }),
    "[First]\na=1\n\n[Second]\nb=2",
  );
  assert.equal(renderEngineIniRecipe(UE_HDR_ENGINE_INI_RECIPE).endsWith("\n"), false);

  assert.throws(
    () => normalizeEngineIniRecipe({ ...validRecipe(), revision: 0 }),
    /revision must be an integer greater than zero/,
  );
  assert.equal(
    renderEngineIniRecipe({ ...validRecipe(), revision: 4294967295 }),
    "[SystemSettings]\nr.AllowHDR=1",
  );
  assert.throws(
    () => normalizeEngineIniRecipe({ ...validRecipe(), revision: 4294967296 }),
    /revision must be no greater than 4294967295/,
  );
  assert.throws(
    () =>
      normalizeEngineIniRecipe({
        ...validRecipe(),
        sections: [
          ...validRecipe().sections,
          { name: "systemsettings", entries: [{ key: "other", value: "1" }] },
        ],
      }),
    /duplicate section names/,
  );
  assert.throws(
    () =>
      normalizeEngineIniRecipe({
        ...validRecipe(),
        sections: [
          {
            name: "SystemSettings",
            entries: [
              { key: "r.AllowHDR", value: "1" },
              { key: "R.ALLOWHDR", value: "1" },
            ],
          },
        ],
      }),
    /duplicate section\/key targets/,
  );
});

test("structured guidance rejects presentation-code drift", () => {
  const guidance = validEngineIniGuidance();
  guidance.code = "[SystemSettings]\nr.AllowHDR=0";
  assert.throws(
    () => normalizeGuidance([guidance], "test guidance"),
    /code does not match engine_ini recipe/,
  );
  delete guidance.code;
  assert.throws(() => normalizeGuidance([guidance], "test guidance"), /code is required/);
});

test("the checked-in ledger covers every active note and excludes unrelated sections", () => {
  const result = verifyCurationLedger(messages, wikiSource);
  assert.equal(result.entries.length, messages.length);
  assert.equal(messages.length, 499);
  assert.deepEqual(result.source.ignored_sections, ["Deprecated", "Related Mods"]);
  assert.equal(result.entries.filter((entry) => entry.disposition === "pending").length, 9);
  assert.equal(result.source.page_reviews.length, 10);
  assert.equal(ledger.entries.length, messages.length);
  assert.equal(JSON.stringify(result).includes("<details>"), false);
});

test("changed upstream note fingerprints cannot silently reach public output", () => {
  const original = wiki.find((game) => game.source_key);
  const message = messages.find(
    (candidate) => candidate.source_key === original.source_key,
  );
  assert.ok(original);
  assert.ok(message);
  assert.throws(
    () =>
      guidanceForWikiGame(original, [
        ...messages.filter((candidate) => candidate.source_key !== message.source_key),
        { ...message, note: `${message.note} changed` },
      ]),
    /fingerprint changed/,
  );
});

test("whole-page changes cannot bypass active-table message review", () => {
  assert.throws(
    () =>
      verifyCurationLedger(messages, {
        ...wikiSource,
        content_sha256: "0".repeat(64),
      }),
    /whole-page fingerprint changed/,
  );
});

test("v2 profiles and title-specific Wukong suppression are materialized", () => {
  assert.deepEqual(
    manifest.engine_profiles.map((profile) => profile.id),
    ["ue_extended", "unreal_legacy", "unity"],
  );
  assert.deepEqual(
    manifest.engine_profiles.map((profile) => profile.processing_path),
    ["unmanaged", "unmanaged", "unmanaged"],
  );
  assert.equal(
    manifest.games.some((game) => game.profile_id === "game"),
    false,
  );
  const wukong = manifest.games.find((game) => game.id === "black-myth-wukong");
  assert.ok(wukong);
  assert.equal(wukong.profile_id, "ue_extended");
  assert.equal(wukong.inherit_page_guidance, false);
  assert.deepEqual(
    wukong.guidance.map((item) => item.code),
    ["r.HDR.EnableHDROutput=1"],
  );
  assert.equal(
    wukong.guidance.some((item) => item.id.includes("lut_update")),
    false,
  );
  assert.equal(
    wukong.guidance.some((item) => item.code?.includes("r.AllowHDR")),
    false,
  );

  const ueExtended = manifest.engine_profiles.find(
    (profile) => profile.id === "ue_extended",
  );
  assert.deepEqual(
    ueExtended.guidance.map((item) => item.id),
    ["renodx.ue_extended.hdr_engine_ini", "renodx.ue_extended.lut_update"],
  );
});

test("generated Engine.ini guidance has exactly one manual exception", () => {
  const allGuidance = [
    ...manifest.page_guidance,
    ...manifest.engine_profiles.flatMap((profile) => profile.guidance),
    ...manifest.games.flatMap((game) => game.guidance ?? []),
  ];
  const engineIni = allGuidance.filter((item) => item.kind === "engine_ini");
  const structured = engineIni.filter((item) => item.engine_ini);
  const manual = engineIni.filter((item) => !item.engine_ini);
  assert.equal(engineIni.length, 50);
  assert.equal(structured.length, 49);
  assert.deepEqual(
    manual.map((item) => item.id),
    ["renodx.black_myth_wukong.hdr"],
  );
  assert.deepEqual(
    manual.map((item) => item.code),
    ["r.HDR.EnableHDROutput=1"],
  );
  for (const item of structured) {
    assert.equal(item.code, renderEngineIniRecipe(item.engine_ini), item.id);
  }
});

test("UE Extended typed Engine.ini recipes cover the reviewed fallback titles", () => {
  const recipeIds = ["renodx.ue_extended.hdr_engine_ini", "renodx.ue_extended.lut_update"];
  const affected = manifest.games
    .filter((game) => (game.guidance ?? []).some((item) => recipeIds.includes(item.id)))
    .map((game) => game.id)
    .sort();
  assert.deepEqual(affected, [
    "chromatic-conundrum",
    "ghostrunner",
    "goat-simulator-3",
    "hydroneer",
    "it-takes-two",
    "little-nightmares",
    "little-nightmares-enhanced-edition",
    "persona-3-reload",
    "scorn",
    "stray",
    "the-alters",
    "vholume",
  ]);
  for (const gameId of affected) {
    const game = manifest.games.find((candidate) => candidate.id === gameId);
    assert.deepEqual(
      game.guidance.filter((item) => recipeIds.includes(item.id)).map((item) => item.id),
      recipeIds,
      gameId,
    );
  }
});

test("double-tonemapping advice is neutral compatibility guidance", () => {
  const item = manifest.page_guidance.find(
    (candidate) => candidate.id === "renodx.page.hdr.disable-double-tonemapping",
  );
  assert.ok(item);
  assert.equal(item.kind, "compatibility");
});

test("processing policy is the reviewed UE Extended matrix", () => {
  const ueExtended = manifest.games.filter((game) => game.profile_id === "ue_extended");
  assert.equal(ueExtended.length, 64);
  const upgradeIds = [
    "abzu",
    "astroneer",
    "a-way-out",
    "deep-rock-galactic-rogue-core",
    "end-of-abyss",
    "escape-the-backrooms",
    "frostpunk-2",
    "goat-simulator-3",
    "ghostrunner",
    "hi-fi-rush",
    "hydroneer",
    "the-idolm-ster-starlit-season",
    "it-takes-two",
    "little-nightmares",
    "little-nightmares-enhanced-edition",
    "little-nightmares-ii",
    "motor-town-behind-the-wheel",
    "pacific-drive",
    "persona-3-reload",
    "scorn",
    "sifu",
    "stray",
    "the-alters",
    "vholume",
    "what-remains-of-edith-finch",
  ].sort();
  assert.deepEqual(
    ueExtended
      .filter((game) => game.processing_path === "upgrade")
      .map((game) => game.id)
      .sort(),
    upgradeIds,
  );
  assert.deepEqual(
    ueExtended
      .filter((game) => game.processing_path === "native")
      .map((game) => game.id)
      .sort(),
    [
      "assetto-corsa-rally",
      "borderlands-4",
      "chromatic-conundrum",
      "dead-as-disco",
      "deep-rock-galactic",
      "far-far-west",
      "hellblade-ii-senua-s-saga",
      "jusant",
      "lego-batmantm-legacy-of-the-dark-knight",
      "lies-of-p",
      "mafia-the-old-country",
      "s-t-a-l-k-e-r-2-heart-of-chornobyl",
      "star-wars-zero-companytm",
      "tokyo-xtreme-racer",
      "until-dawn",
    ].sort(),
  );
  assert.equal(
    manifest.games.find((game) => game.id === "black-myth-wukong").processing_path,
    undefined,
    "Wukong inherits the native UE Extended profile without a title override",
  );
  for (const id of [
    "flyknight",
    "ghostrunner-2",
    "palworld",
    "the-first-berserker-khazan",
  ]) {
    const game = manifest.games.find((candidate) => candidate.id === id);
    assert.notEqual(game?.profile_id, "ue_extended");
    assert.equal(game?.processing_path, undefined);
  }
  const settingNames = manifest.games.flatMap((game) =>
    (game.guidance ?? []).flatMap((item) =>
      (item.settings ?? []).map((setting) => setting.name),
    ),
  );
  assert.equal(settingNames.includes("Upgrade Path"), false);
  assert.equal(JSON.stringify(manifest).includes("Set RenoDX Upgrade Path to On"), false);
});

test("generated game guidance contains no addon settings and keeps Native HDR in-game", () => {
  const guidance = manifest.games.flatMap((game) => game.guidance ?? []);
  assert.equal(
    guidance.some((item) => item.kind === "addon_setting"),
    false,
  );

  const nativeHdrItems = guidance.filter((item) =>
    item.settings?.some((setting) => setting.name === "Native HDR"),
  );
  assert.ok(nativeHdrItems.length > 0);
  assert.equal(
    nativeHdrItems.every((item) => item.kind === "game_setting"),
    true,
  );
});

test("typed config lowers reviewed resource curation without exposing manual INI settings", () => {
  const sonic = manifest.games.find((game) => game.id === "sonic-racing-crossworlds");
  assert.deepEqual(sonic?.renodx_config?.settings, [
    { key: "Upgrade_R10G10B10A2_UNORM", value: 2 },
  ]);

  const conditional = manifest.games.find((game) => game.id === "abzu");
  assert.equal(
    conditional?.renodx_config?.settings.find(
      (setting) => setting.key === "Upgrade_B8G8R8A8_TYPELESS",
    )?.value,
    2,
  );

  const spacer = manifest.games.find(
    (game) => game.id === "the-outer-worlds-spacer-s-choice-edition",
  );
  assert.equal(spacer?.renodx_config, undefined);
  assert.equal(spacer?.guidance?.[0]?.kind, "compatibility");
  assert.equal(spacer?.guidance?.[0]?.settings, undefined);

  const borderlands = manifest.games.find((game) => game.id === "borderlands-3");
  assert.deepEqual(borderlands?.renodx_config?.settings, [
    { key: "Upgrade_CopyDestinations", value: 1 },
    { key: "Upgrade_R8G8B8A8_TYPELESS", value: 2 },
    { key: "Upgrade_B8G8R8A8_TYPELESS", value: 2 },
    { key: "Upgrade_R11G11B10_FLOAT", value: 2 },
  ]);
  assert.equal(
    borderlands?.guidance?.some(
      (item) => item.fallback_text === "Apply these RenoDX settings for this game.",
    ) ?? false,
    false,
  );
  assert.equal(
    spacer?.guidance?.some((item) => item.fallback_text.includes("breaks FMVs")),
    true,
  );

  const hiFiRush = manifest.games.find((game) => game.id === "hi-fi-rush");
  assert.deepEqual(hiFiRush?.renodx_config?.settings, [
    { key: "Upgrade_CopyDestinations", value: 0 },
    { key: "Upgrade_R8G8B8A8_TYPELESS", value: 3 },
  ]);

  const everspace = manifest.games.find((game) => game.id === "everspace");
  assert.deepEqual(everspace?.renodx_config?.settings, [
    { key: "Upgrade_R8G8B8A8_TYPELESS", value: 1 },
    { key: "Upgrade_B8G8R8A8_TYPELESS", value: 1 },
  ]);
  assert.equal(JSON.stringify(manifest).includes("R8G8R8A8_TYPELESS"), false);
});

test("Unity swapchain proxy and pipeline cloning guidance lowers to typed INI settings", () => {
  const gamble = manifest.games.find((game) => game.id === "gamble-with-your-friends");
  assert.ok(gamble, "gamble-with-your-friends must exist in v2 manifest");
  assert.equal(gamble.profile_id, "unity");
  assert.deepEqual(gamble.renodx_config?.settings, [
    { key: "Use_Swapchain_Proxy", value: 1 },
    { key: "Force_Pipeline_Cloning", value: 1 },
  ]);
  assert.equal(
    (gamble.guidance ?? []).some((item) => item.kind === "addon_setting"),
    false,
  );
  assert.equal(
    (gamble.guidance ?? []).some(
      (item) =>
        item.fallback_text.includes("Force Pipeline Cloning") ||
        item.fallback_text.includes("Swapchain Proxy"),
    ),
    false,
  );
});

test("resolved legacy and dedicated titles retain manually curated caveats", () => {
  const guidanceText = (id) =>
    (manifest.games.find((game) => game.id === id)?.guidance ?? [])
      .map((item) => item.fallback_text)
      .join("\n");

  assert.match(guidanceText("flyknight"), /in-game filters can alter HDR presentation/i);
  assert.match(guidanceText("flyknight"), /limited testing/i);
  assert.match(
    guidanceText("ghostrunner-2"),
    /tonemapping issues remain; testing was limited/i,
  );
  assert.match(guidanceText("palworld"), /limited testing/i);
  assert.match(guidanceText("palworld"), /DLSS because it clamps output to SDR/i);
  assert.match(
    guidanceText("the-first-berserker-khazan"),
    /tonemapping issues remain; testing was limited/i,
  );

  for (const id of [
    "flyknight",
    "ghostrunner-2",
    "palworld",
    "the-first-berserker-khazan",
  ]) {
    const game = manifest.games.find((candidate) => candidate.id === id);
    assert.ok(game);
    assert.notEqual(game.profile_id, "ue_extended");
    assert.equal(game.processing_path, undefined);
    assert.equal(
      (game.guidance ?? []).some((item) =>
        item.settings?.some((setting) => setting.name === "Upgrade Path"),
      ),
      false,
    );
  }

  for (const sourceKey of [
    "ue-extended:flyknight",
    "ue-extended:ghostrunner-2",
    "ue-extended:palworld",
    "ue-extended:the-first-berserker-khazan",
  ]) {
    const entry = ledger.entries.find((candidate) => candidate.source_key === sourceKey);
    assert.equal(entry?.disposition, "omitted");
    assert.match(
      entry?.reason ?? "",
      /moved to resolved (?:legacy|dedicated) title guidance/i,
    );
  }
});

test("exact UE Extended and Unity guidance stays structured", () => {
  const stalker = manifest.games.find(
    (game) => game.id === "s-t-a-l-k-e-r-2-heart-of-chornobyl",
  );
  assert.equal(stalker.profile_id, "ue_extended");
  assert.deepEqual(
    stalker.guidance.flatMap((item) => item.settings ?? []).map((setting) => setting.name),
    ["Gamma", "Contrast", "Brightness", "Native HDR"],
  );

  const unityLaunch = manifest.games.find(
    (game) => game.profile_id === "unity" && game.requirements?.launch?.arguments?.length,
  );
  assert.ok(unityLaunch);
  assert.equal(
    unityLaunch.requirements.launch.arguments.every((argument) => argument.startsWith("-")),
    true,
  );
});

test("public guidance contains no raw wiki markup", () => {
  const guidance = [
    ...manifest.page_guidance,
    ...manifest.engine_profiles.flatMap((profile) => profile.guidance),
    ...manifest.games.flatMap((game) => game.guidance ?? []),
  ];
  for (const item of guidance) {
    assert.equal(
      /<\/?(?:details|summary|br)[^>]*>|\[[^\]]+\]\([^)]*\)|`/.test(item.fallback_text),
      false,
    );
  }
});

test("games do not contain un-unified duplicate settings guidance with identical text", () => {
  for (const game of manifest.games) {
    if (!game.guidance || game.guidance.length <= 1) continue;
    const seen = new Set();
    for (const item of game.guidance) {
      if (
        item.settings &&
        (item.kind === "game_setting" || item.kind === "addon_setting")
      ) {
        const key = `${item.kind}:${item.fallback_text}`;
        assert.equal(
          seen.has(key),
          false,
          `game "${game.id}" contains un-unified ${item.kind} guidance for "${item.fallback_text}"`,
        );
        seen.add(key);
      }
    }
  }
});

test("normalizeGuidance allows different text for multiple game settings", () => {
  assert.doesNotThrow(() =>
    normalizeGuidance(
      [
        {
          id: "hdr",
          kind: "game_setting",
          text: "Enable HDR.",
          settings: [{ name: "HDR", value: "On" }],
        },
        {
          id: "film_grain",
          kind: "game_setting",
          text: "Disable Film Grain.",
          settings: [{ name: "Film Grain", value: "Off" }],
        },
      ],
      "test",
    ),
  );
});

test("normalizeGuidance rejects duplicate game settings with identical text", () => {
  assert.throws(
    () =>
      normalizeGuidance(
        [
          {
            id: "gamma",
            kind: "game_setting",
            text: "Set in-game display settings.",
            settings: [{ name: "Gamma", value: "50%" }],
          },
          {
            id: "contrast",
            kind: "game_setting",
            text: "Set in-game display settings.",
            settings: [{ name: "Contrast", value: "50%" }],
          },
        ],
        "test",
      ),
    /duplicates .* "game_setting" guidance with identical text/,
  );
});

test("S.T.A.L.K.E.R. 2 exposes display settings as one guidance block", () => {
  const game = manifest.games.find(({ id }) => id === "s-t-a-l-k-e-r-2-heart-of-chornobyl");

  assert.ok(game);

  const displayGuidance = game.guidance.filter(
    ({ kind, fallback_text }) =>
      kind === "game_setting" && fallback_text === "Apply these in-game display settings.",
  );

  assert.equal(displayGuidance.length, 1);

  assert.deepEqual(displayGuidance[0].settings, [
    { name: "Gamma", value: "50%" },
    { name: "Contrast", value: "50%" },
    { name: "Brightness", value: "50%" },
  ]);
});

test("normalizeGuidance rejects conflicting id and message_id", () => {
  assert.throws(
    () =>
      normalizeGuidance(
        [
          {
            id: "renodx.foo",
            message_id: "renodx.bar",
            kind: "compatibility",
            text: "Some text.",
          },
        ],
        "test",
      ),
    /id and message_id must match/,
  );
});

test("normalizeGuidance rejects conflicting text and fallback_text", () => {
  assert.throws(
    () =>
      normalizeGuidance(
        [
          {
            id: "example",
            kind: "compatibility",
            text: "One text.",
            fallback_text: "Different text.",
          },
        ],
        "test",
      ),
    /text and fallback_text must match/,
  );
});

test("committed RenoDX v2 manifest complies with manifest-v2.schema.json", () => {
  const validate = compileV2Schema();
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors, null, 2));
});
