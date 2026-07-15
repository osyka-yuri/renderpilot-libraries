import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCheckArgs,
  sha256Hex,
  loadLocalJson,
  fetchRemoteJson,
  compareHashes,
  checkOne,
  formatResult,
  formatVerboseLines,
  aggregateResults,
  formatFailureAdvice,
} from "../lib/published-json-check.mjs";
import { UsageError } from "../lib/common.mjs";

// ── helpers ──

const document = (file, r2Key = file) => ({ file, r2Key });

const mockReadFile = (files) => async (absPath) => {
  for (const [key, data] of Object.entries(files)) {
    if (absPath.endsWith(key)) return Buffer.from(data, "utf-8");
  }
  const err = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  throw err;
};

function mockFetch(responseMap) {
  return async (url) => {
    const key = new URL(url).pathname.split("/").pop();
    if (!Object.hasOwn(responseMap, key)) {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    }
    const entry = responseMap[key];
    if (entry.status && entry.status !== 200) {
      return { ok: false, status: entry.status, statusText: entry.statusText ?? "" };
    }
    if (entry.bodyError) {
      return {
        ok: true,
        arrayBuffer: async () => {
          throw new Error(entry.bodyError);
        },
      };
    }
    const buf = Buffer.from(entry.body ?? entry, "utf-8");
    return {
      ok: true,
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

// ── parseCheckArgs ──

test("parseCheckArgs defaults all flags to false", () => {
  assert.deepEqual(parseCheckArgs([]), { verbose: false, dryRun: false, help: false });
});

test("parseCheckArgs recognizes long flags", () => {
  assert.deepEqual(parseCheckArgs(["--verbose", "--dry-run"]), {
    verbose: true,
    dryRun: true,
    help: false,
  });
});

test("parseCheckArgs recognizes short flags", () => {
  assert.deepEqual(parseCheckArgs(["-v", "-h"]), {
    verbose: true,
    dryRun: false,
    help: true,
  });
});

test("parseCheckArgs throws on unknown flags", () => {
  assert.throws(() => parseCheckArgs(["--unknown"]), UsageError);
});

// ── sha256Hex ──

test("sha256Hex produces consistent hashes", () => {
  const hex = sha256Hex(Buffer.from("hello world", "utf-8"));
  assert.equal(hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("sha256Hex of empty buffer is not all zeros", () => {
  const hex = sha256Hex(Buffer.alloc(0));
  assert.equal(hex.length, 64);
  assert.notEqual(hex, "0".repeat(64));
});

// ── loadLocalJson ──

test("loadLocalJson reads a file and computes key/size/sha256", async () => {
  const readFile = mockReadFile({ "manifest.json": '{"key":"value"}' });

  const result = await loadLocalJson(document("manifest.json"), "/repo", readFile);

  assert.equal(result.key, "manifest.json");
  assert.equal(result.relPath, "manifest.json");
  assert.equal(result.size, 15);
  assert.equal(typeof result.sha256, "string");
  assert.equal(result.sha256.length, 64);
});

test("loadLocalJson uses the registry's explicit R2 key", async () => {
  const readFile = mockReadFile({
    "renodx_manifest.json": '{"x":1}',
  });

  const result = await loadLocalJson(
    document("renodx_manifest.json", "legacy/renodx.json"),
    "/repo",
    readFile,
  );

  assert.equal(result.key, "legacy/renodx.json");
});

test("loadLocalJson rethrows missing-file errors with context", async () => {
  const readFile = mockReadFile({});

  await assert.rejects(
    () => loadLocalJson(document("nope.json"), "/repo", readFile),
    /failed to read nope\.json/,
  );
});

// ── fetchRemoteJson ──

test("fetchRemoteJson GETs the body and computes SHA-256", async () => {
  const fetchFn = mockFetch({ "test.json": '{"a":1}' });

  const result = await fetchRemoteJson("test.json", "pub.example.com", fetchFn);

  assert.equal(result.status, "available");
  assert.equal(typeof result.sha256, "string");
  assert.equal(result.sha256.length, 64);
  assert.equal(result.size, 7);
});

test("same bytes => same SHA-256 between local and remote", async () => {
  const body = '{"status":"working"}';
  const readFile = mockReadFile({ "file.json": body });
  const fetchFn = mockFetch({ "file.json": body });

  const local = await loadLocalJson(document("file.json"), "/repo", readFile);
  const remote = await fetchRemoteJson("file.json", "pub.example.com", fetchFn);

  assert.equal(local.sha256, remote.sha256);
});

test("same size but different bytes => different SHA-256", async () => {
  const readFile = mockReadFile({ "file.json": "aaaaaaaaaa" });
  const fetchFn = mockFetch({ "file.json": "bbbbbbbbbb" });

  const local = await loadLocalJson(document("file.json"), "/repo", readFile);
  const remote = await fetchRemoteJson("file.json", "pub.example.com", fetchFn);

  assert.equal(local.size, remote.size);
  assert.notEqual(local.sha256, remote.sha256);
});

test("fetchRemoteJson returns error on HTTP 404", async () => {
  const fetchFn = mockFetch({ "missing.json": { status: 404, statusText: "Not Found" } });

  const result = await fetchRemoteJson("missing.json", "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /HTTP 404 Not Found/);
});

test("fetchRemoteJson returns error on HTTP 403", async () => {
  const fetchFn = mockFetch({ "forbidden.json": { status: 403 } });

  const result = await fetchRemoteJson("forbidden.json", "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /HTTP 403/);
});

test("fetchRemoteJson returns error on network failure", async () => {
  const fetchFn = async () => {
    throw new Error("connect ETIMEDOUT");
  };

  const result = await fetchRemoteJson("test.json", "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /network error: connect ETIMEDOUT/);
});

test("fetchRemoteJson returns unavailable on response body read failure", async () => {
  const fetchFn = mockFetch({ "broken.json": { bodyError: "terminated" } });

  const result = await fetchRemoteJson("broken.json", "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /failed to read response body: terminated/);
});

// ── compareHashes ──

test("compareHashes returns match for identical hashes", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(compareHashes(hash, hash), { status: "match", reason: null });
});

test("compareHashes returns mismatch with reason for different hashes", () => {
  const result = compareHashes(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(result.status, "mismatch");
  assert.match(result.reason, /SHA-256 mismatch/);
  assert.match(result.reason, /local a+/);
  assert.match(result.reason, /remote b+/);
});

// ── checkOne ──

test("checkOne returns OK when local and remote match", async () => {
  const body = '{"x":1}';
  const readFile = mockReadFile({ "match.json": body });
  const fetchFn = mockFetch({ "match.json": body });

  const local = await loadLocalJson(document("match.json"), "/repo", readFile);
  const result = await checkOne(local, "pub.example.com", fetchFn);

  assert.equal(result.key, "match.json");
  assert.equal(result.status, "match");
  assert.equal(result.localSha256, result.remoteSha256);
  assert.equal(result.reason, null);
});

test("checkOne returns MISMATCH when bytes differ", async () => {
  const readFile = mockReadFile({ "diff.json": "local-data" });
  const fetchFn = mockFetch({ "diff.json": "remote-data" });

  const local = await loadLocalJson(document("diff.json"), "/repo", readFile);
  const result = await checkOne(local, "pub.example.com", fetchFn);

  assert.equal(result.status, "mismatch");
  assert.match(result.reason, /SHA-256 mismatch/);
});

test("checkOne returns unavailable when remote returns 404", async () => {
  const readFile = mockReadFile({ "notfound.json": "{}" });
  const fetchFn = mockFetch({
    "notfound.json": { status: 404, statusText: "Not Found" },
  });

  const local = await loadLocalJson(document("notfound.json"), "/repo", readFile);
  const result = await checkOne(local, "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /HTTP 404 Not Found/);
  assert.equal(result.remoteSha256, null);
});

test("checkOne returns unavailable on network error", async () => {
  const readFile = mockReadFile({ "test.json": "{}" });
  const fetchFn = async () => {
    throw new Error("DNS lookup failed");
  };

  const local = await loadLocalJson(document("test.json"), "/repo", readFile);
  const result = await checkOne(local, "pub.example.com", fetchFn);

  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /network error/);
});

// ── formatResult ──

test("formatResult shows OK for passing results", () => {
  const result = { key: "manifest.json", status: "match", reason: null };
  assert.equal(formatResult(result), "  OK   manifest.json");
});

test("formatResult shows MISMATCH with reason for failing results", () => {
  const result = {
    key: "addons/v1/luma.json",
    status: "mismatch",
    reason: "SHA-256 mismatch (local aaa, remote bbb)",
  };
  const formatted = formatResult(result);
  assert.match(formatted, /MISMATCH/);
  assert.match(formatted, /addons\/v1\/luma\.json/);
  assert.match(formatted, /SHA-256 mismatch/);
});

test("formatResult shows UNAVAILABLE for remote failures", () => {
  const result = {
    key: "manifest.json",
    status: "unavailable",
    reason: "failed to read response body: terminated",
  };
  const formatted = formatResult(result);
  assert.match(formatted, /UNAVAILABLE/);
  assert.match(formatted, /manifest\.json/);
  assert.match(formatted, /terminated/);
});

// ── formatVerboseLines ──

test("formatVerboseLines shows local and remote hashes", () => {
  const result = {
    key: "test.json",
    localSha256: "aaa",
    remoteSha256: "bbb",
    reason: null,
  };
  const lines = formatVerboseLines(result);
  assert.equal(lines.local, "  local:  aaa  test.json");
  assert.equal(lines.remote, "  remote: bbb  test.json");
});

test("formatVerboseLines shows error when remoteSha256 is null", () => {
  const result = {
    key: "broken.json",
    localSha256: "ccc",
    remoteSha256: null,
    reason: "HTTP 404 Not Found",
  };
  const lines = formatVerboseLines(result);
  assert.equal(lines.local, "  local:  ccc  broken.json");
  assert.equal(lines.remote, "  remote: <HTTP 404 Not Found>  broken.json");
});

// ── aggregateResults ──

test("aggregateResults counts matched, mismatched, and unavailable", () => {
  const results = [
    { key: "a.json", status: "match" },
    { key: "b.json", status: "match" },
    { key: "c.json", status: "mismatch" },
    { key: "d.json", status: "match" },
    { key: "e.json", status: "unavailable" },
  ];
  assert.deepEqual(aggregateResults(results), {
    matched: 3,
    mismatched: 1,
    unavailable: 1,
  });
});

test("aggregateResults handles empty array", () => {
  assert.deepEqual(aggregateResults([]), {
    matched: 0,
    mismatched: 0,
    unavailable: 0,
  });
});

test("aggregateResults handles all-OK", () => {
  const results = [1, 2, 3].map((i) => ({ key: `${i}.json`, status: "match" }));
  assert.deepEqual(aggregateResults(results), {
    matched: 3,
    mismatched: 0,
    unavailable: 0,
  });
});

test("formatFailureAdvice asks to publish only for mismatches", () => {
  const lines = formatFailureAdvice({
    matched: 2,
    mismatched: 1,
    unavailable: 0,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /pnpm run publish:json/);
  assert.doesNotMatch(lines[0], /network connectivity/);
});

test("formatFailureAdvice asks to re-run for unavailable files", () => {
  const lines = formatFailureAdvice({
    matched: 2,
    mismatched: 0,
    unavailable: 1,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /verify network connectivity and R2 availability/);
  assert.doesNotMatch(lines[0], /pnpm run publish:json/);
});

test("formatFailureAdvice includes both actions for mixed failures", () => {
  const lines = formatFailureAdvice({
    matched: 1,
    mismatched: 1,
    unavailable: 1,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /pnpm run publish:json/);
  assert.match(lines[1], /verify network connectivity and R2 availability/);
});

// ── dry-run does not make network calls ──

test("loadLocalJson does not call fetch", async () => {
  const readFile = mockReadFile({ "file.json": "{}" });
  // If loadLocalJson called fetch, this would throw because no fetchFn is provided
  const result = await loadLocalJson(document("file.json"), "/repo", readFile);
  assert.equal(result.key, "file.json");
  assert.equal(result.sha256.length, 64);
});

test("fetchRemoteJson is only called when --dry-run is false", async () => {
  // loadLocalJson (used in dry-run) does not invoke fetchRemoteJson.
  // This is an architectural test: the library separates load/fetch/check.
  let fetchCalled = false;
  const fetchFn = async () => {
    fetchCalled = true;
    const buf = Buffer.from("{}", "utf-8");
    return {
      ok: true,
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };

  const readFile = mockReadFile({ "file.json": "{}" });
  const local = await loadLocalJson(document("file.json"), "/repo", readFile);

  // At this point (dry-run path in CLI would stop here), fetch has NOT been called.
  assert.equal(fetchCalled, false);

  // Only when checkOne is called does actual fetch happen.
  const result = await checkOne(local, "pub.example.com", fetchFn);
  assert.equal(fetchCalled, true);
  assert.equal(result.status, "match");
});
