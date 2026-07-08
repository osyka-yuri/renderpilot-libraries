import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { buildReshadeManifest, SCHEMA_VERSION } from "../lib/reshade-manifest.mjs";
import { RESHADE_STABLE, RESHADE_NIGHTLY } from "../lib/reshade-sources.mjs";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

test("buildReshadeManifest emits the shared stable/nightly sources under schema v1", () => {
  const manifest = buildReshadeManifest({ generatedAt: "2026-07-05T00:00:00Z" });

  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.equal(manifest.generated_at, "2026-07-05T00:00:00Z");
  assert.deepEqual(manifest.stable, RESHADE_STABLE);
  assert.deepEqual(manifest.nightly, RESHADE_NIGHTLY);
});

test("buildReshadeManifest defaults generated_at when omitted", () => {
  const manifest = buildReshadeManifest();
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
});

test("buildReshadeManifest is deterministic for a fixed generatedAt", () => {
  const a = buildReshadeManifest({ generatedAt: "2026-01-01T00:00:00Z" });
  const b = buildReshadeManifest({ generatedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(a, b);
});

test("integrity - the committed reshade_manifest.json matches the shared source constants", async () => {
  const data = await fs.readFile(path.join(REPO_ROOT, "reshade_manifest.json"), "utf-8");
  const manifest = JSON.parse(data);

  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.deepEqual(manifest.stable, RESHADE_STABLE);
  assert.deepEqual(manifest.nightly, RESHADE_NIGHTLY);
});

test("integrity - renodx_manifest.json embeds shared sources while luma_manifest.json delegates to reshade_manifest.json", async () => {
  const [reshade, renodx, luma] = await Promise.all(
    ["reshade_manifest.json", "renodx_manifest.json", "luma_manifest.json"].map(
      async (file) => JSON.parse(await fs.readFile(path.join(REPO_ROOT, file), "utf-8")),
    ),
  );

  assert.deepEqual(renodx.reshade.nightly, reshade.nightly);
  assert.deepEqual(renodx.reshade.stable, reshade.stable);
  assert.equal("reshade" in luma, false);
  assert.match(luma.min_reshade_version, /^\d+\.\d+\.\d+$/);
});
