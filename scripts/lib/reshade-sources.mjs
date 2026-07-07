// Single source of truth for the ReShade host URLs (both the crosire/reshade
// nightly build and the manifest-current reshade.me stable installer), shared
// by every per-tool manifest generator (RenoDX, Luma, …) that installs a
// ReShade host, and by the standalone `reshade_manifest.json` generator
// (see `scripts/generate-reshade-manifest.mjs`). Keeping this in one place
// prevents the published documents' ReShade URLs from drifting apart as
// crosire's CI artifact paths change or a new stable version ships.

import { deepFreeze } from "./common.mjs";

export const RESHADE_NIGHTLY = deepFreeze({
  url64: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(64-bit).zip",
  url32: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(32-bit).zip",
});

// Manifest-current stable ReShade add-on installer (a versioned reshade.me
// URL, not a "latest" alias — bump this by hand when a new stable version
// ships). Luma has no stable field (it is always nightly-only by design), so
// only RenoDX's manifest and the shared `reshade_manifest.json` carry this.
export const RESHADE_STABLE = deepFreeze({
  url: "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
});
