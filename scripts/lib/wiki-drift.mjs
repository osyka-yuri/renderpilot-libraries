// Pure helpers for scheduled wiki-drift detection and GitHub Issue notification.
// Network / gh I/O lives in `wiki-drift-notify.mjs` and `check-wiki-drift.mjs`.

import { errorMessage } from "./common.mjs";

export const WIKI_DRIFT_STATUS = Object.freeze({
  ok: "ok",
  drift: "drift",
  soft: "soft",
  /** exit 1 without drift marker and without soft network signal (crash / assert). */
  unknown: "unknown",
});

export const WIKI_DRIFT_LABEL = "wiki-drift";

/** Per-tool config: sync script, issue fingerprint, remediation command. */
export const WIKI_DRIFT_TOOLS = Object.freeze({
  renodx: Object.freeze({
    id: "renodx",
    displayName: "RenoDX",
    issueTitle: "wiki-drift: renodx",
    syncScript: "scripts/sync-renodx-wiki.mjs",
    remediate: "pnpm run sync:renodx-wiki",
  }),
  luma: Object.freeze({
    id: "luma",
    displayName: "Luma",
    issueTitle: "wiki-drift: luma",
    syncScript: "scripts/sync-luma-wiki.mjs",
    remediate: "pnpm run sync:luma-wiki",
  }),
});

export const WIKI_DRIFT_TOOL_IDS = Object.freeze(Object.keys(WIKI_DRIFT_TOOLS));

/**
 * Explicit catalogue-drift markers from sync-*-wiki --check error lines.
 * These take priority over soft network patterns so snapshot warnings in the
 * same log cannot hide a real drift conclusion.
 */
export const WIKI_DRIFT_MARKERS = Object.freeze([
  /wiki or overlay drift detected/i,
  /Luma wiki drift/i,
  /unreviewed note detected/i,
  /incomplete catalogue/i,
]);

/**
 * Case-insensitive patterns that indicate network/upstream soft failure.
 * Applied only when no drift marker is present (pure pre-compare failures).
 */
export const WIKI_SOFT_FAILURE_PATTERNS = Object.freeze([
  /could not fetch wiki/i,
  /could not fetch complete .*snapshot assets/i,
  /request timed out/i,
  /request failed/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /HTTP 5\d\d/i,
  /fetch failed/i,
]);

/**
 * @param {string} toolId
 * @returns {typeof WIKI_DRIFT_TOOLS[keyof typeof WIKI_DRIFT_TOOLS]}
 */
export function getWikiDriftTool(toolId) {
  const tool = WIKI_DRIFT_TOOLS[toolId];
  if (!tool) {
    throw new Error(`unknown wiki drift tool: ${toolId}`);
  }
  return tool;
}

/**
 * @param {"all"|string} tool
 * @returns {string[]}
 */
export function toolsToRun(tool) {
  if (tool === "all") {
    return [...WIKI_DRIFT_TOOL_IDS];
  }
  if (!WIKI_DRIFT_TOOL_IDS.includes(tool)) {
    throw new Error(`unknown wiki drift tool: ${tool}`);
  }
  return [tool];
}

/** GitHub issue body hard limit is ~65536; stay under with headroom for metadata. */
export const GITHUB_ISSUE_BODY_MAX_CHARS = 60_000;

/** Cap for the log section inside the issue body (characters, not lines). */
export const WIKI_DRIFT_LOG_MAX_CHARS = 48_000;

/**
 * Normalize `owner/name` repository slugs. Returns null when invalid.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeRepositorySlug(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Build a `gh issue list --search` query for an exact fingerprint title.
 * Prefer `repo:owner/name` so search is scoped to this repository.
 *
 * @param {string} title
 * @param {{ repository?: string|null }} [opts]
 */
export function buildOpenIssueSearchQuery(title, { repository } = {}) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error("buildOpenIssueSearchQuery: title must be a non-empty string");
  }
  // Fingerprints are fixed constants; strip quotes defensively for search syntax.
  const escaped = title.trim().replaceAll('"', "");
  const titleClause = `in:title "${escaped}"`;
  const repo = normalizeRepositorySlug(repository);
  if (repo) {
    return `repo:${repo} ${titleClause}`;
  }
  return titleClause;
}

/**
 * Classifies a wiki sync --check subprocess result.
 *
 * Priority:
 *   1. exit 0 → ok
 *   2. explicit drift markers in log → drift (even if earlier network warnings)
 *   3. soft network patterns → soft
 *   4. exit !== 1 → soft (usage / spawn crash; do not open drift issues)
 *   5. exit 1 without marker → unknown (do not open "Wiki drift" issues)
 *
 * Issue create/update only happens for `drift` (explicit markers).
 *
 * @param {{ exitCode: number|null, log?: string }} input
 * @returns {"ok"|"drift"|"soft"|"unknown"}
 */
export function classifyWikiCheckResult({ exitCode, log = "" } = {}) {
  if (exitCode === 0) {
    return WIKI_DRIFT_STATUS.ok;
  }

  const text = String(log ?? "");
  if (looksLikeWikiDrift(text)) {
    return WIKI_DRIFT_STATUS.drift;
  }
  if (looksLikeSoftWikiFailure(text)) {
    return WIKI_DRIFT_STATUS.soft;
  }

  // Usage / unexpected non-1 exit: soft for notify.
  if (exitCode !== 1) {
    return WIKI_DRIFT_STATUS.soft;
  }

  // exit 1 without an explicit drift marker — treat as unknown failure, not drift.
  return WIKI_DRIFT_STATUS.unknown;
}

export function looksLikeWikiDrift(log) {
  const text = String(log ?? "");
  return WIKI_DRIFT_MARKERS.some((re) => re.test(text));
}

export function looksLikeSoftWikiFailure(log) {
  const text = String(log ?? "");
  return WIKI_SOFT_FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * Truncates log to the last `maxLines` lines and a hard character budget.
 * Character cap prevents a single huge line from exceeding GitHub issue body limits.
 *
 * @param {string} log
 * @param {number} [maxLines=80]
 * @param {number} [maxChars]
 */
export function truncateLogTail(log, maxLines = 80, maxChars = WIKI_DRIFT_LOG_MAX_CHARS) {
  let text = String(log ?? "");
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) {
    const tail = lines.slice(-maxLines).join("\n");
    text = `… (${lines.length - maxLines} earlier lines omitted)\n${tail}`;
  }
  if (typeof maxChars === "number" && maxChars > 0 && text.length > maxChars) {
    const keep = Math.max(0, maxChars - 48);
    text = `… (log truncated to ${maxChars} chars)\n${text.slice(-keep)}`;
  }
  return text;
}

/**
 * Clamp a full issue body under GitHub's ~65k character limit.
 * @param {string} body
 * @param {number} [maxChars]
 */
export function clampGithubIssueBody(body, maxChars = GITHUB_ISSUE_BODY_MAX_CHARS) {
  const text = String(body ?? "");
  if (typeof maxChars !== "number" || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const footer = "\n\n… (issue body truncated for GitHub size limit)\n";
  const keep = Math.max(0, maxChars - footer.length);
  return `${text.slice(0, keep)}${footer}`;
}

/**
 * Builds a markdown issue body for a drifted tool.
 *
 * @param {object} opts
 * @param {"renodx"|"luma"} opts.tool
 * @param {string} [opts.log]
 * @param {string|null} [opts.runUrl]
 */
export function buildIssueBody({ tool, log = "", runUrl = null } = {}) {
  const config = getWikiDriftTool(tool);
  const tail = truncateLogTail(log);
  const runLine = runUrl ? `\n- Run: ${runUrl}` : "";

  const body = [
    `## Wiki drift detected: ${config.displayName}`,
    "",
    "Scheduled check found differences between the upstream wiki and the committed catalogue.",
    "",
    "### What to do",
    "",
    "```powershell",
    config.remediate,
    "pnpm run check",
    "```",
    "",
    "Then open a normal PR with the sync result. Do not force-merge without review.",
    "",
    "### Check log (truncated)",
    "",
    "```",
    tail || "(empty)",
    "```",
    "",
    "### Meta",
    "",
    `- Tool: \`${tool}\``,
    `- Issue fingerprint: \`${config.issueTitle}\``,
    `- Workflow: wiki-drift${runLine}`,
    "",
  ].join("\n");

  return clampGithubIssueBody(body);
}

export function githubRunUrl(env = process.env) {
  const server = env.GITHUB_SERVER_URL?.trim();
  const repo = env.GITHUB_REPOSITORY?.trim();
  const runId = env.GITHUB_RUN_ID?.trim();
  if (!server || !repo || !runId) return null;
  return `${server}/${repo}/actions/runs/${runId}`;
}

/**
 * Decide notify action for one tool status.
 * Only explicit `drift` creates/updates Issues; `ok` can close.
 * `soft` / `unknown` never create Issues.
 *
 * @returns {"create"|"update"|"close"|"none"}
 */
export function notifyActionForStatus(status, { hasOpenIssue }) {
  if (status === WIKI_DRIFT_STATUS.drift) {
    return hasOpenIssue ? "update" : "create";
  }
  if (status === WIKI_DRIFT_STATUS.ok && hasOpenIssue) {
    return "close";
  }
  return "none";
}

/**
 * Parse `gh issue list --json` stdout.
 *
 * @param {string} jsonText
 * @returns {{ ok: true, items: object[] } | { ok: false, detail: string }}
 */
export function parseIssueListJson(jsonText) {
  try {
    const items = JSON.parse(jsonText || "[]");
    if (!Array.isArray(items)) {
      return { ok: false, detail: "issue list JSON is not an array" };
    }
    return { ok: true, items };
  } catch (error) {
    return {
      ok: false,
      detail: `invalid issue list JSON: ${errorMessage(error)}`,
    };
  }
}

/**
 * Find exact title match in a parsed issue list.
 * @param {object[]} items
 * @param {string} title
 * @returns {number|null}
 */
export function findIssueNumberByTitle(items, title) {
  if (!Array.isArray(items)) return null;
  const match = items.find((item) => item?.title === title);
  const number = match?.number;
  return typeof number === "number" ? number : null;
}

/**
 * Pick the issue number whose title matches exactly from `gh issue list --json` output.
 * Returns null only for a successful parse with no match.
 * Throws on invalid JSON / non-array (callers that need soft handling use parseIssueListJson).
 *
 * Prefer `interpretIssueListResult` for notify paths.
 *
 * @param {string} jsonText
 * @param {string} title
 * @returns {number|null}
 */
export function pickIssueNumber(jsonText, title) {
  const parsed = parseIssueListJson(jsonText);
  if (!parsed.ok) {
    throw new Error(parsed.detail);
  }
  return findIssueNumberByTitle(parsed.items, title);
}

/**
 * Result of looking up an open fingerprint issue.
 *
 * - `found` — open issue with exact title
 * - `none` — list succeeded, no matching open issue
 * - `error` — list/API/parse failed; callers must not treat this as `none` (would duplicate)
 *
 * @typedef {{ status: "found", number: number } | { status: "none" } | { status: "error", detail: string }} OpenIssueLookup
 */

/**
 * Interpret a `gh issue list --json` capture for an exact title match.
 *
 * @param {{ ok: boolean, stdout?: string, stderr?: string }} listResult
 * @param {string} title
 * @returns {OpenIssueLookup}
 */
export function interpretIssueListResult(listResult, title) {
  if (!listResult?.ok) {
    return {
      status: "error",
      detail: String(listResult?.stderr || listResult?.stdout || "gh issue list failed"),
    };
  }
  const parsed = parseIssueListJson(listResult.stdout ?? "");
  if (!parsed.ok) {
    return { status: "error", detail: parsed.detail };
  }
  const number = findIssueNumberByTitle(parsed.items, title);
  if (number == null) {
    return { status: "none" };
  }
  return { status: "found", number };
}
