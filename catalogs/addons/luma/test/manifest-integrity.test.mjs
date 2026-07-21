import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");

const DISHONORED_2 = {
  id: "dishonored-2",
  asset: "Luma-Dishonored_2.zip",
  appid: "403640",
};
const BORDERLANDS_2_AND_TPS = "borderlands-2-and-the-pre-sequel";
const TEKKEN_7 = "tekken-7";
const VANQUISH = "vanquish";
const SHADOW_OF_WAR = "middle-earth-shadow-of-war";

test("manifest integrity - committed Luma v1 document is well-formed and internally consistent", async () => {
  const manifestPath = path.join(REPO_ROOT, "addons", "v1", "luma.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.ok(Array.isArray(manifest.games), "Manifest should have a games array");
  assert.ok(manifest.games.length > 0, "Manifest should have at least one game");
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.games.length, 183);
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.match(manifest.minimum_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("host" in manifest, false);

  const dishonored2 = manifest.games.find((t) => t.id === DISHONORED_2.id);
  assert.ok(dishonored2, `${DISHONORED_2.id} must be present`);
  assert.equal(dishonored2.package.release_asset, DISHONORED_2.asset);
  assert.equal(dishonored2.package.addon_file, "Luma-Dishonored 2.addon");
  assert.ok(
    dishonored2.match.some(
      (rule) =>
        rule.kind === "steam_appid" &&
        rule.value === DISHONORED_2.appid &&
        rule.tier === 100,
    ),
    "Dishonored 2 should match by its Steam AppID",
  );

  const borderlands = manifest.games.find((t) => t.id === BORDERLANDS_2_AND_TPS);
  assert.ok(borderlands, `${BORDERLANDS_2_AND_TPS} must be present`);
  assert.equal(
    borderlands.package.addon_file,
    "Luma-Borderlands 2 and The Pre-Sequel.addon",
  );
  const dependency = borderlands.requirements.managed_dependency;
  assert.equal(dependency.kind, "dgvoodoo2");
  assert.equal(dependency.version, "2.87.3");
  assert.deepEqual(dependency.accepted_detected_apis, ["D3D9"]);
  assert.equal(dependency.reshade_proxy_dll, "dxgi.dll");
  assert.equal(typeof dependency.source.url, "string");
  assert.match(dependency.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(dependency.source.size > 0);
  assert.ok(Array.isArray(dependency.install_map));
  assert.ok(dependency.install_map.length > 0);
  const dllEntry = dependency.install_map.find((e) => e.dest === "D3D9.dll");
  assert.ok(dllEntry);
  assert.equal(dllEntry.source, "MS/x86/D3D9.dll");
  assert.match(dllEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(dllEntry.size > 0);
  assert.equal(dependency.config_file, "dgVoodoo.conf");
  assert.deepEqual(
    dependency.config.map((section) => section.section),
    ["General", "DirectX"],
  );

  const tekken7 = manifest.games.find((t) => t.id === TEKKEN_7);
  assert.ok(tekken7, `${TEKKEN_7} must be present`);
  assert.equal(tekken7.profile, "unreal");
  assert.deepEqual(tekken7.requirements.launch_arguments, ["-nod3d9ex"]);
  const sharingItsAsset = manifest.games.filter(
    (t) => t.package.release_asset === tekken7.package.release_asset,
  );
  assert.ok(sharingItsAsset.length > 1, "the generic asset should be shared across titles");

  const vanquish = manifest.games.find((t) => t.id === VANQUISH);
  assert.ok(vanquish, "Vanquish must be present");
  assert.equal(vanquish.package.release_asset, "Luma-Vanquish-x32.zip");
  assert.equal(vanquish.package.addon_file, "Luma-Vanquish.addon");
  assert.equal(vanquish.architecture, "X86");
  assert.deepEqual(vanquish.requirements.managed_dependency.accepted_detected_apis, [
    "D3D9",
  ]);
  assert.equal(vanquish.requirements.managed_dependency.reshade_proxy_dll, "dxgi.dll");
  assert.deepEqual(vanquish.requirements.managed_dependency.config, [
    {
      section: "General",
      entries: [{ key: "OutputAPI", value: "d3d11_fl11_0" }],
    },
  ]);

  const shadowOfWar = manifest.games.find((title) => title.id === SHADOW_OF_WAR);
  assert.ok(shadowOfWar, "Middle-earth: Shadow of War must be published");
  assert.equal(shadowOfWar.package.release_asset, "Luma-Middle-earth_Shadow_of_War.zip");
  assert.equal(shadowOfWar.package.addon_file, "Luma-Middle-earth Shadow of War.addon");
  assert.equal(shadowOfWar.status, "construction");
  assert.ok(
    shadowOfWar.match.some(
      (rule) => rule.kind === "steam_appid" && rule.value === "356190",
    ),
  );
  assert.ok(
    shadowOfWar.match.some(
      (rule) => rule.kind === "exe_name" && rule.value === "ShadowOfWar.exe",
    ),
  );
  assert.equal(shadowOfWar.guidance[0].id, "luma.middle-earth-shadow-of-war.dlss-only");

  const seen = new Map();
  const payloadByAsset = new Map();
  for (const title of manifest.games) {
    if (title.profile === "unreal") {
      assert.ok(title.features, `${title.id} must declare Generic UE features`);
      assert.ok(
        ["supported", "unsupported", "experimental", "unknown"].includes(
          title.features.dlss_fsr,
        ),
      );
      assert.ok(
        ["supported", "unsupported", "experimental", "unknown"].includes(
          title.features.hdr,
        ),
      );
    } else {
      assert.equal("features" in title, false, `${title.id} must not infer features`);
    }
    assert.match(title.package.addon_file, /^Luma-.+\.addon$/u);
    const payload = payloadByAsset.get(title.package.release_asset);
    assert.ok(
      payload === undefined || payload === title.package.addon_file,
      `asset ${title.package.release_asset} maps to multiple payload names`,
    );
    payloadByAsset.set(title.package.release_asset, title.package.addon_file);
    assert.equal("wiki_note_reviews" in title, false, "review records are never published");
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
