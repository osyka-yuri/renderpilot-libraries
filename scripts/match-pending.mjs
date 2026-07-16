#!/usr/bin/env node

import { addonCatalogs } from "./catalog.mjs";
import { UsageError } from "./lib/common.mjs";
import { parseCliArgs, wantsHelp } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
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

const HELP_TEXT = `Usage: node scripts/match-pending.mjs [--tool=renodx|luma]

Match pending Steam AppIDs for an add-on catalogue and write resolved overlays.

  --tool=renodx|luma   Catalogue to process (default: renodx).
  -h, --help           Show this help message.`;

export function parseToolArg(argv) {
  if (wantsHelp(argv)) {
    return { help: true, tool: DEFAULT_TOOL };
  }

  const { values } = parseCliArgs(argv, {
    tool: { type: "string", default: DEFAULT_TOOL },
    help: { type: "boolean", short: "h" },
  });

  const tool = String(values.tool ?? DEFAULT_TOOL);
  if (!Object.hasOwn(TOOLS, tool)) {
    throw new UsageError(
      `Unknown --tool "${tool}"; expected one of: ${Object.keys(TOOLS).join(", ")}`,
    );
  }
  return { help: false, tool };
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

function printHelp() {
  console.error(HELP_TEXT);
}

async function main({ tool }) {
  await runPendingMatching({
    tool,
    files: filesForTool(tool),
    createStore: TOOLS[tool].createStore,
  });
}

if (import.meta.main) {
  runCliMain({
    parse: parseToolArg,
    help: printHelp,
    main,
  });
}
