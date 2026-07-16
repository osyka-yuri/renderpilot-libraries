import assert from "node:assert/strict";
import test from "node:test";

import { md5Hex, sha256Hex } from "../lib/hash.mjs";

test("sha256Hex produces consistent digests", () => {
  const hex = sha256Hex(Buffer.from("hello world", "utf-8"));
  assert.equal(hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("sha256Hex of empty buffer is not all zeros", () => {
  const hex = sha256Hex(Buffer.alloc(0));
  assert.equal(hex.length, 64);
  assert.notEqual(hex, "0".repeat(64));
});

test("md5Hex produces consistent digests", () => {
  const hex = md5Hex(Buffer.from("hello world", "utf-8"));
  assert.equal(hex, "5eb63bbbe01eeed093cb22bb8f5acdc3");
});
