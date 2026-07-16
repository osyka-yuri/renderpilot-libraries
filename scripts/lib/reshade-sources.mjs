// Single source of truth for ReShade host URLs. Generates `addons/v1/reshade.json`.
// Current Luma/RenoDX v1 catalogues never embed this block.

import { deepFreeze } from "./common.mjs";

export const RESHADE_NIGHTLY = deepFreeze({
  url64: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(64-bit).zip",
  url32: "https://nightly.link/crosire/reshade/workflows/build/main/ReShade%20(32-bit).zip",
});

// Manifest-current stable ReShade add-on installer (a versioned reshade.me
// URL, not a "latest" alias — bump this by hand when a new stable version
// ships).
export const RESHADE_STABLE = deepFreeze({
  url: "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
});
