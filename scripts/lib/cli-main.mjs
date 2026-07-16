// Shared CLI entry-point plumbing for repository scripts.
//
// Exit-code contract (also documented on `UsageError` in common.mjs):
//   0 — success / help
//   1 — operational failure
//   2 — usage / bad flags
//
// Convention: help/usage text goes to stderr (same stream as usage errors).

import { UsageError, errorMessage } from "./common.mjs";

/**
 * Assign `process.exitCode` from a programmatic return-code API.
 * @param {number} code
 */
export function applyExitCode(code) {
  process.exitCode = code;
}

/**
 * Runs a CLI `main` after parsing argv. Sets `process.exitCode` and never
 * rethrows expected usage/help paths.
 *
 * Prefer this for process entrypoints. Programmatic/test APIs that return
 * exit codes should share the same parse/main body and call `applyExitCode`
 * only at the process boundary.
 *
 * @param {object} opts
 * @param {(argv: string[]) => object} opts.parse  — may throw `UsageError`
 * @param {(args: object) => void} [opts.help]     — print usage (stderr) when `args.help`
 * @param {(args: object) => void | Promise<void>} opts.main
 * @param {string[]} [opts.argv]                   — defaults to process.argv.slice(2)
 * @param {number} [opts.usageExitCode=2]
 * @param {number} [opts.failureExitCode=1]
 */
export function runCliMain({
  parse,
  help,
  main,
  argv = process.argv.slice(2),
  usageExitCode = 2,
  failureExitCode = 1,
}) {
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      help?.(args ?? {});
      process.exitCode = usageExitCode;
      return;
    }
    console.error(errorMessage(error));
    process.exitCode = failureExitCode;
    return;
  }

  if (args?.help) {
    help?.(args);
    return;
  }

  Promise.resolve()
    .then(() => main(args))
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(error.message);
        help?.(args);
        process.exitCode = usageExitCode;
        return;
      }
      console.error(errorMessage(error));
      process.exitCode = failureExitCode;
    });
}
