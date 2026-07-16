// Shared authoring-input validators used by Luma and RenoDX manifest builders.
//
// Both pipelines normalise/validate the same patterns: semver strings,
// single-line config values, DirectX API allowlists, and ReShade proxy DLL
// slots.  Extracting them here keeps the tool-specific builders focused on
// their own wire-shape assembly and stops the two copies from drifting.
//
// Tool-specific concerns stay in each catalogue: RenoDX slug/split/overlay
// fields in `catalogs/addons/renodx/lib/`, Luma assets/guidance/review in
// `authoring-profile.mjs`, managed dependencies in `managed-dependency.mjs`.

export const SEMVER_RE = /^\d+\.\d+\.\d+$/u;

export const LOWERCASE_SHA256_RE = /^[0-9a-f]{64}$/u;

export const DIRECTX_GRAPHICS_APIS = Object.freeze(
  new Set(["D3D9", "D3D10", "D3D11", "D3D12"]),
);

export const RESHADE_PROXY_DLLS = Object.freeze(
  new Set(["dxgi.dll", "d3d9.dll", "d3d10.dll", "d3d11.dll", "d3d12.dll"]),
);

export function assertSemver(value, context) {
  const trimmed = String(value ?? "").trim();
  if (!SEMVER_RE.test(trimmed)) {
    throw new Error(`${context} must be a dotted triple version (e.g. 1.0.0)`);
  }
  return trimmed;
}

export function assertSingleLineString(value, context) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  if (trimmed.includes("\r") || trimmed.includes("\n")) {
    throw new Error(`${context} must be a single-line string`);
  }
  return trimmed;
}

export function assertNonEmptyStringArray(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${context}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

export function assertOptionalNonEmptyStringArray(value, context) {
  if (value === undefined || value === null) {
    return [];
  }
  return assertNonEmptyStringArray(value, context);
}

export function assertUniqueStringValues(values, context) {
  const seen = new Set();
  for (const item of values) {
    if (seen.has(item)) {
      throw new Error(`${context} contains duplicate "${item}"`);
    }
    seen.add(item);
  }
  return values;
}

export function assertAllowedValue(value, allowedSet, context) {
  const normalized = String(value ?? "").trim();
  if (!allowedSet.has(normalized)) {
    const allowed = [...allowedSet].join(", ");
    throw new Error(`${context} "${normalized}" must be one of: ${allowed}`);
  }
  return normalized;
}

export function assertAllowedValues(values, allowedSet, context) {
  return values.map((item, index) =>
    assertAllowedValue(item, allowedSet, `${context}[${index}]`),
  );
}
