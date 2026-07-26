import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../lib/common.mjs";
import {
  formatLifecyclePlan,
  parseMicrosoftPruneArgs,
  parseMicrosoftWithdrawalArgs,
  validateMicrosoftLifecycleCommandArgs,
} from "../lib/microsoft-lifecycle.mjs";

test("Microsoft lifecycle parsers share canonical package identity handling", () => {
  assert.deepEqual(
    parseMicrosoftWithdrawalArgs([
      "--package-id=Microsoft.Direct3D.DXC",
      "--version=01.09-preview+build.sha",
      "--reason=security",
      "--evidence=GHSA-example",
      "--write",
    ]),
    {
      help: false,
      packageId: "Microsoft.Direct3D.DXC",
      packageVersion: "1.9.0-preview",
      reason: "security",
      evidence: "GHSA-example",
      write: true,
    },
  );
  assert.deepEqual(
    parseMicrosoftPruneArgs(["--package-id=Microsoft.Direct3D.DXC", "--version=1.9"]),
    {
      help: false,
      packageId: "Microsoft.Direct3D.DXC",
      packageVersion: "1.9.0",
      execute: false,
    },
  );
});

test("Microsoft lifecycle parsers reject invalid usage before dispatch", () => {
  assert.throws(
    () =>
      parseMicrosoftWithdrawalArgs([
        "--package-id=Microsoft.Direct3D.DXC",
        "--version=1.9",
        "--reason=other",
      ]),
    (error) => error instanceof UsageError && /reason/u.test(error.message),
  );
  assert.throws(
    () =>
      parseMicrosoftWithdrawalArgs([
        "--package-id=Microsoft.Direct3D.DXC",
        "--version=1.9",
        "--reason=security",
      ]),
    (error) => error instanceof UsageError && /evidence/u.test(error.message),
  );
  assert.throws(
    () => parseMicrosoftPruneArgs(["--package-id=Microsoft.Direct3D.DXC"]),
    (error) => error instanceof UsageError && /required/u.test(error.message),
  );
  assert.throws(
    () => validateMicrosoftLifecycleCommandArgs("withdraw", ["github"]),
    /explicit vendor/u,
  );
});

test("lifecycle plan formatter keeps one stable envelope", () => {
  assert.equal(
    formatLifecyclePlan("dry_run", { package_id: "Example", package_version: "1.0.0" }),
    JSON.stringify(
      {
        action: "dry_run",
        package_id: "Example",
        package_version: "1.0.0",
      },
      null,
      2,
    ),
  );
  assert.throws(
    () => formatLifecyclePlan("dry_run", { action: "execute" }),
    /unambiguous action/u,
  );
});
