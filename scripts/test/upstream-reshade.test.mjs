import test from "node:test";
import assert from "node:assert/strict";

import {
  STABLE_ADDON_URL_RE,
  buildStableAddonUrl,
  currentStableVersion,
  listReshadeHealthTargets,
  parseStableAddonUrl,
  replaceStableUrlInSources,
  RESHADE_STABLE,
} from "../lib/reshade-sources.mjs";
import {
  compareSemver,
  isNewerSemver,
  maxSemver,
  versionFromGitTag,
} from "../lib/upstream/semver-triple.mjs";
import {
  CHECK_STATUS,
  checkResult,
  hasHardFailure,
  hasSoftFailure,
  hardFailureMessages,
  softFailureMessages,
  formatCheckResults,
} from "../lib/upstream/result.mjs";
import { cancelResponseBody } from "../lib/http.mjs";
import {
  DETECT_KIND,
  checkReshadeChannelHealth,
  collectCandidateVersions,
  detectReshadeStableUpdate,
  extractVersionsFromHomepage,
  latestVersionFromTagsPayload,
  newerCandidatesDescending,
  versionsFromTagsPayload,
  RESHADE_HOME_URL,
  RESHADE_TAGS_URL,
} from "../lib/upstream/reshade.mjs";
import {
  collectManagedDependencySourceUrls,
  checkPinnedDependencyUrls,
  pinnedDependencyCheckId,
} from "../lib/upstream/pinned-deps.mjs";

// ── reshade-sources helpers ──

test("parseStableAddonUrl accepts the reshade.me Addon contract", () => {
  const parsed = parseStableAddonUrl(
    "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
  );
  assert.equal(parsed.version, "6.7.3");
  assert.match(parsed.url, STABLE_ADDON_URL_RE);
});

test("parseStableAddonUrl rejects non-Addon and foreign hosts", () => {
  assert.throws(
    () => parseStableAddonUrl("https://reshade.me/downloads/ReShade_Setup_6.7.3.exe"),
    /Addon installer pattern/,
  );
  assert.throws(
    () =>
      parseStableAddonUrl("https://example.com/downloads/ReShade_Setup_6.7.3_Addon.exe"),
    /Addon installer pattern/,
  );
});

test("buildStableAddonUrl / currentStableVersion round-trip the SSoT pin", () => {
  const version = currentStableVersion();
  assert.equal(buildStableAddonUrl(version), RESHADE_STABLE.url);
  assert.equal(parseStableAddonUrl(buildStableAddonUrl("1.2.3")).version, "1.2.3");
});

test("listReshadeHealthTargets covers stable and both nightly arches", () => {
  const targets = listReshadeHealthTargets();
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.map((t) => t.id).sort(), [
    "reshade.nightly.url32",
    "reshade.nightly.url64",
    "reshade.stable",
  ]);
});

// ── semver ──

test("compareSemver and maxSemver order dotted triples", () => {
  assert.ok(compareSemver("6.7.2", "6.7.3") < 0);
  assert.equal(compareSemver("6.7.3", "6.7.3"), 0);
  assert.ok(isNewerSemver("6.8.0", "6.7.3"));
  assert.equal(maxSemver(["6.7.1", "v-nope", "6.7.3", "6.6.9"]), "6.7.3");
  assert.equal(maxSemver([]), null);
  assert.equal(versionFromGitTag("v6.7.3"), "6.7.3");
  assert.equal(versionFromGitTag("6.7.3"), "6.7.3");
  assert.equal(versionFromGitTag("release-6.7.3"), null);
});

// ── homepage / tags parsing ──

test("extractVersionsFromHomepage finds setup links and version labels", () => {
  const html = `
    <p>Version 6.7.3 was released</p>
    <a href="/downloads/ReShade_Setup_6.7.3_Addon.exe">Addon</a>
    <a href="/downloads/ReShade_Setup_6.7.2.exe">old</a>
  `;
  const versions = extractVersionsFromHomepage(html).sort();
  assert.deepEqual(versions, ["6.7.2", "6.7.3"]);
});

test("versionsFromTagsPayload and latestVersionFromTagsPayload", () => {
  const payload = [
    { name: "v6.7.1" },
    { name: "not-a-version" },
    { name: "v6.7.3" },
    { name: "v6.6.2" },
  ];
  assert.deepEqual(versionsFromTagsPayload(payload).sort(compareSemver), [
    "6.6.2",
    "6.7.1",
    "6.7.3",
  ]);
  assert.equal(latestVersionFromTagsPayload(payload), "6.7.3");
});

test("collectCandidateVersions and newerCandidatesDescending", () => {
  const candidates = collectCandidateVersions({
    tagVersions: ["6.7.5", "6.7.4", "6.7.3"],
    homeVersions: ["6.7.3", "6.7.4"],
  });
  assert.deepEqual(candidates, ["6.7.3", "6.7.4", "6.7.5"]);
  assert.deepEqual(newerCandidatesDescending(candidates, "6.7.3"), ["6.7.5", "6.7.4"]);
});

// ── detect with mock fetch ──

function emptyHeaders() {
  return {
    get() {
      return null;
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: emptyHeaders(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    body: { cancel() {} },
  };
}

function headResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: emptyHeaders(),
    json: async () => {
      throw new Error("no body");
    },
    text: async () => "",
    body: { cancel() {} },
  };
}

function redirectResponse(status, location) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Redirect",
    headers: {
      get(name) {
        return name.toLowerCase() === "location" ? location : null;
      },
    },
    json: async () => {
      throw new Error("no body");
    },
    text: async () => "",
    body: { cancel() {} },
  };
}

function mockFetch(routes) {
  return async (url, init = {}) => {
    const key = `${(init.method ?? "GET").toUpperCase()} ${url}`;
    if (!Object.hasOwn(routes, key) && !Object.hasOwn(routes, url)) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    const entry = routes[key] ?? routes[url];
    if (typeof entry === "function") return entry(url, init);
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

test("detectReshadeStableUpdate reports up_to_date when pin matches upstream", async () => {
  const pin = "6.7.3";
  const fetchFn = mockFetch({
    [`GET ${RESHADE_TAGS_URL}`]: jsonResponse([{ name: "v6.7.3" }, { name: "v6.7.2" }]),
    [`GET ${RESHADE_HOME_URL}`]: jsonResponse(
      `Version 6.7.3 <a href="ReShade_Setup_6.7.3_Addon.exe">`,
    ),
    [`HEAD ${buildStableAddonUrl(pin)}`]: headResponse(200),
  });

  const result = await detectReshadeStableUpdate({
    fetchFn,
    currentVersion: pin,
  });

  assert.equal(result.kind, DETECT_KIND.upToDate);
  assert.equal(result.preferredVersion, pin);
  assert.equal(result.soft, false);
});

test("detectReshadeStableUpdate reports update_available when newer Addon is live", async () => {
  const fetchFn = mockFetch({
    [`GET ${RESHADE_TAGS_URL}`]: jsonResponse([{ name: "v6.7.4" }]),
    [`GET ${RESHADE_HOME_URL}`]: jsonResponse(`Version 6.7.4`),
    [`HEAD ${buildStableAddonUrl("6.7.4")}`]: headResponse(200),
  });

  const result = await detectReshadeStableUpdate({
    fetchFn,
    currentVersion: "6.7.3",
  });

  assert.equal(result.kind, DETECT_KIND.updateAvailable);
  assert.equal(result.preferredVersion, "6.7.4");
  assert.equal(result.url, buildStableAddonUrl("6.7.4"));
});

test("detectReshadeStableUpdate picks intermediate live Addon when newest is pending", async () => {
  const fetchFn = mockFetch({
    [`GET ${RESHADE_TAGS_URL}`]: jsonResponse([
      { name: "v6.7.5" },
      { name: "v6.7.4" },
      { name: "v6.7.3" },
    ]),
    [`GET ${RESHADE_HOME_URL}`]: jsonResponse(`Version 6.7.5`),
    [`HEAD ${buildStableAddonUrl("6.7.5")}`]: headResponse(404),
    [`HEAD ${buildStableAddonUrl("6.7.4")}`]: headResponse(200),
  });

  const result = await detectReshadeStableUpdate({
    fetchFn,
    currentVersion: "6.7.3",
  });

  assert.equal(result.kind, DETECT_KIND.updateAvailable);
  assert.equal(result.preferredVersion, "6.7.4");
  assert.equal(result.url, buildStableAddonUrl("6.7.4"));
});

test("detectReshadeStableUpdate reports pending_publish when no newer Addon is live", async () => {
  const fetchFn = mockFetch({
    [`GET ${RESHADE_TAGS_URL}`]: jsonResponse([{ name: "v6.7.4" }]),
    [`GET ${RESHADE_HOME_URL}`]: jsonResponse(`Version 6.7.3`),
    [`HEAD ${buildStableAddonUrl("6.7.4")}`]: headResponse(404),
  });

  const result = await detectReshadeStableUpdate({
    fetchFn,
    currentVersion: "6.7.3",
  });

  assert.equal(result.kind, DETECT_KIND.pendingPublish);
  assert.equal(result.preferredVersion, "6.7.4");
  assert.equal(result.soft, true);
});

test("detectReshadeStableUpdate is soft-unavailable when both sources fail", async () => {
  const fetchFn = mockFetch({
    [`GET ${RESHADE_TAGS_URL}`]: new TypeError("network down"),
    [`GET ${RESHADE_HOME_URL}`]: new TypeError("network down"),
  });

  const result = await detectReshadeStableUpdate({
    fetchFn,
    currentVersion: "6.7.3",
  });

  assert.equal(result.kind, DETECT_KIND.unavailable);
  assert.equal(result.soft, true);
});

// ── check results ──

test("hard/soft failure helpers classify and format check results", () => {
  const results = [
    checkResult("a", CHECK_STATUS.ok, "fine"),
    checkResult("b", CHECK_STATUS.soft, "flaky"),
    checkResult("c", CHECK_STATUS.hard, "missing"),
  ];
  assert.equal(hasHardFailure(results), true);
  assert.equal(hasSoftFailure(results), true);
  assert.deepEqual(hardFailureMessages(results), ["c: missing"]);
  assert.deepEqual(softFailureMessages(results), ["b: flaky"]);
  assert.deepEqual(formatCheckResults(results), [
    "OK   a: fine",
    "SOFT b: flaky",
    "HARD c: missing",
  ]);
});

// ── health ──

test("checkReshadeChannelHealth hard-fails stable 404 and soft-fails nightly 404", async () => {
  const targets = [
    {
      id: "reshade.stable",
      url: buildStableAddonUrl("6.7.3"),
      kind: "stable",
      probe: "head",
    },
    {
      id: "reshade.nightly.url64",
      url: "https://nightly.link/example.zip",
      kind: "nightly",
      probe: "get-redirect",
    },
  ];

  const fetchFn = mockFetch({
    [`HEAD ${targets[0].url}`]: headResponse(404),
    [`GET ${targets[1].url}`]: headResponse(404),
  });

  const results = await checkReshadeChannelHealth({ fetchFn, targets });
  assert.equal(hasHardFailure(results), true);
  assert.equal(hasSoftFailure(results), true);
  assert.equal(results.find((r) => r.id === "reshade.stable").status, CHECK_STATUS.hard);
  const nightly = results.find((r) => r.id === "reshade.nightly.url64");
  assert.equal(nightly.status, CHECK_STATUS.soft);
  assert.match(nightly.detail, /HTTP 404/);
  assert.ok(formatCheckResults(results).length === 2);
});

test("checkReshadeChannelHealth accepts nightly GET redirects", async () => {
  const url = "https://nightly.link/crosire/reshade/example.zip";
  const results = await checkReshadeChannelHealth({
    fetchFn: mockFetch({
      [`GET ${url}`]: redirectResponse(
        302,
        "https://example.blob.core.windows.net/artifact.zip",
      ),
    }),
    targets: [
      {
        id: "reshade.nightly.url64",
        url,
        kind: "nightly",
        probe: "get-redirect",
      },
    ],
  });

  assert.equal(results[0].status, CHECK_STATUS.ok);
  assert.match(results[0].detail, /302 \(redirect\)/);
});

test("checkReshadeChannelHealth hard-fails broken stable URL contract", async () => {
  const results = await checkReshadeChannelHealth({
    fetchFn: mockFetch({}),
    targets: [
      {
        id: "reshade.stable",
        url: "https://reshade.me/downloads/ReShade_Setup_6.7.3.exe",
        kind: "stable",
      },
    ],
  });

  assert.equal(results[0].status, CHECK_STATUS.hard);
  assert.match(results[0].detail, /Addon installer pattern/);
});

test("cancelResponseBody ignores missing body", () => {
  assert.doesNotThrow(() => cancelResponseBody({}));
  assert.doesNotThrow(() => cancelResponseBody(null));
  let cancelled = false;
  cancelResponseBody({
    body: {
      cancel() {
        cancelled = true;
      },
    },
  });
  assert.equal(cancelled, true);
});

// ── pinned deps ──

test("collectManagedDependencySourceUrls de-duplicates archive URLs", () => {
  const urls = collectManagedDependencySourceUrls({
    games: [
      {
        requirements: {
          managed_dependency: {
            source: { url: "https://example.com/a.zip" },
          },
        },
      },
      {
        requirements: {
          managed_dependency: {
            source: { url: "https://example.com/a.zip" },
          },
        },
      },
      {
        requirements: {
          managed_dependency: {
            source: { url: "https://example.com/b.zip" },
          },
        },
      },
      { requirements: {} },
    ],
  });

  assert.deepEqual(urls, ["https://example.com/a.zip", "https://example.com/b.zip"]);
});

test("checkPinnedDependencyUrls hard-fails missing archives with URL-stable ids", async () => {
  const fetchFn = mockFetch({
    "HEAD https://example.com/ok.zip": headResponse(200),
    "HEAD https://example.com/missing.zip": headResponse(404),
  });

  const results = await checkPinnedDependencyUrls(
    ["https://example.com/ok.zip", "https://example.com/missing.zip"],
    { fetchFn },
  );

  assert.equal(hasHardFailure(results), true);
  assert.equal(results.filter((r) => r.status === CHECK_STATUS.ok).length, 1);
  assert.ok(
    results.some(
      (r) => r.id === pinnedDependencyCheckId("https://example.com/missing.zip"),
    ),
  );
  assert.ok(
    results.some((r) => r.id === pinnedDependencyCheckId("https://example.com/ok.zip")),
  );
});

test("replaceStableUrlInSources rewrites the single Addon pin", () => {
  const sample = `
export const RESHADE_STABLE = deepFreeze({
  url: "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe",
});
`;
  const { text, changed, previousUrl } = replaceStableUrlInSources(
    sample,
    "https://reshade.me/downloads/ReShade_Setup_6.7.4_Addon.exe",
  );
  assert.equal(changed, true);
  assert.equal(previousUrl, "https://reshade.me/downloads/ReShade_Setup_6.7.3_Addon.exe");
  assert.match(text, /ReShade_Setup_6\.7\.4_Addon\.exe/);
  assert.doesNotMatch(text, /ReShade_Setup_6\.7\.3_Addon\.exe/);
});
