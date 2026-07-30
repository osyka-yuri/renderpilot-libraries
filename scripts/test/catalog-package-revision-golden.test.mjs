import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Hex } from "../lib/hash.mjs";
import { canonicalJson, packageRevisionInput } from "../lib/library-catalog.mjs";

const FIXTURE = new URL(
  "./fixtures/catalog-package-revision-v2.golden.json",
  import.meta.url,
);

test("V2 package revision matches the shared producer/consumer golden fixture", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const projected = packageRevisionInput(fixture.package, fixture.package.members);
  assert.deepEqual(projected, fixture.canonical_input);
  const canonical = canonicalJson(projected);
  assert.equal(canonical, fixture.canonical_json);
  assert.equal(sha256Hex(canonical), fixture.revision_sha256);
  assert.equal(fixture.package.revision_sha256, fixture.revision_sha256);
  assert.ok(Object.hasOwn(projected, "provenance"));
  assert.ok(!Object.hasOwn(projected, "source_build"));
});
