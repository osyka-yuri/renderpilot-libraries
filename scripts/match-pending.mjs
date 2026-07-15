#!/usr/bin/env node

import { addonCatalogs } from "./catalog.mjs";
import { errorMessage, UsageError } from "./lib/common.mjs";
import { runPendingMatching } from "./lib/pending-matching.mjs";
import {
  createLumaPendingStore,
  createRenodxPendingStore,
} from "./lib/pending-match-stores.mjs";

const DEFAULT_TOOL = "renodx";
const TOOLS = Object.freeze({
  renodx: Object.freeze({
    catalog: addonCatalogs.renodx,
    createStore: createRenodxPendingStore,
  }),
  luma: Object.freeze({
    catalog: addonCatalogs.luma,
    createStore: createLumaPendingStore,
  }),
});

export function parseToolArg(argv) {
  let tool = DEFAULT_TOOL;
  let foundTool = false;

  for (const arg of argv) {
    if (!arg.startsWith("--tool=")) {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
    if (foundTool) throw new UsageError("--tool may be specified only once");
    foundTool = true;
    tool = arg.slice("--tool=".length);
  }

  if (!Object.hasOwn(TOOLS, tool)) {
    throw new UsageError(
      `Unknown --tool "${tool}"; expected one of: ${Object.keys(TOOLS).join(", ")}`,
    );
  }
  return tool;
}

export function filesForTool(tool) {
  const catalog = TOOLS[tool]?.catalog;
  if (!catalog) throw new UsageError(`Unknown tool: ${tool}`);

  return {
    pendingMatch: catalog.sources.pending,
    matchOverlay: catalog.sources.overlay ?? null,
    profiles: catalog.sources.curatedGames ?? null,
    unmatched: catalog.sources.unmatched,
    manifest: catalog.outputs.manifest.file,
  };
}

async function main(argv = process.argv.slice(2)) {
  const tool = parseToolArg(argv);
  await runPendingMatching({
    tool,
    files: filesForTool(tool),
    createStore: TOOLS[tool].createStore,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error instanceof UsageError ? `Usage error: ${error.message}` : errorMessage(error),
    );
    process.exitCode = 1;
  });
}
