#!/usr/bin/env node
// Orchestrate RenoDX + Luma wiki --check runs, classify ok/drift/soft, and
// optionally upsert/close GitHub Issues (notify only — never writes catalogues).
//
//   node scripts/check-wiki-drift.mjs [--notify] [--tool=renodx|luma|all]
//
// Exit: 0 if no drift (soft allowed); 1 if any drift; 2 usage.

import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { UsageError } from "./lib/common.mjs";
import { parseCliArgs, wantsHelp } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { appendGithubOutput } from "./lib/github-actions.mjs";
import { runCaptured } from "./lib/process.mjs";
import {
  WIKI_DRIFT_STATUS,
  WIKI_DRIFT_TOOL_IDS,
  classifyWikiCheckResult,
  getWikiDriftTool,
  githubRunUrl,
  toolsToRun,
} from "./lib/wiki-drift.mjs";
import {
  ensureLabel,
  resolveGithubRepository,
  runWikiDriftNotify,
} from "./lib/wiki-drift-notify.mjs";

const CAPTURE_MAX_CHARS = 200_000;
const CAPTURE_KEEP_CHARS = 150_000;

function usage() {
  console.error(
    "Usage: node scripts/check-wiki-drift.mjs [--notify] [--tool=renodx|luma|all]",
  );
  console.error("");
  console.error("Run wiki --check for RenoDX and/or Luma.");
  console.error(
    "--notify upserts/closes GitHub Issues (requires gh + GH_TOKEN/GITHUB_TOKEN).",
  );
  console.error("Exit 0 when no drift (soft warnings allowed); 1 on drift; 2 on usage.");
}

function parseArgs(argv) {
  if (wantsHelp(argv)) {
    return { notify: false, tool: "all", help: true };
  }

  const { values } = parseCliArgs(argv, {
    notify: { type: "boolean" },
    tool: { type: "string", default: "all" },
  });

  const tool = String(values.tool ?? "all").trim();
  if (tool !== "all" && !WIKI_DRIFT_TOOL_IDS.includes(tool)) {
    throw new UsageError(
      `invalid --tool=${tool}; expected one of ${[...WIKI_DRIFT_TOOL_IDS, "all"].join(", ")}`,
    );
  }

  return {
    notify: Boolean(values.notify),
    tool,
    help: false,
  };
}

async function runNodeScript(scriptRel, args = []) {
  const scriptPath = path.join(repoRoot, scriptRel);
  const result = await runCaptured(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
    maxChars: CAPTURE_MAX_CHARS,
    keepChars: CAPTURE_KEEP_CHARS,
  });
  return { exitCode: result.code, log: result.log };
}

async function runToolCheck(toolId) {
  const config = getWikiDriftTool(toolId);
  console.log(`\n── ${toolId}: ${config.syncScript} --check ──`);
  const { exitCode, log } = await runNodeScript(config.syncScript, ["--check"]);
  if (log.trim()) {
    process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
  }
  const status = classifyWikiCheckResult({ exitCode, log });
  console.log(`wiki_drift ${toolId}=${status} (exit ${exitCode ?? "null"})`);
  return { tool: toolId, status, exitCode, log };
}

async function main(args) {
  const tools = toolsToRun(args.tool);
  const results = [];
  for (const tool of tools) {
    results.push(await runToolCheck(tool));
  }

  const byTool = Object.fromEntries(results.map((r) => [r.tool, r.status]));
  const anyDrift = results.some((r) => r.status === WIKI_DRIFT_STATUS.drift);
  const anySoft = results.some((r) => r.status === WIKI_DRIFT_STATUS.soft);
  const anyUnknown = results.some((r) => r.status === WIKI_DRIFT_STATUS.unknown);

  console.log("\n── summary ──");
  for (const tool of tools) {
    console.log(`wiki_drift ${tool}=${byTool[tool]}`);
  }

  await appendGithubOutput({
    renodx_status: byTool.renodx ?? "",
    luma_status: byTool.luma ?? "",
    any_drift: anyDrift ? "true" : "false",
    any_unknown: anyUnknown ? "true" : "false",
  });

  let notifyIncomplete = false;
  if (args.notify) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const dryRun = !token;
    let labelReady = true;
    if (dryRun) {
      console.warn(
        "\n--notify: GH_TOKEN/GITHUB_TOKEN not set; printing planned actions only.",
      );
    } else {
      labelReady = await ensureLabel({ dryRun: false, cwd: repoRoot });
    }

    const repository = await resolveGithubRepository({ dryRun, cwd: repoRoot });
    if (repository) {
      console.log(`notify repository scope: ${repository}`);
    } else if (!dryRun) {
      console.warn(
        "warn: no repository scope for issue search (set GITHUB_REPOSITORY or run inside a gh repo)",
      );
    }

    notifyIncomplete = await runWikiDriftNotify(results, {
      dryRun,
      runUrl: githubRunUrl(),
      labelReady,
      repository,
      cwd: repoRoot,
    });
  }

  if (anySoft && !anyDrift && !anyUnknown) {
    console.warn("\nCompleted with soft network/upstream warnings only.");
  }

  if (anyUnknown) {
    console.error(
      "\nUnexpected wiki check failure(s) without an explicit drift marker. " +
        "No drift Issue opened; inspect logs.",
    );
    process.exitCode = 1;
    return;
  }

  if (anyDrift) {
    console.error("\nWiki drift detected. See logs above (and Issues if --notify).");
    process.exitCode = 1;
    // Still surface notify failures after drift (e.g. list error prevented Issue).
    if (notifyIncomplete) {
      console.error("Notify incomplete (list/create/update failed).");
    }
    return;
  }

  if (notifyIncomplete) {
    console.error(
      "\nWiki check reported no drift, but notify was incomplete " +
        "(issue list/create/update/close failed). Issue state may be stale.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nNo wiki drift.");
}

runCliMain({
  parse: parseArgs,
  help: usage,
  main,
});
