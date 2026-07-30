#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { resolveRepoPath } from "./catalog.mjs";
import { parseCliArgs } from "./lib/cli-args.mjs";
import { mapConcurrent } from "./lib/common.mjs";
import { sha256Hex } from "./lib/hash.mjs";
import {
  cancelResponseBody,
  fetchWithTimeout,
  readResponseBufferBounded,
} from "./lib/http.mjs";
import { writeJsonFileAtomic } from "./lib/json.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { assertXiphLock } from "./lib/xiph-lock.mjs";
import {
  compareDottedVersions,
  desiredXiphStablePairs,
  parseXiphPendingLimit,
  pendingXiphPairs,
  planExceptionalXiphRebuild,
  withXiphPairAdditions,
  xiphPairKey,
} from "./lib/xiph-refresh.mjs";

const execFileAsync = promisify(execFile);
const LOCK_FILE = resolveRepoPath("catalogs", "libraries", "xiph.lock.json");
const RELEASE_ROOT = "https://downloads.xiph.org/releases";
const RELEASE_MIRROR_ROOT = "https://ftp.osuosl.org/pub/xiph/releases";
const DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 120_000;

runCliMain({
  parse: (argv) =>
    parseCliArgs(argv, {
      write: { type: "boolean" },
      "exceptional-rebuild": { type: "boolean" },
      pair: { type: "string" },
      "pending-limit": { type: "string" },
    }).values,
  main: async (args) => {
    const write = args.write ?? false;
    let lock = assertXiphLock(JSON.parse(await readFile(LOCK_FILE, "utf8")));
    if (args["exceptional-rebuild"]) {
      const planned = planExceptionalXiphRebuild(lock, args.pair);
      if (!write) {
        printStatus("exceptional_rebuild", [planned.pair]);
        return;
      }
      lock = planned.lock;
      await writeLock(lock);
      printStatus("materialization_required", [planned.pair]);
      return;
    }

    const [vorbisReleases, oggReleases, gitRefs] = await Promise.all([
      discoverReleases("vorbis"),
      discoverReleases("ogg"),
      loadGitRefs(),
    ]);
    const desiredPairs = desiredXiphStablePairs(vorbisReleases, oggReleases);
    const existingTuples = new Set(lock.pairs.map(xiphPairKey));
    const sourceCache = collectExistingSources(lock);
    const plannedPairs = desiredPairs.filter(
      ([vorbisVersion, oggVersion]) =>
        !existingTuples.has(`${vorbisVersion}|${oggVersion}`),
    );

    // Complete the only network phase before constructing the candidate lock.
    // The remaining plan, validation, and persistence are pure/local operations.
    const sourceRequests = new Map();
    for (const [vorbisVersion, oggVersion] of plannedPairs) {
      addSourceRequest(sourceRequests, sourceCache, {
        component: "ogg",
        version: oggVersion,
        archiveUrl: oggReleases.get(oggVersion),
        refs: gitRefs.ogg,
      });
      addSourceRequest(sourceRequests, sourceCache, {
        component: "vorbis",
        version: vorbisVersion,
        archiveUrl: vorbisReleases.get(vorbisVersion),
        refs: gitRefs.vorbis,
      });
    }
    const discoveredPins = await mapConcurrent(
      [...sourceRequests],
      4,
      async ([key, request]) => [
        key,
        await sourcePin(
          request.component,
          request.version,
          request.archiveUrl,
          request.refs,
        ),
      ],
    );
    for (const [key, source] of discoveredPins) sourceCache.set(key, source);

    const additions = plannedPairs.map(([vorbisVersion, oggVersion]) => ({
      vorbis_version: vorbisVersion,
      ogg_version: oggVersion,
      build_revision: 1,
      sources: {
        ogg: requiredSourcePin(sourceCache, "ogg", oggVersion),
        vorbis: requiredSourcePin(sourceCache, "vorbis", vorbisVersion),
      },
      builds: [],
    }));

    if (additions.length > 0 && !write) {
      process.stdout.write(
        `stable_releases=${vorbisReleases.size + oggReleases.size}\n` +
          `new_pairs=${additions.length}\n`,
      );
      printStatus("update_available", additions);
      return;
    }
    if (additions.length > 0) {
      lock = withXiphPairAdditions(lock, additions);
      await writeLock(lock);
    }

    const pending = pendingXiphPairs(lock);
    const limit = parseXiphPendingLimit(args["pending-limit"], pending.length);
    process.stdout.write(
      `stable_releases=${vorbisReleases.size + oggReleases.size}\n` +
        `source_pairs=${lock.pairs.length}\n` +
        `pending_pairs=${pending.length}\n`,
    );
    printStatus(
      pending.length === 0 ? "no_update" : "materialization_required",
      pending.slice(0, limit),
    );
  },
});

async function discoverReleases(component) {
  const mirrorUrl = `${RELEASE_MIRROR_ROOT}/${component}/`;
  const canonicalUrl = `${RELEASE_ROOT}/${component}/`;
  const html = await fetchText(mirrorUrl);
  const expression = new RegExp(
    `href="(lib${component}-(\\d+\\.\\d+(?:\\.\\d+)?)\\.tar\\.(xz|bz2|gz))"`,
    "gu",
  );
  const candidates = new Map();
  for (const match of html.matchAll(expression)) {
    const [, fileName, version, format] = match;
    const current = candidates.get(version);
    if (!current || archivePriority(format) < archivePriority(current.format)) {
      candidates.set(version, { format, url: new URL(fileName, canonicalUrl).href });
    }
  }
  if (candidates.size === 0) {
    throw new Error(`official Xiph ${component} directory has no stable archives`);
  }
  return new Map(
    [...candidates.entries()]
      .sort(([left], [right]) => compareDottedVersions(left, right))
      .map(([version, value]) => [version, value.url]),
  );
}

function archivePriority(format) {
  return { xz: 0, bz2: 1, gz: 2 }[format] ?? 99;
}

async function loadGitRefs() {
  const entries = await Promise.all(
    ["ogg", "vorbis"].map(async (component) => {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--tags", `https://github.com/xiph/${component}.git`],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      return [
        component,
        new Map(
          stdout
            .trim()
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => {
              const [sha, ref] = line.split("\t");
              return [ref, sha];
            }),
        ),
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function collectExistingSources(lock) {
  const cache = new Map();
  for (const pair of lock.pairs) {
    cache.set(`ogg|${pair.ogg_version}`, pair.sources.ogg);
    cache.set(`vorbis|${pair.vorbis_version}`, pair.sources.vorbis);
  }
  return cache;
}

function addSourceRequest(requests, cache, request) {
  const { component, version } = request;
  const key = `${component}|${version}`;
  if (!cache.has(key)) requests.set(key, request);
}

function requiredSourcePin(cache, component, version) {
  const key = `${component}|${version}`;
  const source = cache.get(key);
  if (source === undefined) {
    throw new Error(`Xiph discovery did not resolve ${key}`);
  }
  return structuredClone(source);
}

async function sourcePin(component, version, archiveUrl, refs) {
  const repository = `xiph/${component}`;
  const candidateTag =
    component === "vorbis" && version === "1.0" ? "v1.0.0" : `v${version}`;
  const tagRef = `refs/tags/${candidateTag}`;
  const tagObjectSha = refs.get(tagRef) ?? null;
  const commitSha = refs.get(`${tagRef}^{}`) ?? tagObjectSha;
  const tag = tagObjectSha === null ? null : candidateTag;

  const response = await fetchOfficialArchive(archiveUrl);
  if (!response.ok) {
    cancelResponseBody(response);
    throw new Error(`${archiveUrl}: HTTP ${response.status}`);
  }
  const archive = await readResponseBufferBounded(response, {
    maximumSize: ARCHIVE_MAX_BYTES,
    context: `${component} source archive`,
  });
  if (archive.length === 0) {
    throw new Error(`${component} source archive has an unsafe size`);
  }
  return {
    repository,
    tag,
    tag_object_sha: tagObjectSha,
    commit_sha: commitSha,
    archive_url: archiveUrl,
    archive_sha256: sha256Hex(archive),
  };
}

function printStatus(status, pairs) {
  process.stdout.write(
    `status=${status}\n` + `pairs_json=${JSON.stringify(pairs.map(xiphPairKey))}\n`,
  );
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, { redirect: "error" });
  if (!response.ok) {
    cancelResponseBody(response);
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return (
    await readResponseBufferBounded(response, {
      maximumSize: DIRECTORY_MAX_BYTES,
      context: `Xiph release directory ${url}`,
    })
  ).toString("utf8");
}

async function fetchOfficialArchive(url) {
  const source = new URL(url);
  const resolved = new URL(`/pub/xiph${source.pathname}`, "https://ftp.osuosl.org");
  return fetchWithRetry(resolved, {
    redirect: "error",
    timeoutMs: ARCHIVE_TIMEOUT_MS,
  });
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw new Error(`${url}: ${lastError.message}`, { cause: lastError });
}

async function writeLock(lock) {
  assertXiphLock(lock);
  await writeJsonFileAtomic(LOCK_FILE, lock);
}
