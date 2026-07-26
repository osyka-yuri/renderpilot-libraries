import path from "node:path";

import { microsoftLibraryVendor, repoRoot } from "../catalog.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";
import { UsageError } from "./common.mjs";
import { readJsonFileAsync } from "./json.mjs";
import { normalizePackageVersion } from "./library-values.mjs";
import {
  assertLockSemantics,
  assertMicrosoftWithdrawalEvidence,
  MICROSOFT_WITHDRAWAL_REASONS,
} from "./microsoft-nuget.mjs";

export { MICROSOFT_WITHDRAWAL_REASONS };
export const MICROSOFT_WITHDRAWAL_OPTIONS = Object.freeze({
  "package-id": { type: "string" },
  version: { type: "string" },
  reason: { type: "string" },
  evidence: { type: "string" },
  write: { type: "boolean" },
});
export const MICROSOFT_PRUNE_OPTIONS = Object.freeze({
  "package-id": { type: "string" },
  version: { type: "string" },
  execute: { type: "boolean" },
});

export const MICROSOFT_WITHDRAWAL_HELP = `Usage: node scripts/withdraw-microsoft-nuget.mjs --package-id=<id> --version=<version> [options]

  --reason=<reason>  unlisted, hard_delete, security, or legal
  --evidence=<text>  Required for manual security/legal withdrawal
  --write            Persist the tombstone and rebuild all v1 snapshots

Without --write the command performs a verified dry-run.`;

export const MICROSOFT_PRUNE_HELP = `Usage: node scripts/prune-microsoft-withdrawn.mjs --package-id=<id> --version=<version> [--execute]

Default mode prints the exact tombstone-scoped prune plan. --execute deletes only
unreferenced DLL transport objects; legal documents and shared blobs are retained.`;

export function parseMicrosoftWithdrawalArgs(argv) {
  if (wantsHelp(argv)) return { help: true };
  const { values } = parseCliArgs(argv, MICROSOFT_WITHDRAWAL_OPTIONS);
  const identity = parseMicrosoftPackageIdentity(values);
  if (
    values.reason !== undefined &&
    !MICROSOFT_WITHDRAWAL_REASONS.includes(values.reason)
  ) {
    throw new UsageError(`--reason must be ${MICROSOFT_WITHDRAWAL_REASONS.join(", ")}`);
  }
  try {
    assertMicrosoftWithdrawalEvidence(values.reason, values.evidence);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    help: false,
    ...identity,
    reason: values.reason,
    evidence: values.evidence,
    write: Boolean(values.write),
  };
}

export function parseMicrosoftPruneArgs(argv) {
  if (wantsHelp(argv)) return { help: true };
  const { values } = parseCliArgs(argv, MICROSOFT_PRUNE_OPTIONS);
  return {
    help: false,
    ...parseMicrosoftPackageIdentity(values),
    execute: Boolean(values.execute),
  };
}

export function validateMicrosoftLifecycleCommandArgs(command, args) {
  const [vendor, ...flags] = args;
  if (vendor !== "microsoft") {
    throw new UsageError(`${command} requires the explicit vendor: 'microsoft'`);
  }
  const parser =
    command === "withdraw"
      ? parseMicrosoftWithdrawalArgs
      : command === "prune"
        ? parseMicrosoftPruneArgs
        : null;
  if (!parser) throw new UsageError(`unsupported Microsoft lifecycle command: ${command}`);
  parser(flags);
}

export async function loadMicrosoftCatalogState() {
  const configFile = path.join(repoRoot, microsoftLibraryVendor.configFile);
  const lockFile = path.join(repoRoot, microsoftLibraryVendor.lockFile);
  const [config, lock] = await Promise.all([
    readJsonFileAsync(configFile),
    readJsonFileAsync(lockFile),
  ]);
  assertLockSemantics(lock, config);
  return Object.freeze({ config, lock, configFile, lockFile });
}

export function formatLifecyclePlan(action, plan) {
  if (
    typeof action !== "string" ||
    action.length === 0 ||
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    Object.hasOwn(plan, "action")
  ) {
    throw new TypeError("lifecycle plan requires one unambiguous action envelope");
  }
  return JSON.stringify({ action, ...plan }, null, 2);
}

function parseMicrosoftPackageIdentity(values) {
  const packageId = values["package-id"];
  if (
    typeof packageId !== "string" ||
    packageId.trim() === "" ||
    packageId !== packageId.trim() ||
    typeof values.version !== "string" ||
    values.version.trim() === ""
  ) {
    throw new UsageError("--package-id and --version are required");
  }
  let packageVersion;
  try {
    packageVersion = normalizePackageVersion(values.version);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    packageId,
    packageVersion,
  };
}
