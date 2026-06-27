import { assertPlainObject, hasOwn } from "./json.mjs";

export const KNOWN_OVERLAY_FIELDS = new Set([
  "appid",
  "appids",
  "exe",
  "slug",
  "risk",
  "conflicts",
  "required_api",
  "notes_keys",
  "proxy_dll_override",
  "download_url",
  "min_app_version",
  "external",
  "native_hdr",
  "blacklist",
  "split",
]);

export const KNOWN_SPLIT_FIELDS = new Set([...KNOWN_OVERLAY_FIELDS, "suffix", "name"]);

const SPLIT_LOCAL_FIELDS = new Set(["suffix", "name"]);

const NON_INHERITABLE_SPLIT_FIELDS = new Set(["appid", "appids", "exe", "split"]);

const INHERITED_SPLIT_FIELDS = new Set(
  [...KNOWN_OVERLAY_FIELDS].filter((field) => !NON_INHERITABLE_SPLIT_FIELDS.has(field)),
);

const CATEGORY_FIELDS = ["native_hdr", "blacklist", "external"];

const APPID_RE = /^[1-9]\d*$/u;
const SLUG_RE = /^[A-Za-z0-9._-]+$/u;
const EXE_EXTENSION_RE = /\.exe$/iu;
const WINDOWS_BASENAME_FORBIDDEN_RE = /[<>:"/\\|?*\u0000-\u001F]/u;
const WHITESPACE_RE = /\s/u;

function validateWarningSink(warn) {
  if (typeof warn !== "function") {
    throw new Error("warn must be a function");
  }
}

function assertNonEmptyArray(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }
}

function normalizeOptionalString(value, context) {
  if (value === undefined) return undefined;

  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${context} must be a non-empty string`);
  }

  return trimmed;
}

function normalizeRequiredString(value, context) {
  const normalized = normalizeOptionalString(value, context);

  if (normalized === undefined) {
    throw new Error(`${context} must be a non-empty string`);
  }

  return normalized;
}

function validateOptionalString(value, context) {
  normalizeOptionalString(value, context);
}

function validateOptionalStringArray(value, context) {
  if (value === undefined) return;

  assertNonEmptyArray(value, context);

  value.forEach((item, index) => {
    normalizeRequiredString(item, `${context}[${index}]`);
  });
}

function addNormalizedAppids(out, overlay, context) {
  for (const appid of normalizeAppids(overlay, context)) {
    out.add(appid);
  }
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
    reason: normalizeRequiredString(overlay.blacklist, `${context}.blacklist`),
  };
}

function validateExternalCategory(overlay, context) {
  assertPlainObject(overlay.external, `${context}.external`);

  return {
    kind: "external",
    url: normalizeHttpsUrl(overlay.external.url, `${context}.external.url`),
    label_key: normalizeRequiredString(
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

  if (hasOwn(overlay, "risk")) {
    assertPlainObject(overlay.risk, `${context}.risk`);
  }

  validateOptionalStringArray(overlay.conflicts, `${context}.conflicts`);
  validateOptionalStringArray(overlay.required_api, `${context}.required_api`);
  validateOptionalStringArray(overlay.notes_keys, `${context}.notes_keys`);
  validateOptionalString(overlay.proxy_dll_override, `${context}.proxy_dll_override`);
  validateOptionalString(overlay.min_app_version, `${context}.min_app_version`);

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

export function warnUnknownFields(value, knownFields, context, warn = console.warn) {
  validateWarningSink(warn);

  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      warn(`⚠ ${context} has unknown field "${key}" (typo? ignored)`);
    }
  }
}

export function addCaseInsensitiveUnique(out, value) {
  if (value === null || value === undefined || value === "") return;

  if (typeof value !== "string") {
    throw new Error("value must be a string");
  }

  const normalized = value.toLowerCase();

  if (!out.some((existing) => existing.toLowerCase() === normalized)) {
    out.push(value);
  }
}

export function normalizeAppid(value, context) {
  const appid =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : null;

  if (!appid || !APPID_RE.test(appid)) {
    throw new Error(`${context} must be a positive Steam AppID`);
  }

  return appid;
}

export function normalizeAppids(overlay, context) {
  assertPlainObject(overlay, context);

  const appids = [];

  const push = (value, field) => {
    addCaseInsensitiveUnique(appids, normalizeAppid(value, `${context}.${field}`));
  };

  if (hasOwn(overlay, "appid")) {
    push(overlay.appid, "appid");
  }

  if (hasOwn(overlay, "appids")) {
    assertNonEmptyArray(overlay.appids, `${context}.appids`);

    overlay.appids.forEach((appid, index) => {
      push(appid, `appids[${index}]`);
    });
  }

  return appids;
}

export function collectOverlayAppids(value, into, context = "match_overlay.json") {
  collectAppidsRecursively(value, into, context);
}

export function normalizeExeName(value, context) {
  if (value === null || value === undefined) {
    return null;
  }

  const exe = normalizeRequiredString(value, context);

  if (
    exe === ".exe" ||
    !EXE_EXTENSION_RE.test(exe) ||
    WINDOWS_BASENAME_FORBIDDEN_RE.test(exe)
  ) {
    throw new Error(`${context} must be an .exe basename`);
  }

  return exe;
}

export function normalizeCachedExes(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  const out = [];

  value.forEach((exe, index) => {
    const normalized = normalizeExeName(exe, `${context}[${index}]`);

    if (normalized === null) {
      throw new Error(`${context}[${index}] must be an .exe basename`);
    }

    addCaseInsensitiveUnique(out, normalized);
  });

  return out;
}

export function normalizeSlug(value, context) {
  const slug = normalizeRequiredString(value, context);

  if (!SLUG_RE.test(slug)) {
    throw new Error(`${context} must be a non-empty RenoDX slug`);
  }

  return slug;
}

export function normalizeHttpsUrl(value, context) {
  const url = normalizeRequiredString(value, context);

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
  validateWarningSink(warn);
  assertPlainObject(overlay, "match_overlay.json");

  for (const [id, entry] of Object.entries(overlay)) {
    const context = `overlay "${id}"`;

    assertPlainObject(entry, context);

    if (!wikiIds.has(id)) {
      warn(`⚠ ${context} has no matching wiki entry (orphan)`);
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

export function collectMatchedAppids(wiki, overlay) {
  if (!Array.isArray(wiki)) {
    throw new Error("wiki must be an array");
  }

  assertPlainObject(overlay, "match_overlay.json");

  const appids = new Set();

  wiki.forEach((game, index) => {
    assertPlainObject(game, `wiki[${index}]`);

    const id = normalizeRequiredString(game.id, `wiki[${index}].id`);
    const entry = overlay[id] ?? {};
    const context = `overlay "${id}"`;

    assertPlainObject(entry, context);

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
