import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildManifest, SCHEMA_VERSION } from "../lib/build-manifest.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const game = (id, overrides = {}) => ({
  id,
  name: overrides.name ?? id,
  asset: overrides.asset ?? `Luma-${id}.zip`,
  arch: overrides.arch ?? "X64",
  status: overrides.status ?? "working",
  ...overrides,
});

// ── schema_version: 1, backward compatibility ──

test("schema_version stays at 1 (no wire-breaking bump)", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("committed luma_manifest.json still has schema_version 1", async () => {
  const manifestPath = path.join(REPO_ROOT, "luma_manifest.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.equal(manifest.schema_version, 1);
});

// ── old-style title without external_requirement emits exactly the old shape ──

test("title without external_requirement has no external_requirement field", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("old-style-game", { name: "Old Style Game", asset: "Luma-Old_Style.zip" }),
    ],
    overlay: { "old-style-game": { appid: "100" } },
    warn: () => {},
  });

  const [title] = result.manifest.titles;
  assert.equal(title.id, "old-style-game");
  assert.equal(title.name, "Old Style Game");
  assert.equal(title.asset, "Luma-Old_Style.zip");
  assert.equal(title.status, "working");
  assert.equal(title.channel, undefined);
  assert.equal(title.min_app_version, undefined);
  assert.equal(title.generic, undefined);
  assert.equal(title.launch_args, undefined);
  assert.equal(title.notes_keys, undefined);
  assert.equal("external_requirement" in title, false);
});

// ── title with external_requirement emits the field and keeps schema_version: 1 ──

test("Borderlands dgVoodoo requirement emits external_requirement on schema v1", () => {
  const dgVoodooRequirement = {
    kind: "dgvoodoo2",
    version: "2.87.3",
    accepted_detected_apis: ["D3D9"],
    proxy_dll: "dxgi.dll",
    config: [
      {
        section: "General",
        entries: [{ key: "OutputAPI", value: "d3d11_fl11_0" }],
      },
      {
        section: "DirectX",
        entries: [{ key: "VideoCard", value: "geforce_9800_gt", comment: "fixes shadows" }],
      },
    ],
  };

  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("borderlands-2-and-the-pre-sequel", {
        asset: "Luma-Borderlands_2_and_The_Pre-Sequel-x32.zip",
        arch: "X86",
        external_requirement: dgVoodooRequirement,
      }),
    ],
    overlay: {
      "borderlands-2-and-the-pre-sequel": { appids: ["49520", "261640"] },
    },
    warn: () => {},
  });

  assert.equal(result.manifest.schema_version, 1);

  const [title] = result.manifest.titles;
  assert.equal("external_requirement" in title, true);
  assert.deepEqual(title.external_requirement, dgVoodooRequirement);
});

// ── optional fields omitted from old-style title ──

test("old-style title omits category, channel, min_app_version when at defaults", () => {
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
              proxy_dll: "dxgi.dll",
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
              proxy_dll: "dxgi.dll",
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
              proxy_dll: "dxgi.dll",
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
              proxy_dll: "opengl32.dll",
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
