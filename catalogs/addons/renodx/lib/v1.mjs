// Public RenoDX v1 field helpers. The builder assembles the v1 document
// directly; this module only owns message fallbacks and availability mapping
// so legacy field names never leak into the published contract.

import { requiredNonEmptyString } from "../../../../scripts/lib/common.mjs";

export const SCHEMA_VERSION = 1;

const FALLBACKS = Object.freeze({
  "renodx.external.discord":
    "Get the add-on from Discord, then install the downloaded file.",
  "renodx.external.nexus":
    "Get the add-on from Nexus Mods, then install the downloaded file.",
  "renodx.generic.unity": "Uses the shared Unity engine profile.",
  "renodx.generic.universal": "Uses the shared Unreal Engine profile.",
});

export function message(id) {
  const normalizedId = requiredNonEmptyString(id, "RenoDX message id");
  if (!Object.hasOwn(FALLBACKS, normalizedId)) {
    throw new Error(`No RenoDX fallback text registered for message id "${normalizedId}"`);
  }
  return { id: normalizedId, fallback_text: FALLBACKS[normalizedId] };
}

/** Maps overlay category records onto the v1 availability union. */
export function availabilityFromCategory(category) {
  switch (category?.kind) {
    case "external":
      return { kind: "external", url: category.url, message: message(category.label_key) };
    case "native_hdr":
      return { kind: "native_hdr" };
    case "blacklist":
      return { kind: "blocked", message: message(category.reason) };
    default:
      return undefined;
  }
}

export function engineProfileFromGeneric(generic) {
  const addon = {};
  if (generic.slug) addon.slug = generic.slug;

  const hasUrl64 = generic.url64 !== undefined;
  const hasUrl32 = generic.url32 !== undefined;
  if (hasUrl64 !== hasUrl32) {
    throw new Error(
      `RenoDX generic "${generic.engine}" must provide url64 and url32 together`,
    );
  }
  if (hasUrl64) {
    addon.sources = {
      x64: requiredNonEmptyString(generic.url64, `generic "${generic.engine}".url64`),
      x86: requiredNonEmptyString(generic.url32, `generic "${generic.engine}".url32`),
    };
  }
  return {
    engine: generic.engine,
    status: generic.status,
    addon,
    message: message(generic.label_key ?? `renodx.generic.${generic.engine}`),
  };
}
