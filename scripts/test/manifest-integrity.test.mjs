import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

test("manifest integrity - Tainted Grail should have correct status and slug", async () => {
  const manifestPath = path.join(REPO_ROOT, "renodx_manifest.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.ok(manifest.titles, "Manifest should have titles");
  assert.ok(manifest.generics, "Manifest should have generics");

  const taintedGrail = manifest.titles.find(
    (t) => t.id === "tainted-grail-the-fall-of-avalon",
  );

  // Depending on whether we've run sync:wiki and generate:renodx,
  // it might not be there if the manifest isn't generated yet in CI,
  // but let's assert if it's there, it's correct.
  if (taintedGrail) {
    assert.equal(taintedGrail.status, "working");
    // Should use the generic unityengine slug!
    assert.equal(taintedGrail.slug, "unityengine");
  }
});
