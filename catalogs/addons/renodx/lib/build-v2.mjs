import { requiredNonEmptyString } from "../../../../scripts/lib/common.mjs";
import {
  PAGE_GUIDANCE,
  decisionForWikiGame,
  guidanceForWikiGame,
  verifyCurationLedger,
} from "./curation.mjs";
import {
  UE_HDR_ENGINE_INI_RECIPE,
  UE_LUT_ENGINE_INI_RECIPE,
  normalizeEngineIniRecipe,
  renderEngineIniRecipe,
} from "./engine-ini.mjs";
import { RESOLVED_TITLE_GUIDANCE } from "./reviewed-guidance.mjs";

const UE_HDR_CODE = renderEngineIniRecipe(UE_HDR_ENGINE_INI_RECIPE);
const UE_LUT_CODE = renderEngineIniRecipe(UE_LUT_ENGINE_INI_RECIPE);

const UE_HDR = Object.freeze({
  id: "renodx.ue_extended.hdr_engine_ini",
  kind: "engine_ini",
  message_id: "renodx.ue_extended.hdr_engine_ini",
  fallback_text: "For the UE5 HDR path, add these settings to Engine.ini.",
  engine_ini: UE_HDR_ENGINE_INI_RECIPE,
  code: UE_HDR_CODE,
  condition: { engine: "unreal", unreal_major: 5 },
});

const UE_LUT = Object.freeze({
  id: "renodx.ue_extended.lut_update",
  kind: "engine_ini",
  message_id: "renodx.ue_extended.lut_update",
  fallback_text: "For UE5.3 and newer, add this setting to enable real-time sliders.",
  engine_ini: UE_LUT_ENGINE_INI_RECIPE,
  code: UE_LUT_CODE,
  condition: { engine: "unreal", unreal_major: 5, unreal_minor_min: 3 },
});

const UE_COMMON = Object.freeze([UE_HDR, UE_LUT]);

const LEGACY_COMMON = Object.freeze([]);

const UNITY_COMMON = Object.freeze([
  {
    id: "renodx.unity.reset_display_controls",
    kind: "game_setting",
    message_id: "renodx.unity.reset_display_controls",
    fallback_text:
      "Keep the game's brightness, contrast, and gamma controls at their default values unless a title note says otherwise.",
  },
  {
    id: "renodx.unity.windowed",
    kind: "compatibility",
    message_id: "renodx.unity.windowed",
    fallback_text: "Avoid Exclusive Fullscreen; use Borderless or Windowed mode.",
  },
]);

const PROFILE_DEFS = Object.freeze([
  {
    id: "ue_extended",
    engine: "unreal",
    generic_fallback: true,
    status: "unknown",
    message: {
      id: "renodx.generic.ue_extended",
      fallback_text: "Uses the shared Unreal Engine Extended profile.",
    },
    guidance: UE_COMMON,
  },
  {
    id: "unreal_legacy",
    engine: "unreal",
    generic_fallback: false,
    status: "unknown",
    message: {
      id: "renodx.generic.unreal_legacy",
      fallback_text: "Uses a title-specific legacy Unreal Engine profile.",
    },
    guidance: LEGACY_COMMON,
  },
  {
    id: "unity",
    engine: "unity",
    generic_fallback: true,
    status: "unknown",
    message: {
      id: "renodx.generic.unity",
      fallback_text: "Uses the shared Unity engine profile.",
    },
    guidance: UNITY_COMMON,
  },
]);

const GAME_OVERRIDES = Object.freeze({
  // Wukong remains the exact title routed through UE Extended. Its upstream
  // note explicitly replaces the shared Engine.ini recipe and LUT setting.
  "black-myth-wukong": [
    {
      id: "renodx.black_myth_wukong.hdr",
      kind: "engine_ini",
      message_id: "renodx.black_myth_wukong.hdr",
      fallback_text: "In Engine.ini, add this setting for the UE Extended HDR path.",
      code: "r.HDR.EnableHDROutput=1",
    },
  ],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function profileForGame(game) {
  if (game.slug === "ue-extended") return "ue_extended";
  if (game.slug === "unrealengine") return "unreal_legacy";
  if (game.slug === "unityengine") return "unity";
  return null;
}

export function normalizeGuidance(items, context) {
  if (!Array.isArray(items)) throw new Error(`${context}.guidance must be an array`);

  const normalized = items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${context}.guidance[${index}] must be an object`);
    }
    const { text, ...result } = item;
    if (
      text !== undefined &&
      result.fallback_text !== undefined &&
      text !== result.fallback_text
    ) {
      throw new Error(
        `${context}.guidance[${index}] text and fallback_text must match (${JSON.stringify(text)} !== ${JSON.stringify(result.fallback_text)})`,
      );
    }
    if (result.fallback_text === undefined && typeof text === "string") {
      result.fallback_text = text;
    }

    if (result.id === undefined && result.message_id !== undefined) {
      result.id = result.message_id;
    }
    if (result.message_id === undefined && result.id !== undefined) {
      result.message_id = result.id;
    }
    if (result.id !== result.message_id) {
      throw new Error(
        `${context}.guidance[${index}] id and message_id must match (${JSON.stringify(result.id)} !== ${JSON.stringify(result.message_id)})`,
      );
    }

    requiredNonEmptyString(result.id, `${context}.guidance[${index}].id`);
    requiredNonEmptyString(result.kind, `${context}.guidance[${index}].kind`);
    requiredNonEmptyString(result.message_id, `${context}.guidance[${index}].message_id`);
    requiredNonEmptyString(
      result.fallback_text,
      `${context}.guidance[${index}].fallback_text`,
    );
    if (result.code !== undefined)
      requiredNonEmptyString(result.code, `${context}.guidance[${index}].code`);
    if (result.kind === "engine_ini" && result.code === undefined) {
      throw new Error(`${context}.guidance[${index}].code is required`);
    }
    if (result.engine_ini !== undefined) {
      if (result.kind !== "engine_ini") {
        throw new Error(
          `${context}.guidance[${index}].engine_ini is only valid for engine_ini guidance`,
        );
      }
      const recipe = normalizeEngineIniRecipe(
        result.engine_ini,
        `${context}.guidance[${index}].engine_ini`,
      );
      const canonicalCode = renderEngineIniRecipe(recipe);
      if (result.code !== undefined && result.code !== canonicalCode) {
        throw new Error(
          `${context}.guidance[${index}] code does not match engine_ini recipe`,
        );
      }
      result.engine_ini = recipe;
      result.code = canonicalCode;
    }
    if (result.settings !== undefined && !Array.isArray(result.settings)) {
      throw new Error(`${context}.guidance[${index}].settings must be an array`);
    }
    if (Array.isArray(result.settings)) {
      for (const [settingIndex, setting] of result.settings.entries()) {
        if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
          throw new Error(
            `${context}.guidance[${index}].settings[${settingIndex}] must be an object`,
          );
        }
        requiredNonEmptyString(
          setting.name,
          `${context}.guidance[${index}].settings[${settingIndex}].name`,
        );
        requiredNonEmptyString(
          setting.value,
          `${context}.guidance[${index}].settings[${settingIndex}].value`,
        );
      }
    }
    return result;
  });

  // Settings with identical text within the same scope must be unified into a single block.
  const seenTypedSettings = new Map();
  for (const [index, item] of normalized.entries()) {
    if (item.settings && (item.kind === "game_setting" || item.kind === "addon_setting")) {
      const text = item.fallback_text;
      const key = `${item.kind}:${text}`;
      const firstIndex = seenTypedSettings.get(key);
      if (firstIndex !== undefined) {
        throw new Error(
          `${context}.guidance[${index}] duplicates ${context}.guidance[${firstIndex}] "${item.kind}" guidance with identical text: ${JSON.stringify(text)}. Unify settings into a single guidance block instead of duplicating guidance items.`,
        );
      }
      seenTypedSettings.set(key, index);
    }
  }

  return normalized;
}

function materializeGuidance(
  game,
  wikiMessages,
  decision = decisionForWikiGame(game, wikiMessages),
) {
  const profile = profileForGame(game);
  const resolvedTitleGuidance = RESOLVED_TITLE_GUIDANCE[game.id] ?? [];
  // Wukong is an explicit suppression rule: do not compose UE's broad HDR/LUT
  // recipes with this one-line title-specific Engine.ini exception.
  if (game.id === "black-myth-wukong") return clone(GAME_OVERRIDES[game.id]);
  const curated = guidanceForWikiGame(game, wikiMessages);
  const common =
    profile === "ue_extended"
      ? UE_COMMON
      : profile === "unreal_legacy"
        ? LEGACY_COMMON
        : profile === "unity"
          ? UNITY_COMMON
          : [];
  if (decision) {
    return clone([
      ...(decision.inherit_common ? common : []),
      ...curated,
      ...resolvedTitleGuidance,
    ]);
  }
  if (resolvedTitleGuidance.length) return clone([...common, ...resolvedTitleGuidance]);
  if (Object.hasOwn(GAME_OVERRIDES, game.id)) return clone(GAME_OVERRIDES[game.id]);
  if (profile === "ue_extended") return clone(UE_COMMON);
  if (profile === "unreal_legacy") return clone(LEGACY_COMMON);
  if (profile === "unity") return clone(UNITY_COMMON);
  return [];
}

const RESOURCE_FORMATS = new Set([
  "B8G8R8A8_TYPELESS",
  "B8G8R8A8_UNORM",
  "R8G8B8A8_TYPELESS",
  "R8G8B8A8_UNORM",
  "R10G10B10A2_UNORM",
  "R10G10B10A2_TYPELESS",
  "R11G11B10_FLOAT",
  "R16G16B16A16_TYPELESS",
]);

const RESOURCE_VALUES = new Map([
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
]);

export function resourceValue(name, value, gameId) {
  if (RESOURCE_VALUES.has(value)) return RESOURCE_VALUES.get(value);
  throw new Error(
    `Unrecognized RenoDX resource value for ${gameId}: ${name}=${JSON.stringify(value)}`,
  );
}

/** Compiles reviewed presentation settings into a closed install-time contract. */
function compileRenoDxConfig(guidance, profile, gameId) {
  const settings = [];
  const add = (key, value) => {
    const existing = settings.find((entry) => entry.key === key);
    if (existing && existing.value === value) return;
    if (existing) {
      throw new Error(`Duplicate RenoDX config key for ${gameId}: ${key}`);
    }
    settings.push({ key, value });
  };
  for (const item of guidance) {
    if (item.kind !== "addon_setting") continue;
    for (const setting of item.settings ?? []) {
      const { name, value } = setting;
      if (RESOURCE_FORMATS.has(name)) {
        const mapped = resourceValue(name, value, gameId);
        if (mapped !== null) add(`Upgrade_${name}`, mapped);
      } else if (name === "Upgrade Copy Destinations") {
        if (value === "Off") add("Upgrade_CopyDestinations", 0);
        else if (value === "On") add("Upgrade_CopyDestinations", 1);
        else if (profile === "unity" && value === "Auto-Upgrade")
          add("Upgrade_CopyDestinations", 2);
        else
          throw new Error(
            `Unrecognized RenoDX copy-destination value for ${gameId}: ${value}`,
          );
      } else if (name === "Force Borderless") {
        if (value === "Disabled") add("ForceBorderless", 0);
        else if (value === "Enabled") add("ForceBorderless", 1);
        else
          throw new Error(`Unrecognized RenoDX borderless value for ${gameId}: ${value}`);
      } else if (name === "Swap Chain Format" && value === "scRGB")
        add("Upgrade_UseSCRGB", 1);
      else if (name === "Swapchain Encoding" && value === "Gamma")
        add("Swapchain_Encoding", 1);
      else if (name === "Compatibility Scaling Offset" && /^\+[0-9]+$/.test(value))
        add("Scaling_Offset", Number(value.slice(1)));
      else if (name === "Compatibility Tonemap Offset" && /^\+[0-9]+$/.test(value))
        add("Tonemap_Offset", Number(value.slice(1)));
      else if (name === "Compatibility Blit Copy" && value === "Scaling only")
        add("Blit_Copy_Hack", 3);
      else if (name === "Swapchain Proxy" && value === "On") add("Use_Swapchain_Proxy", 1);
      else if (name === "Swapchain Proxy" && value === "Compatibility")
        add("Use_Swapchain_Proxy", 2);
      else if (name === "Force Pipeline Cloning" && value === "On")
        add("Force_Pipeline_Cloning", 1);
      else if (name === "Color Grading Preset" && value === "SDR Grading Bypass") {
        add("ColorGradeContrast", 80);
        add("ColorGradeSaturation", 80);
        add("ColorGradeBlowout", 80);
      } else {
        throw new Error(`Unrecognized RenoDX setting for ${gameId}: ${name}=${value}`);
      }
    }
  }
  return settings.length ? { settings } : undefined;
}

/** Builds the v2 document from an already-normalized v1 document. */
export function buildV2Manifest(
  v1Manifest,
  { generatedAt = v1Manifest.generated_at, wikiGames = [], wikiMessages = [] } = {},
) {
  if (!v1Manifest || v1Manifest.schema_version !== 1) {
    throw new Error("buildV2Manifest expects a schema-v1 manifest");
  }
  const games = v1Manifest.games.map((game) => {
    const wikiGame = wikiGames.find((candidate) => candidate.id === game.id);
    const sourceGame = wikiGame ? { ...game, ...wikiGame } : game;
    const profileId = profileForGame(sourceGame);
    const decision = decisionForWikiGame(sourceGame, wikiMessages);
    const materialized = materializeGuidance(sourceGame, wikiMessages, decision);
    const config = compileRenoDxConfig(materialized, profileId, game.id);
    const presentation = materialized.flatMap((item) => {
      if (item.kind !== "addon_setting") return [item];
      const intentionallyUncompiled = item.settings?.some(
        ({ name, value }) =>
          RESOURCE_FORMATS.has(name) && resourceValue(name, value, game.id) === null,
      );
      if (intentionallyUncompiled) {
        const { settings: _settings, ...rest } = item;
        return [{ ...rest, kind: "compatibility" }];
      }
      return [];
    });
    const guidance = normalizeGuidance(presentation, `game "${game.id}"`);
    const result = {
      id: game.id,
      name: game.name,
      architecture: game.architecture,
      status: game.status,
      match: game.match,
      addon: game.addon,
    };
    for (const field of ["availability", "constraints", "proxy_dll"]) {
      if (game[field] !== undefined) result[field] = game[field];
    }
    if (guidance.length) result.guidance = guidance;
    if (config) result.renodx_config = config;
    if (profileId) result.profile_id = profileId;
    if (game.id === "black-myth-wukong") result.inherit_page_guidance = false;
    const nativeHdrOn = materialized.some(
      (item) =>
        item.kind === "game_setting" &&
        item.settings?.some(
          (setting) => setting.name === "Native HDR" && setting.value === "On",
        ),
    );
    const processingPath =
      decision?.processing_path ??
      (profileId === "ue_extended" && nativeHdrOn ? "native" : null);
    if (profileId === "ue_extended" && processingPath)
      result.processing_path = processingPath;
    if (decision?.launch) result.requirements = { launch: clone(decision.launch) };
    return result;
  });

  return {
    schema_version: 2,
    generated_at: generatedAt,
    games,
    page_guidance: normalizeGuidance(PAGE_GUIDANCE, "page guidance"),
    engine_profiles: PROFILE_DEFS.map((profile) => ({
      id: profile.id,
      engine: profile.engine,
      generic_fallback: profile.generic_fallback,
      status: profile.status,
      addon:
        profile.id === "ue_extended"
          ? {
              slug: "ue-extended",
              sources: {
                x64: "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
                x86: "https://marat569.github.io/renodx/renodx-ue-extended.addon32",
              },
            }
          : profile.id === "unity"
            ? {
                slug: "unityengine",
                sources: {
                  x64: "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon64",
                  x86: "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon32",
                },
              }
            : { slug: "unrealengine" },
      message: profile.message,
      guidance: normalizeGuidance(profile.guidance, `profile "${profile.id}"`),
      processing_path: "unmanaged",
    })),
  };
}

/** Validates that every guidance item in the v2 manifest matches messages.json. */
export function verifyMessagesCatalog(manifest, messagesCatalog) {
  if (!messagesCatalog || !Array.isArray(messagesCatalog.messages)) {
    throw new Error(
      "RenoDX messages catalog is required and must contain a messages array",
    );
  }
  const messageMap = new Map(messagesCatalog.messages.map((m) => [m.id, m]));

  function check(item, context) {
    if (!item) return;
    const id = item.message_id ?? item.id ?? item.message?.id;
    if (!id) {
      throw new Error(`RenoDX guidance in ${context} is missing a message id`);
    }
    const fallback = item.fallback_text ?? item.message?.fallback_text;
    if (!fallback) {
      throw new Error(`RenoDX guidance "${id}" in ${context} is missing fallback_text`);
    }
    const kind = item.kind ?? "compatibility";

    const catalogEntry = messageMap.get(id);
    if (!catalogEntry) {
      throw new Error(
        `RenoDX guidance id "${id}" in ${context} is missing from messages.json`,
      );
    }
    if (catalogEntry.fallback_text !== fallback) {
      throw new Error(
        `RenoDX guidance id "${id}" fallback_text mismatch between manifest and messages.json`,
      );
    }
    if (catalogEntry.kind !== kind) {
      throw new Error(
        `RenoDX guidance id "${id}" kind mismatch: expected "${kind}", got "${catalogEntry.kind}"`,
      );
    }
  }

  manifest.page_guidance?.forEach((g) => check(g, "page_guidance"));
  manifest.engine_profiles?.forEach((p) => {
    check(p.message, `engine_profiles[${p.id}].message`);
    p.guidance?.forEach((g) => check(g, `engine_profiles[${p.id}].guidance`));
  });
  manifest.games?.forEach((game) => {
    check(game.availability?.message, `game "${game.id}".availability`);
    game.guidance?.forEach((g) => check(g, `game "${game.id}".guidance`));
  });
}

/** Returns the public v2 manifest and the authoring-only review ledger. */
export function buildV2Artifacts(
  v1Manifest,
  {
    generatedAt = v1Manifest.generated_at,
    wikiGames = [],
    wikiMessages = [],
    wikiSource = null,
    messages,
  } = {},
) {
  verifyCurationLedger(wikiMessages, wikiSource);
  const manifest = buildV2Manifest(v1Manifest, { generatedAt, wikiGames, wikiMessages });
  verifyMessagesCatalog(manifest, messages);
  return { manifest };
}

export const V2_GUIDANCE = Object.freeze({ UE_HDR_CODE, UE_LUT_CODE });
