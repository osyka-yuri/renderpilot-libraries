import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const DISHONORED_2 = {
  id: "dishonored-2",
  asset: "Luma-Dishonored_2.zip",
  appid: "403640",
};
const BORDERLANDS_2_AND_TPS = "borderlands-2-and-the-pre-sequel";
const TEKKEN_7 = "tekken-7";

test("manifest integrity - committed luma_manifest.json is well-formed and internally consistent", async () => {
  const manifestPath = path.join(REPO_ROOT, "luma_manifest.json");
  const data = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(data);

  assert.ok(Array.isArray(manifest.titles), "Manifest should have a titles array");
  assert.ok(manifest.titles.length > 0, "Manifest should have at least one title");
  assert.equal(manifest.schema_version, 2);
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.match(manifest.min_reshade_version, /^\d+\.\d+\.\d+$/);
  assert.equal("reshade" in manifest, false);
  assert.match(manifest.defaults.min_app_version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.defaults.channel, "stable");

  const dishonored2 = manifest.titles.find((t) => t.id === DISHONORED_2.id);
  assert.ok(dishonored2, `${DISHONORED_2.id} must be present`);
  assert.equal(dishonored2.asset, DISHONORED_2.asset);
  assert.equal(dishonored2.addon_file, "Luma-Dishonored 2.addon");
  assert.ok(
    dishonored2.match.some(
      (rule) =>
        rule.kind === "steam_appid" &&
        rule.value === DISHONORED_2.appid &&
        rule.tier === 100,
    ),
    "Dishonored 2 should match by its Steam AppID",
  );

  const borderlands = manifest.titles.find((t) => t.id === BORDERLANDS_2_AND_TPS);
  assert.ok(borderlands, `${BORDERLANDS_2_AND_TPS} must be present`);
  assert.equal(borderlands.addon_file, "Luma-Borderlands 2 and The Pre-Sequel.addon");
  assert.equal(borderlands.external_requirement.kind, "dgvoodoo2");
  assert.equal(borderlands.external_requirement.version, "2.87.3");
  assert.deepEqual(borderlands.external_requirement.accepted_detected_apis, ["D3D9"]);
  assert.equal(borderlands.external_requirement.reshade_proxy_dll, "dxgi.dll");
  assert.equal(typeof borderlands.external_requirement.source.url, "string");
  assert.match(borderlands.external_requirement.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(borderlands.external_requirement.source.size > 0);
  assert.ok(Array.isArray(borderlands.external_requirement.install_map));
  assert.ok(borderlands.external_requirement.install_map.length > 0);
  const dllEntry = borderlands.external_requirement.install_map.find(
    (e) => e.dest === "D3D9.dll",
  );
  assert.ok(dllEntry);
  assert.equal(dllEntry.source, "MS/x86/D3D9.dll");
  assert.match(dllEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(dllEntry.size > 0);
  assert.equal(borderlands.external_requirement.config_file, "dgVoodoo.conf");
  assert.deepEqual(
    borderlands.external_requirement.config.map((section) => section.section),
    ["General", "DirectX"],
  );

  const tekken7 = manifest.titles.find((t) => t.id === TEKKEN_7);
  assert.ok(tekken7, `${TEKKEN_7} must be present`);
  assert.equal(tekken7.generic, true);
  assert.deepEqual(tekken7.launch_args, ["-nod3d9ex"]);
  const sharingItsAsset = manifest.titles.filter((t) => t.asset === tekken7.asset);
  assert.ok(sharingItsAsset.length > 1, "the generic asset should be shared across titles");

  const seen = new Map();
  const payloadByAsset = new Map();
  for (const title of manifest.titles) {
    assert.match(title.addon_file, /^Luma-.+\.addon$/u);
    const payload = payloadByAsset.get(title.asset);
    assert.ok(
      payload === undefined || payload === title.addon_file,
      `asset ${title.asset} maps to multiple payload names`,
    );
    payloadByAsset.set(title.asset, title.addon_file);
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
