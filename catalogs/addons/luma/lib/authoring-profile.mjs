import {
  assertPlainObject,
  requiredNonEmptyString,
} from "../../../../scripts/lib/common.mjs";
import {
  assertAllowedValue,
  assertOptionalNonEmptyStringArray,
  LOWERCASE_SHA256_RE,
} from "../../../../scripts/lib/validators.mjs";
import {
  normalizeAppid,
  normalizeExeName,
} from "../../../../scripts/lib/overlay-shared.mjs";
import {
  normalizeExternalRequirement,
  normalizeGameDirectoryFile,
} from "./managed-dependency.mjs";
import {
  ENGINE_PROFILES,
  UNREAL_ASSET,
  isSharedEngineAsset,
  sharedAssetForProfile,
} from "./v1.mjs";

const ARCHITECTURES = new Set(["X86", "X64"]);
const ASSET_PREFIX = "Luma-";
const ASSET_SUFFIX = ".zip";
const ASSET_FORBIDDEN_MARKERS = ["-test", "-dev"];
const ASSET_X32_SUFFIX = "-x32";
const ASSET_NAME_CHAR_RE = /^[A-Za-z0-9._()'-]+$/u;
const ADDON_PREFIX = "Luma-";
const ADDON_SUFFIX = ".addon";
const FEATURE_STATUSES = new Set(["supported", "unsupported", "experimental", "unknown"]);
const GUIDANCE_KINDS = new Set([
  "game_setting",
  "engine_ini",
  "launch_argument",
  "warning",
  "compatibility",
  "external_tool",
]);
const CODE_GUIDANCE_KINDS = new Set(["engine_ini", "launch_argument"]);
const GUIDANCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const WIKI_REVIEW_SECTIONS = new Set(["completed", "unreal"]);
const WIKI_REVIEW_DISPOSITIONS = new Set(["published", "omitted"]);
const MATCH_KINDS = new Set(["steam_appid", "epic_id", "gog_id", "exe_sha256", "exe_name"]);

export function normalizeCuratedGames(curatedGames) {
  if (!Array.isArray(curatedGames)) {
    throw new Error("curated_games.json must be an array");
  }
  return curatedGames.map(normalizeCuratedGame);
}

function normalizeCuratedGame(game, index) {
  const context = `curated_games.json[${index}]`;
  assertPlainObject(game, context);

  if (game.generic !== undefined) {
    throw new Error(`${context}.generic is obsolete; use an explicit engine profile`);
  }

  const arch = assertAllowedValue(
    requiredNonEmptyString(game.arch, `${context}.arch`),
    ARCHITECTURES,
    `${context}.arch`,
  );
  const asset = normalizeAsset(
    requiredNonEmptyString(game.asset, `${context}.asset`),
    arch,
    context,
  );
  const profile = normalizeProfile(game.profile, asset, arch, context);
  const guidance = normalizeGuidance(game.guidance, `${context}.guidance`);
  const wikiNoteReviews = normalizeWikiNoteReviews(
    game.wiki_note_reviews,
    `${context}.wiki_note_reviews`,
  );
  assertReviewGuidanceReferences(guidance, wikiNoteReviews, context);

  if (game.match_ignore !== undefined && typeof game.match_ignore !== "boolean") {
    throw new Error(`${context}.match_ignore must be a boolean when present`);
  }

  return {
    id: requiredNonEmptyString(game.id, `${context}.id`),
    name: requiredNonEmptyString(game.name, `${context}.name`),
    asset,
    addon_file: normalizeAddonFile(
      requiredNonEmptyString(game.addon_file, `${context}.addon_file`),
      context,
    ),
    arch,
    profile,
    status: game.status,
    match: normalizeMatchRules(game.match, `${context}.match`),
    match_ignore: game.match_ignore === true,
    blacklist:
      game.blacklist === undefined
        ? null
        : requiredNonEmptyString(game.blacklist, `${context}.blacklist`),
    launch_args: assertOptionalNonEmptyStringArray(
      game.launch_args,
      `${context}.launch_args`,
    ),
    external_requirement: normalizeExternalRequirement(
      game.external_requirement,
      `${context}.external_requirement`,
    ),
    features: normalizeFeatures(game.features, profile, context),
    guidance,
    wiki_note_reviews: wikiNoteReviews,
  };
}

function normalizeProfile(value, asset, arch, context) {
  let profile = "game";
  if (value !== undefined) {
    const authoredProfile = requiredNonEmptyString(value, `${context}.profile`);
    if (authoredProfile === "game") {
      throw new Error(`${context}.profile must be omitted for a game-specific payload`);
    }
    profile = assertAllowedValue(authoredProfile, ENGINE_PROFILES, `${context}.profile`);
  }

  if (profile === "game") {
    if (isSharedEngineAsset(asset)) {
      throw new Error(`${context}.profile is required for shared asset ${asset}`);
    }
    return profile;
  }

  const expectedAsset = sharedAssetForProfile(profile, arch);
  if (asset !== expectedAsset) {
    throw new Error(
      `${context}.asset must be ${expectedAsset} for ${profile} ${arch} profile`,
    );
  }
  return profile;
}

export function normalizeMatchRules(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array when present`);

  return value.map((rule, index) => {
    const ruleContext = `${context}[${index}]`;
    assertPlainObject(rule, ruleContext);
    const kind = requiredNonEmptyString(rule.kind, `${ruleContext}.kind`);
    if (!MATCH_KINDS.has(kind)) {
      throw new Error(`${ruleContext}.kind is unsupported: ${kind}`);
    }
    const ruleValue = normalizeMatchRuleValue(kind, rule.value, `${ruleContext}.value`);
    if (!Number.isInteger(rule.tier) || rule.tier <= 0) {
      throw new Error(`${ruleContext}.tier must be a positive integer`);
    }
    return { kind, value: ruleValue, tier: rule.tier };
  });
}

function normalizeMatchRuleValue(kind, value, context) {
  const normalized = requiredNonEmptyString(value, context);

  switch (kind) {
    case "steam_appid":
      return normalizeAppid(normalized, context);
    case "exe_name":
      return normalizeExeName(normalized, context);
    case "exe_sha256":
      if (!LOWERCASE_SHA256_RE.test(normalized)) {
        throw new Error(`${context} must be a lowercase SHA-256 digest`);
      }
      return normalized;
    default:
      return normalized;
  }
}

function normalizeFeatures(features, profile, context) {
  if (profile !== "unreal") {
    if (features !== undefined) {
      throw new Error(`${context}.features is only valid for the unreal profile`);
    }
    return null;
  }

  assertPlainObject(features, `${context}.features`);
  return {
    dlss_fsr: assertAllowedValue(
      requiredNonEmptyString(features.dlss_fsr, `${context}.features.dlss_fsr`),
      FEATURE_STATUSES,
      `${context}.features.dlss_fsr`,
    ),
    hdr: assertAllowedValue(
      requiredNonEmptyString(features.hdr, `${context}.features.hdr`),
      FEATURE_STATUSES,
      `${context}.features.hdr`,
    ),
  };
}

function assertReviewGuidanceReferences(guidance, reviews, context) {
  const guidanceIds = new Set(guidance.map((item) => item.id));
  for (const review of reviews) {
    for (const id of review.guidance_ids ?? []) {
      if (!guidanceIds.has(id)) {
        throw new Error(
          `${context}.wiki_note_reviews references unknown guidance id "${id}"`,
        );
      }
    }
  }
}

function normalizeGuidance(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array when present`);

  const ids = new Set();
  return value.map((item, index) => {
    const itemContext = `${context}[${index}]`;
    assertPlainObject(item, itemContext);
    const id = requiredNonEmptyString(item.id, `${itemContext}.id`);
    if (!GUIDANCE_ID_RE.test(id)) {
      throw new Error(
        `${itemContext}.id must be lowercase ASCII and use only . _ - separators`,
      );
    }
    if (ids.has(id)) throw new Error(`${context} contains duplicate guidance id "${id}"`);
    ids.add(id);

    const kind = assertAllowedValue(
      requiredNonEmptyString(item.kind, `${itemContext}.kind`),
      GUIDANCE_KINDS,
      `${itemContext}.kind`,
    );
    const fallbackText = requiredNonEmptyString(
      item.fallback_text,
      `${itemContext}.fallback_text`,
    );
    const code = item.code;
    if (CODE_GUIDANCE_KINDS.has(kind)) {
      if (typeof code !== "string" || code.trim() === "") {
        throw new Error(`${itemContext}.code is required for ${kind} guidance`);
      }
    } else if (code !== undefined) {
      throw new Error(
        `${itemContext}.code is only valid for engine_ini or launch_argument guidance`,
      );
    }

    return code === undefined
      ? { id, kind, fallback_text: fallbackText }
      : { id, kind, fallback_text: fallbackText, code };
  });
}

function normalizeWikiNoteReviews(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array when present`);

  const sourceKeys = new Set();
  return value.map((item, index) => {
    const itemContext = `${context}[${index}]`;
    assertPlainObject(item, itemContext);
    const section = assertAllowedValue(
      requiredNonEmptyString(item.section, `${itemContext}.section`),
      WIKI_REVIEW_SECTIONS,
      `${itemContext}.section`,
    );
    const name = requiredNonEmptyString(item.name, `${itemContext}.name`);
    const sourceKey = `${section}:${name.toLocaleLowerCase("en-US")}`;
    if (sourceKeys.has(sourceKey)) {
      throw new Error(`${context} contains duplicate review for ${section} "${name}"`);
    }
    sourceKeys.add(sourceKey);

    const fingerprint = requiredNonEmptyString(
      item.fingerprint,
      `${itemContext}.fingerprint`,
    );
    if (!LOWERCASE_SHA256_RE.test(fingerprint)) {
      throw new Error(`${itemContext}.fingerprint must be a lowercase SHA-256 digest`);
    }
    const disposition = assertAllowedValue(
      requiredNonEmptyString(item.disposition, `${itemContext}.disposition`),
      WIKI_REVIEW_DISPOSITIONS,
      `${itemContext}.disposition`,
    );
    const guidanceIds = assertOptionalNonEmptyStringArray(
      item.guidance_ids,
      `${itemContext}.guidance_ids`,
    );
    const reason = item.reason;

    if (disposition === "published") {
      if (guidanceIds.length === 0) {
        throw new Error(
          `${itemContext}.guidance_ids must be non-empty for published reviews`,
        );
      }
      if (reason !== undefined) {
        throw new Error(`${itemContext}.reason is only valid for omitted reviews`);
      }
    } else {
      if (guidanceIds.length > 0) {
        throw new Error(`${itemContext}.guidance_ids is only valid for published reviews`);
      }
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error(`${itemContext}.reason is required for omitted reviews`);
      }
    }

    return {
      section,
      name,
      fingerprint,
      disposition,
      ...(guidanceIds.length > 0 ? { guidance_ids: guidanceIds } : {}),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

function normalizeAddonFile(addonFile, context) {
  const file = normalizeGameDirectoryFile(addonFile, `${context}.addon_file`);
  const lower = file.toLowerCase();
  if (!file.startsWith(ADDON_PREFIX) || !lower.endsWith(ADDON_SUFFIX)) {
    throw new Error(`${context}.addon_file "${file}" must be a Luma root .addon filename`);
  }
  if (file.slice(ADDON_PREFIX.length, -ADDON_SUFFIX.length).trim().length === 0) {
    throw new Error(`${context}.addon_file must include a name between Luma- and .addon`);
  }
  return file;
}

function normalizeAsset(asset, arch, context) {
  const stem = asset.startsWith(ASSET_PREFIX) ? asset.slice(ASSET_PREFIX.length) : null;
  const stemWithoutSuffix =
    stem !== null && stem.endsWith(ASSET_SUFFIX)
      ? stem.slice(0, -ASSET_SUFFIX.length)
      : null;

  if (!stemWithoutSuffix) {
    throw new Error(
      `${context}.asset "${asset}" must match ${ASSET_PREFIX}<name>[-x32]${ASSET_SUFFIX}`,
    );
  }

  const lower = stemWithoutSuffix.toLowerCase();
  if (ASSET_FORBIDDEN_MARKERS.some((marker) => lower.endsWith(marker))) {
    throw new Error(
      `${context}.asset "${asset}" is a non-Publishing build (-Test/-Dev); only Publishing assets are curated`,
    );
  }

  const isX32 = stemWithoutSuffix.endsWith(ASSET_X32_SUFFIX);
  const namePart = isX32
    ? stemWithoutSuffix.slice(0, -ASSET_X32_SUFFIX.length)
    : stemWithoutSuffix;

  if (namePart.length === 0 || !ASSET_NAME_CHAR_RE.test(namePart)) {
    throw new Error(`${context}.asset "${asset}" has an invalid name component`);
  }

  if (isX32 !== (arch === "X86")) {
    throw new Error(
      `${context}.asset "${asset}" -x32 suffix must agree with arch (${arch})`,
    );
  }
  return asset;
}
