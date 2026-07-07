import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

test("manifest integrity - committed renodx_manifest.json is well-formed and internally consistent", async () => {
  const manifestPath = path.join(REPO_ROOT, "renodx_manifest.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.ok(Array.isArray(manifest.titles), "Manifest should have a titles array");
  assert.ok(manifest.titles.length > 0, "Manifest should have at least one title");
  assert.ok(Array.isArray(manifest.generics), "Manifest should have a generics array");
  assert.ok(manifest.generics.length > 0, "Manifest should have at least one generic");
  assert.equal(manifest.schema_version, 3);
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.match(manifest.defaults.min_app_version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.defaults.channel, "stable");
  assert.ok(manifest.reshade.nightly.url64.startsWith("https://"), true);

  const taintedGrail = manifest.titles.find(
    (t) => t.id === "tainted-grail-the-fall-of-avalon",
  );
  assert.ok(
    taintedGrail,
    "tainted-grail-the-fall-of-avalon must be present in the generated manifest",
  );
  assert.equal(taintedGrail.status, "working");
  assert.equal(taintedGrail.slug, "unityengine");

  const seen = new Map();
  for (const title of manifest.titles) {
    for (const rule of title.match) {
      const key = `${rule.kind}:${String(rule.value ?? "").toLowerCase()}`;
      const owner = seen.get(key);
      assert.equal(
        owner,
        undefined,
        `match rule ${key} claimed by both "${owner}" and "${title.id}"`,
      );
      seen.set(key, title.id);
    }
  }
});
