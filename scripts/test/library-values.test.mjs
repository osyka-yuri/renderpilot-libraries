import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDottedNumericVersions,
  latestRfc3339Timestamp,
  normalizeDottedNumericVersion,
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
