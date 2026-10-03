#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { finalizeXiphSource } from "./finalize-xiph-source.mjs";
import { parseCliArgs } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { persistPreparedLibraryObject } from "./lib/library-artifact-io.mjs";
import { expectedXiphArtifactKeys, xiphBuildConfigurations } from "./lib/xiph-matrix.mjs";

runCliMain({
  parse: (argv) =>
    parseCliArgs(argv, {
      "build-root": { type: "string" },
      "lock-file": { type: "string" },
      "source-file": { type: "string" },
      "cdn-directory": { type: "string" },
    }).values,
  main: async (args) => {
    const buildRoot = requiredPath(args, "build-root");
    const lockFile = requiredPath(args, "lock-file");
    const sourceFile = requiredPath(args, "source-file");
    const cdnDirectory = requiredPath(args, "cdn-directory");
    const result = await finalizeXiphSource({
      buildRoot,
      lockFile,
      sourceFile,
      runnerContext: "integration",
      persistObject: (prepared) => persistPreparedLibraryObject(prepared, { cdnDirectory }),
    });
    const expectedArtifacts = expectedXiphArtifactKeys(
      result.pair,
      result.pair.build_revision,
    );
    const expectedConfigurations = xiphBuildConfigurations({
      buildRevision: result.pair.build_revision,
    });
    assertFinalizedSource(
      result.source,
      "prepared source",
      expectedConfigurations.length,
      expectedArtifacts.length,
    );
    if (result.pair.builds.at(-1)?.artifacts.length !== expectedArtifacts.length) {
      throw new Error(
        `Xiph integration finalization did not preserve all ${expectedArtifacts.length} build receipts`,
      );
    }
    const committed = JSON.parse(await readFile(sourceFile, "utf8"));
    assertFinalizedSource(
      committed,
      "committed source",
      expectedConfigurations.length,
      expectedArtifacts.length,
    );
  },
});

function assertFinalizedSource(
  source,
  context,
  expectedPackagesCount,
  expectedArtifactsCount,
) {
  const artifactKeys = new Set(source.artifacts.map((artifact) => artifact.artifact_key));
  const dllHashes = new Set(source.artifacts.map((artifact) => artifact.dll.sha256));
  const members = source.packages.flatMap((packageValue) => packageValue.members);
  if (
    source.packages.length !== expectedPackagesCount ||
    members.length !== expectedArtifactsCount ||
    source.artifacts.length === 0 ||
    source.artifacts.length > expectedArtifactsCount ||
    artifactKeys.size !== source.artifacts.length ||
    dllHashes.size !== source.artifacts.length ||
    members.some((member) => !artifactKeys.has(member.artifact_key))
  ) {
    throw new Error(`${context}: Xiph integration catalog is incomplete or inconsistent`);
  }
}

function requiredPath(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required`);
  }
  return path.resolve(value);
}
