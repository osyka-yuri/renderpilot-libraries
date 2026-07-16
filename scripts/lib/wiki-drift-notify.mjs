// GitHub Issue notify I/O for wiki-drift (lookup / create / update / close).
// Pure classifiers and issue body builders live in `wiki-drift.mjs`.

import { sleep } from "./common.mjs";
import { runGh as defaultRunGh } from "./gh.mjs";
import {
  WIKI_DRIFT_LABEL,
  buildIssueBody,
  buildOpenIssueSearchQuery,
  getWikiDriftTool,
  interpretIssueListResult,
  normalizeRepositorySlug,
  notifyActionForStatus,
} from "./wiki-drift.mjs";

/** Brief wait before re-search when about to create (Search API lag). */
export const CREATE_RECHECK_DELAY_MS = 2_000;

/**
 * Resolve `owner/name` for search scoping.
 * Prefer GITHUB_REPOSITORY (Actions); fall back to `gh repo view` for local notify.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.cwd]
 * @param {typeof defaultRunGh} [opts.runGhFn]
 * @returns {Promise<string|null>}
 */
export async function resolveGithubRepository({
  dryRun = false,
  env = process.env,
  cwd,
  runGhFn = defaultRunGh,
} = {}) {
  const fromEnv = normalizeRepositorySlug(env.GITHUB_REPOSITORY);
  if (fromEnv) return fromEnv;
  if (dryRun) return null;

  const viewed = await runGhFn(["repo", "view", "--json", "nameWithOwner"], {
    cwd,
    env,
  });
  if (!viewed.ok) {
    console.warn(
      `warn: could not resolve repository via gh repo view: ${viewed.stderr || viewed.stdout}`,
    );
    return null;
  }
  try {
    const data = JSON.parse(viewed.stdout || "{}");
    return normalizeRepositorySlug(data?.nameWithOwner);
  } catch {
    return normalizeRepositorySlug(viewed.stdout);
  }
}

/**
 * Look up an open issue by title search (not “first N open issues”).
 * Avoids missing fingerprint issues when the repo has many open issues.
 * Label is organizational only (create may attach it). Never treats API/parse
 * failure as “no issue” (that would spawn duplicates).
 *
 * @param {string} title
 * @param {object} opts
 * @param {boolean} [opts.dryRun]
 * @param {string|null} [opts.repository]
 * @param {string} [opts.cwd]
 * @param {typeof defaultRunGh} [opts.runGhFn]
 * @returns {Promise<import("./wiki-drift.mjs").OpenIssueLookup>}
 */
export async function lookupOpenIssue(
  title,
  { dryRun, repository, cwd, runGhFn = defaultRunGh } = {},
) {
  if (dryRun) {
    // Dry-run: pretend none open so planned actions show create, not update.
    return { status: "none" };
  }

  const query = buildOpenIssueSearchQuery(title, { repository });

  const listed = await runGhFn(
    [
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      query,
      "--json",
      "number,title",
      "--limit",
      "10",
    ],
    { cwd },
  );

  const interpreted = interpretIssueListResult(listed, title);
  if (interpreted.status === "error") {
    console.warn(`warn: gh issue list failed: ${interpreted.detail}`);
  }
  return interpreted;
}

/**
 * Best-effort label ensure. Failure is non-fatal for lookup (title-based),
 * but create may omit the label if ensure failed.
 *
 * @returns {Promise<boolean>} true when label is available (or dry-run)
 */
export async function ensureLabel({ dryRun, cwd, runGhFn = defaultRunGh } = {}) {
  if (dryRun) return true;

  const result = await runGhFn(
    [
      "label",
      "create",
      WIKI_DRIFT_LABEL,
      "--color",
      "BFD4F2",
      "--description",
      "Upstream wiki catalogue drift",
      "--force",
    ],
    { dryRun: false, cwd },
  );

  if (!result.ok) {
    console.warn(
      `warn: could not ensure label ${WIKI_DRIFT_LABEL}: ${result.stderr || result.stdout}`,
    );
    return false;
  }
  return true;
}

/**
 * @param {{ tool: string, status: string, log: string }} result
 * @param {object} opts
 * @returns {Promise<"ok"|"skipped_list_error"|"failed">}
 */
export async function notifyTool(
  result,
  {
    dryRun,
    runUrl,
    labelReady,
    repository,
    cwd,
    runGhFn = defaultRunGh,
    sleepFn = sleep,
    recheckDelayMs = CREATE_RECHECK_DELAY_MS,
    now = () => new Date(),
  } = {},
) {
  const config = getWikiDriftTool(result.tool);
  let lookup = await lookupOpenIssue(config.issueTitle, {
    dryRun,
    repository,
    cwd,
    runGhFn,
  });

  if (lookup.status === "error") {
    // Never invent "no open issue" — that creates daily duplicates on API blips.
    console.warn(
      `notify ${result.tool}: skip (issue list error: ${lookup.detail}); status=${result.status}`,
    );
    return "skipped_list_error";
  }

  let openNumber = lookup.status === "found" ? lookup.number : null;
  let action = notifyActionForStatus(result.status, {
    hasOpenIssue: lookup.status === "found",
  });

  // Search is eventually consistent: re-check once before creating a duplicate.
  if (action === "create" && !dryRun) {
    await sleepFn(recheckDelayMs);
    const recheck = await lookupOpenIssue(config.issueTitle, {
      dryRun,
      repository,
      cwd,
      runGhFn,
    });
    if (recheck.status === "error") {
      console.warn(
        `notify ${result.tool}: skip create (recheck list error: ${recheck.detail})`,
      );
      return "skipped_list_error";
    }
    if (recheck.status === "found") {
      lookup = recheck;
      openNumber = recheck.number;
      action = "update";
      console.log(
        `notify ${result.tool}: create aborted; found #${openNumber} on recheck (search lag)`,
      );
    }
  }

  console.log(
    `notify ${result.tool}: status=${result.status} action=${action}` +
      (openNumber != null ? ` issue=#${openNumber}` : ""),
  );

  if (action === "none") {
    return "ok";
  }

  if (action === "create") {
    const body = buildIssueBody({
      tool: result.tool,
      log: result.log,
      runUrl,
    });
    const createArgs = ["issue", "create", "--title", config.issueTitle, "--body", body];
    // Only attach label when ensure succeeded; missing label must not block create.
    if (labelReady) {
      createArgs.push("--label", WIKI_DRIFT_LABEL);
    }
    const created = await runGhFn(createArgs, { dryRun, cwd });
    if (!created.ok) {
      console.warn(`warn: failed to create issue: ${created.stderr || created.stdout}`);
      return "failed";
    }
    if (!dryRun) {
      console.log(`created issue: ${created.stdout.trim()}`);
    }
    return "ok";
  }

  if (action === "update") {
    const body = buildIssueBody({
      tool: result.tool,
      log: result.log,
      runUrl,
    });
    const edited = await runGhFn(["issue", "edit", String(openNumber), "--body", body], {
      dryRun,
      cwd,
    });
    if (!edited.ok) {
      console.warn(`warn: failed to update issue #${openNumber}: ${edited.stderr}`);
    }
    const commented = await runGhFn(
      [
        "issue",
        "comment",
        String(openNumber),
        "--body",
        `Still drifting as of scheduled check (${now().toISOString()}).`,
      ],
      { dryRun, cwd },
    );
    if (!commented.ok) {
      console.warn(`warn: failed to comment on #${openNumber}: ${commented.stderr}`);
    }
    return edited.ok || commented.ok ? "ok" : "failed";
  }

  if (action === "close") {
    const closed = await runGhFn(
      [
        "issue",
        "close",
        String(openNumber),
        "--comment",
        "Wiki drift cleared; committed catalogue matches upstream check.",
      ],
      { dryRun, cwd },
    );
    if (!closed.ok) {
      console.warn(`warn: failed to close issue #${openNumber}: ${closed.stderr}`);
      return "failed";
    }
    console.log(`closed issue #${openNumber}`);
    return "ok";
  }

  return "ok";
}

/**
 * Run notify for every tool result. Returns true when any notify step was incomplete.
 *
 * @param {Array<{ tool: string, status: string, log: string }>} results
 * @param {object} opts
 * @returns {Promise<boolean>} notifyIncomplete
 */
export async function runWikiDriftNotify(
  results,
  {
    dryRun,
    runUrl,
    labelReady,
    repository,
    cwd,
    runGhFn = defaultRunGh,
    sleepFn = sleep,
    recheckDelayMs = CREATE_RECHECK_DELAY_MS,
    now = () => new Date(),
  } = {},
) {
  let notifyIncomplete = false;
  for (const result of results) {
    const notifyResult = await notifyTool(result, {
      dryRun,
      runUrl,
      labelReady,
      repository,
      cwd,
      runGhFn,
      sleepFn,
      recheckDelayMs,
      now,
    });
    if (notifyResult !== "ok") {
      notifyIncomplete = true;
    }
  }
  return notifyIncomplete;
}
