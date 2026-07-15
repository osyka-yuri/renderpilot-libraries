import { readFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_PATH = path.join(import.meta.dirname, "..", "manifest-v1.schema.json");

export function compileLumaSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function authoringGame(id, overrides = {}) {
  const asset = overrides.asset ?? `Luma-${id}.zip`;
  return {
    id,
    name: overrides.name ?? id,
    asset,
    addon_file: overrides.addon_file ?? asset.replace(/\.zip$/u, ".addon"),
    arch: overrides.arch ?? "X64",
    status: overrides.status ?? "working",
    ...(overrides.features === undefined ? {} : { features: overrides.features }),
    ...overrides,
    match: overrides.match ?? [
      { kind: "steam_appid", value: defaultSteamAppid(id), tier: 100 },
    ],
  };
}

function defaultSteamAppid(id) {
  let hash = 0;
  for (const character of id) {
    hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
  }
  return String(hash || 1);
}

export function minimalManifest(gameOverrides = {}) {
  return {
    schema_version: 1,
    generated_at: "2026-07-05T00:00:00Z",
    minimum_reshade_version: "6.7.0",
    games: [
      {
        id: "schema-game",
        name: "Schema Game",
        architecture: "X64",
        status: "working",
        match: [{ kind: "steam_appid", value: "1", tier: 100 }],
        package: {
          release_asset: "Luma-Schema.zip",
          addon_file: "Luma-Schema.addon",
        },
        profile: "game",
        ...gameOverrides,
      },
    ],
  };
}

export const DGVOODOO_REQUIREMENT = Object.freeze({
  kind: "dgvoodoo2",
  version: "2.87.3",
  accepted_detected_apis: ["D3D9"],
  reshade_proxy_dll: "dxgi.dll",
  source: {
    url: "https://example.com/dgVoodoo2.zip",
    sha256: "6fb954bed55bf70e948c5045a663a9df31ea206faf105e327bafe46c318f867f",
    size: 9082391,
  },
  install_map: [
    {
      source: "MS/x86/D3D9.dll",
      dest: "D3D9.dll",
      sha256: "c13e3c0969d2c70a1a63cf96b83c7cd3bc47f925f28ec92c07d5b72d6df4c240",
      size: 485888,
    },
  ],
  config_file: "dgVoodoo.conf",
  config: [
    {
      section: "General",
      entries: [{ key: "OutputAPI", value: "d3d11_fl11_0" }],
    },
  ],
});
