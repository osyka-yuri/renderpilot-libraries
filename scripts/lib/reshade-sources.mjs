// Single source of truth for ReShade host URLs. Generates `addons/v1/reshade.json`.
// Current Luma/RenoDX v1 catalogues never embed this block.

import { deepFreeze } from "./common.mjs";
import { assertSemver } from "./validators.mjs";

export const RESHADE_NIGHTLY = deepFreeze({
  url64: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(64-bit).zip",
  url32: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(32-bit).zip",
});

// Manifest-current stable ReShade add-on installer (a versioned reshade.me
// URL, not a "latest" alias — bump via refresh-reshade-stable when a new
// stable version ships).
export const RESHADE_STABLE = deepFreeze({
  url: "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
});

/** Versioned Addon installer on reshade.me (capture group 1 = X.Y.Z). */
export const STABLE_ADDON_URL_RE =
  /^https:\/\/reshade\.me\/downloads\/ReShade_Setup_(\d+\.\d+\.\d+)_Addon\.exe$/u;

/**
 * Parses a stable Addon installer URL into `{ version, url }`.
 * Throws when the URL does not match the reshade.me Addon contract.
 */
export function parseStableAddonUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("stable ReShade URL must be a non-empty string");
  }

  const trimmed = url.trim();
  const match = STABLE_ADDON_URL_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `stable ReShade URL must match reshade.me Addon installer pattern, got ${JSON.stringify(trimmed)}`,
    );
  }

  return { version: match[1], url: trimmed };
}

/** Builds the reshade.me Addon installer URL for a dotted triple version. */
export function buildStableAddonUrl(version) {
  const v = assertSemver(version, "ReShade stable version");
  return `https://reshade.me/downloads/ReShade_Setup_${v}_Addon.exe`;
}

/** Version currently pinned in `RESHADE_STABLE`. */
export function currentStableVersion() {
  return parseStableAddonUrl(RESHADE_STABLE.url).version;
}

/**
 * Targets for live health checks of the committed ReShade channel pins.
 * Stable failures are treated as hard; nightly may be soft on flaky hosts.
 *
 * `probe`:
 * - `"head"` — standard HEAD (reshade.me Addon installers)
 * - `"get-redirect"` — GET without following redirects; a 3xx Location is
 *   enough (nightly.link returns 404 for HEAD but 302 for GET)
 */
export function listReshadeHealthTargets() {
  return Object.freeze([
    Object.freeze({
      id: "reshade.stable",
      url: RESHADE_STABLE.url,
      kind: "stable",
      probe: "head",
    }),
    Object.freeze({
      id: "reshade.nightly.url64",
      url: RESHADE_NIGHTLY.url64,
      kind: "nightly",
      probe: "get-redirect",
    }),
    Object.freeze({
      id: "reshade.nightly.url32",
      url: RESHADE_NIGHTLY.url32,
      kind: "nightly",
      probe: "get-redirect",
    }),
  ]);
}

/**
 * Surgical replace of the single stable Addon URL string in the
 * `reshade-sources.mjs` module text. Preserves comments/formatting.
 */
export function replaceStableUrlInSources(sourceText, nextUrl) {
  parseStableAddonUrl(nextUrl);

  const pattern =
    /https:\/\/reshade\.me\/downloads\/ReShade_Setup_\d+\.\d+\.\d+_Addon\.exe/gu;
  const matches = sourceText.match(pattern);
  if (!matches || matches.length === 0) {
    throw new Error("reshade-sources: no stable Addon URL found to replace");
  }
  if (matches.length !== 1) {
    throw new Error(
      `reshade-sources: expected exactly one stable Addon URL, found ${matches.length}`,
    );
  }

  const current = matches[0];
  if (current === nextUrl) {
    return { text: sourceText, changed: false, previousUrl: current };
  }

  return {
    text: sourceText.replace(current, nextUrl),
    changed: true,
    previousUrl: current,
  };
}
