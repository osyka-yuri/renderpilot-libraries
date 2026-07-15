// Public Luma v1 field helpers. The catalogue builder assembles the v1 document
// directly; this module owns the public profile vocabulary and exact shared
// release-asset identities used by authoring, schema tests, and reconciliation.

export const SCHEMA_VERSION = 1;

export const UNREAL_ASSET = "Luma-Unreal_Engine.zip";
export const UNITY_ASSET = "Luma-Unity_Engine.zip";
export const UNITY_ASSET_X32 = "Luma-Unity_Engine-x32.zip";

export const ENGINE_PROFILES = Object.freeze(new Set(["unreal", "unity"]));

export function sharedAssetForProfile(profile, architecture) {
  if (profile === "unreal") return UNREAL_ASSET;
  if (profile === "unity") {
    return architecture === "X86" ? UNITY_ASSET_X32 : UNITY_ASSET;
  }
  throw new Error(`Unsupported Luma engine profile: ${profile}`);
}

export function isSharedEngineAsset(asset) {
  return asset === UNREAL_ASSET || asset === UNITY_ASSET || asset === UNITY_ASSET_X32;
}
