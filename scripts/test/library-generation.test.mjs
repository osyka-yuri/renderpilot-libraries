import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { libraryIndexFile, microsoftLibraryVendor, repoRoot } from "../catalog.mjs";
import { buildLibraryCatalogPlan } from "../lib/library-generation.mjs";
import { readJsonFileAsync } from "../lib/json.mjs";

test("catalog generation plan is deterministic and index-last", async () => {
  const [left, right] = await Promise.all([
    buildLibraryCatalogPlan(),
    buildLibraryCatalogPlan(),
  ]);
  assert.deepEqual(
    left.outputs.map(({ relativeFile }) => relativeFile),
    right.outputs.map(({ relativeFile }) => relativeFile),
  );
  assert.deepEqual(
    left.outputs.slice(0, -1).map(({ relativeFile }) => relativeFile),
    [...left.outputs.slice(0, -1).map(({ relativeFile }) => relativeFile)].sort(),
  );
  assert.equal(left.outputs.at(-1).relativeFile, libraryIndexFile);
  for (const [index, output] of left.outputs.entries()) {
    assert.equal(path.isAbsolute(output.file), true);
    assert.equal(output.body.equals(right.outputs[index].body), true);
    assert.equal(Object.isFrozen(output.value), true);
  }
  assert.ok(left.activeTransportObjectKeys.size > 0);
  assert.equal(Object.isFrozen(left.activeTransportObjectKeys), true);
  assert.equal("add" in left.activeTransportObjectKeys, false);
  const body = left.outputs[0].body;
  body[0] ^= 1;
  assert.equal(body.equals(left.outputs[0].body), false);
  const index = left.outputs.at(-1).value;
  assert.equal(
    index.vendors.some(({ vendor_id }) => vendor_id === "xiph"),
    false,
    "an empty staged vendor must not become a production index entry",
  );
  assert.ok(
    left.outputs.some(
      ({ relativeFile }) => relativeFile === "libraries/v1/vendors/xiph.json",
    ),
    "the staged snapshot remains generated and schema-checked",
  );
});

test("lock override rebuilds the Microsoft snapshot and index coherently", async () => {
  const baseline = await buildLibraryCatalogPlan();
  const lock = await readJsonFileAsync(
    path.join(repoRoot, microsoftLibraryVendor.lockFile),
  );
  const overridden = structuredClone(lock);
  overridden.releases[0].published_at = "2099-01-01T00:00:00.000Z";

  const plan = await buildLibraryCatalogPlan(
    new Map([[microsoftLibraryVendor.lockFile, overridden]]),
  );
  const microsoft = plan.outputs.find(
    ({ relativeFile }) => relativeFile === microsoftLibraryVendor.outputFile,
  );
  assert.equal(microsoft.value.generated_at, "2099-01-01T00:00:00.000Z");
  assert.notEqual(
    microsoft.body.toString("utf8"),
    baseline.outputs
      .find(({ relativeFile }) => relativeFile === microsoftLibraryVendor.outputFile)
      .body.toString("utf8"),
  );
  assert.notEqual(
    plan.outputs.at(-1).body.toString("utf8"),
    baseline.outputs.at(-1).body.toString("utf8"),
  );
});
