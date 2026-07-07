import {
  collectOverlayAppidsFlat,
  normalizeAppid,
  normalizeAppids,
  normalizeExeName,
  warnUnknownFields,
} from "../../scripts/lib/overlay-shared.mjs";
import {
  assertPlainObject,
  hasOwn,
  requiredNonEmptyString,
} from "../../scripts/lib/common.mjs";

export { normalizeAppid, normalizeAppids, normalizeExeName };

// match_overlay.json holds ONLY match identifiers (appid/appids/exe) plus
// `ignore` to cleanly drop a row. Unlike RenoDX's overlay, everything else a
// title needs (asset, launch_args, generic, notes_keys, blacklist reason)
// lives directly on the curated_games.json row: that file is
// itself hand-curated (there is no auto-scraped wiki_games.json equivalent to
// layer overrides on top of), so there is nothing left for an overlay to
// override except the Steam-derived match identifiers.
export const KNOWN_OVERLAY_FIELDS = new Set(["appid", "appids", "exe", "ignore"]);

function validateOverlayShape(overlay, context) {
  normalizeAppids(overlay, context);
  normalizeExeName(overlay.exe, `${context}.exe`);

  if (hasOwn(overlay, "ignore") && typeof overlay.ignore !== "boolean") {
    throw new Error(`${context}.ignore must be a boolean`);
  }
}

export function validateOverlay(overlay, curatedIds, warn = console.warn) {
  assertPlainObject(overlay, "match_overlay.json");

  for (const [id, entry] of Object.entries(overlay)) {
    const context = `overlay "${id}"`;

    assertPlainObject(entry, context);

    if (!curatedIds.has(id)) {
      warn(`Warning: ${context} has no matching curated_games.json entry (orphan)`);
    }

    warnUnknownFields(entry, KNOWN_OVERLAY_FIELDS, context, warn);
    validateOverlayShape(entry, context);
  }
}

export function collectOverlayAppids(value, into, context = "match_overlay.json") {
  collectOverlayAppidsFlat(value, into, context);
}

export function collectMatchedAppids(curatedGames, overlay) {
  if (!Array.isArray(curatedGames)) {
    throw new Error("curated_games.json must be an array");
  }

  assertPlainObject(overlay, "match_overlay.json");

  const appids = new Set();

  curatedGames.forEach((game, index) => {
    assertPlainObject(game, `curated_games.json[${index}]`);

    const id = requiredNonEmptyString(game.id, `curated_games.json[${index}].id`);
    const entry = overlay[id] ?? {};
    const context = `overlay "${id}"`;

    for (const appid of normalizeAppids(entry, context)) {
      appids.add(appid);
    }
  });

  return appids;
}
