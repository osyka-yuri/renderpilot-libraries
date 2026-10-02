// Human-authored RenoDX wiki review. Assignments are intentionally keyed by
// the stable source row, never inferred from upstream prose. A sync may update
// the raw snapshot, but generation fails until the corresponding fingerprint
// and decision are reviewed here and in review-ledger.json.

import { UE_HDR_ENGINE_INI_RECIPE, engineIniGuidance } from "./engine-ini.mjs";

const decisions = new Map();

const keyList = (section, ids) =>
  ids
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => `${section}:${id}`);

const guidance = (kind, text, extra = {}) => ({ kind, fallback_text: text, ...extra });
const info = (text) => guidance("compatibility", text);
const warn = (text) => guidance("warning", text);
const external = (text, url) => guidance("external_tool", text, { url });
const addonSettings = (settings, text = "Apply these RenoDX settings for this game.") =>
  guidance("addon_setting", text, { settings });
const addonSetting = (name, value, text) => addonSettings([{ name, value }], text);
const gameSettings = (settings, text = "Apply these in-game settings.") =>
  guidance("game_setting", text, { settings });
const gameSetting = (name, value, text) => gameSettings([{ name, value }], text);
const ini = (text, recipe, condition) => engineIniGuidance(text, recipe, condition);
const manualIni = (text, code, condition) =>
  guidance("engine_ini", text, { code, ...(condition ? { condition } : {}) });
const launch = (arguments_, requirement = "required") => ({
  arguments: arguments_,
  requirement,
});

// A few upstream rows resolve to a different stable title/profile than the
// source section suggests. Keep their useful caveats on the final title entry
// instead of leaking an obsolete UE Extended processing decision.
export const RESOLVED_TITLE_GUIDANCE = Object.freeze({
  flyknight: [
    {
      id: "renodx.unreal.flyknight.filter_warning",
      kind: "compatibility",
      message_id: "renodx.unreal.flyknight.filter_warning",
      fallback_text: "In-game filters can alter HDR presentation.",
    },
    {
      id: "renodx.unreal.flyknight.limited_testing",
      kind: "compatibility",
      message_id: "renodx.unreal.flyknight.limited_testing",
      fallback_text: "This configuration has limited testing.",
    },
  ],
  "ghostrunner-2": [
    {
      id: "renodx.unreal.ghostrunner-2.limited_testing",
      kind: "compatibility",
      message_id: "renodx.unreal.ghostrunner-2.limited_testing",
      fallback_text: "Tonemapping issues remain; testing was limited.",
    },
  ],
  palworld: [
    {
      id: "renodx.unreal.palworld.limited_testing",
      kind: "compatibility",
      message_id: "renodx.unreal.palworld.limited_testing",
      fallback_text: "This configuration has limited testing.",
    },
  ],
  "the-first-berserker-khazan": [
    {
      id: "renodx.the_first_berserker_khazan.tonemapping",
      kind: "compatibility",
      message_id: "renodx.the_first_berserker_khazan.tonemapping",
      fallback_text: "Tonemapping issues remain; testing was limited.",
    },
  ],
});

function assign(keys, guidanceItems = [], options = {}) {
  for (const sourceKey of keys) {
    if (decisions.has(sourceKey))
      throw new Error(`Duplicate RenoDX review decision: ${sourceKey}`);
    decisions.set(sourceKey, {
      disposition: "curated_manual",
      guidance: guidanceItems,
      inherit_common: options.inheritCommon ?? false,
      launch: options.launch ?? null,
      processing_path: options.processingPath ?? null,
    });
  }
}

function omit(keys, reason) {
  for (const sourceKey of keys) {
    if (decisions.has(sourceKey))
      throw new Error(`Duplicate RenoDX review decision: ${sourceKey}`);
    decisions.set(sourceKey, {
      disposition: "omitted",
      reason,
      guidance: [],
      inherit_common: false,
      launch: null,
      processing_path: null,
    });
  }
}

function pending(keys, reason) {
  for (const sourceKey of keys) {
    if (decisions.has(sourceKey))
      throw new Error(`Duplicate RenoDX review decision: ${sourceKey}`);
    decisions.set(sourceKey, {
      disposition: "pending",
      reason,
      guidance: [],
      inherit_common: false,
      launch: null,
      processing_path: null,
    });
  }
}

// Main RenoDX table status notes.
omit(
  keyList(
    "main",
    "alice-madness-returns borderlands-2-the-pre-sequel child-of-light journey remember-me spec-ops-the-line",
  ),
  "The upstream note only redirects to another page and contains no actionable instruction.",
);
assign(keyList("main", "assassin-s-creed-iv-black-flagtm"), [
  info("The mod is playable, but some graphics issues remain unresolved."),
]);
assign(
  keyList(
    "main",
    "atelier-yumia-the-alchemist-of-memories-the-envisioned-land the-evil-within-2",
  ),
  [info("The mod is considered playable but still needs broader playtesting.")],
);
assign(keyList("main", "atlas-fallen-dx12"), [
  info("Install ReShade in the game's Atlas Fallen\\bin directory."),
  warn("FSR 2 can cause crashes with this mod."),
]);
assign(keyList("main", "clive-barker-s-jericho"), [
  warn("ACES output is currently broken in this build."),
]);
assign(keyList("main", "crimson-desert"), [
  info(
    "Frequent game updates can break the mod; re-check compatibility after each update.",
  ),
]);
assign(keyList("main", "days-gone"), [
  info("This dedicated build is functional, but its HDR result may still need refinement."),
]);
assign(keyList("main", "dead-island-riptide-definitive-edition steelrising"), [
  warn("The current dedicated mod build is broken."),
]);
assign(keyList("main", "dragon-s-dogma-2"), [
  warn(
    "After installing the mod, delete shader.cache2 from the game directory to avoid shader stutter.",
  ),
]);
assign(keyList("main", "forza-horizon-6"), [
  info(
    "The game's native HDR already works well; this mod offers an alternative presentation rather than an HDR fix.",
  ),
]);
assign(keyList("main", "ninja-gaiden-4 ninja-gaiden-sigma ninja-gaiden-sigma-2"), [
  external(
    "This mod requires Lyall's NinjaGaidenMCFix.",
    "https://codeberg.org/Lyall/NinjaGaidenMCFix",
  ),
]);
assign(keyList("main", "opus-echo-of-starsong-full-bloom-edition"), [
  gameSetting(
    "Steam Overlay",
    "Off",
    "Disable the Steam overlay. If problems remain, disable other overlays as well.",
  ),
]);
assign(keyList("main", "raidou-remastered-the-mystery-of-the-soulless-army"), [
  info("The mod needs more playtesting; shaders may be missing in later areas."),
]);
assign(keyList("main", "sonic-unleashed-recompiled"), [
  gameSetting("Motion Blur", "Off", "Disable motion blur before using this mod."),
  warn("The current mod build does not work on GeForce RTX 50-series GPUs."),
]);
assign(keyList("main", "tomb-raider-2013-definitive-edition"), [
  info("The mod can break lighting in some areas, including Chasm Monastery."),
]);
assign(keyList("main", "trackmania"), [
  info("HDR works well, but some customization menus are broken."),
]);
assign(keyList("main", "yakuza-kiwami-1"), [
  info(
    "This build was primarily designed for Yakuza 0; Yakuza Kiwami support is secondary.",
  ),
]);

// UE Extended table. These decisions intentionally describe the common
// UE Extended add-on; none of these rows creates a dedicated add-on.
assign(keyList("main", "s-t-a-l-k-e-r-2-heart-of-chornobyl"), [
  gameSettings(
    [
      { name: "Gamma", value: "50%" },
      { name: "Contrast", value: "50%" },
      { name: "Brightness", value: "50%" },
    ],
    "Apply these in-game display settings.",
  ),
]);
assign(
  keyList(
    "ue-extended",
    "assetto-corsa-rally borderlands-4 dead-as-disco deep-rock-galactic far-far-west ghostwire-tokyo jusant mafia-the-old-country s-t-a-l-k-e-r-2-heart-of-chornobyl star-wars-zero-companytm tokyo-xtreme-racer until-dawn",
  ),
  [gameSetting("Native HDR", "On", "Enable the game's native HDR.")],
);
assign(keyList("ue-extended", "days-gone"), [
  gameSetting("Native HDR", "On", "Enable the game's native HDR."),
  info("This configuration has limited playtesting."),
]);
assign(
  keyList("ue-extended", "astroneer"),
  [info("Color-grading errors and flickering may still occur.")],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "a-way-out"),
  [info("This configuration has limited playtesting.")],
  { processingPath: "upgrade" },
);
assign(keyList("ue-extended", "black-myth-wukong"), [
  manualIni(
    "For the UE Extended HDR path, add only this line to Engine.ini.",
    "r.HDR.EnableHDROutput=1",
  ),
]);
assign(keyList("ue-extended", "abiotic-factor"), [
  ini(
    "Add these settings to Engine.ini for the UE Extended HDR path.",
    UE_HDR_ENGINE_INI_RECIPE,
  ),
]);
assign(
  keyList("ue-extended", "abzu"),
  [
    addonSettings(
      [
        { name: "B8G8R8A8_TYPELESS", value: "Output Size at 100% render resolution" },
        { name: "B8G8R8A8_TYPELESS", value: "Output Ratio at other render resolutions" },
      ],
      "Choose the B8G8R8A8_TYPELESS upgrade according to the game's render-resolution scale.",
    ),
  ],
  { processingPath: "upgrade" },
);
assign(
  keyList(
    "ue-extended",
    "goat-simulator-3 ghostrunner hydroneer little-nightmares little-nightmares-enhanced scorn stray the-alters vholume",
  ),
  [],
  { inheritCommon: true, processingPath: "upgrade" },
);
omit(
  keyList(
    "ue-extended",
    "grand-theft-auto-the-trilogy-the-definitive-edition-iii-vice-city-san-andreas little-nightmares-ii-enhanced",
  ),
  "This UE Extended source row resolves to a legacy, dedicated, or absent manifest output; its guidance is intentionally not duplicated here.",
);
omit(
  keyList("ue-extended", "flyknight ghostrunner-2 palworld"),
  "Moved to resolved legacy title guidance; no UE Extended processing policy is emitted for this source row.",
);
omit(
  keyList("ue-extended", "the-first-berserker-khazan"),
  "Moved to resolved dedicated title guidance; no UE Extended processing policy is emitted for this source row.",
);
assign(
  keyList(
    "ue-extended",
    "bodycam choo-choo-charles conan-exiles-enhanced crab-champions everwind grounded-2 inzoi meccha-chameleon mortal-shell-ii nobody-wants-to-die quarantine-zone-the-last-check rv-there-yet satisfactory solarpunk subnautica-2 the-blood-of-dawnwalker the-enjenir-the-engineering-physics-building-simulator",
  ),
  [
    ini(
      "Add these settings to Engine.ini for the UE Extended HDR path.",
      UE_HDR_ENGINE_INI_RECIPE,
    ),
  ],
);
assign(keyList("ue-extended", "chained-together"), [
  ini(
    "Add these settings to Engine.ini for the UE Extended HDR path.",
    UE_HDR_ENGINE_INI_RECIPE,
  ),
  info("RenoDX slider changes do not apply in real time in this game."),
]);
assign(keyList("ue-extended", "ready-or-not"), [
  ini(
    "Add these settings to Engine.ini for the UE Extended HDR path.",
    UE_HDR_ENGINE_INI_RECIPE,
  ),
  info("RenoDX slider changes do not apply in real time in this game."),
  info("This configuration has limited playtesting."),
]);
assign(
  keyList("ue-extended", "chromatic-conundrum"),
  [warn("Upgrade Path is incompatible with this title and causes broken rendering.")],
  { inheritCommon: true, processingPath: "native" },
);
assign(
  keyList("ue-extended", "deep-rock-galactic-rogue-core"),
  [
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
    gameSetting(
      "Native HDR",
      "Off",
      "Keep the game's native HDR disabled; its native HDR path is broken.",
    ),
  ],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "escape-the-backrooms"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
    info("This configuration has limited playtesting."),
  ],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "pacific-drive"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "frostpunk-2"),
  [info("The RenoDX UI brightness slider controls paper white in this game.")],
  { processingPath: "upgrade" },
);
assign(keyList("ue-extended", "gothic-1-remake lords-of-the-fallen"), [
  gameSetting("Native HDR", "On", "Enable the game's native HDR."),
  info("Tonemapping issues may still occur."),
]);
assign(keyList("ue-extended", "it-takes-two"), [], {
  inheritCommon: true,
  processingPath: "upgrade",
});
assign(
  keyList(
    "ue-extended",
    "hellblade-ii-senua-s-saga lego-batmantm-legacy-of-the-dark-knight lies-of-p",
  ),
  [
    gameSetting("Native HDR", "On", "Enable the game's native HDR."),
    info("RenoDX slider changes do not apply in real time in this game."),
    info("This configuration has limited playtesting."),
  ],
);
assign(
  keyList("ue-extended", "hi-fi-rush"),
  [
    addonSettings([
      { name: "Upgrade Copy Destinations", value: "Off" },
      { name: "R8G8B8A8_TYPELESS", value: "Any Size" },
    ]),
    info(
      "The Engine.ini HDR path overexposes shading; this title uses the compatible Upgrade Path.",
    ),
    info("Gameplay highlights are clamped to the UI brightness setting."),
  ],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "the-idolm-ster-starlit-season"),
  [
    addonSettings([
      { name: "Upgrade Copy Destinations", value: "Off" },
      { name: "B8G8R8A8_TYPELESS", value: "Any Size" },
    ]),
    info(
      "Some communication and stage lighting remain clamped or do not produce HDR highlights.",
    ),
  ],
  { launch: launch(["-dx11"]), processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "little-nightmares-ii"),
  [info("Color-grading issues remain.")],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "motor-town-behind-the-wheel"),
  [info("RenoDX slider changes do not apply in real time in this game.")],
  { processingPath: "upgrade" },
);
assign(keyList("ue-extended", "persona-3-reload"), [], {
  inheritCommon: true,
  processingPath: "upgrade",
});
assign(
  keyList("ue-extended", "sifu"),
  [info("Peak brightness remains limited in some content.")],
  { processingPath: "upgrade" },
);
assign(
  keyList("ue-extended", "what-remains-of-edith-finch"),
  [
    info(
      "If HDR is clamped with high-DPI scaling, temporarily set Windows scaling to 100%, launch the game once, then restore the preferred scaling.",
    ),
  ],
  { processingPath: "upgrade" },
);

// Legacy Unreal table. Exact matches continue to use the legacy generic add-on;
// the table notes below are additive to the shared legacy instructions.
assign(
  keyList("unreal", "abiotic-factor"),
  [
    info(
      "Use DirectX 11. Some UI elements remain incorrect, and color-grading changes apply only after reloading.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx11"], "recommended") },
);
assign(
  keyList("unreal", "abzu"),
  [
    addonSettings(
      [
        { name: "B8G8R8A8_TYPELESS", value: "Output Size at 100% render resolution" },
        { name: "B8G8R8A8_TYPELESS", value: "Output Ratio at other render resolutions" },
      ],
      "Choose the B8G8R8A8_TYPELESS upgrade according to the game's render-resolution scale.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "age-of-darkness-final-stand"),
  [
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Output Ratio",
      "Set the R8G8B8A8_TYPELESS resource upgrade to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "aliens-dark-descent the-outer-worlds threshold"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Any Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "aphelion banishers-ghosts-of-new-eden"),
  [
    addonSettings([
      { name: "Upgrade Copy Destinations", value: "On" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unreal",
    "the-ascent asterigos-curse-of-the-stars the-awesome-adventures-of-captain-spirit bloodstained-ritual-of-the-night bramble-the-mountain-king call-of-the-sea chorus clash-artifacts-of-chaos daemon-x-machina daymare-1994-sandcastle demon-slayer-kny-hinokami-chronicles dnf-duel dragon-quest-iii-hd-2d-remake echo-point-nova escape-from-ever-after evil-west flyknight the-forgotten-city hyper-light-breaker indika the-invincible journey-to-the-savage-planet just-die-already kitten-burst life-is-strange-true-colors necromunda-hired-gun the-occupation octopath-traveler octopath-traveler-ii pacific-drive severed-steel solar-ash soulstice spongebob-squarepants-battle-for-bikini-bottom-rehydrated stray styx-shards-of-darkness sword-and-fairy-7 system-shock-remake terminator-resistance thymesia trek-to-yomi vampyr warhammer-40-000-boltgun we-happy-few weird-west",
  ),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-alters"),
  [
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "If Frame Generation causes a black screen, set R10G10B10A2_UNORM to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "ashen"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "astroneer"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
    info("Text can glitch during loading and in the backpack or mission log."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "atomic-heart grounded"),
  [
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "borderlands-3"),
  [
    addonSettings([
      { name: "Upgrade Copy Destinations", value: "On" },
      { name: "R8G8B8A8_TYPELESS", value: "Output Ratio" },
      { name: "B8G8R8A8_TYPELESS", value: "Output Ratio (optional)" },
      { name: "R11G11B10_FLOAT", value: "Output Ratio (optional)" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "bright-memory-infinite"),
  [
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
    info("Use DirectX 12."),
  ],
  { inheritCommon: true, launch: launch(["-dx12"], "recommended") },
);
assign(
  keyList("unreal", "the-cabin-factory"),
  [info("The mod works without resource upgrades, but color grading is not corrected.")],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "cepheus-protocol"),
  [
    addonSetting(
      "R10G10B10A2_UNORM",
      "Any Size",
      "Use this upgrade when resolution scale or screen percentage differs from 100%.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "chernobylite"),
  [
    info("Use DirectX 12."),
    info(
      "Changing DLSS quality can temporarily disable the game's excessive sharpening, but the workaround must be repeated each session.",
    ),
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true, launch: launch(["-dx12"], "recommended") },
);
assign(
  keyList("unreal", "choo-choo-charles"),
  [
    gameSetting(
      "Display Mode",
      "Windowed Fullscreen",
      "Set the game to Windowed Fullscreen manually.",
    ),
    info("Cutscenes can cause brightness problems."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "colony-ship-a-post-earth-role-playing-game"),
  [info("Some menus and the loading screen still need fixes.")],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "crisis-core-ff7-reunion"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size (automatic)",
      "RenoDX automatically upgrades B8G8R8A8_TYPELESS to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "cronos-the-new-dawn"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "dahlia-view"),
  [
    gameSetting(
      "Native HDR",
      "Off",
      "Disable the game's broken native HDR, especially when using DirectX 12.",
    ),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "darksiders-3"),
  [info("Non-boss enemy health bars do not update correctly.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unreal", "darksiders-genesis"),
  [
    info("Some loading-screen text can render as solid blocks."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "dead-as-disco"),
  [
    info("This profile was tested only with the demo."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "deadlink"),
  [
    info("Use DirectX 12."),
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Any Size",
      "Set the R8G8B8A8_TYPELESS resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx12"], "recommended") },
);
assign(
  keyList("unreal", "deep-rock-galactic mafia-the-old-country marvel-s-midnight-suns"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "dragon-ball-z-kakarot"),
  [
    info("Some colors remain inaccurate."),
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size at 100% render resolution" },
      { name: "B8G8R8A8_TYPELESS", value: "Output Ratio at other render resolutions" },
    ]),
  ],
  { inheritCommon: true },
);
assign(keyList("unreal", "en-garde"), [warn("DirectX 12 crashes; use DirectX 11.")], {
  inheritCommon: true,
  launch: launch(["-dx11"]),
});
assign(
  keyList("unreal", "enotria-the-last-song"),
  [
    info(
      "Slider changes apply only after a scene change or after returning from the main menu.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "everspace"),
  [
    info(
      "Use the 64-bit RSG-Win64-Shipping.exe. This configuration was tested only with the GOG release.",
    ),
    addonSettings([
      { name: "R8G8B8A8_TYPELESS", value: "Output Size" },
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "everspace-2"),
  [
    info("Use DirectX 12."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx12"], "recommended") },
);
assign(
  keyList("unreal", "forgive-me-father"),
  [
    info("Some text can render as solid blocks."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unreal",
    "fort-solis gothic-1-remake infinity-nikki inzoi jusant the-midnight-walk motorslice remnant-2 rv-there-yet witchfire",
  ),
  [
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "ghostrunner"),
  [
    warn("DirectX 12 crashes; use DirectX 11."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx11"]) },
);
assign(
  keyList("unreal", "ghostrunner-2"),
  [
    info("Output remains limited to BT.709."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "granblue-fantasy-versus"),
  [
    info("Character and map highlights are clamped to the UI brightness level."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "guilty-gear-strive"),
  [
    warn(
      "Health bars do not update, character selection can show corruption, and the tension meter is excessively bright.",
    ),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "hell-is-us"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    info("This profile was tested only with the demo."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
omit(
  keyList("unreal", "hogwarts-legacy"),
  "The upstream note only redirects to the RenoDX Discord channel for the generic Unreal Engine build that RenderPilot already provides automatically.",
);
assign(
  keyList("unreal", "industria"),
  [
    info("Use DirectX 12."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx12"], "recommended") },
);
assign(
  keyList("unreal", "islands-of-insight"),
  [
    info("Output remains limited to BT.709."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "it-takes-two"),
  [
    info("A full playthrough completed without general failures."),
    info(
      "Underwater sections remain SDR; some space scenes have incorrect colors, and some fades to white look wrong.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "jdm-japanese-drift-master"),
  [
    info("Slider changes require a scene change before they appear."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "kena-bridge-of-spirits"),
  [info("Cutscene brightness is clamped to the UI brightness level.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unreal", "kingdom-hearts-iii"),
  [
    info("Texture flickering can occur."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "lay-of-the-land"),
  [
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "B8G8R8A8_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "lego-2k-drive"),
  [
    info(
      "The mod works without resource upgrades, although some vehicle headlights may still be clamped.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "lies-of-p lost-soul-aside police-simulator-patrol-officer"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "lightyear-frontier"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Ratio",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "little-nightmares little-nightmares-enhanced-edition"),
  [
    addonSetting(
      "Saturation Correction",
      "Off",
      "Disable Saturation Correction to preserve the game's color grading.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "little-nightmares-ii"),
  [info("The mod works without resource upgrades, but gamut clamping may be required.")],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "little-nightmares-iii"),
  [
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "lords-of-the-fallen-2023"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    gameSetting("Easy Anti-Cheat", "Off", "Disable Easy Anti-Cheat before using the mod."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "master-detective-archives-rain-code-plus"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Ratio (automatic)",
      "RenoDX automatically upgrades B8G8R8A8_TYPELESS to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-medium"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    info("Highlights in the spirit world are clamped to the UI brightness level."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Any Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "metal-eden"),
  [
    info("The main menu and respawn screen can show corruption."),
    info("This profile was tested only with the demo."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "metro-gravity"),
  [
    addonSetting(
      "Color Grading Preset",
      "SDR Grading Bypass",
      "Use the SDR Grading Bypass color-grading preset.",
    ),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Any Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "miasma-chronicles the-outlast-trials"),
  [
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Output Size",
      "Set the R8G8B8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "murky-divers"),
  [
    info("Gamut clamping may be required."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Any Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(keyList("unreal", "neverness-to-everness"), [
  external(
    "Follow the game's detailed RenoDX setup instructions.",
    "https://github.com/clshortfuse/renodx/discussions/557",
  ),
]);
assign(
  keyList("unreal", "ninja-gaiden-2-black"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    info("RenoDX slider changes do not apply in real time in this game."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "nobody-wants-to-die"),
  [
    info(
      "Slider changes apply only after a scene change or after returning from the main menu.",
    ),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "outriders"),
  [
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R8G8B8A8_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-outer-worlds-spacer-s-choice-edition"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Any Size (optional)",
      "This optional upgrade prevents HDR from being disabled in some scenes but breaks FMVs.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-outer-worlds-2"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    info("Invalid color values can appear during FMVs."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "palworld"),
  [
    gameSetting("DLSS", "Off", "Disable DLSS because it clamps output to SDR."),
    addonSettings([
      { name: "R8G8B8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "persona-3-reload"),
  [
    info("The map background is excessively bright while its entrance animation plays."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "psychonauts-2"),
  [
    addonSettings([
      { name: "R8G8B8A8_TYPELESS", value: "Output Size (automatic)" },
      { name: "R10G10B10A2_UNORM", value: "Output Size (automatic)" },
      { name: "Force Borderless", value: "Disabled" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "ready-or-not"),
  [
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
    info(
      "Slider changes apply only after a scene change or after returning from the main menu.",
    ),
  ],
  { inheritCommon: true },
);
assign(keyList("unreal", "reanimal"), [
  info(
    "The game already provides a proper custom HDR implementation; RenoDX is generally unnecessary.",
  ),
]);
assign(
  keyList("unreal", "redout-2"),
  [
    warn("The game may crash with this profile."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "returnal"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR after every launch."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "runescape-dragonwilds"),
  [
    info("If the game is unstable, switch to DirectX 11 in its graphics settings."),
    info(
      "Slider changes apply only after a scene change or after returning from the main menu.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "sackboy-a-big-adventure"),
  [
    addonSettings([
      {
        name: "B8G8R8A8_TYPELESS",
        value: "Output Size at 100% render resolution; Output Ratio otherwise",
      },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "satisfactory"),
  [
    gameSetting(
      "Upscaling",
      "DLSS at 99% or lower",
      "DLAA does not work with this profile; use DLSS at 99% scaling or lower.",
    ),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "scarlet-nexus"),
  [
    warn("Visual-novel scenes are broken."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "scorn"),
  [
    addonSetting(
      "Color Grading Preset",
      "SDR Grading Bypass",
      "Use the SDR Grading Bypass color-grading preset.",
    ),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "sifu"),
  [
    info(
      "Most content remains near SDR brightness; only specular highlights, fire, and the sun become substantially brighter.",
    ),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "six-days-in-fallujah"),
  [
    info("A dark artifact can appear around the sun, and smoke may render too dark."),
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-smurfs-dreams"),
  [
    info("The RenoDX UI brightness slider also affects FMVs."),
    addonSettings([
      { name: "B8G8R8A8_TYPELESS", value: "Output Size" },
      { name: "R10G10B10A2_UNORM", value: "Output Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "sonic-racing-crossworlds"),
  [
    info("Slider changes apply after restarting the track."),
    info(
      "Bright elements are clamped to UI brightness, and the Water Palace sky remains excessively bright.",
    ),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Ratio",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "south-of-midnight"),
  [
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Ratio",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "split-fiction"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    info("Slider changes may require a scene change before they appear."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "squirrel-with-a-gun"),
  [addonSetting("Swap Chain Format", "scRGB", "Set RenoDX Swap Chain Format to scRGB.")],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "stellar-blade"),
  [
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
    gameSetting(
      "Aspect Ratio",
      "Auto",
      "On ultrawide displays, use the in-game Auto aspect ratio to avoid NIKKE minigame problems.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "tales-of-arise"),
  [
    info("Bloom can occasionally render incorrectly."),
    gameSetting(
      "Anti-Aliasing",
      "TAA or Off",
      "SMAA and SMAA + TAA are unsupported; use TAA or disable anti-aliasing.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "tales-of-kenzera-zau"),
  [
    warn("Update libxess.dll before using XeSS to prevent crashes."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "tekken-7"),
  [
    info("Some stages are clamped to the UI brightness level."),
    addonSetting(
      "B8G8R8A8_TYPELESS",
      "Output Size",
      "Set the B8G8R8A8_TYPELESS resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "the-thaumaturge"),
  [
    info("Some scenes remain brightness-clamped."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "tiny-tina-s-wonderlands"),
  [
    gameSetting(
      "FidelityFX Sharpening",
      "Off",
      "Disable the game's FidelityFX Sharpening.",
    ),
    addonSettings([
      { name: "Upgrade Copy Destinations", value: "On" },
      { name: "R8G8B8A8_TYPELESS", value: "Output Ratio" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unreal", "tokyo-xtreme-racer"),
  [
    info("Use DirectX 11."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true, launch: launch(["-dx11"], "recommended") },
);
assign(
  keyList("unreal", "vampire-the-masquerade-bloodlines-2"),
  [
    info("Cutscenes remain brightness-clamped."),
    addonSetting(
      "R10G10B10A2_UNORM",
      "Output Size",
      "Set the R10G10B10A2_UNORM resource upgrade to Output Size.",
    ),
  ],
  { inheritCommon: true },
);

// Unity table. All rows use the shared Unity add-on; these are reviewed title
// requirements layered over the shared Unity guidance.
assign(
  keyList(
    "unity",
    "60-parsecs for-the-king-ii keywe outer-wilds road-redemption shadows-awakening",
  ),
  [info("Tonemapping and color-grading changes do not appear in real time.")],
  { inheritCommon: true },
);
assign(
  keyList("unity", "7-days-to-die"),
  [
    addonSetting(
      "Swapchain Proxy",
      "On",
      "Enable Swapchain Proxy when using Dynamic Resolution or render scaling.",
    ),
  ],
  { inheritCommon: true },
);
omit(
  keyList(
    "unity",
    "aer-memories-of-old among-the-sleep-enhanced-edition bad-north-jotunn-edition blackwind satellite-reign vigil-the-longest-night warhammer-40-000-shootas-blood-teef",
  ),
  "The 32-bit requirement is represented by the manifest architecture.",
);
assign(
  keyList("unity", "aeterna-noctis"),
  [
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Output Ratio or Any Size",
      "Upgrade R8G8B8A8_TYPELESS to Output Ratio or Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "afterparty akiba-s-trip-hellbound-debriefed battlestar-galactica-deadlock children-of-morta cloudpunk ctrl-alt-ego cuphead fantasy-general-ii far-lone-sails firewatch for-the-king incision katamari-damacy-reroll keep-talking-and-nobody-explodes kona lego-voyagers lost-in-vivo mages-of-mystralia overcooked-2 playing-kafka space-crew streets-of-rogue the-pedestrian two-point-hospital unruly-heroes valley",
  ),
  [addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy.")],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "agatha-christie-death-on-the-nile all-we-need altheia-the-wrath-of-aferi amerzone-the-explorer-s-legacy-2025 bendy-secrets-of-the-machine blazblue-entropy-effect bo-path-of-the-teal-lotus bounty-star breachway bubsy-4d cakey-s-twisted-bakery children-of-the-sun circuit-superstars coridden dave-the-diver deep-rock-survivor dino-topia dracomaton eiyuden-chronicle-hundred-heroes eiyuden-chronicle-rising el-paso-elsewhere encased enigma-of-fear ereban-shadow-legacy five-nights-at-freddy-s-into-the-pit flashback-2 forgotten-23 gatekeeper giggleland-terry-s-vegetable-patch halve-demo hardspace-shipbreaker hordelord hunter-hunter-nen-impact in-sound-mind killer-frequency kill-knight little-kitty-big-city little-noah-scion-of-paradise little-witch-in-the-woods lost-in-random mai-child-of-ages maid-of-sker metal-hellsinger my-friendly-neighborhood neoverse node-the-last-favor-of-the-antarii operation-wolf-returns-first-mission oxenfree-ii-lost-signals reka reveil road-96-mile-0 shadow-labyrinth shadow-of-the-road-demo shadows-of-doubt shift-87 soulstone-survivors spacebase-startopia super-crazy-rhythm-castle sworn syberia-remastered syberia-the-world-before tainted-grail-conquest teenage-mutant-ninja-turtles-mutants-unleashed the-karters-2-turbo-charged the-knightling the-rogue-prince-of-persia tin-can tinykin touhou-dystopian wavetale we-were-here-expeditions-the-friendship witchspring-r-the-story-of-pieberry yooka-replaylee",
  ),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "agent-a-a-puzzle-in-disguise atlyss ball-x-pit beyond-galaxyland oxenfree",
  ),
  [addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma.")],
  { inheritCommon: true },
);
assign(
  keyList("unity", "american-fugitive"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    gameSetting(
      "Graphics Quality",
      "Medium or higher",
      "Set the game's Graphics Quality to Medium or higher.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "anodyne-2-return-to-dust"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "aragami"),
  [info("Tonemapping and color grading update after restarting the level.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "aragami-2 atomic-owl"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "arkham-horror-mother-s-embrace"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Swapchain Proxy", value: "On" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "assault-android-cactus"),
  [addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList(
    "unity",
    "autonauts autonauts-vs-piratebots before-your-eyes ben-10-power-trip enter-the-gungeon exit-the-gungeon fe observation pillars-of-eternity-ii-deadfire praey-for-the-gods wasteland-2-directors-cut",
  ),
  [addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy.")],
  { inheritCommon: true },
);
assign(
  keyList("unity", "batbarian-testament-of-the-primordials"),
  [
    addonSettings([
      { name: "R8G8B8A8_TYPELESS", value: "Any Size" },
      { name: "Swapchain Proxy", value: "On" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "beholder"),
  [
    addonSettings([
      { name: "R8G8B8A8_TYPELESS", value: "Any Size" },
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "beholder-2 stick-fight-the-game the-first-tree"),
  [addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy.")],
  { inheritCommon: true },
);
assign(
  keyList("unity", "bendy-and-the-ink-machine"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    info("Tonemapping and color-grading changes do not appear in real time."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "besiege"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "bionic-bay"),
  [warn("The game is not yet fully playable with this profile.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "biped"),
  [
    info(
      "Load a save point to refresh tonemapping and color grading after changing sliders.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "bloody-hell shape-of-dreams"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "cat-quest-iii"),
  [addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma.")],
  {
    inheritCommon: true,
  },
);
assign(keyList("unity", "cloverpit"), [info("Launch the game's DirectX 11 option.")], {
  inheritCommon: true,
  launch: launch(["-force-d3d11"]),
});
assign(
  keyList("unity", "copycat egging-on front-mission-2-remake nocturnal"),
  [
    addonSetting(
      "R10G10B10A2_TYPELESS",
      "Upgrade",
      "Upgrade the R10G10B10A2_TYPELESS resource format.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "creature-kitchen r-e-p-o"),
  [
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Any Size",
      "Set the R8G8B8A8_TYPELESS resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "deadcore-redux-demo jotunnslayer-hordes-of-hel"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    info("Tonemapping and color-grading changes do not appear in real time."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "digimon-world-next-order"),
  [addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "dragon-quest-builders"),
  [gameSetting("Bloom", "On", "Enable in-game bloom; it can be disabled later in RenoDX.")],
  { inheritCommon: true },
);
omit(
  keyList("unity", "dread-delusion dredge sunless-skies-sovereign-edition"),
  "The 32-bit requirement is represented by the manifest architecture.",
);
assign(
  keyList("unity", "dreamfall-chapters-the-final-cut"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    info("Save-preview images are broken."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "dread-templar"),
  [
    warn(
      "Applying or saving RenoDX settings crashes the game, but the settings are still saved.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "dungeons-2"),
  [
    addonSettings([
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
    warn(
      "The main menu is black; rendering returns to normal after loading into the game.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "dungeons-3"),
  [addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "dungeons-4"),
  [
    info(
      "Change the game's Brightness or Gamma control to refresh the LUT after adjusting RenoDX.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "dystopika end-transmission party-club towa-and-the-guardians-of-the-sacred-tree",
  ),
  [
    addonSettings([
      { name: "R10G10B10A2_TYPELESS", value: "Upgrade" },
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "eastern-exorcist"),
  [
    addonSettings([
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "eastshade"),
  [info("Open the game's Brightness control and save it to refresh the LUT.")],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "epistory-typing-chronicles icey new-super-lucky-s-tale quern-undying-thoughts terratech",
  ),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "drova-forsaken-kin"),
  [
    gameSetting("Display Mode", "Borderless Windowed", "Use Borderless Windowed mode."),
    addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "fabledom"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    addonSetting(
      "Compatibility Blit Copy",
      "Scaling only",
      "When in-game anti-aliasing is enabled, set Compatibility Blit Copy to Scaling only.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "fallen-aces"),
  [
    addonSettings([
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "gamble-with-your-friends"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Force Pipeline Cloning", value: "On" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "ghost-of-a-tale"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    gameSetting("Bloom", "On", "Enable in-game bloom; it can be disabled later in RenoDX."),
  ],
  { inheritCommon: true },
);
pending(
  keyList(
    "unity",
    "golf-with-your-friends gunfire-reborn lego-bricktales monster-train morbid-metal-demo phasmophobia",
  ),
  "The upstream resource-upgrade instruction is incomplete and does not identify a format.",
);
assign(
  keyList("unity", "great-god-grove"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Output Ratio",
      "Upgrade R11G11B10_FLOAT to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "have-a-nice-death i-know-a-guy-shady-life-simulator sektori"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "heart-of-the-machine"),
  [
    addonSetting(
      "Compatibility Scaling Offset",
      "+1",
      "Set Compatibility Scaling Offset to +1.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "herdling"),
  [
    gameSetting(
      "Native HDR",
      "Off",
      "Disable the game's native HDR in its configuration file.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "hollow-cocoon"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    gameSetting("Rendering Quality", "100%", "Set the game's Rendering Quality to 100%."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "house-flipper-2"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    info("Change the game's Saturation control to refresh tonemapping and color grading."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "human-fall-flat"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "kaze-and-the-wild-masks"),
  [
    addonSetting(
      "R8G8B8A8_TYPELESS",
      "Any Size",
      "Set the R8G8B8A8_TYPELESS resource upgrade to Any Size.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "kerbal-space-program monument-valley monument-valley-2"),
  [addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma.")],
  { inheritCommon: true },
);
assign(
  keyList("unity", "lumines-arise"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Output Ratio",
      "Set the R11G11B10_FLOAT resource upgrade to Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "lysfanga-the-time-shift-warrior"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Compatibility Scaling Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
pending(
  keyList("unity", "moonlighter nova-lands spellforce-conquest-of-eo"),
  "The upstream Swapchain Proxy instruction is explicitly uncertain.",
);
assign(
  keyList("unity", "mouthwashing"),
  [
    gameSetting("Display Mode", "Borderless", "Use Borderless display mode."),
    addonSettings([
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
      { name: "R8G8B8A8_TYPELESS", value: "Output Ratio" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "my-friend-pedro"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    info("Restart the level to refresh tonemapping and color grading."),
  ],
  { inheritCommon: true },
);
assign(keyList("unity", "necropolis-brutal-edition"), [
  external(
    "Load ReShade through Ultimate ASI Loader for this 32-bit game.",
    "https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases",
  ),
]);
assign(
  keyList("unity", "neon-abyss"),
  [
    addonSettings([
      { name: "R16G16B16A16_TYPELESS", value: "Upgrade" },
      { name: "Swapchain Proxy", value: "On" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "nottolot"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "oddworld-soulstorm-enhanced-edition"),
  [
    addonSetting(
      "R10G10B10A2_TYPELESS",
      "Upgrade",
      "Upgrade the R10G10B10A2_TYPELESS resource format.",
    ),
    info("Restart a checkpoint or level to refresh tonemapping and color grading."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "order-13"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    info("Change the in-game Brightness setting to refresh tonemapping and color grading."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "overcooked"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "overcooked-all-you-can-eat"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "R8G8B8A8_TYPELESS", value: "Output Ratio or Any Size" },
    ]),
  ],
  { inheritCommon: true },
);
assign(keyList("unity", "peak"), [info("Launch the game with DirectX 11.")], {
  inheritCommon: true,
  launch: launch(["-force-d3d11"]),
});
assign(
  keyList("unity", "pillars-of-eternity"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(keyList("unity", "prince-of-persia-the-lost-crown"), [
  info("RenoDX cannot affect color grading beyond Peak and UI Brightness in this game."),
  external(
    "Use the dedicated Luma Framework mod for full correction.",
    "https://github.com/Filoppi/Luma-Framework",
  ),
]);
assign(
  keyList("unity", "ruined-king-a-league-of-legends-storytm"),
  [info("The pause-menu background is broken.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "skate-story"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    gameSetting("Native HDR", "Off", "Disable the game's native HDR."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "sker-ritual"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    info(
      "Open the game's graphics settings and select Apply to refresh tonemapping and color grading.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "songs-of-silence"),
  [
    addonSettings([
      { name: "R10G10B10A2_TYPELESS", value: "Upgrade" },
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Compatibility Scaling Offset", value: "+2" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "spiritfall"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Swapchain Proxy", value: "On" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "spooky-s-jump-scare-mansion-hd-renovation"),
  [
    addonSettings([
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "Compatibility Scaling Offset", value: "+1" },
      { name: "Compatibility Tonemap Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "summoner-s-war-chronicles"),
  [gameSetting("Bloom", "On", "Enable bloom in the game settings.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "superhot"),
  [addonSetting("Swapchain Encoding", "Gamma", "Set Swapchain Encoding to Gamma.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "superhot-mind-control-delete"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "tales-of-berseria-remastered"),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "R8G8B8A8_TYPELESS", value: "Upgrade" },
    ]),
    info("The correction also affects animated FMV cutscenes."),
  ],
  { inheritCommon: true },
);
assign(
  keyList(
    "unity",
    "tales-of-xillia-remastered tales-of-the-shire-a-the-lord-of-the-ringstm-game",
  ),
  [
    addonSettings([
      { name: "Swapchain Proxy", value: "On" },
      { name: "Swapchain Encoding", value: "Gamma" },
      { name: "R8G8B8A8_TYPELESS", value: "Upgrade" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "the-upturned"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Compatibility Scaling Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "towaga-among-shadows"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    gameSetting("Post-processing", "On", "Enable post-processing in the game settings."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "trailmakers"),
  [
    gameSetting("Post Processing", "On", "Enable post-processing at any quality level."),
    gameSetting("Internal HDR", "On", "Enable Internal HDR in the game settings."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "turbo-golf-racing"),
  [
    gameSetting(
      "Post-Processing",
      "On",
      "Enable post-processing in the game's graphics settings.",
    ),
  ],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "ultros"),
  [gameSetting("Color Grading", "On", "Enable color grading in the game settings.")],
  {
    inheritCommon: true,
  },
);
assign(
  keyList("unity", "undying"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Output Ratio or higher",
      "When using FSR 1, set the R11G11B10_FLOAT resource upgrade to at least Output Ratio.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "viewfinder"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    gameSetting("Post-processing", "On", "Enable post-processing in the game settings."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "void-crew"),
  [
    addonSetting(
      "R11G11B10_FLOAT",
      "Upgrade",
      "Upgrade the R11G11B10_FLOAT resource format.",
    ),
    info("DLSS clamps colors to BT.709."),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "v-rising"),
  [
    info("In solo play, toggle the Pause or Options menu to refresh the LUT."),
    info(
      "In multiplayer, stand in sunlight or open Graphics > Calibrate Brightness and confirm the default value of 50 to refresh the LUT.",
    ),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "wasteland-3"),
  [
    addonSettings([
      { name: "R11G11B10_FLOAT", value: "Upgrade" },
      { name: "Swapchain Proxy", value: "On" },
      { name: "Compatibility Scaling Offset", value: "+1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "windblown"),
  [
    addonSettings([
      { name: "R10G10B10A2_TYPELESS", value: "Upgrade when using FSR 1" },
      { name: "R11G11B10_FLOAT", value: "Upgrade when using FSR 1" },
    ]),
  ],
  { inheritCommon: true },
);
assign(
  keyList("unity", "wizard-with-a-gun"),
  [
    addonSetting("Swapchain Proxy", "On", "Enable RenoDX Swapchain Proxy."),
    info(
      "Increase the Highlights slider substantially because the default highlights are dim.",
    ),
  ],
  { inheritCommon: true },
);

export function reviewedDecision(sourceKey) {
  const decision = decisions.get(sourceKey);
  if (!decision) return null;
  return structuredClone(decision);
}

export function reviewedSourceKeys() {
  return new Set(decisions.keys());
}
