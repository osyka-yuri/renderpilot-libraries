import assert from "node:assert/strict";
import test from "node:test";

import { libraryVendors } from "../catalog.mjs";
import { assertLibraryVendorRegistry } from "../lib/library-source-adapters.mjs";

function registry() {
  return libraryVendors.map((vendor) => ({ ...vendor }));
}

function rejectsMutation(mutate, pattern) {
  const vendors = registry();
  mutate(vendors);
  assert.throws(() => assertLibraryVendorRegistry(vendors), pattern);
}

test("library registry accepts the committed provider contracts", () => {
  assert.equal(assertLibraryVendorRegistry(registry()).length, libraryVendors.length);
});

test("library registry rejects duplicate vendor, refresh, profile, and aggregate ids", () => {
  rejectsMutation((vendors) => {
    vendors[2].vendorId = vendors[1].vendorId;
  }, /vendorId collides/u);
  rejectsMutation((vendors) => {
    vendors[2].refreshName = vendors[1].refreshName;
  }, /refreshName collides/u);
  rejectsMutation((vendors) => {
    vendors[2].profile = vendors[1].profile;
  }, /profile collides/u);
  rejectsMutation((vendors) => {
    vendors[3].refreshName = "github";
  }, /aggregate refresh name github collides/u);
});

test("library registry rejects every repository-path collision class", () => {
  const pathFields = [
    ["sourceFile", 0],
    ["configFile", 1],
    ["lockFile", 1],
    ["overlayFile", 1],
    ["outputFile", 1],
  ];
  for (const [field, index] of pathFields) {
    rejectsMutation((vendors) => {
      vendors[2].outputFile = vendors[index][field];
    }, /collides/u);
  }
  rejectsMutation((vendors) => {
    vendors[1].configFile = vendors[1].lockFile;
  }, /collides/u);
});

test("library registry enforces source-kind fields and adapter availability", () => {
  rejectsMutation((vendors) => {
    delete vendors[0].sourceFile;
  }, /sourceFile/u);
  rejectsMutation((vendors) => {
    delete vendors[1].configFile;
  }, /configFile/u);
  rejectsMutation((vendors) => {
    delete vendors[1].profile;
  }, /profile/u);
  rejectsMutation((vendors) => {
    delete vendors[3].refreshName;
  }, /refreshName/u);
  rejectsMutation((vendors) => {
    vendors[1].sourceKind = "missing-adapter";
  }, /unsupported generated library source/u);
});

test("library registry requires source-appropriate safe concurrency", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    rejectsMutation((vendors) => {
      vendors[1].refreshConcurrency = value;
    }, /positive safe integer/u);
  }
  rejectsMutation((vendors) => {
    vendors[3].refreshConcurrency = 1;
  }, /does not accept refreshConcurrency/u);
});

test("library registry rejects unsafe and non-normalized repository paths", () => {
  for (const value of [
    "",
    "../lock.json",
    "/absolute.json",
    "C:/outside.json",
    "C:outside.json",
    "a\\b.json",
    "a//b.json",
  ]) {
    rejectsMutation((vendors) => {
      vendors[1].lockFile = value;
    }, /normalized relative repository path/u);
  }
});
