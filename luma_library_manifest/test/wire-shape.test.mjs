import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildManifest, SCHEMA_VERSION } from "../lib/build-manifest.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const game = (id, overrides = {}) => {
  const asset = overrides.asset ?? `Luma-${id}.zip`;
  return {
    id,
    name: overrides.name ?? id,
    asset,
    addon_file: overrides.addon_file ?? asset.replace(/\.zip$/u, ".addon"),
    arch: overrides.arch ?? "X64",
    status: overrides.status ?? "working",
    ...overrides,
  };
};

// ── top-level wire contract ──

test("schema_version is the current Luma manifest schema", () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test("committed luma_manifest.json uses the current top-level contract", async () => {
  const manifestPath = path.join(REPO_ROOT, "luma_manifest.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.equal(manifest.schema_version, 2);
  assert.match(manifest.min_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("reshade" in manifest, false);
});

// ── title without external_requirement emits only its needed fields ──

test("title without external_requirement has no external_requirement field", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("catalog-game", { name: "Catalog Game", asset: "Luma-Catalog.zip" }),
    ],
    overlay: { "catalog-game": { appid: "100" } },
    warn: () => {},
  });

  const [title] = result.manifest.titles;
  assert.equal(title.id, "catalog-game");
  assert.equal(title.name, "Catalog Game");
  assert.equal(title.asset, "Luma-Catalog.zip");
  assert.equal(title.addon_file, "Luma-Catalog.addon");
  assert.equal(title.status, "working");
  assert.equal(title.channel, undefined);
  assert.equal(title.min_app_version, undefined);
  assert.equal(title.generic, undefined);
  assert.equal(title.launch_args, undefined);
  assert.equal(title.notes_keys, undefined);
  assert.equal("external_requirement" in title, false);
});

// ── title with external_requirement emits the managed dependency field ──

test("Borderlands dgVoodoo requirement emits external_requirement on schema v2", () => {
  const dgVoodooRequirement = {
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
      {
        section: "DirectX",
        entries: [{ key: "VideoCard", value: "geforce_9800_gt" }],
      },
    ],
  };

  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("borderlands-2-and-the-pre-sequel", {
        asset: "Luma-Borderlands_2_and_The_Pre-Sequel-x32.zip",
        addon_file: "Luma-Borderlands 2 and The Pre-Sequel.addon",
        arch: "X86",
        external_requirement: dgVoodooRequirement,
      }),
    ],
    overlay: {
      "borderlands-2-and-the-pre-sequel": { appids: ["49520", "261640"] },
    },
    warn: () => {},
  });

  assert.equal(result.manifest.schema_version, 2);

  const [title] = result.manifest.titles;
  assert.equal(title.addon_file, "Luma-Borderlands 2 and The Pre-Sequel.addon");
  assert.equal("external_requirement" in title, true);
  assert.deepEqual(title.external_requirement, dgVoodooRequirement);
});

// ── optional fields omitted from simple title ──

test("simple title omits category, channel, min_app_version when at defaults", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("basic-game", {
        name: "Basic Game",
        asset: "Luma-Basic.zip",
        status: "working",
      }),
    ],
    overlay: { "basic-game": { appid: "200" } },
    warn: () => {},
  });

  const [title] = result.manifest.titles;

  // working status → stable channel → omitted (equals default)
  assert.equal(title.channel, undefined);
  // default min_app_version → omitted
  assert.equal(title.min_app_version, undefined);
  // no category → omitted
  assert.equal(title.category, undefined);
  // no generic → omitted
  assert.equal(title.generic, undefined);
  // no external_requirement → omitted
  assert.equal("external_requirement" in title, false);
});

// ── served JSON list covers generator outputs ──

test("catalog.mjs served JSON list includes all three generated manifests", async () => {
  const catalogUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "catalog.mjs")).href;
  const { servedJson } = await import(catalogUrl);

  assert.ok(
    servedJson.includes("renodx_manifest.json"),
    "renodx_manifest.json in servedJson",
  );
  assert.ok(servedJson.includes("luma_manifest.json"), "luma_manifest.json in servedJson");
  assert.ok(
    servedJson.includes("reshade_manifest.json"),
    "reshade_manifest.json in servedJson",
  );
  assert.ok(servedJson.includes("manifest.json"), "manifest.json in servedJson");
});

// ── config values are single-line (multiline rejected) ──

test("external_requirement config rejects multiline key/value", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-config", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [
                {
                  section: "General",
                  entries: [{ key: "multiline\nkey", value: "val" }],
                },
              ],
            },
          }),
        ],
        overlay: { "bad-config": { appid: "1" } },
        warn: () => {},
      }),
    /single-line/,
  );
});

// ── dgVoodoo is the only supported external requirement kind ──

test("external_requirement rejects unsupported kinds", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-kind", {
            external_requirement: {
              kind: "wine",
              version: "1.0.0",
              accepted_detected_apis: ["D3D11"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-kind": { appid: "1" } },
        warn: () => {},
      }),
    /must be "dgvoodoo2"/,
  );
});

// ── accepted_detected_apis must be DirectX APIs and non-empty ──

test("external_requirement rejects empty accepted_detected_apis", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("empty-apis", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: [],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "empty-apis": { appid: "1" } },
        warn: () => {},
      }),
    /non-empty array/,
  );
});

test("external_requirement rejects unsupported proxy DLLs", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-dll", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "opengl32.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-dll": { appid: "1" } },
        warn: () => {},
      }),
    /must be one of/,
  );
});

// ── managed source validation ──

test("external_requirement source rejects non-HTTPS URLs", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-source", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "http://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-source": { appid: "1" } },
        warn: () => {},
      }),
    /must be an HTTPS URL/,
  );
});

test("external_requirement source rejects invalid SHA-256", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-source", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "short",
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-source": { appid: "1" } },
        warn: () => {},
      }),
    /64-character hex/,
  );
});

test("external_requirement source rejects non-positive size", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-source", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 0,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-source": { appid: "1" } },
        warn: () => {},
      }),
    /positive integer/,
  );
});

// ── config comment rejection ──

test("external_requirement config rejects comment field", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-config", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "a/b.dll",
                  dest: "b.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [
                {
                  section: "S",
                  entries: [{ key: "k", value: "v", comment: "not allowed" }],
                },
              ],
            },
          }),
        ],
        overlay: { "bad-config": { appid: "1" } },
        warn: () => {},
      }),
    /not supported in managed config entries/,
  );
});

// ── install_map validation ──

test("external_requirement install_map rejects empty array", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("empty-map", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "empty-map": { appid: "1" } },
        warn: () => {},
      }),
    /non-empty array/,
  );
});

test("external_requirement install_map entry rejects bad source path", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-07-05T00:00:00Z",
        curatedGames: [
          game("bad-map", {
            external_requirement: {
              kind: "dgvoodoo2",
              version: "2.87.3",
              accepted_detected_apis: ["D3D9"],
              reshade_proxy_dll: "dxgi.dll",
              source: {
                url: "https://example.com/pkg.zip",
                sha256: "a".repeat(64),
                size: 1,
              },
              install_map: [
                {
                  source: "",
                  dest: "d.dll",
                  sha256: "b".repeat(64),
                  size: 1,
                },
              ],
              config_file: "dgVoodoo.conf",
              config: [{ section: "S", entries: [{ key: "k", value: "v" }] }],
            },
          }),
        ],
        overlay: { "bad-map": { appid: "1" } },
        warn: () => {},
      }),
    /non-empty string/,
  );
});
