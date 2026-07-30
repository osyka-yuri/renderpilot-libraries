import { generatedLibraryVendors } from "../catalog.mjs";
import { UsageError } from "./common.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";
import { parseRefreshArgs } from "./refresh-cli.mjs";
import {
  generatedLibraryAggregateRefreshProviders,
  generatedLibraryRefreshProvider,
  generatedLibraryValidatorScripts,
} from "./library-source-adapters.mjs";
import { validateMicrosoftLifecycleCommandArgs } from "./microsoft-lifecycle.mjs";

const COMMANDS = new Set([
  "generate",
  "validate",
  "refresh",
  "withdraw",
  "prune",
  "publish",
  "audit-published",
]);
const REFRESH_PROVIDERS = Object.freeze({
  ...Object.fromEntries(
    generatedLibraryVendors.map((vendor) => [
      vendor.refreshName,
      generatedLibraryRefreshProvider(vendor),
    ]),
  ),
  ...generatedLibraryAggregateRefreshProviders(generatedLibraryVendors),
});
const REFRESH_VENDOR_NAMES = Object.keys(REFRESH_PROVIDERS);
const REFRESH_VENDOR_LIST = REFRESH_VENDOR_NAMES.join("|");
const REFRESH_VENDOR_QUOTED = REFRESH_VENDOR_NAMES.map((name) => `'${name}'`).join(", ");
const GENERATED_VALIDATOR_SCRIPTS =
  generatedLibraryValidatorScripts(generatedLibraryVendors);

const HELP = Object.freeze({
  all: `Usage: node scripts/libraries.mjs <command> [options]

Commands:
  generate [--check]
  validate
  refresh <${REFRESH_VENDOR_LIST}> [--check|--write|--materialize-locked|--migrate-transport|--backfill-signatures]
  withdraw microsoft --package-id=<id> --version=<version> [--reason=<reason>] [--evidence=<text>] [--write]
  prune microsoft --package-id=<id> --version=<version> [--execute]
  publish [--json-only|--assets-only] [--asset-manifest=<path>] [--dry-run] [--force]
  audit-published [--verbose] [--dry-run]`,
  generate: `Usage: node scripts/libraries.mjs generate [--check]

  --check       Verify generated snapshots without writing files.`,
  validate: `Usage: node scripts/libraries.mjs validate`,
  refresh: `Usage: node scripts/libraries.mjs refresh <${REFRESH_VENDOR_LIST}> [options]

  --check                    Detect missing listed releases and active withdrawals.
  --write                    Import missing releases and persist the lock.
  --materialize-locked      Re-verify and restore the exact locked transport identity.
  --migrate-transport       Intentionally replace locked transport identities.
  --backfill-signatures      Re-verify and backfill missing signed_at values.
  --product=<id>             Microsoft only: limit to one configured product.`,
  withdraw: `Usage: node scripts/libraries.mjs withdraw microsoft --package-id=<id> --version=<version> [options]

  --reason=<reason>  unlisted, hard_delete, security, or legal
  --evidence=<text>  Required for manual security/legal withdrawal
  --write            Persist the tombstone and rebuild v1 snapshots.`,
  prune: `Usage: node scripts/libraries.mjs prune microsoft --package-id=<id> --version=<version> [--execute]

  --execute  Delete only tombstone-scoped, unreferenced DLL transport objects.`,
  publish: `Usage: node scripts/libraries.mjs publish [options]

  --json-only    Publish JSON snapshots and index; verify every referenced asset.
  --assets-only  Publish locally available immutable DLL and legal-document assets.
  --asset-manifest  Restrict assets-only publication to a verified CI bundle manifest.
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
      case "withdraw":
        validateMicrosoftLifecycleCommandArgs(command, args);
        break;
      case "prune":
        validateMicrosoftLifecycleCommandArgs(command, args);
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
    ...(command === "refresh" ? { refreshVendor: args[0] } : {}),
    // The outer CLI consumes the provider positional argument; refresh
    // workers receive only their option flags.
    args: new Set(["refresh", "withdraw", "prune"]).has(command) ? args.slice(1) : args,
  };
}

export function printLibrariesHelp({ command } = {}) {
  console.error(HELP[command] ?? HELP.all);
}

export function helpTextForLibrariesCommand(command = null) {
  return HELP[command] ?? HELP.all;
}

export async function dispatchLibrariesCommand(
  { command, args, refreshVendor },
  runScript,
) {
  switch (command) {
    case "generate":
      return runScript("generate-library-catalog.mjs", args);
    case "validate":
      await runScript("validate.mjs", []);
      for (const script of GENERATED_VALIDATOR_SCRIPTS) {
        await runScript(script, []);
      }
      return;
    case "refresh": {
      const provider = REFRESH_PROVIDERS[refreshVendor];
      if (!provider) {
        throw new UsageError(
          `refresh requires an explicit vendor: ${REFRESH_VENDOR_QUOTED}`,
        );
      }
      return runScript(provider.script, [...provider.argsPrefix, ...args]);
    }
    case "withdraw":
      return runScript("withdraw-microsoft-nuget.mjs", args);
    case "prune":
      return runScript("prune-microsoft-withdrawn.mjs", args);
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
  const provider = REFRESH_PROVIDERS[vendor];
  if (!provider) {
    throw new UsageError(`refresh requires an explicit vendor: ${REFRESH_VENDOR_QUOTED}`);
  }

  parseRefreshArgs(flags, {
    allowBackfillSignatures: provider.allowBackfillSignatures,
    allowProduct: provider.allowProduct,
  });
}

function validatePublishArgs(args) {
  const { values } = parseCliArgs(args, {
    "json-only": { type: "boolean" },
    "assets-only": { type: "boolean" },
    "asset-manifest": { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
  });
  if (values["json-only"] && values["assets-only"]) {
    throw new UsageError("--json-only and --assets-only are mutually exclusive");
  }
  if (values["asset-manifest"] && !values["assets-only"]) {
    throw new UsageError("--asset-manifest requires --assets-only");
  }
}

function validateAuditArgs(args) {
  parseCliArgs(args, {
    verbose: { type: "boolean", short: "v" },
    "dry-run": { type: "boolean" },
  });
}
