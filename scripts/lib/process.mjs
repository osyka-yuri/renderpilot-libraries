// Shared child-process helpers for repository tooling.
//
// Two policies:
//   runCaptured — capture stdout/stderr; always resolves (caller inspects code)
//                 stdin is ignored so children cannot hang on an open pipe
//   runInherit  — inherit stdio; rejects on non-zero exit or signal

import { spawn } from "node:child_process";

import { errorMessage } from "./common.mjs";

/**
 * Caps a growing log string by **character** length (JS string `.length`),
 * not UTF-8 byte length. Good enough for process log budgets.
 *
 * @param {string} log
 * @param {number} maxChars
 * @param {number} keepChars
 */
export function capLogTail(log, maxChars, keepChars) {
  if (typeof log !== "string" || log.length <= maxChars) {
    return log;
  }
  return log.slice(-keepChars);
}

/**
 * Spawn `command` with `args`, capture stdout+stderr.
 * Always resolves (including spawn errors → code null).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.windowsHide=true]
 * @param {number|null} [opts.maxChars] — if set, cap combined log by string length
 * @param {number} [opts.keepChars] — retained tail when capping (default 75% of max)
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, log: string }>}
 */
export function runCaptured(command, args, opts = {}) {
  const { cwd, env = process.env, windowsHide = true } = opts;
  const maxChars = opts.maxChars ?? null;
  const keepChars =
    opts.keepChars ?? (maxChars != null ? Math.floor(maxChars * 0.75) : null);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide,
      // Do not leave stdin piped; tools that never read stdin should not hang.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let log = "";

    const append = (chunk, stream) => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      log += text;
      if (maxChars != null && keepChars != null && log.length > maxChars) {
        log = capLogTail(log, maxChars, keepChars);
        // Keep stream buffers roughly in sync with the capped combined log.
        if (stdout.length > keepChars) stdout = stdout.slice(-keepChars);
        if (stderr.length > keepChars) stderr = stderr.slice(-keepChars);
      }
    };

    child.stdout?.on("data", (c) => append(c, "stdout"));
    child.stderr?.on("data", (c) => append(c, "stderr"));

    child.on("error", (error) => {
      const message = `spawn error: ${errorMessage(error)}`;
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr ? `${stderr}\n${message}` : message,
        log: log ? `${log}\n${message}` : message,
      });
    });

    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, log });
    });
  });
}

/**
 * Spawn with inherited stdio. Rejects on spawn error, signal, or non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.shell] — default true on win32 (needed for pnpm.cmd)
 * @param {boolean} [opts.windowsHide=true]
 */
export function runInherit(command, args, opts = {}) {
  const {
    cwd,
    env = process.env,
    shell = process.platform === "win32",
    windowsHide = true,
  } = opts;

  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell,
    windowsHide,
  });

  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`${command} ${args.join(" ")} killed by ${signal}`));
      return;
    }
    if (code !== 0) {
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      return;
    }
    resolve();
  });

  return promise;
}
