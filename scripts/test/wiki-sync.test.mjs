import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageError } from "../lib/common.mjs";
import { writeFormattedJsonFile, writeJsonFileAtomic } from "../lib/json.mjs";
import { fetchWikiMarkdown, jsonChanged, parseWikiSyncArgs } from "../lib/wiki-sync.mjs";

test("parseWikiSyncArgs accepts check aliases and rejects unknown arguments", () => {
  assert.deepEqual(parseWikiSyncArgs([]), { check: false, help: false });
  assert.deepEqual(parseWikiSyncArgs(["--dry-run", "--help"]), { check: true, help: true });
  assert.throws(() => parseWikiSyncArgs(["--unexpected"]), UsageError);
});

test("fetchWikiMarkdown adds a user agent and returns text", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders;
  globalThis.fetch = async (_url, options) => {
    observedHeaders = options.headers;
    return new Response("# Wiki", { status: 200 });
  };

  try {
    assert.equal(await fetchWikiMarkdown("https://example.test/wiki"), "# Wiki");
    assert.equal(observedHeaders["User-Agent"], "renderpilot-libraries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("atomic JSON writers replace the target with complete JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-sync-"));
  const rawPath = path.join(directory, "raw.json");
  const formattedPath = path.join(directory, "formatted.json");

  try {
    await writeJsonFileAtomic(rawPath, { value: 1 });
    await writeFormattedJsonFile(formattedPath, { value: [1, 2] });
    assert.deepEqual(JSON.parse(await readFile(rawPath, "utf8")), { value: 1 });
    assert.deepEqual(JSON.parse(await readFile(formattedPath, "utf8")), { value: [1, 2] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("jsonChanged distinguishes semantic JSON drift", () => {
  assert.equal(jsonChanged({ value: 1 }, { value: 1 }), false);
  assert.equal(jsonChanged({ value: 1 }, { value: 2 }), true);
});
