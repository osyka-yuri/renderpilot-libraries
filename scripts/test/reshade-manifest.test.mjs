import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  buildLegacyV1ReshadeManifest,
  buildV1ReshadeManifest,
  SCHEMA_VERSION,
} from "../../catalogs/addons/reshade/build-manifest.mjs";
import { RESHADE_STABLE, RESHADE_NIGHTLY } from "../lib/reshade-sources.mjs";
import { publishedJsonDocuments } from "../catalog.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

function compileCurrentSchema() {
  const schema = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "catalogs", "addons", "reshade", "manifest-v1.schema.json"),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

test("buildV1ReshadeManifest emits shared channels under schema v1", () => {
  const manifest = buildV1ReshadeManifest({ generatedAt: "2026-07-05T00:00:00Z" });

  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.equal(manifest.generated_at, "2026-07-05T00:00:00Z");
  assert.deepEqual(manifest.channels.stable, RESHADE_STABLE);
  assert.deepEqual(manifest.channels.nightly, RESHADE_NIGHTLY);
});

test("buildV1ReshadeManifest defaults generated_at when omitted", () => {
  const manifest = buildV1ReshadeManifest();
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
});

test("current ReShade schema permits a nightly-only catalogue", () => {
  const manifest = buildV1ReshadeManifest({ generatedAt: "2026-07-05T00:00:00Z" });
  const nightlyOnly = {
    ...manifest,
    channels: { nightly: manifest.channels.nightly },
  };
  const validate = compileCurrentSchema();
  assert.equal(validate(nightlyOnly), true, JSON.stringify(validate.errors));
});

test("current and legacy v1 projections are deterministic for a fixed generatedAt", () => {
  const a = buildV1ReshadeManifest({ generatedAt: "2026-01-01T00:00:00Z" });
  const b = buildV1ReshadeManifest({ generatedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(a, b);
  assert.equal(buildLegacyV1ReshadeManifest(a).schema_version, 1);
});

test("integrity - the committed ReShade v1 document matches the shared source constants", async () => {
  const data = await fs.readFile(
    path.join(REPO_ROOT, "addons", "v1", "reshade.json"),
    "utf-8",
  );
  const manifest = JSON.parse(data);

  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.deepEqual(manifest.channels.stable, RESHADE_STABLE);
  assert.deepEqual(manifest.channels.nightly, RESHADE_NIGHTLY);
});

test("integrity - legacy RenoDX v3 embeds the ReShade v1 projection", async () => {
  const [reshade, renodx] = await Promise.all(
    ["reshade_manifest.json", "renodx_manifest.json"].map(async (file) =>
      JSON.parse(await fs.readFile(path.join(REPO_ROOT, file), "utf-8")),
    ),
  );

  assert.deepEqual(renodx.reshade.nightly, reshade.nightly);
  assert.deepEqual(renodx.reshade.stable, reshade.stable);
});

test("integrity - current tool-v1 catalogues contain no ReShade source block", async () => {
  const [luma, renodx] = await Promise.all(
    ["addons/v1/luma.json", "addons/v1/renodx.json"].map(async (file) =>
      JSON.parse(await fs.readFile(path.join(REPO_ROOT, file), "utf-8")),
    ),
  );

  for (const [name, manifest] of [
    ["Luma", luma],
    ["RenoDX", renodx],
  ]) {
    assert.equal(Object.hasOwn(manifest, "reshade"), false, `${name} has no reshade block`);
    assert.equal(
      Object.hasOwn(manifest, "channels"),
      false,
      `${name} has no channels block`,
    );
  }
});

test("integrity - current ReShade and both legacy projections remain published", () => {
  const publishedFiles = publishedJsonDocuments.map(({ file }) => file);
  for (const file of [
    "addons/v1/reshade.json",
    "reshade_manifest.json",
    "renodx_manifest.json",
  ]) {
    assert.ok(publishedFiles.includes(file), `${file} remains in the R2 publication list`);
  }
});

test("publication registry pins explicit R2 keys for every served JSON document", () => {
  assert.ok(publishedJsonDocuments.length > 0);
  for (const document of publishedJsonDocuments) {
    assert.equal(typeof document.file, "string");
    assert.equal(typeof document.r2Key, "string");
    assert.ok(document.r2Key.length > 0);
    assert.equal(document.r2Key.includes("\\"), false);
  }

  const keys = Object.fromEntries(
    publishedJsonDocuments.map(({ file, r2Key }) => [file, r2Key]),
  );
  assert.equal(keys["addons/v1/luma.json"], "addons/v1/luma.json");
  assert.equal(keys["addons/v1/renodx.json"], "addons/v1/renodx.json");
  assert.equal(keys["addons/v1/reshade.json"], "addons/v1/reshade.json");
  assert.equal(keys["renodx_manifest.json"], "renodx_manifest.json");
  assert.equal(keys["reshade_manifest.json"], "reshade_manifest.json");
});
