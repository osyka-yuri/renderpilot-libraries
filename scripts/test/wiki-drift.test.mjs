import test from "node:test";
import assert from "node:assert/strict";

import {
  WIKI_DRIFT_STATUS,
  WIKI_DRIFT_TOOL_IDS,
  WIKI_DRIFT_TOOLS,
  GITHUB_ISSUE_BODY_MAX_CHARS,
  WIKI_DRIFT_LOG_MAX_CHARS,
  buildIssueBody,
  buildOpenIssueSearchQuery,
  clampGithubIssueBody,
  classifyWikiCheckResult,
  findIssueNumberByTitle,
  getWikiDriftTool,
  githubRunUrl,
  interpretIssueListResult,
  looksLikeSoftWikiFailure,
  looksLikeWikiDrift,
  normalizeRepositorySlug,
  notifyActionForStatus,
  parseIssueListJson,
  pickIssueNumber,
  toolsToRun,
  truncateLogTail,
} from "../lib/wiki-drift.mjs";

test("WIKI_DRIFT_TOOLS exposes renodx and luma config", () => {
  assert.deepEqual([...WIKI_DRIFT_TOOL_IDS].sort(), ["luma", "renodx"]);
  assert.equal(WIKI_DRIFT_TOOLS.renodx.issueTitle, "wiki-drift: renodx");
  assert.equal(WIKI_DRIFT_TOOLS.luma.remediate, "pnpm run sync:luma-wiki");
  assert.equal(getWikiDriftTool("renodx").displayName, "RenoDX");
  assert.throws(() => getWikiDriftTool("reshade"), /unknown wiki drift tool/);
});

test("toolsToRun expands all and rejects unknown", () => {
  assert.deepEqual(toolsToRun("all"), ["renodx", "luma"]);
  assert.deepEqual(toolsToRun("luma"), ["luma"]);
  assert.throws(() => toolsToRun("reshade"), /unknown wiki drift tool/);
});

test("normalizeRepositorySlug accepts owner/name only", () => {
  assert.equal(normalizeRepositorySlug("acme/libs"), "acme/libs");
  assert.equal(normalizeRepositorySlug("  acme/libs  "), "acme/libs");
  assert.equal(normalizeRepositorySlug("not-a-repo"), null);
  assert.equal(normalizeRepositorySlug(""), null);
  assert.equal(normalizeRepositorySlug(null), null);
});

test("buildOpenIssueSearchQuery scopes by title and optional repo", () => {
  assert.equal(
    buildOpenIssueSearchQuery("wiki-drift: renodx"),
    'in:title "wiki-drift: renodx"',
  );
  assert.equal(
    buildOpenIssueSearchQuery("wiki-drift: luma", { repository: "acme/libs" }),
    'repo:acme/libs in:title "wiki-drift: luma"',
  );
  assert.equal(
    buildOpenIssueSearchQuery("wiki-drift: renodx", { repository: "not-a-repo" }),
    'in:title "wiki-drift: renodx"',
  );
  assert.equal(
    buildOpenIssueSearchQuery('wiki-drift: "quoted"', {}),
    'in:title "wiki-drift: quoted"',
  );
  assert.throws(() => buildOpenIssueSearchQuery(""), /non-empty/);
});

test("classifyWikiCheckResult maps exit 0 to ok", () => {
  assert.equal(classifyWikiCheckResult({ exitCode: 0, log: "" }), WIKI_DRIFT_STATUS.ok);
});

test("classifyWikiCheckResult maps exit 1 drift message to drift", () => {
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "RenoDX wiki or overlay drift detected; run sync:renodx-wiki.",
    }),
    WIKI_DRIFT_STATUS.drift,
  );
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "Luma wiki drift, incomplete catalogue, or unreviewed note detected",
    }),
    WIKI_DRIFT_STATUS.drift,
  );
});

test("classifyWikiCheckResult maps fetch failures to soft", () => {
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "Could not fetch wiki https://example.com: HTTP 503",
    }),
    WIKI_DRIFT_STATUS.soft,
  );
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "request timed out after 30000ms",
    }),
    WIKI_DRIFT_STATUS.soft,
  );
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "Could not fetch complete RenoDX snapshot assets: GitHub API returned 403",
    }),
    WIKI_DRIFT_STATUS.soft,
  );
  assert.ok(looksLikeSoftWikiFailure("ENOTFOUND raw.githubusercontent.com"));
});

test("classifyWikiCheckResult prefers drift markers over soft network noise", () => {
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log:
        "Warning: could not fetch snapshot assets: request failed for https://api.github.com/...\n" +
        "RenoDX wiki or overlay drift detected; run sync:renodx-wiki.",
    }),
    WIKI_DRIFT_STATUS.drift,
  );
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log:
        "request timed out after 30000ms\n" +
        "Luma wiki drift, incomplete catalogue, or unreviewed note detected",
    }),
    WIKI_DRIFT_STATUS.drift,
  );
  assert.ok(
    looksLikeWikiDrift("RenoDX wiki or overlay drift detected; run sync:renodx-wiki."),
  );
});

test("classifyWikiCheckResult treats non-1 failures as soft for notify", () => {
  assert.equal(
    classifyWikiCheckResult({ exitCode: 2, log: "usage" }),
    WIKI_DRIFT_STATUS.soft,
  );
  assert.equal(
    classifyWikiCheckResult({ exitCode: null, log: "" }),
    WIKI_DRIFT_STATUS.soft,
  );
});

test("classifyWikiCheckResult maps bare exit 1 without markers to unknown", () => {
  assert.equal(
    classifyWikiCheckResult({
      exitCode: 1,
      log: "TypeError: cannot read properties of undefined",
    }),
    WIKI_DRIFT_STATUS.unknown,
  );
  assert.equal(
    classifyWikiCheckResult({ exitCode: 1, log: "" }),
    WIKI_DRIFT_STATUS.unknown,
  );
});

test("truncateLogTail keeps the last lines and respects char budget", () => {
  const log = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
  const tail = truncateLogTail(log, 5, WIKI_DRIFT_LOG_MAX_CHARS);
  assert.match(tail, /earlier lines omitted/);
  assert.match(tail, /line-99$/);
  assert.doesNotMatch(tail, /line-0\n/);

  const huge = "x".repeat(10_000);
  const capped = truncateLogTail(huge, 80, 500);
  assert.ok(capped.length <= 500 + 40);
  assert.match(capped, /truncated to 500 chars/);
});

test("clampGithubIssueBody enforces GitHub size headroom", () => {
  const body = "a".repeat(GITHUB_ISSUE_BODY_MAX_CHARS + 1000);
  const clamped = clampGithubIssueBody(body);
  assert.ok(clamped.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
  assert.match(clamped, /truncated for GitHub size limit/);
  assert.equal(clampGithubIssueBody("short"), "short");
});

test("buildIssueBody stays under the GitHub body budget", () => {
  const body = buildIssueBody({
    tool: "renodx",
    log: "y".repeat(WIKI_DRIFT_LOG_MAX_CHARS + 20_000),
  });
  assert.ok(body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
});

test("buildIssueBody includes remediation and fingerprint", () => {
  const body = buildIssueBody({
    tool: "renodx",
    log: "RenoDX wiki or overlay drift detected",
    runUrl: "https://github.com/o/r/actions/runs/1",
  });
  assert.match(body, /Wiki drift detected: RenoDX/);
  assert.match(body, /pnpm run sync:renodx-wiki/);
  assert.match(body, /wiki-drift: renodx/);
  assert.match(body, /actions\/runs\/1/);
  assert.match(body, /RenoDX wiki or overlay drift detected/);
});

test("buildIssueBody rejects unknown tools", () => {
  assert.throws(() => buildIssueBody({ tool: "reshade" }), /unknown wiki drift tool/);
});

test("githubRunUrl builds Actions URL when env is present", () => {
  assert.equal(
    githubRunUrl({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/renderpilot-libraries",
      GITHUB_RUN_ID: "99",
    }),
    "https://github.com/acme/renderpilot-libraries/actions/runs/99",
  );
  assert.equal(githubRunUrl({}), null);
});

test("notifyActionForStatus maps drift/ok/soft correctly", () => {
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.drift, { hasOpenIssue: false }),
    "create",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.drift, { hasOpenIssue: true }),
    "update",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.ok, { hasOpenIssue: true }),
    "close",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.ok, { hasOpenIssue: false }),
    "none",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.soft, { hasOpenIssue: true }),
    "none",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.unknown, { hasOpenIssue: false }),
    "none",
  );
  assert.equal(
    notifyActionForStatus(WIKI_DRIFT_STATUS.unknown, { hasOpenIssue: true }),
    "none",
  );
});

test("parseIssueListJson distinguishes valid list from garbage", () => {
  const json = JSON.stringify([
    { number: 1, title: "other" },
    { number: 42, title: "wiki-drift: renodx" },
  ]);
  const parsed = parseIssueListJson(json);
  assert.equal(parsed.ok, true);
  assert.equal(findIssueNumberByTitle(parsed.items, "wiki-drift: renodx"), 42);
  assert.equal(findIssueNumberByTitle(parsed.items, "wiki-drift: luma"), null);

  assert.equal(parseIssueListJson("not-json").ok, false);
  assert.equal(parseIssueListJson("{}").ok, false);
  assert.equal(parseIssueListJson("").ok, true);
  assert.deepEqual(parseIssueListJson("").items, []);
});

test("pickIssueNumber matches exact title and throws on bad JSON", () => {
  const json = JSON.stringify([
    { number: 1, title: "other" },
    { number: 42, title: "wiki-drift: renodx" },
  ]);
  assert.equal(pickIssueNumber(json, "wiki-drift: renodx"), 42);
  assert.equal(pickIssueNumber(json, "wiki-drift: luma"), null);
  assert.throws(
    () => pickIssueNumber("not-json", "wiki-drift: renodx"),
    /invalid issue list JSON/,
  );
  assert.throws(() => pickIssueNumber("{}", "wiki-drift: renodx"), /not an array/);
  assert.equal(pickIssueNumber("[]", "wiki-drift: renodx"), null);
});

test("interpretIssueListResult distinguishes found, none, and error", () => {
  const json = JSON.stringify([{ number: 7, title: "wiki-drift: luma" }]);
  assert.deepEqual(
    interpretIssueListResult({ ok: true, stdout: json }, "wiki-drift: luma"),
    {
      status: "found",
      number: 7,
    },
  );
  assert.deepEqual(
    interpretIssueListResult({ ok: true, stdout: json }, "wiki-drift: renodx"),
    { status: "none" },
  );
  assert.equal(
    interpretIssueListResult({ ok: false, stderr: "HTTP 401" }, "wiki-drift: renodx")
      .status,
    "error",
  );
  assert.match(
    interpretIssueListResult({ ok: false, stderr: "HTTP 401" }, "wiki-drift: renodx")
      .detail,
    /401/,
  );
  // Successful gh exit with garbage stdout must be error, not none (would duplicate).
  assert.equal(
    interpretIssueListResult({ ok: true, stdout: "not-json" }, "wiki-drift: renodx").status,
    "error",
  );
  assert.equal(
    interpretIssueListResult({ ok: true, stdout: "{}" }, "wiki-drift: renodx").status,
    "error",
  );
});
