import assert from "node:assert/strict";
import test from "node:test";

import { runEnrichExe } from "../lib/enrich-exe-runner.mjs";

test("enrich-exe help describes the RenoDX-only cache source", async (t) => {
  const messages = [];
  t.mock.method(console, "log", (message) => messages.push(String(message)));

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
