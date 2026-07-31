#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { resolveRepoPath } from "./catalog.mjs";
import {
  persistPreparedLibraryObject,
  prepareCompressedDll,
  prepareLegalDocument,
} from "./lib/library-artifact-io.mjs";
import { buildVendorSnapshot } from "./lib/library-catalog.mjs";
import { sha256Hex } from "./lib/hash.mjs";
import { assertJsonSchema, compileJsonSchema } from "./lib/json-schema-validation.mjs";
import { parseCliArgs } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { stringifyFormattedJson, writeJsonFilesBatchWithRollback } from "./lib/json.mjs";
import { assertXiphCatalogMatchesLock } from "./lib/xiph-catalog-state.mjs";
import {
  assertXiphManifestMatrix,
  canonicalXiphReleaseVersion,
  xiphArtifactKey,
  xiphBuildConfigurations,
  xiphCatalogArtifactKey,
} from "./lib/xiph-matrix.mjs";

const BUILD_ROOT = resolveRepoPath(".artifacts", "xiph");
const LOCK_FILE = resolveRepoPath("catalogs", "libraries", "xiph.lock.json");
const SOURCE_FILE = resolveRepoPath("catalogs", "libraries", "xiph.json");
const SOURCE_SCHEMA_FILE = resolveRepoPath("schemas", "library_vendor_source.schema.json");
const SNAPSHOT_SCHEMA_FILE = resolveRepoPath("schemas", "library_vendor_v1.schema.json");
let schemaValidatorsPromise;

if (isMainModule()) {
  runCliMain({
    parse: (argv) =>
      parseCliArgs(argv, {
        "build-root": { type: "string" },
      }).values,
    main: async (args) => {
      const buildRoot =
        args["build-root"] === undefined
          ? BUILD_ROOT
          : path.resolve(resolveRepoPath(), args["build-root"]);
      const result = await finalizeXiphSource({ buildRoot });
      process.stdout.write(
        `materialized=${result.pair.vorbis_version}|${result.pair.ogg_version}\n`,
      );
    },
  });
}

export async function finalizeXiphSource({
  buildRoot = BUILD_ROOT,
  lockFile = LOCK_FILE,
  sourceFile = SOURCE_FILE,
  prepareDll = prepareCompressedDll,
  prepareLegal = prepareLegalDocument,
  persistObject = persistPreparedLibraryObject,
  writeBatch = writeJsonFilesBatchWithRollback,
  now = () => new Date(),
  runnerContext = "publication",
} = {}) {
  const [manifestValue, lock, previous, validators] = await Promise.all([
    readFile(path.join(buildRoot, "build-manifest.json"), "utf8").then(JSON.parse),
    readFile(lockFile, "utf8").then(JSON.parse),
    readFile(sourceFile, "utf8").then(JSON.parse),
    xiphSchemaValidators(),
  ]);
  const manifest = assertXiphManifestMatrix(manifestValue);
  const { artifactsByDllSha: sourceArtifactByDllSha } = assertXiphCatalogMatchesLock(
    previous,
    lock,
    { runnerContext },
  );
  assertJsonSchema(previous, validators.validateSource, "existing Xiph source catalog");
  const previousSnapshot = buildVendorSnapshot(previous);
  assertJsonSchema(
    previousSnapshot,
    validators.validateSnapshot,
    "existing Xiph vendor snapshot",
  );

  const pair = lock.pairs.find(
    (candidate) =>
      candidate.vorbis_version === manifest.pair.vorbis_version &&
      candidate.ogg_version === manifest.pair.ogg_version,
  );
  if (!pair || pair.build_revision !== manifest.pair.build_revision) {
    throw new Error("build manifest does not match the active append-only Xiph pair");
  }
  if (pair.builds.some((build) => build.build_revision === pair.build_revision)) {
    throw new Error(
      "locked Xiph builds are immutable; increment build_revision for an exceptional rebuild",
    );
  }

  const legalInputs = [
    ["ogg", "COPYING.ogg.txt"],
    ["vorbis", "COPYING.vorbis.txt"],
  ];
  const preparedObjects = new Map();
  const legalById = new Map();
  for (const [component, fileName] of legalInputs) {
    const bytes = await readFile(path.join(buildRoot, fileName));
    const prepared = await prepareLegal(bytes, "text");
    recordPreparedObject(preparedObjects, prepared);
    const content = prepared.result;
    const id = `license.${content.sha256}`;
    if (!legalById.has(id)) {
      legalById.set(id, {
        legal_document_id: id,
        kind: "license",
        title: `${component === "ogg" ? "libogg" : "libvorbis"} BSD license`,
        format: "text",
        file_name: fileName,
        content: { sha256: content.sha256, size_bytes: content.size_bytes },
      });
    }
  }
  const legalDocuments = [...legalById.values()];
  legalDocuments.sort((left, right) =>
    left.legal_document_id.localeCompare(right.legal_document_id),
  );

  const artifacts = [];
  const lockedArtifacts = [];
  const configurations = xiphBuildConfigurations();
  const recordsByConfiguration = new Map(
    configurations.map((configuration) => [xiphConfigurationKey(configuration), []]),
  );
  const allowedComponents = new Set(
    configurations.flatMap((configuration) => configuration.components),
  );
  const sourceArtifactKeyByBuildArtifactKey = new Map();
  for (const record of manifest.artifacts) {
    const artifactPath = path.resolve(record.path);
    const relative = path.relative(buildRoot, artifactPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `build manifest artifact escapes the Xiph output root: ${record.path}`,
      );
    }
    if (typeof record.pe_version !== "string") {
      throw new Error(`built DLL has no verified PE FileVersion: ${record.path}`);
    }
    const bytes = await readFile(artifactPath);
    if (sha256Hex(bytes) !== record.sha256 || bytes.length !== record.size_bytes) {
      throw new Error(`built DLL changed after verification: ${record.path}`);
    }
    const component = record.component;
    if (!allowedComponents.has(component)) {
      throw new Error(`build manifest has an unknown Xiph component: ${component}`);
    }
    const configurationRecords = recordsByConfiguration.get(xiphConfigurationKey(record));
    if (configurationRecords === undefined) {
      throw new Error(
        `build manifest has an unknown Xiph configuration: ${xiphConfigurationKey(record)}`,
      );
    }
    configurationRecords.push(record);

    const artifactKey = xiphArtifactKey(pair, pair.build_revision, record);
    const candidateIdentity = {
      library_id: `xiph_${component}`,
      file_name: record.file_name,
      file_version: record.pe_version,
      architecture: record.architecture,
      pe_named_exports: record.pe_named_exports,
      pe_imports: record.pe_imports,
      dll: { sha256: record.sha256, size_bytes: record.size_bytes },
      signature: { status: "unsigned" },
    };

    let indexedArtifact = sourceArtifactByDllSha.get(record.sha256);
    if (indexedArtifact === undefined) {
      const prepared = await prepareDll(bytes);
      recordPreparedObject(preparedObjects, prepared);
      const transport = prepared.result;
      const sourceArtifact = {
        artifact_key: xiphCatalogArtifactKey(record.sha256),
        ...candidateIdentity,
        transport: {
          sha256: transport.zst_sha256,
          size_bytes: transport.zst_size_bytes,
        },
      };
      indexedArtifact = {
        sourceArtifact,
        buildTransport: transport,
      };
      sourceArtifactByDllSha.set(record.sha256, indexedArtifact);
      artifacts.push(sourceArtifact);
      sourceArtifactKeyByBuildArtifactKey.set(artifactKey, sourceArtifact.artifact_key);
    } else {
      const {
        artifact_key: _existingKey,
        transport: _existingTransport,
        ...existingIdentity
      } = indexedArtifact.sourceArtifact;
      if (!isDeepStrictEqual(existingIdentity, candidateIdentity)) {
        throw new Error(
          `identical Xiph DLL bytes have conflicting metadata: ${record.sha256}`,
        );
      }
      sourceArtifactKeyByBuildArtifactKey.set(
        artifactKey,
        indexedArtifact.sourceArtifact.artifact_key,
      );
    }
    lockedArtifacts.push({
      artifact_key: artifactKey,
      dll_sha256: record.sha256,
      dll_size_bytes: record.size_bytes,
      transport: indexedArtifact.buildTransport,
    });
  }
  artifacts.sort((left, right) => left.artifact_key.localeCompare(right.artifact_key));
  lockedArtifacts.sort((left, right) =>
    left.artifact_key.localeCompare(right.artifact_key),
  );

  const provenance = {
    kind: "source_build",
    sources: {
      ogg: { version: pair.ogg_version, ...pair.sources.ogg },
      vorbis: { version: pair.vorbis_version, ...pair.sources.vorbis },
    },
    build_revision: pair.build_revision,
    recipe_sha256: manifest.recipe_sha256,
    verification_policy_sha256: manifest.verification_policy_sha256,
    patches: manifest.patches,
    toolchain: manifest.toolchain,
  };
  const packages = [];
  for (const { architecture, topology, profile, components } of configurations) {
    const records = recordsByConfiguration.get(
      xiphConfigurationKey({ architecture, topology, profile }),
    );
    const names = new Map(records.map((record) => [record.component, record.file_name]));
    const orderedComponents = components;
    if (
      records.length !== orderedComponents.length ||
      orderedComponents.some((component) => !names.has(component))
    ) {
      throw new Error(
        `build manifest is incomplete for ${architecture}/${topology}/${profile}`,
      );
    }
    const lookup =
      `vorbis-${pair.vorbis_version}.ogg-${pair.ogg_version}` +
      `.r${pair.build_revision}.${architecture.toLowerCase()}` +
      `.${topology}.${profile}`;
    const variant = `${topology}.${profile}`;
    packages.push({
      package_id:
        `xiph_vorbis.vorbis-${pair.vorbis_version}.ogg-${pair.ogg_version}` +
        `.r${pair.build_revision}.${architecture.toLowerCase()}.${variant}`,
      technology: "xiph_vorbis",
      variant,
      display_name: `Xiph Vorbis/Ogg (${topology}, ${profile})`,
      release: {
        version: canonicalXiphReleaseVersion(pair.vorbis_version),
        channel: "stable",
        label: null,
        components: {
          ogg: canonicalXiphReleaseVersion(pair.ogg_version),
          vorbis: canonicalXiphReleaseVersion(pair.vorbis_version),
        },
      },
      target: { os: "windows", architecture },
      provenance,
      legal_document_ids: legalDocuments.map((document) => document.legal_document_id),
      members: orderedComponents.map((component, index) => {
        const buildArtifactKey = `${lookup}.${component}`;
        const sourceArtifactKey = sourceArtifactKeyByBuildArtifactKey.get(buildArtifactKey);
        if (sourceArtifactKey === undefined) {
          throw new Error(`missing finalized Xiph artifact ${buildArtifactKey}`);
        }
        return {
          artifact_key: sourceArtifactKey,
          component,
          role: index === 0 ? "primary" : "support",
          install_as: names.get(component),
        };
      }),
    });
  }
  packages.sort((left, right) => left.package_id.localeCompare(right.package_id));

  const generatedAt = now().toISOString();
  const retainedPackages = previous.packages.filter(
    (packageValue) => !isSameXiphTuple(packageValue, pair),
  );
  const activePackages = mergeByKey(retainedPackages, packages, "package_id");
  const referencedArtifactKeys = new Set(
    activePackages.flatMap((packageValue) =>
      packageValue.members.map((member) => member.artifact_key),
    ),
  );
  const activeArtifacts = mergeByKey(
    previous.artifacts.filter((artifact) =>
      referencedArtifactKeys.has(artifact.artifact_key),
    ),
    artifacts,
    "artifact_key",
  ).filter((artifact) => referencedArtifactKeys.has(artifact.artifact_key));
  const referencedLegalIds = new Set(
    activePackages.flatMap((packageValue) => packageValue.legal_document_ids),
  );
  const source = {
    schema_version: 1,
    vendor: { id: "xiph", display_name: "Xiph.Org Foundation" },
    generated_at: generatedAt,
    legal_documents: mergeByKey(
      previous.legal_documents.filter((document) =>
        referencedLegalIds.has(document.legal_document_id),
      ),
      legalDocuments,
      "legal_document_id",
      { allowIdentical: true },
    ).filter((document) => referencedLegalIds.has(document.legal_document_id)),
    artifacts: activeArtifacts,
    packages: activePackages,
  };
  pair.builds.push({
    build_revision: pair.build_revision,
    generated_at: generatedAt,
    recipe_sha256: manifest.recipe_sha256,
    verification_policy_sha256: manifest.verification_policy_sha256,
    patches: manifest.patches,
    toolchain: manifest.toolchain,
    artifacts: lockedArtifacts,
  });
  const snapshot = buildVendorSnapshot(source);
  assertXiphCatalogMatchesLock(source, lock, { runnerContext });
  assertJsonSchema(source, validators.validateSource, "candidate Xiph source catalog");
  assertJsonSchema(snapshot, validators.validateSnapshot, "candidate Xiph vendor snapshot");
  const [sourceBody, lockBody] = await Promise.all([
    stringifyFormattedJson(source, sourceFile),
    stringifyFormattedJson(lock, lockFile),
  ]);
  // Immutable content-addressed objects are intentionally persisted before the
  // mutable JSON commit point. A later failure can leave safe orphan blobs, but
  // the index/source never references a partially persisted set.
  for (const prepared of preparedObjects.values()) {
    await persistObject(prepared);
  }
  await writeBatch([
    { file: sourceFile, body: sourceBody },
    { file: lockFile, body: lockBody },
  ]);
  return { pair, source, lock };
}

async function xiphSchemaValidators() {
  schemaValidatorsPromise ??= Promise.all([
    readFile(SOURCE_SCHEMA_FILE, "utf8"),
    readFile(SNAPSHOT_SCHEMA_FILE, "utf8"),
  ]).then(([sourceSchema, snapshotSchema]) => ({
    validateSource: compileJsonSchema(JSON.parse(sourceSchema)),
    validateSnapshot: compileJsonSchema(JSON.parse(snapshotSchema)),
  }));
  return schemaValidatorsPromise;
}

function xiphConfigurationKey({ architecture, topology, profile }) {
  return `${architecture}\0${topology}\0${profile}`;
}

function recordPreparedObject(objects, prepared) {
  if (
    typeof prepared?.object_key !== "string" ||
    !Buffer.isBuffer(prepared.bytes) ||
    prepared.bytes.length === 0 ||
    prepared.result === null ||
    typeof prepared.result !== "object"
  ) {
    throw new Error("Xiph finalizer received an invalid prepared asset");
  }
  const previous = objects.get(prepared.object_key);
  if (previous && !previous.bytes.equals(prepared.bytes)) {
    throw new Error(`${prepared.object_key}: conflicting prepared immutable bytes`);
  }
  objects.set(prepared.object_key, prepared);
}

function isMainModule() {
  return (
    typeof process.argv[1] === "string" &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

function isSameXiphTuple(packageValue, pair) {
  return (
    packageValue.technology === "xiph_vorbis" &&
    packageValue.provenance?.kind === "source_build" &&
    packageValue.provenance.sources?.vorbis?.version === pair.vorbis_version &&
    packageValue.provenance.sources?.ogg?.version === pair.ogg_version
  );
}

function mergeByKey(previous, additions, key, { allowIdentical = false } = {}) {
  const values = new Map((previous ?? []).map((value) => [value[key], value]));
  for (const value of additions) {
    if (values.has(value[key])) {
      if (
        allowIdentical &&
        JSON.stringify(values.get(value[key])) === JSON.stringify(value)
      ) {
        continue;
      }
      throw new Error(`Xiph catalog identity is immutable: duplicate ${key} ${value[key]}`);
    }
    values.set(value[key], value);
  }
  return [...values.values()].sort((left, right) => left[key].localeCompare(right[key]));
}
