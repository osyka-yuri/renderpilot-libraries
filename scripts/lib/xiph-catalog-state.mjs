import { isDeepStrictEqual } from "node:util";

import { assertVendorSource } from "./library-catalog.mjs";
import { assertXiphLock } from "./xiph-lock.mjs";
import {
  XIPH_SOURCE_IDS,
  xiphArtifactKey,
  xiphBuildConfigurations,
} from "./xiph-matrix.mjs";

export function assertXiphCatalogMatchesLock(
  source,
  lock,
  { runnerContext = "publication" } = {},
) {
  assertVendorSource(source);
  assertXiphLock(lock, { runnerContext });
  if (source.vendor.id !== "xiph") {
    throw new Error(`Xiph catalog state has unexpected vendor ${source.vendor.id}`);
  }

  const sourceArtifactsByKey = new Map(
    source.artifacts.map((artifact) => [artifact.artifact_key, artifact]),
  );
  const completedBuilds = indexLatestCompletedBuilds(lock);
  const expectedPackages = expectedCompletedPackageKeys(completedBuilds);
  const observedPackages = new Set();
  const artifactsByDllSha = new Map();

  for (const packageValue of source.packages) {
    if (packageValue.technology !== "xiph_vorbis") {
      throw new Error(
        `${packageValue.package_id}: non-Xiph package is forbidden in the Xiph catalog`,
      );
    }
    const buildContext = completedBuilds.get(packageBuildKey(packageValue));
    if (buildContext === undefined) {
      throw new Error(
        `${packageValue.package_id}: Xiph package does not reference the latest completed build`,
      );
    }

    const packageKey = completedPackageKey(packageValue);
    if (!expectedPackages.has(packageKey)) {
      throw new Error(
        `${packageValue.package_id}: Xiph package configuration is not locked`,
      );
    }
    if (observedPackages.has(packageKey)) {
      throw new Error(
        `${packageValue.package_id}: duplicate locked Xiph package configuration`,
      );
    }
    observedPackages.add(packageKey);

    assertPackageProvenance(packageValue, buildContext);
    assertPackageArtifacts(
      packageValue,
      buildContext,
      sourceArtifactsByKey,
      artifactsByDllSha,
    );
  }

  const missingPackages = [...expectedPackages].filter(
    (packageKey) => !observedPackages.has(packageKey),
  );
  if (missingPackages.length !== 0) {
    throw new Error(
      `Xiph catalog is missing packages for completed locked builds: ${missingPackages.join(", ")}`,
    );
  }
  return { artifactsByDllSha };
}

function indexLatestCompletedBuilds(lock) {
  const builds = new Map();
  for (const pair of lock.pairs) {
    const build = pair.builds.at(-1);
    if (build === undefined) continue;
    builds.set(buildKey(pair.vorbis_version, pair.ogg_version, build.build_revision), {
      pair,
      build,
      artifactsByKey: new Map(
        build.artifacts.map((artifact) => [artifact.artifact_key, artifact]),
      ),
    });
  }
  return builds;
}

function expectedCompletedPackageKeys(completedBuilds) {
  const expected = new Set();
  for (const buildContext of completedBuilds.values()) {
    for (const configuration of xiphBuildConfigurations()) {
      expected.add(configurationKey(buildContext, configuration));
    }
  }
  return expected;
}

function assertPackageProvenance(packageValue, { pair, build }) {
  const expected = {
    kind: "source_build",
    sources: Object.fromEntries(
      XIPH_SOURCE_IDS.map((component) => [
        component,
        {
          version: component === "ogg" ? pair.ogg_version : pair.vorbis_version,
          ...pair.sources[component],
        },
      ]),
    ),
    build_revision: build.build_revision,
    recipe_sha256: build.recipe_sha256,
    verification_policy_sha256: build.verification_policy_sha256,
    patches: build.patches,
    toolchain: build.toolchain,
  };
  if (!isDeepStrictEqual(packageValue.provenance, expected)) {
    throw new Error(
      `${packageValue.package_id}: Xiph package provenance differs from its locked build`,
    );
  }
}

function assertPackageArtifacts(
  packageValue,
  buildContext,
  sourceArtifactsByKey,
  artifactsByDllSha,
) {
  const [topology, profile] = packageValue.variant.split(".");
  for (const member of packageValue.members) {
    const sourceArtifact = sourceArtifactsByKey.get(member.artifact_key);
    const receiptKey = xiphArtifactKey(
      buildContext.pair,
      buildContext.build.build_revision,
      {
        architecture: packageValue.target.architecture,
        topology,
        profile,
        component: member.component,
      },
    );
    const receipt = buildContext.artifactsByKey.get(receiptKey);
    if (
      receipt === undefined ||
      receipt.dll_sha256 !== sourceArtifact.dll.sha256 ||
      receipt.dll_size_bytes !== sourceArtifact.dll.size_bytes ||
      receipt.transport.zst_sha256 !== sourceArtifact.transport.sha256 ||
      receipt.transport.zst_size_bytes !== sourceArtifact.transport.size_bytes
    ) {
      throw new Error(
        `${packageValue.package_id}/${member.component}: Xiph artifact differs from its exact locked build receipt`,
      );
    }

    artifactsByDllSha.set(sourceArtifact.dll.sha256, {
      sourceArtifact,
      buildTransport: receipt.transport,
    });
  }
}

function packageBuildKey(packageValue) {
  return buildKey(
    packageValue.provenance.sources.vorbis.version,
    packageValue.provenance.sources.ogg.version,
    packageValue.provenance.build_revision,
  );
}

function buildKey(vorbisVersion, oggVersion, buildRevision) {
  return `${vorbisVersion}\0${oggVersion}\0${buildRevision}`;
}

function completedPackageKey(packageValue) {
  return [
    packageBuildKey(packageValue),
    packageValue.target.architecture,
    packageValue.variant,
  ].join("\0");
}

function configurationKey({ pair, build }, configuration) {
  return [
    buildKey(pair.vorbis_version, pair.ogg_version, build.build_revision),
    configuration.architecture,
    `${configuration.topology}.${configuration.profile}`,
  ].join("\0");
}
