#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import {
  dispatchLibrariesCommand,
  parseLibrariesArgs,
  printLibrariesHelp,
} from "./lib/libraries-cli.mjs";

function runScript(file, args) {
  const script = path.join(repoRoot, "scripts", file);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${file} terminated by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${file} exited with status ${code}`));
    });
  });
}

runCliMain({
  parse: parseLibrariesArgs,
  help: printLibrariesHelp,
  main: (args) => dispatchLibrariesCommand(args, runScript),
});
