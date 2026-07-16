import assert from "node:assert/strict";
import test from "node:test";

import {
  collectManagedDependencySourceUrls,
  pinnedDependencyCheckId,
  checkPinnedDependencyUrls,
} from "../lib/upstream/pinned-deps.mjs";
import { CHECK_STATUS } from "../lib/upstream/result.mjs";

test("collectManagedDependencySourceUrls returns unique sorted urls", () => {
  const urls = collectManagedDependencySourceUrls({
    games: [
      {
        requirements: {
          managed_dependency: { source: { url: "https://example.test/b.zip" } },
        },
      },
      {
        requirements: {
          managed_dependency: { source: { url: "https://example.test/a.zip" } },
        },
      },
      {
        requirements: {
          managed_dependency: { source: { url: "https://example.test/a.zip" } },
        },
      },
      { requirements: {} },
    ],
  });

  assert.deepEqual(urls, ["https://example.test/a.zip", "https://example.test/b.zip"]);
});

test("collectManagedDependencySourceUrls tolerates missing shape", () => {
  assert.deepEqual(collectManagedDependencySourceUrls(null), []);
  assert.deepEqual(collectManagedDependencySourceUrls({}), []);
});

test("pinnedDependencyCheckId is stable", () => {
  assert.equal(
    pinnedDependencyCheckId("https://example.test/a.zip"),
    "pinned.dependency:https://example.test/a.zip",
  );
});

test("checkPinnedDependencyUrls maps probe outcomes", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("missing")) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 200 });
  };

  const results = await checkPinnedDependencyUrls(
    ["https://example.test/ok.zip", "https://example.test/missing.zip"],
    { fetchFn, concurrency: 2 },
  );

  assert.equal(results.length, 2);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(
    byId["pinned.dependency:https://example.test/ok.zip"].status,
    CHECK_STATUS.ok,
  );
  assert.equal(
    byId["pinned.dependency:https://example.test/missing.zip"].status,
    CHECK_STATUS.hard,
  );
});
