import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubReleaseTreeRefreshBatch } from "../lib/github-release-tree-refresh.mjs";

const VENDORS = Object.freeze([
  Object.freeze({ vendorId: "amd" }),
  Object.freeze({ vendorId: "intel" }),
  Object.freeze({ vendorId: "valve" }),
]);

for (const missingIndex of [0, VENDORS.length - 1]) {
  test(`signature backfill fails closed when vendor ${missingIndex + 1} has a missing release`, async () => {
    const discovered = [];
    let importerCalls = 0;
    let writeCalls = 0;
    await assert.rejects(
      () =>
        runGitHubReleaseTreeRefreshBatch(
          VENDORS,
          { mode: "backfill-signatures" },
          {
            async discoverVendor(vendor) {
              const index = VENDORS.indexOf(vendor);
              discovered.push(vendor.vendorId);
              return {
                vendor,
                missing: index === missingIndex ? [{ tag: "v-next" }] : [],
              };
            },
            async prepareVendor() {
              importerCalls += 1;
              return { changed: true };
            },
            async writeResults() {
              writeCalls += 1;
            },
            async reportResults() {},
          },
        ),
      /signature backfill requires every selected lock to be current/u,
    );
    assert.deepEqual(discovered, ["amd", "intel", "valve"]);
    assert.equal(importerCalls, 0);
    assert.equal(writeCalls, 0);
  });
}

test("refresh batch writes only after every vendor result is prepared", async () => {
  const events = [];
  await runGitHubReleaseTreeRefreshBatch(
    VENDORS,
    { mode: "write" },
    {
      async discoverVendor(vendor) {
        events.push(`discover:${vendor.vendorId}`);
        return { vendor, missing: [] };
      },
      async prepareVendor({ vendor }) {
        events.push(`prepare:${vendor.vendorId}`);
        return { vendor, changed: true, missingCount: 0 };
      },
      async writeResults(results) {
        events.push(`write:${results.length}`);
      },
      async reportResults() {
        events.push("report");
      },
    },
  );
  assert.deepEqual(events, [
    "discover:amd",
    "discover:intel",
    "discover:valve",
    "prepare:amd",
    "prepare:intel",
    "prepare:valve",
    "write:3",
    "report",
  ]);
});
