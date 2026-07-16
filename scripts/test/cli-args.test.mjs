import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../lib/common.mjs";
import { parseCliArgs, wantsHelp } from "../lib/cli-args.mjs";

test("wantsHelp detects --help and -h among other flags", () => {
  assert.equal(wantsHelp([]), false);
  assert.equal(wantsHelp(["--check"]), false);
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--check", "--help"]), true);
});

test("parseCliArgs returns values for known flags", () => {
  const { values } = parseCliArgs(["--check", "--verbose"], {
    check: { type: "boolean" },
    verbose: { type: "boolean" },
  });
  assert.equal(values.check, true);
  assert.equal(values.verbose, true);
});

test("parseCliArgs throws UsageError for unknown flags", () => {
  assert.throws(() => parseCliArgs(["--nope"], { check: { type: "boolean" } }), UsageError);
});
