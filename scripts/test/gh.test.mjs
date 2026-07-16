import assert from "node:assert/strict";
import test from "node:test";

import { runGh } from "../lib/gh.mjs";

test("runGh dry-run does not spawn and returns ok", async () => {
  const logs = [];
  let spawned = false;
  const result = await runGh(["issue", "list"], {
    dryRun: true,
    log: (msg) => logs.push(msg),
    runCapturedFn: async () => {
      spawned = true;
      return { code: 0, stdout: "", stderr: "", log: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(spawned, false);
  assert.match(logs.join("\n"), /\[dry-run\] gh issue list/);
});

test("runGh maps zero exit to ok", async () => {
  const result = await runGh(["version"], {
    runCapturedFn: async (command, args) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["version"]);
      return { code: 0, stdout: "gh 1.0\n", stderr: "", log: "gh 1.0\n" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "gh 1.0\n");
  assert.equal(result.code, 0);
});

test("runGh maps non-zero exit to not ok", async () => {
  const result = await runGh(["issue", "list"], {
    runCapturedFn: async () => ({
      code: 1,
      stdout: "",
      stderr: "auth required",
      log: "auth required",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stderr, "auth required");
  assert.equal(result.code, 1);
});
