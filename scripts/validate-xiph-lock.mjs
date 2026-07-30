#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { resolveRepoPath } from "./catalog.mjs";
import { parseCliArgs } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { assertXiphCatalogMatchesLock } from "./lib/xiph-catalog-state.mjs";
import { assertXiphLockExtendsBaseline } from "./lib/xiph-lock.mjs";

const execFileAsync = promisify(execFile);
const LOCK_RELATIVE_PATH = "catalogs/libraries/xiph.lock.json";
const SOURCE_RELATIVE_PATH = "catalogs/libraries/xiph.json";

runCliMain({
  parse: (argv) =>
    parseCliArgs(argv, {
      "baseline-git": { type: "boolean" },
    }).values,
  main: async (args) => {
    const [lock, source] = await Promise.all([
      readFile(resolveRepoPath(...LOCK_RELATIVE_PATH.split("/")), "utf8").then(JSON.parse),
      readFile(resolveRepoPath(...SOURCE_RELATIVE_PATH.split("/")), "utf8").then(
        JSON.parse,
      ),
    ]);
    assertXiphCatalogMatchesLock(source, lock);
    if (args["baseline-git"]) {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `HEAD:${LOCK_RELATIVE_PATH}`],
        { cwd: resolveRepoPath() },
      );
      assertXiphLockExtendsBaseline(JSON.parse(stdout), lock);
    }
  },
});
