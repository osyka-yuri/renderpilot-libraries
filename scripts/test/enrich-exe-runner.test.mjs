import assert from "node:assert/strict";
import test from "node:test";

import { runEnrichExe } from "../lib/enrich-exe-runner.mjs";

test("enrich-exe help describes the RenoDX-only cache source", async (t) => {
  const messages = [];
  t.mock.method(console, "error", (message) => messages.push(String(message)));

  const exitCode = await runEnrichExe({
    cacheFile: "unused-for-help.json",
    collectAppids: () => [],
    argv: ["--help"],
  });

  const help = messages.join("\n");
  assert.equal(exitCode, 0);
  assert.match(help, /RenoDX match overlay/);
  assert.doesNotMatch(help, /any tool's match_overlay/);
});

test("enrich-exe unknown flags return usage exit code 2", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(String(message)));

  const exitCode = await runEnrichExe({
    cacheFile: "unused-for-usage.json",
    collectAppids: () => [],
    argv: ["--nope"],
  });

  assert.equal(exitCode, 2);
  assert.match(errors.join("\n"), /Unknown option|unknown|nope/i);
  assert.match(errors.join("\n"), /Usage: node enrich-exe/);
});
