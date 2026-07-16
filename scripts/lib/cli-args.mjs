// Thin wrapper around `node:util` parseArgs for repository CLI scripts.
// Unknown options and invalid values surface as `UsageError` (no stack dump).
//
// Standard help-wins pattern for parsers:
//   if (wantsHelp(argv)) return { help: true, ...defaults };
//   const { values } = parseCliArgs(argv, options);

import { parseArgs as nodeParseArgs } from "node:util";

import { UsageError, errorMessage } from "./common.mjs";

/** True when argv requests help (`--help` or `-h`), including mixed with other flags. */
export function wantsHelp(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * @param {string[]} argv
 * @param {import("node:util").ParseArgsConfig["options"]} options
 * @param {Omit<import("node:util").ParseArgsConfig, "args"|"options">} [config]
 * @returns {import("node:util").ParseArgsReturn<"strict", any, any, any>}
 */
export function parseCliArgs(argv, options, config = {}) {
  try {
    return nodeParseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: false,
      ...config,
    });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}
