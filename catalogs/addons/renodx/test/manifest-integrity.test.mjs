import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");

test("manifest integrity - committed RenoDX v1 document is well-formed and internally consistent", async () => {
  const manifestPath = path.join(REPO_ROOT, "addons", "v1", "renodx.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.ok(Array.isArray(manifest.games), "Manifest should have a games array");
  assert.ok(manifest.games.length > 0, "Manifest should have at least one game");
  assert.ok(
    Array.isArray(manifest.engine_profiles),
    "Manifest should have engine profiles",
  );
  assert.ok(
    manifest.engine_profiles.length > 0,
    "Manifest should have at least one engine profile",
  );
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.games.length, 834);
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);

  const taintedGrail = manifest.games.find(
    (t) => t.id === "tainted-grail-the-fall-of-avalon",
  );
  assert.ok(
    taintedGrail,
    "tainted-grail-the-fall-of-avalon must be present in the generated manifest",
  );
  assert.equal(taintedGrail.status, "working");
  assert.equal(taintedGrail.addon.slug, "unityengine");

  const blackFlagResynced = manifest.games.find(
    (title) => title.id === "assassin-s-creed-black-flag-resynced",
  );
  const blackFlagOriginal = manifest.games.find(
    (title) => title.id === "assassins-creed-iv-black-flag",
  );
  assert.ok(blackFlagResynced, "Black Flag Resynced must be a distinct title");
  assert.ok(blackFlagOriginal, "original Black Flag must remain a distinct title");
  assert.equal(blackFlagResynced.name, "Assassin’s Creed®: Black Flag Resynced");
  assert.equal(blackFlagResynced.architecture, "X64");
  assert.equal(blackFlagResynced.status, "working");
  assert.equal(blackFlagResynced.addon.slug, "asscreedblackflagresynced");
  assert.equal(
    blackFlagResynced.availability,
    undefined,
    "Resynced is official snapshot delivery, not external/Nexus",
  );
  assert.ok(
    blackFlagResynced.match.some(
      (rule) => rule.kind === "steam_appid" && rule.value === "3751950",
    ),
  );
  assert.ok(
    blackFlagResynced.match.some(
      (rule) => rule.kind === "exe_name" && rule.value === "ACBlackFlag.exe",
    ),
  );
  assert.equal(blackFlagOriginal.addon.slug, "asscreedblackflag");
  assert.ok(
    blackFlagOriginal.match.some(
      (rule) => rule.kind === "steam_appid" && rule.value === "242050",
    ),
  );
  assert.ok(
    blackFlagOriginal.match.some(
      (rule) => rule.kind === "exe_name" && rule.value === "AC4BFSP.exe",
    ),
    "original Black Flag must keep AC4BFSP.exe, not the Resynced exe",
  );

  const seen = new Map();
  for (const title of manifest.games) {
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
