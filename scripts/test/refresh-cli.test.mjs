import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../catalog.mjs";
import { UsageError } from "../lib/common.mjs";
import { parseRefreshArgs } from "../lib/refresh-cli.mjs";

const MODES = [
  "check",
  "write",
  "materialize-locked",
  "migrate-transport",
  "backfill-signatures",
];

test("refresh parser defaults to check and accepts every single mode", () => {
  assert.deepEqual(parseRefreshArgs([]), { mode: "check" });
  for (const mode of MODES) {
    assert.deepEqual(parseRefreshArgs([`--${mode}`]), { mode });
  }
});

test("refresh parser rejects repeated and pairwise-conflicting modes", () => {
  for (const mode of MODES) {
    assert.throws(
      () => parseRefreshArgs([`--${mode}`, `--${mode}`]),
      (error) => error instanceof UsageError && /only once/u.test(error.message),
    );
  }
  for (let left = 0; left < MODES.length; left += 1) {
    for (let right = left + 1; right < MODES.length; right += 1) {
      assert.throws(
        () => parseRefreshArgs([`--${MODES[left]}`, `--${MODES[right]}`]),
        (error) => error instanceof UsageError && /mutually exclusive/u.test(error.message),
      );
    }
  }
});

test("refresh parser enforces the Microsoft-only product contract", () => {
  assert.deepEqual(parseRefreshArgs(["--product", "dxc"], { allowProduct: true }), {
    mode: "check",
    product: "dxc",
  });
  assert.throws(
    () =>
      parseRefreshArgs(["--product=dxc", "--product=directstorage"], {
        allowProduct: true,
      }),
    /only once/u,
  );
  assert.throws(
    () => parseRefreshArgs(["--product="], { allowProduct: true }),
    /non-empty product id/u,
  );
  assert.throws(() => parseRefreshArgs(["--product=dxc"]), /only valid for Microsoft/u);
});

test("refresh parser requires exactly one non-repeated vendor target", () => {
  const target = { target: "vendor-or-all" };
  assert.deepEqual(parseRefreshArgs(["--all"], target), {
    mode: "check",
    all: true,
  });
  assert.deepEqual(parseRefreshArgs(["--vendor=amd"], target), {
    mode: "check",
    vendorId: "amd",
    all: false,
  });
  assert.throws(() => parseRefreshArgs([], target), /exactly one/u);
  assert.throws(() => parseRefreshArgs(["--all", "--vendor=amd"], target), /exactly one/u);
  assert.throws(() => parseRefreshArgs(["--all", "--all"], target), /only once/u);
  assert.throws(
    () => parseRefreshArgs(["--vendor=amd", "--vendor=intel"], target),
    /only once/u,
  );
  assert.throws(() => parseRefreshArgs(["--vendor="], target), /non-empty vendor id/u);
});

function runScript(relativeFile, args) {
  return spawnSync(process.execPath, [path.join(repoRoot, relativeFile), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("unified and direct refresh CLIs return exit code 2 for usage errors", () => {
  const cases = [
    ["scripts/libraries.mjs", ["refresh", "github", "--write", "--check"]],
    ["scripts/libraries.mjs", ["refresh", "microsoft", "--product=unknown"]],
    ["scripts/refresh-github-release-tree.mjs", ["--all", "--all"]],
    ["scripts/refresh-github-release-tree.mjs", ["--vendor=unknown"]],
    ["scripts/refresh-microsoft-nuget.mjs", ["--product=dxc", "--product=dxc"]],
    ["scripts/refresh-microsoft-nuget.mjs", ["--product=unknown"]],
  ];
  for (const [file, args] of cases) {
    const result = runScript(file, args);
    assert.equal(result.status, 2, `${file}: ${result.stderr}`);
  }
});
