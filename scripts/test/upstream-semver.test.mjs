import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSemver,
  isNewerSemver,
  maxSemver,
  versionFromGitTag,
} from "../lib/upstream/semver-triple.mjs";

test("compareSemver orders dotted triples", () => {
  assert.ok(compareSemver("1.0.0", "1.0.1") < 0);
  assert.ok(compareSemver("2.0.0", "1.9.9") > 0);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

test("isNewerSemver is strict", () => {
  assert.equal(isNewerSemver("6.7.3", "6.7.2"), true);
  assert.equal(isNewerSemver("6.7.2", "6.7.2"), false);
  assert.equal(isNewerSemver("6.7.1", "6.7.2"), false);
});

test("maxSemver ignores invalid entries", () => {
  assert.equal(maxSemver(["1.0.0", "nope", "1.2.0", null, "1.1.9"]), "1.2.0");
  assert.equal(maxSemver([]), null);
});

test("versionFromGitTag accepts v-prefix and bare triples", () => {
  assert.equal(versionFromGitTag("v6.7.3"), "6.7.3");
  assert.equal(versionFromGitTag("6.7.3"), "6.7.3");
  assert.equal(versionFromGitTag("release-1"), null);
});
