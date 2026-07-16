// Thin wrapper around the GitHub CLI (`gh`) for repository automation scripts.

import { runCaptured } from "./process.mjs";

/**
 * Run `gh` with the given args.
 *
 * When `dryRun` is true, logs the planned command and returns ok without spawning.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof runCaptured} [opts.runCapturedFn]
 * @param {(msg: string) => void} [opts.log] — dry-run logger (default console.log)
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code?: number|null }>}
 */
export async function runGh(args, opts = {}) {
  const {
    dryRun = false,
    cwd,
    env = process.env,
    runCapturedFn = runCaptured,
    log = console.log,
  } = opts;

  if (dryRun) {
    log(`[dry-run] gh ${args.join(" ")}`);
    return { ok: true, stdout: "", stderr: "" };
  }

  const result = await runCapturedFn("gh", args, { cwd, env, windowsHide: true });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}
