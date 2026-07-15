import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { buildManifest } from "../lib/build-manifest.mjs";
import {
  DGVOODOO_REQUIREMENT,
  authoringGame as game,
  compileLumaSchema,
  minimalManifest,
} from "./helpers.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
// ── top-level wire contract ──

test("committed Luma v1 document uses the current top-level contract", async () => {
  const manifestPath = path.join(REPO_ROOT, "addons", "v1", "luma.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.equal(manifest.schema_version, 1);
  assert.match(manifest.minimum_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("host" in manifest, false);
  assert.ok(Array.isArray(manifest.games));
});

// ── game without managed dependency omits requirements ──

test("game without managed dependency has no requirements field", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("catalog-game", { name: "Catalog Game", asset: "Luma-Catalog.zip" }),
    ],
  });

  const [published] = result.manifest.games;
  assert.equal(published.id, "catalog-game");
  assert.equal(published.name, "Catalog Game");
  assert.equal(published.package.release_asset, "Luma-Catalog.zip");
  assert.equal(published.package.addon_file, "Luma-Catalog.addon");
  assert.equal(published.architecture, "X64");
  assert.equal(published.status, "working");
  assert.equal(published.profile, "game");
  assert.equal("channel" in published, false);
  assert.equal("generic" in published, false);
  assert.equal("launch_args" in published, false);
  assert.equal("features" in published, false);
  assert.equal("requirements" in published, false);
  assert.equal("external_requirement" in published, false);
});

// ── managed dependency lands under requirements ──

test("Borderlands dgVoodoo requirement emits managed_dependency", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("borderlands-2-and-the-pre-sequel", {
        asset: "Luma-Borderlands_2_and_The_Pre-Sequel-x32.zip",
        addon_file: "Luma-Borderlands 2 and The Pre-Sequel.addon",
        arch: "X86",
        external_requirement: DGVOODOO_REQUIREMENT,
      }),
    ],
  });

  const [published] = result.manifest.games;
  assert.equal(published.package.addon_file, "Luma-Borderlands 2 and The Pre-Sequel.addon");
  assert.equal(published.architecture, "X86");
  assert.deepEqual(published.requirements.managed_dependency, DGVOODOO_REQUIREMENT);
  assert.equal("external_requirement" in published, false);
});

// ── optional fields omitted from simple game ──

test("simple v1 game omits availability and requirements when not needed", () => {
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("basic-game", {
        name: "Basic Game",
        asset: "Luma-Basic.zip",
        status: "working",
      }),
    ],
  });

  const [published] = result.manifest.games;

  assert.equal("channel" in published, false);
  assert.equal("availability" in published, false);
  assert.equal("requirements" in published, false);
  assert.equal("generic" in published, false);
  assert.equal(published.profile, "game");
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
      }),
    /non-empty string/,
  );
});

// ── public schema pins requirements shape ──

test("v1 schema accepts builder output with managed_dependency", () => {
  const validate = compileLumaSchema();
  const result = buildManifest({
    generatedAt: "2026-07-05T00:00:00Z",
    curatedGames: [
      game("schema-managed", {
        arch: "X86",
        asset: "Luma-Schema-x32.zip",
        addon_file: "Luma-Schema.addon",
        external_requirement: DGVOODOO_REQUIREMENT,
        launch_args: ["-dx11"],
      }),
    ],
  });

  assert.equal(validate(result.manifest), true, JSON.stringify(validate.errors, null, 2));
});

test("v1 schema accepts launch_arguments-only requirements", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({
    requirements: { launch_arguments: ["-nod3d9ex"] },
  });
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors, null, 2));
});

test("v1 schema accepts only the strict profile enum", () => {
  const validate = compileLumaSchema();
  for (const profile of ["game", "unreal", "unity"]) {
    const overrides = { profile };
    if (profile === "unreal") {
      overrides.package = {
        release_asset: "Luma-Unreal_Engine.zip",
        addon_file: "Luma-Unreal Engine.addon",
      };
      overrides.features = { dlss_fsr: "supported", hdr: "experimental" };
    } else if (profile === "unity") {
      overrides.package = {
        release_asset: "Luma-Unity_Engine.zip",
        addon_file: "Luma-Unity Engine.addon",
      };
    }
    assert.equal(
      validate(minimalManifest(overrides)),
      true,
      `${profile}: ${JSON.stringify(validate.errors)}`,
    );
  }

  assert.equal(validate(minimalManifest({ profile: "engine" })), false);
  assert.equal(validate(minimalManifest({ profile: { scope: "game" } })), false);
});

test("v1 schema binds profiles to exact shared assets", () => {
  const validate = compileLumaSchema();

  assert.equal(
    validate(
      minimalManifest({
        profile: "unreal",
        package: {
          release_asset: "Luma-Other.zip",
          addon_file: "Luma-Other.addon",
        },
        features: { dlss_fsr: "supported", hdr: "supported" },
      }),
    ),
    false,
  );
  assert.equal(
    validate(
      minimalManifest({
        profile: "game",
        package: {
          release_asset: "Luma-Unity_Engine.zip",
          addon_file: "Luma-Unity Engine.addon",
        },
      }),
    ),
    false,
  );
  assert.equal(
    validate(
      minimalManifest({
        architecture: "X86",
        profile: "unity",
        package: {
          release_asset: "Luma-Unity_Engine.zip",
          addon_file: "Luma-Unity Engine.addon",
        },
      }),
    ),
    false,
  );
});

test("v1 schema requires Unreal features and forbids them elsewhere", () => {
  const validate = compileLumaSchema();
  assert.equal(
    validate(
      minimalManifest({
        profile: "unreal",
        package: {
          release_asset: "Luma-Unreal_Engine.zip",
          addon_file: "Luma-Unreal Engine.addon",
        },
      }),
    ),
    false,
  );
  assert.equal(
    validate(
      minimalManifest({
        features: { dlss_fsr: "supported", hdr: "supported" },
      }),
    ),
    false,
  );
});

test("v1 schema rejects empty requirements object", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({ requirements: {} });
  assert.equal(validate(manifest), false);
});

test("v1 schema rejects unknown requirements keys", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({ requirements: { foo: true } });
  assert.equal(validate(manifest), false);
});

test("v1 schema rejects managed_dependency with wrong kind", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({
    requirements: {
      managed_dependency: { ...DGVOODOO_REQUIREMENT, kind: "wine" },
    },
  });
  assert.equal(validate(manifest), false);
});

test("v1 schema rejects managed_dependency with non-HTTPS source", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({
    requirements: {
      managed_dependency: {
        ...DGVOODOO_REQUIREMENT,
        source: { ...DGVOODOO_REQUIREMENT.source, url: "http://example.com/x.zip" },
      },
    },
  });
  assert.equal(validate(manifest), false);
});

test("v1 schema rejects managed_dependency with invalid sha256", () => {
  const validate = compileLumaSchema();
  const manifest = minimalManifest({
    requirements: {
      managed_dependency: {
        ...DGVOODOO_REQUIREMENT,
        source: { ...DGVOODOO_REQUIREMENT.source, sha256: "not-a-hash" },
      },
    },
  });
  assert.equal(validate(manifest), false);
});

test("v1 schema validates match-rule values by kind", () => {
  const validate = compileLumaSchema();
  const validRules = [
    { kind: "steam_appid", value: "42", tier: 100 },
    { kind: "epic_id", value: "epic-catalog-id", tier: 90 },
    { kind: "gog_id", value: "gog-product-id", tier: 90 },
    { kind: "exe_sha256", value: "a".repeat(64), tier: 80 },
    { kind: "exe_name", value: "Game.EXE", tier: 70 },
  ];

  for (const rule of validRules) {
    assert.equal(
      validate(minimalManifest({ match: [rule] })),
      true,
      `${rule.kind}: ${JSON.stringify(validate.errors)}`,
    );
  }

  const invalidRules = [
    { kind: "steam_appid", value: "0", tier: 100 },
    { kind: "steam_appid", value: "12x", tier: 100 },
    { kind: "epic_id", value: "   ", tier: 90 },
    { kind: "exe_sha256", value: "A".repeat(64), tier: 80 },
    { kind: "exe_sha256", value: "a".repeat(63), tier: 80 },
    { kind: "exe_name", value: "Game", tier: 70 },
    { kind: "exe_name", value: "bin/Game.exe", tier: 70 },
  ];

  for (const rule of invalidRules) {
    assert.equal(validate(minimalManifest({ match: [rule] })), false, rule.kind);
  }
});

test("v1 schema binds guidance code presence to its kind", () => {
  const validate = compileLumaSchema();

  for (const kind of ["engine_ini", "launch_argument"]) {
    const guidance = {
      id: `luma.schema.${kind}`,
      kind,
      fallback_text: "Reviewed guidance.",
      code: kind === "engine_ini" ? "r.Lumen.Reflections=1" : "-dx11",
    };
    assert.equal(
      validate(minimalManifest({ guidance: [guidance] })),
      true,
      `${kind}: ${JSON.stringify(validate.errors)}`,
    );

    delete guidance.code;
    assert.equal(validate(minimalManifest({ guidance: [guidance] })), false, kind);
  }

  const warning = {
    id: "luma.schema.warning",
    kind: "warning",
    fallback_text: "Reviewed warning.",
  };
  assert.equal(
    validate(minimalManifest({ guidance: [warning] })),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate(minimalManifest({ guidance: [{ ...warning, code: "not allowed" }] })),
    false,
  );
});
