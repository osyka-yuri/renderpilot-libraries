import {
  addNormalizedAppids,
  normalizeAppid,
  normalizeAppids,
  normalizeExeName,
  warnUnknownFields,
} from "../../scripts/lib/overlay-shared.mjs";
import {
  assertNonEmptyArray,
  assertPlainObject,
  hasOwn,
  requiredNonEmptyString,
} from "../../scripts/lib/common.mjs";

export { normalizeAppid, normalizeAppids, normalizeExeName };

export const KNOWN_OVERLAY_FIELDS = new Set([
  "appid",
  "appids",
  "exe",
  "slug",
  "conflicts",
  "required_api",
  "notes_keys",
  "proxy_dll_override",
  "compatibility_source",
  "download_url",
  "min_app_version",
  "external",
  "native_hdr",
  "blacklist",
  "split",
  "ignore",
]);

export const KNOWN_SPLIT_FIELDS = new Set([...KNOWN_OVERLAY_FIELDS, "suffix", "name"]);

const SPLIT_LOCAL_FIELDS = new Set(["suffix", "name"]);

const NON_INHERITABLE_SPLIT_FIELDS = new Set(["appid", "appids", "exe", "split"]);

const INHERITED_SPLIT_FIELDS = new Set(
  [...KNOWN_OVERLAY_FIELDS].filter((field) => !NON_INHERITABLE_SPLIT_FIELDS.has(field)),
);

const CATEGORY_FIELDS = ["native_hdr", "blacklist", "external"];

const SLUG_RE = /^[A-Za-z0-9._-]+$/u;
const WHITESPACE_RE = /\s/u;

function validateOptionalString(value, context) {
  if (value === undefined) return;

  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function validateOptionalStringArray(value, context) {
  if (value === undefined) return;

  assertNonEmptyArray(value, context);

  value.forEach((item, index) => {
    requiredNonEmptyString(item, `${context}[${index}]`);
  });
}

function validateNativeHdrCategory(overlay, context) {
  if (overlay.native_hdr !== true) {
    throw new Error(`${context}.native_hdr must be true when present`);
  }

  return { kind: "native_hdr" };
}

function validateBlacklistCategory(overlay, context) {
  return {
    kind: "blacklist",
    reason: requiredNonEmptyString(overlay.blacklist, `${context}.blacklist`),
  };
}

function validateExternalCategory(overlay, context) {
  assertPlainObject(overlay.external, `${context}.external`);

  return {
    kind: "external",
    url: normalizeHttpsUrl(overlay.external.url, `${context}.external.url`),
    label_key: requiredNonEmptyString(
      overlay.external.label_key,
      `${context}.external.label_key`,
    ),
  };
}

function validateOverlayShape(overlay, context) {
  normalizeAppids(overlay, context);
  normalizeExeName(overlay.exe, `${context}.exe`);

  if (hasOwn(overlay, "slug")) {
    normalizeSlug(overlay.slug, `${context}.slug`);
  }

  if (hasOwn(overlay, "download_url")) {
    normalizeHttpsUrl(overlay.download_url, `${context}.download_url`);
  }

  validateOptionalStringArray(overlay.conflicts, `${context}.conflicts`);
  validateOptionalString(overlay.compatibility_source, `${context}.compatibility_source`);
  validateOptionalStringArray(overlay.required_api, `${context}.required_api`);
  validateOptionalStringArray(overlay.notes_keys, `${context}.notes_keys`);
  validateOptionalString(overlay.proxy_dll_override, `${context}.proxy_dll_override`);
  validateOptionalString(overlay.min_app_version, `${context}.min_app_version`);

  if (hasOwn(overlay, "ignore") && typeof overlay.ignore !== "boolean") {
    throw new Error(`${context}.ignore must be a boolean`);
  }

  categoryOf(overlay, context);
}

function validateSplit(parent, split, splitContext, warn) {
  assertPlainObject(split, splitContext);

  warnUnknownFields(split, KNOWN_SPLIT_FIELDS, splitContext, warn);

  validateOptionalString(split.suffix, `${splitContext}.suffix`);
  validateOptionalString(split.name, `${splitContext}.name`);

  validateOverlayShape(inheritedSplitOverlay(parent, split), splitContext);
}

function collectAppidsRecursively(value, into, context) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectAppidsRecursively(item, into, `${context}[${index}]`);
    });
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, val] of Object.entries(value)) {
    if (key === "appid") {
      into.add(normalizeAppid(val, `${context}.appid`));
      continue;
    }

    if (key === "appids") {
      assertNonEmptyArray(val, `${context}.appids`);

      val.forEach((appid, index) => {
        into.add(normalizeAppid(appid, `${context}.appids[${index}]`));
      });

      continue;
    }

    collectAppidsRecursively(val, into, `${context}.${key}`);
  }
}

export function normalizeSlug(value, context) {
  const slug = requiredNonEmptyString(value, context);

  if (!SLUG_RE.test(slug)) {
    throw new Error(`${context} must be a non-empty RenoDX slug`);
  }

  return slug;
}

function normalizeHttpsUrl(value, context) {
  const url = requiredNonEmptyString(value, context);

  if (WHITESPACE_RE.test(url)) {
    throw new Error(`${context} must be a valid https URL`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context} must be a valid https URL`);
  }

  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`${context} must be an https URL`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${context} must not contain credentials`);
  }

  return url;
}

export function categoryOf(overlay, context) {
  const markers = CATEGORY_FIELDS.filter((field) => hasOwn(overlay, field));

  if (markers.length > 1) {
    throw new Error(`${context} has conflicting categories: ${markers.join(", ")}`);
  }

  if (markers.length > 0 && hasOwn(overlay, "download_url")) {
    throw new Error(`${context} cannot combine a category with download_url`);
  }

  if (hasOwn(overlay, "native_hdr")) {
    return validateNativeHdrCategory(overlay, context);
  }

  if (hasOwn(overlay, "blacklist")) {
    return validateBlacklistCategory(overlay, context);
  }

  if (hasOwn(overlay, "external")) {
    return validateExternalCategory(overlay, context);
  }

  return null;
}

export function inheritedSplitOverlay(parent, split) {
  const inherited = {};

  for (const [field, value] of Object.entries(parent)) {
    if (INHERITED_SPLIT_FIELDS.has(field)) {
      inherited[field] = value;
    }
  }

  const merged = { ...inherited };

  for (const [field, value] of Object.entries(split)) {
    if (!SPLIT_LOCAL_FIELDS.has(field)) {
      merged[field] = value;
    }
  }

  return merged;
}

export function validateOverlay(overlay, wikiIds, warn = console.warn) {
  assertPlainObject(overlay, "match_overlay.json");

  for (const [id, entry] of Object.entries(overlay)) {
    const context = `overlay "${id}"`;

    assertPlainObject(entry, context);

    if (!wikiIds.has(id)) {
      warn(`Warning: ${context} has no matching wiki entry (orphan)`);
    }

    warnUnknownFields(entry, KNOWN_OVERLAY_FIELDS, context, warn);
    validateOverlayShape(entry, context);

    if (!hasOwn(entry, "split")) {
      continue;
    }

    assertNonEmptyArray(entry.split, `${context}.split`);

    entry.split.forEach((split, index) => {
      validateSplit(entry, split, `${context}.split[${index}]`, warn);
    });
  }
}

export function collectOverlayAppids(value, into, context = "match_overlay.json") {
  collectAppidsRecursively(value, into, context);
}

export function collectMatchedAppids(wiki, overlay) {
  if (!Array.isArray(wiki)) {
    throw new Error("wiki_games.json must be an array");
  }

  assertPlainObject(overlay, "match_overlay.json");

  const appids = new Set();

  wiki.forEach((game, index) => {
    assertPlainObject(game, `wiki[${index}]`);

    const id = requiredNonEmptyString(game.id, `wiki[${index}].id`);
    const entry = overlay[id] ?? {};
    const context = `overlay "${id}"`;

    if (!hasOwn(entry, "split")) {
      addNormalizedAppids(appids, entry, context);
      return;
    }

    assertNonEmptyArray(entry.split, `${context}.split`);

    entry.split.forEach((split, splitIndex) => {
      const splitContext = `${context}.split[${splitIndex}]`;

      assertPlainObject(split, splitContext);

      addNormalizedAppids(appids, inheritedSplitOverlay(entry, split), splitContext);
    });
  });

  return appids;
}
