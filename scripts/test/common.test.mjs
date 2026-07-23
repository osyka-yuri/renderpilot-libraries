import assert from "node:assert/strict";
import test from "node:test";

import { mapConcurrent } from "../lib/common.mjs";

test("mapConcurrent bounds work and retains input order", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = await mapConcurrent([30, 20, 10, 0], 2, async (delay, index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `${index}:${delay}`;
  });

  assert.deepEqual(values, ["0:30", "1:20", "2:10", "3:0"]);
  assert.equal(maximumActive, 2);
  await assert.rejects(
    mapConcurrent([1], 0, async (value) => value),
    /concurrency/,
  );
});
