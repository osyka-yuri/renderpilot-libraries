import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDottedNumericVersions,
  comparePackageVersions,
  latestRfc3339Timestamp,
  normalizeDottedNumericVersion,
  normalizePackageVersion,
  parsePackageVersion,
  normalizeRfc3339Timestamp,
} from "../lib/library-values.mjs";

test("RFC 3339 helpers normalize offsets and select the latest instant", () => {
  assert.equal(
    normalizeRfc3339Timestamp("2024-01-02T03:04:05+03:00", "fixture"),
    "2024-01-02T00:04:05.000Z",
  );
  assert.equal(
    latestRfc3339Timestamp(["2024-01-02T03:04:05+03:00", "2024-01-02T01:04:05Z"]),
    "2024-01-02T01:04:05.000Z",
  );
  assert.equal(latestRfc3339Timestamp([]), "1970-01-01T00:00:00.000Z");
});

test("package versions normalize and order actual Microsoft preview suffixes", () => {
  assert.deepEqual(parsePackageVersion("01.0721.2-PREVIEW+build.sha"), {
    canonical: "1.721.2-preview",
    identity: "1.721.2-preview",
    numericCore: [1n, 721n, 2n],
    prerelease: ["preview"],
    channel: "preview",
  });
  assert.equal(normalizePackageVersion("01.0721.2-PREVIEW"), "1.721.2-preview");
  assert.equal(comparePackageVersions("1.721.2-preview", "1.721.2"), -1);
  assert.equal(
    comparePackageVersions("1.4.0-preview2-2606.904", "1.4.0-preview1-2603.504"),
    1,
  );
  assert.equal(
    comparePackageVersions("1.8.2404.55-mesh-nodes-preview", "1.8.2306.6-preview"),
    1,
  );
  assert.equal(
    comparePackageVersions(
      "1.0.0-preview.18446744073709551615",
      "1.0.0-preview.9999999999999999999",
    ),
    1,
  );
  for (const value of ["1", "1.0", "1.0.0", "1.0.0.0", "01.00.000+build.7"]) {
    assert.equal(normalizePackageVersion(value), "1.0.0");
  }
  assert.equal(normalizePackageVersion("1.2.3.4-preview+build.sha"), "1.2.3.4-preview");
});

test("package version validation rejects malformed and non-SemVer identities", () => {
  for (const value of [
    "1.2.3.4.5",
    "1.2-preview..1",
    "1.2-preview+",
    "1.2-",
    "1.2-préview",
    "1.2-preview.01",
  ]) {
    assert.throws(() => normalizePackageVersion(value), /NuGet\/SemVer2|non-canonical/u);
  }
});

test("RFC 3339 helper rejects invalid calendar and time fields", () => {
  for (const value of [
    "2023-02-29T00:00:00Z",
    "2024-13-01T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:60:00Z",
    "2024-01-01",
  ]) {
    assert.throws(() => normalizeRfc3339Timestamp(value, "fixture"), /RFC 3339 timestamp/u);
  }
});

test("dotted numeric helpers share canonical u64 comparison semantics", () => {
  assert.equal(normalizeDottedNumericVersion("1.2.0.0"), "1.2");
  assert.equal(
    compareDottedNumericVersions("1.18446744073709551614", "1.18446744073709551615"),
    -1,
  );
  assert.throws(
    () => normalizeDottedNumericVersion("1.18446744073709551616"),
    /dotted numeric version/u,
  );
  assert.throws(() => normalizeDottedNumericVersion("1.02"), /dotted numeric version/u);
});
