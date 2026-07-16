import assert from "node:assert/strict";
import test from "node:test";

import { WIKI_DRIFT_STATUS } from "../lib/wiki-drift.mjs";
import {
  lookupOpenIssue,
  notifyTool,
  resolveGithubRepository,
  runWikiDriftNotify,
} from "../lib/wiki-drift-notify.mjs";

test("resolveGithubRepository prefers GITHUB_REPOSITORY", async () => {
  let called = false;
  const slug = await resolveGithubRepository({
    env: { GITHUB_REPOSITORY: "owner/repo" },
    runGhFn: async () => {
      called = true;
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  assert.equal(slug, "owner/repo");
  assert.equal(called, false);
});

test("lookupOpenIssue dry-run returns none without spawning", async () => {
  let called = false;
  const result = await lookupOpenIssue("wiki-drift: renodx", {
    dryRun: true,
    runGhFn: async () => {
      called = true;
      return { ok: true, stdout: "[]", stderr: "" };
    },
  });
  assert.deepEqual(result, { status: "none" });
  assert.equal(called, false);
});

test("notifyTool creates issue when drift and no open issue", async () => {
  const calls = [];
  const result = await notifyTool(
    {
      tool: "renodx",
      status: WIKI_DRIFT_STATUS.drift,
      log: "wiki or overlay drift detected",
    },
    {
      dryRun: false,
      runUrl: null,
      labelReady: true,
      repository: "owner/repo",
      sleepFn: async () => {},
      recheckDelayMs: 0,
      runGhFn: async (args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "list") {
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }
        if (args[0] === "issue" && args[1] === "create") {
          return {
            ok: true,
            stdout: "https://github.com/owner/repo/issues/1\n",
            stderr: "",
            code: 0,
          };
        }
        return { ok: false, stdout: "", stderr: "unexpected", code: 1 };
      },
    },
  );

  assert.equal(result, "ok");
  assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "create"));
});

test("notifyTool skips create when list fails", async () => {
  const result = await notifyTool(
    {
      tool: "luma",
      status: WIKI_DRIFT_STATUS.drift,
      log: "Luma wiki drift",
    },
    {
      dryRun: false,
      labelReady: false,
      repository: "owner/repo",
      sleepFn: async () => {},
      runGhFn: async () => ({
        ok: false,
        stdout: "",
        stderr: "auth required",
        code: 1,
      }),
    },
  );
  assert.equal(result, "skipped_list_error");
});

test("runWikiDriftNotify reports incomplete when any tool fails", async () => {
  let n = 0;
  const incomplete = await runWikiDriftNotify(
    [
      { tool: "renodx", status: WIKI_DRIFT_STATUS.ok, log: "ok" },
      { tool: "luma", status: WIKI_DRIFT_STATUS.drift, log: "Luma wiki drift" },
    ],
    {
      dryRun: false,
      labelReady: true,
      repository: "owner/repo",
      sleepFn: async () => {},
      recheckDelayMs: 0,
      runGhFn: async (args) => {
        if (args[0] === "issue" && args[1] === "list") {
          n += 1;
          // Second tool: list fails
          if (n > 1) {
            return { ok: false, stdout: "", stderr: "fail", code: 1 };
          }
          return { ok: true, stdout: "[]", stderr: "", code: 0 };
        }
        return { ok: true, stdout: "", stderr: "", code: 0 };
      },
    },
  );
  assert.equal(incomplete, true);
});
