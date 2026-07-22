import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../lib/common.mjs";
import {
  dispatchLibrariesCommand,
  helpTextForLibrariesCommand,
  parseLibrariesArgs,
} from "../lib/libraries-cli.mjs";

test("library CLI parses command-specific help", () => {
  assert.deepEqual(parseLibrariesArgs(["publish", "--help"]), {
    help: true,
    command: "publish",
    args: [],
  });
  assert.match(helpTextForLibrariesCommand("publish"), /publish \[options\]/);
  assert.match(helpTextForLibrariesCommand("refresh"), /--materialize-locked/);
});

test("library CLI accepts only documented generate and validate flags", () => {
  assert.deepEqual(parseLibrariesArgs(["generate", "--check"]), {
    help: false,
    command: "generate",
    args: ["--check"],
  });
  assert.deepEqual(parseLibrariesArgs(["validate"]), {
    help: false,
    command: "validate",
    args: [],
  });
  assert.throws(
    () => parseLibrariesArgs(["generate", "--bogus"]),
    (error) =>
      error instanceof UsageError &&
      error.command === "generate" &&
      /Unknown option/.test(error.message),
  );
  assert.throws(
    () => parseLibrariesArgs(["validate", "--bogus"]),
    (error) => error instanceof UsageError && /Unknown option/.test(error.message),
  );
});

test("library CLI validates refresh mode and preserves worker arguments", () => {
  assert.deepEqual(parseLibrariesArgs(["refresh", "microsoft", "--product=dxc"]), {
    help: false,
    command: "refresh",
    args: ["--product=dxc"],
  });
  assert.deepEqual(parseLibrariesArgs(["refresh", "microsoft", "--product", "dxc"]), {
    help: false,
    command: "refresh",
    args: ["--product", "dxc"],
  });
  assert.throws(
    () => parseLibrariesArgs(["refresh", "microsoft", "--check", "--write"]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseLibrariesArgs(["refresh", "microsoft", "--bogus"]),
    (error) => error instanceof UsageError && /Unknown option/.test(error.message),
  );
  assert.throws(
    () => parseLibrariesArgs(["refresh", "nvidia", "--check"]),
    /explicit vendor 'microsoft'/,
  );
});

test("library CLI validates publish and audit flags", () => {
  assert.deepEqual(parseLibrariesArgs(["publish", "--json-only", "--dry-run"]), {
    help: false,
    command: "publish",
    args: ["--json-only", "--dry-run"],
  });
  assert.deepEqual(parseLibrariesArgs(["audit-published", "--verbose"]), {
    help: false,
    command: "audit-published",
    args: ["--verbose"],
  });
  assert.throws(
    () => parseLibrariesArgs(["publish", "--json-only", "--binary-only"]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseLibrariesArgs(["audit-published", "--bogus"]),
    (error) => error instanceof UsageError && /Unknown option/.test(error.message),
  );
});

test("library CLI dispatches each command to an explicit worker sequence", async () => {
  const calls = [];
  const runScript = async (file, args) => calls.push([file, args]);

  await dispatchLibrariesCommand({ command: "generate", args: ["--check"] }, runScript);
  assert.deepEqual(calls.splice(0), [["generate-library-catalog.mjs", ["--check"]]]);

  await dispatchLibrariesCommand({ command: "validate", args: [] }, runScript);
  assert.deepEqual(calls.splice(0), [
    ["validate.mjs", []],
    ["validate-microsoft-nuget.mjs", []],
  ]);

  await dispatchLibrariesCommand({ command: "refresh", args: ["--write"] }, runScript);
  assert.deepEqual(calls.splice(0), [["refresh-microsoft-nuget.mjs", ["--write"]]]);

  await dispatchLibrariesCommand({ command: "publish", args: ["--dry-run"] }, runScript);
  assert.deepEqual(calls.splice(0), [["publish-library-catalog.mjs", ["--dry-run"]]]);

  await dispatchLibrariesCommand(
    { command: "audit-published", args: ["--verbose"] },
    runScript,
  );
  assert.deepEqual(calls.splice(0), [["check-published-json.mjs", ["--verbose"]]]);
});
