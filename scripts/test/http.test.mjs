import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TIMEOUT_MS,
  HttpStatusError,
  PAYLOAD_TIMEOUT_MS,
  STEAM_TIMEOUT_MS,
  UpstreamNetworkError,
  USER_AGENT,
  WIKI_TIMEOUT_MS,
  cancelResponseBody,
  fetchJsonWithTimeout,
  fetchWithTimeout,
  probeUrl,
} from "../lib/http.mjs";

test("fetchWithTimeout sets User-Agent and forwards method", async () => {
  let observed;
  const fetchFn = async (url, options) => {
    observed = { url, options };
    return new Response("ok", { status: 200 });
  };

  const response = await fetchWithTimeout("https://example.test/x", {
    fetchFn,
    method: "HEAD",
    timeoutMs: 5_000,
  });

  assert.equal(response.status, 200);
  assert.equal(observed.url, "https://example.test/x");
  assert.equal(observed.options.method, "HEAD");
  assert.equal(observed.options.headers["User-Agent"], USER_AGENT);
  assert.ok(observed.options.signal);
});

test("fetchWithTimeout maps abort/timeout to UpstreamNetworkError", async () => {
  const fetchFn = async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    throw err;
  };

  await assert.rejects(
    () => fetchWithTimeout("https://example.test/timeout", { fetchFn, timeoutMs: 1 }),
    (error) => {
      assert.ok(error instanceof UpstreamNetworkError);
      assert.match(error.message, /timed out after 1ms/);
      return true;
    },
  );
});

test("fetchWithTimeout maps other failures to UpstreamNetworkError", async () => {
  const fetchFn = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    () => fetchWithTimeout("https://example.test/down", { fetchFn }),
    (error) => {
      assert.ok(error instanceof UpstreamNetworkError);
      assert.match(error.message, /request failed for https:\/\/example\.test\/down/);
      return true;
    },
  );
});

test("fetchJsonWithTimeout returns parsed JSON", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const data = await fetchJsonWithTimeout("https://example.test/json", { fetchFn });
  assert.deepEqual(data, { ok: true });
});

test("fetchJsonWithTimeout throws HttpStatusError on non-OK", async () => {
  const fetchFn = async () =>
    new Response("nope", { status: 503, statusText: "Unavailable" });

  await assert.rejects(
    () => fetchJsonWithTimeout("https://example.test/json", { fetchFn }),
    (error) => {
      assert.ok(error instanceof HttpStatusError);
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("probeUrl marks redirectOk 3xx with Location as ok", async () => {
  const fetchFn = async () =>
    new Response(null, {
      status: 302,
      headers: { Location: "https://cdn.example.test/file" },
    });

  const result = await probeUrl("https://example.test/redirect", {
    fetchFn,
    redirectOk: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 302);
  assert.equal(result.location, "https://cdn.example.test/file");
});

test("probeUrl cancels response body", async () => {
  let cancelled = false;
  const body = {
    cancel() {
      cancelled = true;
    },
  };
  const fetchFn = async () => {
    const response = new Response("payload", { status: 200 });
    Object.defineProperty(response, "body", { value: body });
    return response;
  };

  await probeUrl("https://example.test/head", { fetchFn, method: "GET" });
  assert.equal(cancelled, true);
});

test("cancelResponseBody ignores missing body", () => {
  assert.doesNotThrow(() => cancelResponseBody(null));
  assert.doesNotThrow(() => cancelResponseBody({}));
});

test("timeout constants are positive and ordered", () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
  assert.ok(STEAM_TIMEOUT_MS > 0);
  assert.ok(STEAM_TIMEOUT_MS <= DEFAULT_TIMEOUT_MS);
  assert.ok(WIKI_TIMEOUT_MS >= DEFAULT_TIMEOUT_MS);
  assert.ok(PAYLOAD_TIMEOUT_MS >= DEFAULT_TIMEOUT_MS);
});
