import assert from "node:assert/strict";
import test from "node:test";

import { capLogTail, runCaptured, runInherit } from "../lib/process.mjs";

test("capLogTail returns short strings unchanged", () => {
  assert.equal(capLogTail("hello", 10, 5), "hello");
});

test("capLogTail keeps the tail by character length", () => {
  assert.equal(capLogTail("abcdefghij", 5, 3), "hij");
});

test("runCaptured captures stdout and exit code", async () => {
  const result = await runCaptured(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hi");
  assert.match(result.log, /hi/);
});

test("runCaptured caps combined log by maxChars", async () => {
  const result = await runCaptured(
    process.execPath,
    ["-e", "process.stdout.write('abcdefghijklmnopqrstuvwxyz')"],
    { maxChars: 10, keepChars: 6 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.log.length, 6);
  assert.equal(result.log, "uvwxyz");
});

test("runCaptured resolves spawn errors with null code", async () => {
  const result = await runCaptured("definitely-not-a-real-command-xyz", [], {});
  assert.equal(result.code, null);
  assert.match(result.stderr, /spawn error/i);
});

test("runInherit resolves on zero exit", async () => {
  await runInherit(process.execPath, ["-e", "process.exit(0)"], { shell: false });
});

test("runInherit rejects on non-zero exit", async () => {
  await assert.rejects(
    () => runInherit(process.execPath, ["-e", "process.exit(3)"], { shell: false }),
    /exited with code 3/,
  );
});
