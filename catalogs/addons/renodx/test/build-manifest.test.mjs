import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { buildManifest } from "../lib/build-manifest.mjs";

const SCHEMA_PATH = path.join(import.meta.dirname, "..", "manifest-v1.schema.json");

function compileRenodxSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

const game = (id, name = id) => ({
  id,
  name,
  slug: id,
  arch: "X64",
  status: "working",
});

function minimalManifest(gameOverrides = {}) {
  return {
    schema_version: 1,
    generated_at: "2026-06-27T00:00:00Z",
    games: [
      {
        id: "schema-game",
        name: "Schema Game",
        architecture: "X64",
        status: "working",
        match: [{ kind: "steam_appid", value: "1", tier: 100 }],
        addon: { slug: "schema-game" },
        ...gameOverrides,
      },
    ],
    engine_profiles: [
      {
        engine: "unity",
        status: "unknown",
        addon: { slug: "unityengine" },
        message: {
          id: "renodx.generic.unity",
          fallback_text: "Uses the shared Unity engine profile.",
        },
      },
    ],
  };
}

test("buildManifest promotes matched split entries into v1 games", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("collection", "Collection")],
    overlay: {
      collection: {
        slug: "shared",
        split: [
          { suffix: "one", name: "One", appid: "100" },
          { suffix: "two", name: "Two", exe: "Two.exe" },
        ],
      },
    },
    exeCache: { 100: ["One.exe"] },
    warn: () => {},
  });

  assert.equal(result.manifest.schema_version, 1);
  assert.equal(result.manifest.games.length, 2);
  assert.deepEqual(
    result.manifest.games.map((title) => title.id),
    ["collection-one", "collection-two"],
  );
  assert.equal(result.manifest.games[0].addon.slug, "shared");
  assert.equal(result.manifest.games[0].architecture, "X64");
  assert.deepEqual(
    result.manifest.games[0].match.map((rule) => rule.kind),
    ["steam_appid", "exe_name"],
  );
  assert.deepEqual(result.pending, []);
  assert.ok(result.manifest.engine_profiles.length >= 1);
});

test("buildManifest keeps unmatched categorized rows pending", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("external-game", "External Game")],
    overlay: {
      "external-game": {
        external: {
          url: "https://www.nexusmods.com/example/mods/1",
          label_key: "renodx.external.nexus",
        },
      },
    },
    warn: () => {},
  });

  assert.equal(result.manifest.games.length, 0);
  assert.deepEqual(result.pending, [
    { id: "external-game", name: "External Game", slug: "external-game", arch: "X64" },
  ]);
});

test("buildManifest maps external category onto v1 availability", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("external-game", "External Game")],
    overlay: {
      "external-game": {
        appid: "42",
        external: {
          url: "https://www.nexusmods.com/example/mods/1",
          label_key: "renodx.external.nexus",
        },
      },
    },
    warn: () => {},
  });

  const [title] = result.manifest.games;
  assert.equal(title.availability.kind, "external");
  assert.equal(title.availability.url, "https://www.nexusmods.com/example/mods/1");
  assert.equal(title.availability.message.id, "renodx.external.nexus");
  assert.equal(result.stats.external, 1);
});

test("buildManifest drops items with ignore flag entirely", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("garbage-game", "Garbage Game")],
    overlay: {
      "garbage-game": {
        ignore: true,
      },
    },
    warn: () => {},
  });

  assert.equal(result.manifest.games.length, 0);
  assert.deepEqual(result.pending, []);
});

test("buildManifest rejects duplicate match rules across titles", () => {
  assert.throws(
    () =>
      buildManifest({
        generatedAt: "2026-06-27T00:00:00Z",
        wiki: [game("one"), game("two")],
        overlay: {
          one: { appid: "100" },
          two: { appid: "100" },
        },
        warn: () => {},
      }),
    /duplicate match rules/,
  );
});

test("buildManifest projects overlay constraints and proxy_dll onto v1", () => {
  const result = buildManifest({
    generatedAt: "2026-06-27T00:00:00Z",
    wiki: [game("constrained-game", "Constrained Game")],
    overlay: {
      "constrained-game": {
        appid: "9001",
        required_api: ["D3D11"],
        conflicts: ["hdr"],
        compatibility_source: "https://example.com/notes",
        proxy_dll_override: "dxgi.dll",
      },
    },
    warn: () => {},
  });

  const [title] = result.manifest.games;
  assert.deepEqual(title.constraints, {
    required_api: ["D3D11"],
    conflicts: ["hdr"],
    source: "https://example.com/notes",
  });
  assert.equal(title.proxy_dll, "dxgi.dll");

  const validate = compileRenodxSchema();
  assert.equal(validate(result.manifest), true, JSON.stringify(validate.errors, null, 2));
});

test("v1 schema accepts constraints sample and rejects empty/unknown shapes", () => {
  const validate = compileRenodxSchema();

  assert.equal(
    validate(
      minimalManifest({
        constraints: { required_api: ["D3D11"], conflicts: ["hdr"] },
        proxy_dll: "dxgi.dll",
      }),
    ),
    true,
    JSON.stringify(validate.errors, null, 2),
  );

  assert.equal(validate(minimalManifest({ constraints: {} })), false);
  assert.equal(validate(minimalManifest({ constraints: { unknown: true } })), false);
  assert.equal(validate(minimalManifest({ proxy_dll: "path/to.dll" })), false);
  assert.equal(validate(minimalManifest({ proxy_dll: "path\\to.dll" })), false);
});
