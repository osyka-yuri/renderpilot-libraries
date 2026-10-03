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
  assert.equal(manifest.games.length, 907);

  const dragonQuestS = manifest.games.find((title) => title.id === "dragon-quest-11-s");
  assert.ok(dragonQuestS, "Dragon Quest XI S must be a distinct exact RenoDX target");
  assert.equal(dragonQuestS.addon.slug, "dragonquest-ue");
  assert.ok(
    dragonQuestS.match.some(
      (rule) => rule.kind === "steam_appid" && rule.value === "1295510",
    ),
  );
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);

  const enjenir = manifest.games.find((t) => t.id === "the-enjenir");
  assert.ok(enjenir, "The Enjenir must be present in manifest");
  assert.equal(enjenir.addon.slug, "ue-extended");
  assert.equal(
    enjenir.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );
  assert.ok(enjenir.match.some((r) => r.kind === "steam_appid" && r.value === "1800940"));
  assert.ok(
    enjenir.match.some((r) => r.kind === "exe_name" && r.value === "The_Enjenir.exe"),
  );

  const ln2 = manifest.games.find((t) => t.id === "little-nightmares-ii");
  assert.ok(ln2, "Little Nightmares II must be present in manifest");
  assert.equal(ln2.addon.slug, "ue-extended");
  assert.equal(
    ln2.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );
  assert.ok(ln2.match.some((r) => r.kind === "steam_appid" && r.value === "860510"));
  assert.ok(
    ln2.match.some((r) => r.kind === "exe_name" && r.value === "Little Nightmares II.exe"),
  );
  assert.ok(
    ln2.match.some(
      (r) => r.kind === "exe_name" && r.value === "Little_Nightmares_II_Enhanced.exe",
    ),
  );
  assert.equal(
    manifest.games.find((t) => t.id === "little-nightmares-ii-enhanced"),
    undefined,
    "duplicate wiki entry little-nightmares-ii-enhanced must be ignored in favor of little-nightmares-ii",
  );

  const lnEnhanced = manifest.games.find(
    (t) => t.id === "little-nightmares-enhanced-edition",
  );
  assert.ok(lnEnhanced, "Little Nightmares Enhanced Edition must be present in manifest");
  assert.equal(lnEnhanced.addon.slug, "ue-extended");
  assert.equal(
    lnEnhanced.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );
  assert.ok(
    lnEnhanced.match.some((r) => r.kind === "steam_appid" && r.value === "2149010"),
  );

  const wukong = manifest.games.find((t) => t.id === "black-myth-wukong");
  assert.ok(wukong, "Black Myth: Wukong must be present in manifest");
  assert.equal(wukong.addon.slug, "ue-extended");
  assert.equal(
    wukong.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );
  assert.ok(wukong.match.some((r) => r.kind === "steam_appid" && r.value === "2358720"));

  const bl4 = manifest.games.find((t) => t.id === "borderlands-4");
  assert.ok(bl4, "Borderlands 4 must be present in manifest");
  assert.equal(bl4.addon.slug, "ue-extended");
  assert.equal(
    bl4.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );

  const wuchang = manifest.games.find((t) => t.id === "wuchang-fallen-feathers");
  assert.ok(wuchang, "Wuchang: Fallen Feathers must be present in manifest");
  assert.equal(wuchang.addon.slug, "ue-extended");
  assert.equal(
    wuchang.addon.source,
    "https://marat569.github.io/renodx/renodx-ue-extended.addon64",
  );

  assert.equal(
    manifest.games.find((t) => t.id === "honkai-star-rail"),
    undefined,
    "Deprecated mods must not be in manifest",
  );
  assert.equal(
    manifest.games.find((t) => t.id === "sea-of-thieves"),
    undefined,
    "Deprecated mods must not be in manifest",
  );

  const spooky = manifest.games.find(
    (title) => title.id === "spooky-s-jump-scare-mansion-hd-renovation",
  );
  assert.ok(spooky, "Spooky's HD Renovation must be present in the manifest");
  assert.equal(spooky.architecture, "X64");
  assert.equal(spooky.status, "working");
  assert.equal(spooky.addon.slug, "unityengine");
  assert.ok(
    spooky.match.some((rule) => rule.kind === "steam_appid" && rule.value === "577690"),
  );
  assert.ok(
    spooky.match.some(
      (rule) => rule.kind === "exe_name" && rule.value === "SpookyUnity.exe",
    ),
  );

  const scorn = manifest.games.find((title) => title.id === "scorn");
  assert.ok(scorn, "Scorn must be present in the generated manifest");
  assert.equal(scorn.architecture, "X64");
  assert.equal(scorn.status, "working");
  assert.equal(scorn.addon.slug, "ue-extended");
  assert.ok(
    scorn.match.some((rule) => rule.kind === "steam_appid" && rule.value === "698670"),
  );
  assert.ok(
    scorn.match.some((rule) => rule.kind === "exe_name" && rule.value === "Scorn.exe"),
  );

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
