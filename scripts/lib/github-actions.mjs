// Helpers for GitHub Actions step outputs ($GITHUB_OUTPUT).
//
// Values are written with the delimiter form recommended by GitHub so
// multiline values, `%`, and embedded newlines cannot break parsing:
//
//   name<<DELIMITER
//   value
//   DELIMITER

import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Builds a unique delimiter that does not appear in `value`.
 * @param {string} key
 * @param {string} value
 */
export function githubOutputDelimiter(key, value) {
  const safeKey = String(key).replace(/[^A-Za-z0-9_]/g, "_") || "field";
  let delim = `ghadelim_${safeKey}_${randomBytes(6).toString("hex")}`;
  let n = 0;
  while (value.includes(delim) && n < 8) {
    delim = `ghadelim_${safeKey}_${randomBytes(8).toString("hex")}`;
    n += 1;
  }
  return delim;
}

/**
 * Formats one field as a GITHUB_OUTPUT block (always delimiter form).
 * @param {string} key
 * @param {unknown} value
 */
export function formatGithubOutputEntry(key, value) {
  const str = String(value);
  const delim = githubOutputDelimiter(key, str);
  return `${key}<<${delim}\n${str}\n${delim}`;
}

/**
 * Formats fields for `$GITHUB_OUTPUT`.
 * Skips null/undefined values. Values are stringified.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string} blocks joined by `\n`, without trailing newline; empty if none
 */
export function formatGithubOutputLines(fields) {
  if (!fields || typeof fields !== "object") {
    return "";
  }

  const blocks = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    blocks.push(formatGithubOutputEntry(key, value));
  }
  return blocks.join("\n");
}

/**
 * Appends output fields to `$GITHUB_OUTPUT` when that env var is set.
 * No-op when unset or when all values are null/undefined.
 *
 * @param {Record<string, unknown>} fields
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof writeFile} [opts.writeFileFn]
 */
export async function appendGithubOutput(fields, opts = {}) {
  const env = opts.env ?? process.env;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const out = env.GITHUB_OUTPUT;
  if (!out) return;

  const lines = formatGithubOutputLines(fields);
  if (lines.length === 0) return;

  await writeFileFn(out, `${lines}\n`, { flag: "a" });
}
