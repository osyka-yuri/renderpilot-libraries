import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../lib/common.mjs";
import { runCliMain } from "../lib/cli-main.mjs";

async function withCapturedExit(fn) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return process.exitCode;
  } finally {
    process.exitCode = previous;
  }
}

test("runCliMain sets exitCode 2 on UsageError from parse", async () => {
  let helpArgs;
  const code = await withCapturedExit(() => {
    runCliMain({
      argv: ["--bad"],
      parse: () => {
        const error = new UsageError("bad flag");
        error.command = "generate";
        throw error;
      },
      help: (args) => {
        helpArgs = args;
      },
      main: async () => {
        throw new Error("should not run");
      },
    });
  });
  assert.equal(code, 2);
  assert.deepEqual(helpArgs, { command: "generate" });
});

test("runCliMain short-circuits help without calling main", async () => {
  let mainCalled = false;
  const code = await withCapturedExit(() => {
    runCliMain({
      argv: ["--help"],
      parse: () => ({ help: true }),
      help: () => {},
      main: async () => {
        mainCalled = true;
      },
    });
  });
  assert.equal(mainCalled, false);
  assert.equal(code, undefined);
});

test("runCliMain sets exitCode 1 on operational failure", async () => {
  const code = await withCapturedExit(async () => {
    runCliMain({
      argv: [],
      parse: () => ({}),
      main: async () => {
        throw new Error("boom");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(code, 1);
});

test("runCliMain leaves exitCode unset on success", async () => {
  const code = await withCapturedExit(async () => {
    runCliMain({
      argv: [],
      parse: () => ({}),
      main: async () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(code, undefined);
});
