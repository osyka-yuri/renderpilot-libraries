import assert from "node:assert/strict";
import test from "node:test";

import { checkUrlHealth } from "../lib/upstream/check-url-health.mjs";
import { CHECK_STATUS } from "../lib/upstream/result.mjs";

function mockFetch(status, { ok = status >= 200 && status < 300, headers = {} } = {}) {
  return async () => ({
    ok,
    status,
    statusText: "x",
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    body: { cancel: () => {} },
  });
}

test("checkUrlHealth returns ok on HTTP 200", async () => {
  const result = await checkUrlHealth("pin", "https://example.test/a", {
    fetchFn: mockFetch(200),
    missingStatus: CHECK_STATUS.hard,
  });
  assert.equal(result.status, CHECK_STATUS.ok);
  assert.match(result.detail, /HTTP 200/);
});

test("checkUrlHealth maps non-ok to missingStatus", async () => {
  const result = await checkUrlHealth("pin", "https://example.test/a", {
    fetchFn: mockFetch(404, { ok: false }),
    missingStatus: CHECK_STATUS.hard,
  });
  assert.equal(result.status, CHECK_STATUS.hard);
  assert.match(result.detail, /HTTP 404/);
});

test("checkUrlHealth maps network errors to soft by default", async () => {
  const result = await checkUrlHealth("pin", "https://example.test/a", {
    fetchFn: async () => {
      throw new Error("ECONNRESET");
    },
    missingStatus: CHECK_STATUS.hard,
  });
  assert.equal(result.status, CHECK_STATUS.soft);
  assert.match(result.detail, /ECONNRESET|request failed/i);
});
