import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendGithubOutput,
  formatGithubOutputEntry,
  formatGithubOutputLines,
  githubOutputDelimiter,
} from "../lib/github-actions.mjs";
import { capLogTail } from "../lib/process.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

async function actionYamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return actionYamlFiles(entryPath);
      }
      return /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

test("formatGithubOutputEntry uses delimiter form", () => {
  const block = formatGithubOutputEntry("status", "update_available");
  const match = /^(?<key>[^\n<]+)<<(?<delim>[^\n]+)\n(?<value>[\s\S]*)\n\k<delim>$/.exec(
    block,
  );
  assert.ok(match, `unexpected block: ${JSON.stringify(block)}`);
  assert.equal(match.groups.key, "status");
  assert.equal(match.groups.value, "update_available");
  assert.match(match.groups.delim, /^ghadelim_status_[a-f0-9]+$/);
});

test("formatGithubOutputEntry handles multiline values", () => {
  const block = formatGithubOutputEntry("body", "line1\nline2");
  const match = /^(?<key>[^\n<]+)<<(?<delim>[^\n]+)\n(?<value>[\s\S]*)\n\k<delim>$/.exec(
    block,
  );
  assert.ok(match);
  assert.equal(match.groups.value, "line1\nline2");
});

test("githubOutputDelimiter avoids collisions with the value", () => {
  const value = "contains ghadelim_x_deadbeef already";
  const delim = githubOutputDelimiter("x", value);
  assert.equal(value.includes(delim), false);
});

test("formatGithubOutputLines skips null and undefined", () => {
  const text = formatGithubOutputLines({ a: "1", b: null, c: undefined, d: 0, e: "" });
  assert.match(text, /^a<<.+\n1\n/m);
  assert.match(text, /^d<<.+\n0\n/m);
  assert.match(text, /^e<<.+\n\n/m);
  assert.doesNotMatch(text, /^b<</m);
  assert.doesNotMatch(text, /^c<</m);
});

test("formatGithubOutputLines returns empty for empty input", () => {
  assert.equal(formatGithubOutputLines({}), "");
  assert.equal(formatGithubOutputLines(null), "");
});

test("appendGithubOutput is a no-op without GITHUB_OUTPUT", async () => {
  let called = false;
  await appendGithubOutput(
    { status: "ok" },
    {
      env: {},
      writeFileFn: async () => {
        called = true;
      },
    },
  );
  assert.equal(called, false);
});

test("appendGithubOutput appends delimiter blocks", async () => {
  const writes = [];
  await appendGithubOutput(
    { status: "update_available", version: "6.0.0", skip: null },
    {
      env: { GITHUB_OUTPUT: "/tmp/fake-output" },
      writeFileFn: async (path, data, opts) => {
        writes.push({ path, data, opts });
      },
    },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/fake-output");
  assert.equal(writes[0].opts.flag, "a");
  assert.match(writes[0].data, /status<<.+\nupdate_available\n/);
  assert.match(writes[0].data, /version<<.+\n6\.0\.0\n/);
  assert.doesNotMatch(writes[0].data, /^status=/m);
});

test("capLogTail keeps the end of a long log", () => {
  const log = "a".repeat(100);
  assert.equal(capLogTail(log, 50, 40).length, 40);
  assert.equal(capLogTail("short", 50, 40), "short");
});

test("all external GitHub Actions are pinned to full commit SHAs", async () => {
  const files = await actionYamlFiles(path.join(REPOSITORY_ROOT, ".github"));
  const violations = [];

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    lines.forEach((line, index) => {
      const match = /^\s*uses:\s+(?<action>[^./\s][^@\s]*)@(?<ref>[^\s#]+)/u.exec(line);
      if (match === null) {
        return;
      }
      if (!/^[a-f0-9]{40}$/u.test(match.groups.ref) || !/#\s+v\d/u.test(line)) {
        violations.push(
          `${path.relative(REPOSITORY_ROOT, file)}:${index + 1}: ${line.trim()}`,
        );
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("pnpm setup reads its single version from package.json", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  assert.equal(packageJson.packageManager, "pnpm@11.18.0");

  const files = await actionYamlFiles(path.join(REPOSITORY_ROOT, ".github"));
  const violations = [];

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!/^\s*-\s+uses:\s+pnpm\/action-setup@/u.test(line)) {
        return;
      }

      const stepIndent = /^\s*/u.exec(line)[0].length;
      let end = index + 1;
      while (end < lines.length) {
        const candidate = lines[end];
        if (candidate.trim() !== "" && /^\s*/u.exec(candidate)[0].length <= stepIndent) {
          break;
        }
        end += 1;
      }

      const step = lines.slice(index, end).join("\n");
      if (/^\s+version:\s+/mu.test(step)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});
