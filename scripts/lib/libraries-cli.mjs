import { UsageError } from "./common.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";

const COMMANDS = new Set(["generate", "validate", "refresh", "publish", "audit-published"]);

const HELP = Object.freeze({
  all: `Usage: node scripts/libraries.mjs <command> [options]

Commands:
  generate [--check]
  validate
  refresh microsoft [--check|--write|--materialize-locked|--backfill-signatures]
  publish [--json-only|--binary-only] [--dry-run] [--force]
  audit-published [--verbose] [--dry-run]`,
  generate: `Usage: node scripts/libraries.mjs generate [--check]

  --check       Verify generated snapshots without writing files.`,
  validate: `Usage: node scripts/libraries.mjs validate`,
  refresh: `Usage: node scripts/libraries.mjs refresh microsoft [options]

  --check                    Detect missing listed stable releases.
  --write                    Import missing releases and persist the lock.
  --materialize-locked      Re-verify and recompress locked releases.
  --backfill-signatures      Re-verify missing Authenticode timestamps.
  --product=<id>             Limit the operation to one configured product.`,
  publish: `Usage: node scripts/libraries.mjs publish [options]

  --json-only    Publish JSON snapshots and index; verify every referenced blob.
  --binary-only  Publish locally available blobs, then verify every catalog blob.
  --dry-run      Print ordered publication phases without network access.
  --force        Re-upload objects even when the remote copy matches.`,
  "audit-published": `Usage: node scripts/libraries.mjs audit-published [options]

  --verbose, -v  Print local and remote SHA-256 for every file.
  --dry-run      List local files and their SHA-256; no network access.`,
});

export function parseLibrariesArgs(argv) {
  if (argv.length === 0) return { help: true, command: null, args: [] };
  if (argv.length === 1 && wantsHelp(argv)) {
    return { help: true, command: null, args: [] };
  }

  const [command, ...args] = argv;
  if (!COMMANDS.has(command)) {
    throw new UsageError(`unknown library command: ${command}`);
  }
  if (wantsHelp(args)) {
    return { help: true, command, args: [] };
  }

  try {
    switch (command) {
      case "generate":
        parseCliArgs(args, { check: { type: "boolean" } });
        break;
      case "validate":
        parseCliArgs(args, {});
        break;
      case "refresh":
        validateRefreshArgs(args);
        break;
      case "publish":
        validatePublishArgs(args);
        break;
      case "audit-published":
        validateAuditArgs(args);
        break;
      default:
        throw new UsageError(`unsupported library command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) error.command = command;
    throw error;
  }

  return {
    help: false,
    command,
    // The outer CLI consumes the vendor positional argument; the legacy
    // refresh worker receives only its option flags.
    args: command === "refresh" ? args.slice(1) : args,
  };
}

export function printLibrariesHelp({ command } = {}) {
  console.error(HELP[command] ?? HELP.all);
}

export function helpTextForLibrariesCommand(command = null) {
  return HELP[command] ?? HELP.all;
}

export async function dispatchLibrariesCommand({ command, args }, runScript) {
  switch (command) {
    case "generate":
      return runScript("generate-library-catalog.mjs", args);
    case "validate":
      await runScript("validate.mjs", []);
      return runScript("validate-microsoft-nuget.mjs", []);
    case "refresh":
      return runScript("refresh-microsoft-nuget.mjs", args);
    case "publish":
      return runScript("publish-library-catalog.mjs", args);
    case "audit-published":
      return runScript("check-published-json.mjs", args);
    default:
      throw new UsageError(`unsupported library command: ${command}`);
  }
}

function validateRefreshArgs(args) {
  const [vendor, ...flags] = args;
  if (vendor !== "microsoft") {
    throw new UsageError("refresh currently requires the explicit vendor 'microsoft'");
  }

  const { values } = parseCliArgs(flags, {
    check: { type: "boolean" },
    write: { type: "boolean" },
    "materialize-locked": { type: "boolean" },
    "backfill-signatures": { type: "boolean" },
    product: { type: "string" },
  });
  const modes = [
    values.check,
    values.write,
    values["materialize-locked"],
    values["backfill-signatures"],
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new UsageError(
      "refresh modes --check, --write, --materialize-locked, and --backfill-signatures are mutually exclusive",
    );
  }
  if (values.product !== undefined && values.product.trim() === "") {
    throw new UsageError("--product requires a non-empty product id");
  }
}

function validatePublishArgs(args) {
  const { values } = parseCliArgs(args, {
    "json-only": { type: "boolean" },
    "binary-only": { type: "boolean" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
  });
  if (values["json-only"] && values["binary-only"]) {
    throw new UsageError("--json-only and --binary-only are mutually exclusive");
  }
}

function validateAuditArgs(args) {
  parseCliArgs(args, {
    verbose: { type: "boolean", short: "v" },
    "dry-run": { type: "boolean" },
  });
}
