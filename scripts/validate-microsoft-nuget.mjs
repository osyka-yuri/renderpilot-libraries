#!/usr/bin/env node

import path from "node:path";

import { microsoftLibraryVendor, repoRoot } from "./catalog.mjs";
import {
  assertLockSemantics,
  assertLockExtendsBaseline,
  buildMicrosoftVendorSource,
  releaseCounts,
} from "./lib/microsoft-nuget.mjs";
import { buildVendorSnapshot, compareNumericVersions } from "./lib/library-catalog.mjs";
import { readJsonAtGitRef } from "./lib/git-json.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";

const LOCK_REPO_PATH = microsoftLibraryVendor.lockFile;

const DIRECTSTORAGE_RELEASES = new Map([
  ["9bc09a0a76183c9470d86694a95224c16dfd94c637360ef948f7db291a6ee523", "1.0.2203.901"],
  ["30706ddcabc0f5f15f70fa41c153da6923d18551c8e560c3593dce63a017fc2b", "1.0.2205.2402"],
  ["25979f0b9e1ed1d05d1021104692f9967f3540098117db1fb74485b1fbbead94", "1.1.2211.304"],
  ["c7e9013c280e399181cde12a42339dfc24ec4fce623f6b114120c31f43a31b78", "1.1.2212.610"],
  ["cc61dacb8b5de98db8563d13d3d76585d7e87b3e0840e2e9212e89692d960ae3", "1.2.2304.1701"],
  ["1347296498710391508ef8c605298c73c1610c6610576819192959193d2bf036", "1.2.2305.1502"],
  ["8a7f9809b4630d22796445ab9aa44181458d0f73f03705b1dfafd79410e07334", "1.2.2311.1405"],
  ["882d95c3012aa4e49bee48fe7e2305dbf3aa06df001e431a6606aec756feff6c", "1.2.2407.1501"],
  ["66c5ffc2f525fb1ce33f9fec4eceda122545201a14c5397c42cd91fc956c7c6a", "1.2.2504.401"],
  ["cae65787f61514bec6f012f44546e68b19e39d8854a9ab52af813370d44b272a", "1.3.2506.2501"],
]);

async function main() {
  const [config, lock, snapshot] = await Promise.all([
    readJsonFileAsync(path.join(repoRoot, microsoftLibraryVendor.configFile)),
    readJsonFileAsync(path.join(repoRoot, microsoftLibraryVendor.lockFile)),
    readJsonFileAsync(path.join(repoRoot, microsoftLibraryVendor.outputFile)),
  ]);
  assertLockSemantics(lock, config);
  const baselineRef = process.env.MICROSOFT_NUGET_BASE_REF || "HEAD";
  const baseline = await readJsonAtGitRef(baselineRef, LOCK_REPO_PATH, {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (baseline) {
    assertLockSemantics(baseline, config);
    assertLockExtendsBaseline(lock, baseline);
  } else {
    console.log(`Microsoft NuGet lock has no baseline at ${baselineRef} (initial import).`);
  }

  const counts = releaseCounts(lock);
  for (const product of config.products) {
    const actual = counts.get(product.key) ?? 0;
    if (actual < product.expected_listed_stable_releases) {
      throw new Error(
        `${product.key}: expected at least ${product.expected_listed_stable_releases} locked releases, got ${actual}`,
      );
    }
  }

  const forbiddenDxc = new Set(["1.7.2212.48", "101.7.2207.25"]);
  for (const release of lock.releases) {
    if (release.product === "dxc" && forbiddenDxc.has(release.package_version)) {
      throw new Error(`unlisted DXC ${release.package_version} must not be imported`);
    }
  }

  const directStorage = lock.releases
    .filter((release) => release.product === "directstorage")
    .flatMap((release) => release.artifacts.map((artifact) => artifact.dll_sha256));
  for (const release of lock.releases.filter(
    (candidate) => candidate.product === "directstorage",
  )) {
    for (const artifact of release.artifacts) {
      if (!artifact.r2.object_key.startsWith("libraries/blobs/sha256/")) {
        throw new Error(`${release.package_id} ${release.package_version}: non-v1 R2 key`);
      }
    }
  }
  const importedDirectStorage = new Set(directStorage);
  if ([...DIRECTSTORAGE_RELEASES.keys()].some((hash) => !importedDirectStorage.has(hash))) {
    throw new Error(
      "one or more published DirectStorage DLL hashes disappeared or changed",
    );
  }

  const expectedSnapshot = buildVendorSnapshot(buildMicrosoftVendorSource(lock, config));
  if (JSON.stringify(expectedSnapshot) !== JSON.stringify(snapshot)) {
    throw new Error("Microsoft vendor snapshot does not match its deterministic sources");
  }
  const artifactById = new Map(
    expectedSnapshot.artifacts.map((artifact) => [artifact.artifact_id, artifact]),
  );
  for (const packageValue of expectedSnapshot.packages.filter(
    (candidate) => candidate.technology === "direct_storage",
  )) {
    const primary = packageValue.members.find((member) => member.role === "primary");
    const artifact = artifactById.get(primary?.artifact_id);
    const expectedVersion = DIRECTSTORAGE_RELEASES.get(artifact?.dll.sha256);
    if (
      !artifact?.file_version ||
      compareNumericVersions(expectedVersion, artifact.file_version) !== 0
    ) {
      throw new Error(
        `published DirectStorage DLL identity changed for ${packageValue.release.version}`,
      );
    }
  }

  console.log(
    `Microsoft NuGet lock is valid: D3D12 ${counts.get("d3d12_agility")}, DXC ${counts.get("dxc")}, DirectStorage ${counts.get("directstorage")}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
