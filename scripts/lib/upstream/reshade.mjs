// Pure ReShade upstream detect + health logic. All network I/O goes through
// injectable fetch so unit tests never hit the network.

import {
  buildStableAddonUrl,
  currentStableVersion,
  listReshadeHealthTargets,
  parseStableAddonUrl,
} from "../reshade-sources.mjs";
import { githubHeaders } from "../github.mjs";
import { errorMessage } from "../common.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  HttpStatusError,
  UpstreamNetworkError,
  fetchJsonWithTimeout,
  fetchWithTimeout,
  probeUrl,
} from "../http.mjs";
import { checkUrlHealth } from "./check-url-health.mjs";
import { CHECK_STATUS, checkResult } from "./result.mjs";
import {
  compareSemver,
  isNewerSemver,
  maxSemver,
  versionFromGitTag,
} from "./semver-triple.mjs";

export const RESHADE_TAGS_URL =
  "https://api.github.com/repos/crosire/reshade/tags?per_page=30";
export const RESHADE_HOME_URL = "https://reshade.me/";

const SETUP_VERSION_RE = /ReShade_Setup_(\d+\.\d+\.\d+)(?:_Addon)?\.exe/giu;
const VERSION_LABEL_RE = /Version\s+(\d+\.\d+\.\d+)/giu;

export const DETECT_KIND = Object.freeze({
  upToDate: "up_to_date",
  updateAvailable: "update_available",
  pendingPublish: "pending_publish",
  unavailable: "unavailable",
});

/**
 * Extracts candidate X.Y.Z versions from the reshade.me homepage HTML.
 */
export function extractVersionsFromHomepage(html) {
  if (typeof html !== "string" || html.length === 0) return [];

  const found = new Set();

  for (const pattern of [SETUP_VERSION_RE, VERSION_LABEL_RE]) {
    // Fresh instance per call so /g lastIndex state never leaks across callers.
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of html.matchAll(re)) {
      found.add(match[1]);
    }
  }

  return [...found];
}

/**
 * Extracts all dotted triples from a GitHub tags API payload.
 */
export function versionsFromTagsPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("GitHub tags response must be an array");
  }

  return payload
    .map((entry) => versionFromGitTag(entry?.name))
    .filter((value) => value !== null);
}

/**
 * Extracts the newest dotted triple from a GitHub tags API payload.
 */
export function latestVersionFromTagsPayload(payload) {
  return maxSemver(versionsFromTagsPayload(payload));
}

/**
 * Unique candidate versions from tags + homepage, sorted ascending.
 */
export function collectCandidateVersions({ tagVersions = [], homeVersions = [] } = {}) {
  const set = new Set();
  for (const value of [...tagVersions, ...homeVersions]) {
    if (typeof value === "string" && value.trim() !== "") {
      set.add(value.trim());
    }
  }
  return [...set].sort(compareSemver);
}

/**
 * Versions strictly newer than `currentVersion`, newest first.
 */
export function newerCandidatesDescending(candidates, currentVersion) {
  return candidates
    .filter((version) => isNewerSemver(version, currentVersion))
    .sort((a, b) => compareSemver(b, a));
}

async function fetchTagVersions(fetchFn, timeoutMs) {
  try {
    const payload = await fetchJsonWithTimeout(RESHADE_TAGS_URL, {
      fetchFn,
      timeoutMs,
      headers: githubHeaders(),
    });
    return versionsFromTagsPayload(payload);
  } catch (error) {
    if (error instanceof UpstreamNetworkError) {
      throw error;
    }
    if (error instanceof HttpStatusError) {
      throw new UpstreamNetworkError(
        `GitHub tags API returned HTTP ${error.status} ${error.statusText}`,
        { cause: error },
      );
    }
    const detail =
      error instanceof Error && error.message.startsWith("Invalid JSON")
        ? `GitHub tags API returned invalid JSON: ${errorMessage(error.cause ?? error)}`
        : errorMessage(error);
    throw new UpstreamNetworkError(detail, { cause: error });
  }
}

async function fetchHomepageVersions(fetchFn, timeoutMs) {
  const response = await fetchWithTimeout(RESHADE_HOME_URL, {
    fetchFn,
    timeoutMs,
    method: "GET",
  });

  if (!response.ok) {
    throw new UpstreamNetworkError(
      `reshade.me returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  return extractVersionsFromHomepage(html);
}

async function loadVersionSources(fetchFn, timeoutMs) {
  const sources = {
    tagVersions: [],
    tagVersion: null,
    homeVersions: [],
    homeVersion: null,
    tagError: null,
    homeError: null,
  };

  const [tagOutcome, homeOutcome] = await Promise.all([
    fetchTagVersions(fetchFn, timeoutMs).then(
      (versions) => ({ ok: true, versions }),
      (error) => ({ ok: false, error }),
    ),
    fetchHomepageVersions(fetchFn, timeoutMs).then(
      (versions) => ({ ok: true, versions }),
      (error) => ({ ok: false, error }),
    ),
  ]);

  if (tagOutcome.ok) {
    sources.tagVersions = tagOutcome.versions;
    sources.tagVersion = maxSemver(tagOutcome.versions);
  } else {
    sources.tagError = errorMessage(tagOutcome.error);
  }

  if (homeOutcome.ok) {
    sources.homeVersions = homeOutcome.versions;
    sources.homeVersion = maxSemver(homeOutcome.versions);
  } else {
    sources.homeError = errorMessage(homeOutcome.error);
  }

  return sources;
}

function freezeSources(sources) {
  return Object.freeze({ ...sources });
}

function freezeProbe(probe) {
  if (!probe) return undefined;
  return Object.freeze({ ...probe });
}

function detectionResult({
  kind,
  soft,
  currentVersion,
  preferredVersion,
  url,
  sources,
  probe,
  detail,
}) {
  const result = {
    kind,
    soft,
    currentVersion,
    preferredVersion,
    url,
    sources: freezeSources(sources),
    detail,
  };
  const frozenProbe = freezeProbe(probe);
  if (frozenProbe) {
    result.probe = frozenProbe;
  }
  return Object.freeze(result);
}

export async function probeAddon(version, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildStableAddonUrl(version);
  try {
    const probe = await probeUrl(url, { fetchFn, timeoutMs, method: "HEAD" });
    return { url, version, ...probe };
  } catch (error) {
    if (error instanceof UpstreamNetworkError) {
      return { url, version, ok: false, status: 0, networkError: error.message };
    }
    throw error;
  }
}

/**
 * Detects whether a newer stable Addon installer is available.
 *
 * Probes every candidate newer than the pin (newest first) so an intermediate
 * live Addon is chosen when the absolute newest is not published yet.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn]
 * @param {string} [options.currentVersion] defaults to SSoT pin
 * @param {number} [options.timeoutMs]
 */
export async function detectReshadeStableUpdate(options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const currentVersion = options.currentVersion ?? currentStableVersion();

  // Validate pin contract early (hard for callers that surface it).
  parseStableAddonUrl(buildStableAddonUrl(currentVersion));

  const sources = await loadVersionSources(fetchFn, timeoutMs);
  const candidates = collectCandidateVersions({
    tagVersions: sources.tagVersions,
    homeVersions: sources.homeVersions,
  });
  const observedMax = maxSemver(candidates);

  if (!observedMax) {
    const sourceErrors = [sources.tagError, sources.homeError].filter(Boolean);
    return detectionResult({
      kind: DETECT_KIND.unavailable,
      soft: true,
      currentVersion,
      preferredVersion: null,
      url: null,
      sources,
      detail:
        sourceErrors.length > 0
          ? `could not determine latest ReShade version (${sourceErrors.join("; ")})`
          : "could not determine latest ReShade version from tags or homepage",
    });
  }

  const newer = newerCandidatesDescending(candidates, currentVersion);

  if (newer.length > 0) {
    let lastProbe = null;
    for (const version of newer) {
      const probe = await probeAddon(version, { fetchFn, timeoutMs });
      lastProbe = probe;
      if (probe.ok) {
        return detectionResult({
          kind: DETECT_KIND.updateAvailable,
          soft: false,
          currentVersion,
          preferredVersion: version,
          url: probe.url,
          sources,
          probe: { status: probe.status, ok: true },
          detail: `stable ${version} is available (current pin ${currentVersion})`,
        });
      }
    }

    const newest = newer[0];
    return detectionResult({
      kind: DETECT_KIND.pendingPublish,
      soft: true,
      currentVersion,
      preferredVersion: newest,
      url: lastProbe?.url ?? buildStableAddonUrl(newest),
      sources,
      probe: {
        status: lastProbe?.status ?? 0,
        ok: false,
        networkError: lastProbe?.networkError ?? null,
      },
      detail: lastProbe?.networkError
        ? `newer version(s) seen upstream but no downloadable Addon yet (tried ${newer.join(", ")}); last error: ${lastProbe.networkError}`
        : `newer version(s) seen upstream but no downloadable Addon yet (tried ${newer.join(", ")}); last HTTP ${lastProbe?.status ?? "n/a"}`,
    });
  }

  // No newer candidates: confirm current pin when it matches observed max,
  // or report pin-ahead when current is already newer than upstream.
  if (observedMax === currentVersion) {
    const probe = await probeAddon(currentVersion, { fetchFn, timeoutMs });
    if (probe.ok) {
      return detectionResult({
        kind: DETECT_KIND.upToDate,
        soft: false,
        currentVersion,
        preferredVersion: currentVersion,
        url: probe.url,
        sources,
        probe: { status: probe.status, ok: true },
        detail: `stable pin ${currentVersion} matches upstream and is downloadable`,
      });
    }

    return detectionResult({
      kind: DETECT_KIND.upToDate,
      soft: true,
      currentVersion,
      preferredVersion: currentVersion,
      url: probe.url,
      sources,
      probe: {
        status: probe.status,
        ok: false,
        networkError: probe.networkError ?? null,
      },
      detail: probe.networkError
        ? `pin ${currentVersion} matches upstream but probe failed: ${probe.networkError}`
        : `pin ${currentVersion} matches upstream but Addon URL returned HTTP ${probe.status}`,
    });
  }

  // observedMax < current (pin ahead of public sources)
  return detectionResult({
    kind: DETECT_KIND.upToDate,
    soft: false,
    currentVersion,
    preferredVersion: observedMax,
    url: buildStableAddonUrl(currentVersion),
    sources,
    detail: `stable pin ${currentVersion} is ahead of observed upstream ${observedMax}`,
  });
}

/**
 * Live health checks for committed ReShade channel pins.
 *
 * Stable: contract parse + HEAD 200 тЖТ ok; 404/non-ok тЖТ hard; network тЖТ soft.
 * Nightly: GET without following redirects (nightly.link 404s HEAD); 3xx is ok.
 * Nightly non-ok/network тЖТ soft (host is flaky by nature).
 */
export async function checkReshadeChannelHealth(options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targets = options.targets ?? listReshadeHealthTargets();
  const results = [];

  for (const target of targets) {
    if (target.kind === "stable") {
      try {
        parseStableAddonUrl(target.url);
      } catch (error) {
        results.push(checkResult(target.id, CHECK_STATUS.hard, errorMessage(error)));
        continue;
      }
    }

    const redirectOk = target.probe === "get-redirect";
    const missingStatus = target.kind === "stable" ? CHECK_STATUS.hard : CHECK_STATUS.soft;

    results.push(
      await checkUrlHealth(target.id, target.url, {
        fetchFn,
        timeoutMs,
        redirectOk,
        method: redirectOk ? "GET" : "HEAD",
        missingStatus,
      }),
    );
  }

  return results;
}
