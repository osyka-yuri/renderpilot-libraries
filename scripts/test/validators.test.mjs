import test from "node:test";
import assert from "node:assert/strict";

import {
  SEMVER_RE,
  DIRECTX_GRAPHICS_APIS,
  RESHADE_PROXY_DLLS,
  assertSemver,
  assertSingleLineString,
  assertOptionalSingleLineString,
  assertNonEmptyStringArray,
  assertOptionalNonEmptyStringArray,
  assertUniqueStringValues,
  assertAllowedValue,
  assertAllowedValues,
} from "../lib/validators.mjs";

// ── semver ──

test("assertSemver accepts valid dotted triples", () => {
  assert.equal(assertSemver("1.0.0", "version"), "1.0.0");
  assert.equal(assertSemver("0.0.0", "version"), "0.0.0");
  assert.equal(assertSemver("10.20.300", "version"), "10.20.300");
  assert.equal(assertSemver(" 2.87.3 ", "version"), "2.87.3");
});

test("assertSemver rejects non-semver strings", () => {
  assert.throws(() => assertSemver("1.0", "version"), /dotted triple/);
  assert.throws(() => assertSemver("v1.0.0", "version"), /dotted triple/);
  assert.throws(() => assertSemver("1.0.0-beta", "version"), /dotted triple/);
  assert.throws(() => assertSemver("", "version"), /dotted triple/);
  assert.throws(() => assertSemver("not a version", "version"), /dotted triple/);
});

test("SEMVER_RE matches valid and rejects invalid", () => {
  assert.ok(SEMVER_RE.test("1.0.0"));
  assert.ok(SEMVER_RE.test("10.999.1"));
  assert.equal(SEMVER_RE.test("1.0"), false);
  assert.equal(SEMVER_RE.test("v1.0.0"), false);
  assert.equal(SEMVER_RE.test("1.0.0-alpha"), false);
});

// ── single-line strings ──

test("assertSingleLineString accepts clean strings", () => {
  assert.equal(assertSingleLineString("hello", "field"), "hello");
  assert.equal(assertSingleLineString("  trimmed  ", "field"), "trimmed");
  assert.equal(assertSingleLineString("key=value", "field"), "key=value");
});

test("assertSingleLineString rejects multiline config values", () => {
  assert.throws(() => assertSingleLineString("line1\nline2", "field"), /single-line/);
  assert.throws(() => assertSingleLineString("line1\r\nline2", "field"), /single-line/);
  assert.throws(() => assertSingleLineString("", "field"), /non-empty/);
  assert.throws(() => assertSingleLineString("   ", "field"), /non-empty/);
});

test("assertOptionalSingleLineString returns null for missing values", () => {
  assert.equal(assertOptionalSingleLineString(undefined, "field"), null);
  assert.equal(assertOptionalSingleLineString(null, "field"), null);
  assert.equal(assertOptionalSingleLineString("value", "field"), "value");
});

// ── string arrays ──

test("assertNonEmptyStringArray validates and trims", () => {
  assert.deepEqual(assertNonEmptyStringArray(["a", "b"], "arr"), ["a", "b"]);
  assert.deepEqual(assertNonEmptyStringArray(["  x  "], "arr"), ["x"]);
});

test("assertNonEmptyStringArray rejects invalid inputs", () => {
  assert.throws(() => assertNonEmptyStringArray([], "arr"), /non-empty array/);
  assert.throws(() => assertNonEmptyStringArray(["a", ""], "arr"), /non-empty string/);
  assert.throws(() => assertNonEmptyStringArray(["a", 123], "arr"), /non-empty string/);
});

test("assertOptionalNonEmptyStringArray returns empty array for missing values", () => {
  assert.deepEqual(assertOptionalNonEmptyStringArray(undefined, "arr"), []);
  assert.deepEqual(assertOptionalNonEmptyStringArray(null, "arr"), []);
  assert.deepEqual(assertOptionalNonEmptyStringArray(["x"], "arr"), ["x"]);
});

// ── uniqueness ──

test("assertUniqueStringValues passes for unique values", () => {
  assert.deepEqual(assertUniqueStringValues(["a", "b", "c"], "arr"), ["a", "b", "c"]);
});

test("assertUniqueStringValues rejects duplicate APIs", () => {
  assert.throws(
    () => assertUniqueStringValues(["D3D9", "D3D11", "D3D9"], "apis"),
    /duplicate "D3D9"/,
  );
});

// ── allowlists ──

test("assertAllowedValue handles supported values", () => {
  assert.equal(assertAllowedValue("D3D9", DIRECTX_GRAPHICS_APIS, "api"), "D3D9");
  assert.equal(assertAllowedValue("dxgi.dll", RESHADE_PROXY_DLLS, "dll"), "dxgi.dll");
  assert.equal(assertAllowedValue("d3d12.dll", RESHADE_PROXY_DLLS, "dll"), "d3d12.dll");
});

test("assertAllowedValue rejects unsupported values", () => {
  assert.throws(
    () => assertAllowedValue("Vulkan", DIRECTX_GRAPHICS_APIS, "api"),
    /must be one of/,
  );
  assert.throws(
    () => assertAllowedValue("d3d8.dll", RESHADE_PROXY_DLLS, "dll"),
    /must be one of/,
  );
});

test("assertAllowedValues validates every item in an array", () => {
  assert.deepEqual(assertAllowedValues(["D3D9", "D3D11"], DIRECTX_GRAPHICS_APIS, "apis"), [
    "D3D9",
    "D3D11",
  ]);
  assert.throws(
    () => assertAllowedValues(["D3D9", "Vulkan"], DIRECTX_GRAPHICS_APIS, "apis"),
    /must be one of/,
  );
});

// ── allowlist constants ──

test("DIRECTX_GRAPHICS_APIS contains only DirectX APIs", () => {
  assert.deepEqual([...DIRECTX_GRAPHICS_APIS].sort(), ["D3D10", "D3D11", "D3D12", "D3D9"]);
});

test("RESHADE_PROXY_DLLS contains only valid ReShade proxy slots", () => {
  assert.deepEqual([...RESHADE_PROXY_DLLS].sort(), [
    "d3d10.dll",
    "d3d11.dll",
    "d3d12.dll",
    "d3d9.dll",
    "dxgi.dll",
  ]);
});
