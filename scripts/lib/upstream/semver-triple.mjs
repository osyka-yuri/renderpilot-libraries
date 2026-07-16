// Dotted-triple (X.Y.Z) ordering helpers for upstream version pins.

import { SEMVER_RE, assertSemver } from "../validators.mjs";

/**
 * Compares two dotted triples. Returns negative if `a < b`, 0 if equal,
 * positive if `a > b`.
 */
export function compareSemver(a, b) {
  const left = assertSemver(a, "semver a").split(".").map(Number);
  const right = assertSemver(b, "semver b").split(".").map(Number);

  for (let i = 0; i < 3; i += 1) {
    const delta = left[i] - right[i];
    if (delta !== 0) return delta;
  }
  return 0;
}

/** True when `candidate` is strictly greater than `current`. */
export function isNewerSemver(candidate, current) {
  return compareSemver(candidate, current) > 0;
}

/**
 * Returns the maximum dotted triple from `versions`, ignoring non-matching
 * values. Returns `null` when no valid versions are present.
 */
export function maxSemver(versions) {
  let best = null;

  for (const value of versions) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!SEMVER_RE.test(trimmed)) continue;
    if (best === null || compareSemver(trimmed, best) > 0) {
      best = trimmed;
    }
  }

  return best;
}

/**
 * Parses a Git tag into a dotted triple.
 * Accepts `v6.7.3` (common) and bare `6.7.3`.
 */
export function versionFromGitTag(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (SEMVER_RE.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("v")) {
    const version = trimmed.slice(1);
    return SEMVER_RE.test(version) ? version : null;
  }
  return null;
}
