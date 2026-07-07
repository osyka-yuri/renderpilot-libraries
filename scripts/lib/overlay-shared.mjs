// Shared overlay primitives used by both the RenoDX and Luma manifest
// pipelines (`renodx_library_manifest/lib/overlay.mjs` and
// `luma_library_manifest/lib/overlay.mjs`). Anything that is identical
// between the two tools lives here so the two cannot drift on the basic
// shape of match-overlay validation (AppID parsing, exe-basename rules,
// unknown-field warnings, the recursive-vs-flat appid collectors).
//
// Tool-specific overlay concerns (RenoDX's `split`/`slug`/`category`/
// `external`/`native_hdr`, Luma's curated-games-driven `validateOverlay`)
// stay in their own `overlay.mjs`.

import {
  addCaseInsensitiveUnique,
  assertNonEmptyArray,
  assertPlainObject,
  hasOwn,
  requiredNonEmptyString,
} from "./common.mjs";

const APPID_RE = /^[1-9]\d*$/u;
const EXE_EXTENSION_RE = /\.exe$/iu;
const WINDOWS_BASENAME_FORBIDDEN_RE = /[<>:"/\\|?*\u0000-\u001F]/u;

function validateWarningSink(warn) {
  if (typeof warn !== "function") {
    throw new Error("warn must be a function");
  }
}

export function warnUnknownFields(value, knownFields, context, warn = console.warn) {
  validateWarningSink(warn);

  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      warn(`Warning: ${context} has unknown field "${key}" (typo? ignored)`);
    }
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

export function normalizeExeName(value, context) {
  if (value === null || value === undefined) {
    return null;
  }

  const exe = requiredNonEmptyString(value, context);

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

export function addNormalizedAppids(out, overlay, context) {
  for (const appid of normalizeAppids(overlay, context)) {
    out.add(appid);
  }
}

/**
 * Flat (non-recursive) collector: gathers `appid`/`appids` from each
 * top-level overlay entry. Used by Luma (which has no `split`) and by
 * `enrich-exe.mjs` to find which AppIDs to fetch.
 */
export function collectOverlayAppidsFlat(value, into, context = "match_overlay.json") {
  assertPlainObject(value, context);

  for (const [id, entry] of Object.entries(value)) {
    addNormalizedAppids(into, entry, `${context}."${id}"`);
  }
}
