const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const NUMERIC_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
const PACKAGE_VERSION_PATTERN =
  /^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_U64 = 18_446_744_073_709_551_615n;
const UNIX_EPOCH = "1970-01-01T00:00:00.000Z";

export function normalizeRfc3339Timestamp(value, context = "timestamp") {
  const match = typeof value === "string" ? RFC3339_TIMESTAMP_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error(`${context} must be an RFC 3339 timestamp`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[7] === undefined ? null : Number(match[7]);
  const offsetMinute = match[8] === undefined ? null : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHour !== null && (offsetHour > 23 || offsetMinute > 59))
  ) {
    throw new Error(`${context} must be an RFC 3339 timestamp`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error(`${context} must be an RFC 3339 timestamp`);
  }
  return timestamp.toISOString();
}

export function latestRfc3339Timestamp(values, context = "timestamp") {
  if (!Array.isArray(values)) {
    throw new Error(`${context} values must be an array`);
  }
  if (values.length === 0) return UNIX_EPOCH;
  return values
    .map((value) => normalizeRfc3339Timestamp(value, context))
    .sort()
    .at(-1);
}

export function dottedNumericVersionParts(value, context = "version") {
  if (
    typeof value !== "string" ||
    !NUMERIC_VERSION_PATTERN.test(value) ||
    value.split(".").some((segment) => BigInt(segment) > MAX_U64)
  ) {
    throw new Error(`${context} must be a dotted numeric version`);
  }
  return value.split(".").map(BigInt);
}

export function normalizeDottedNumericVersion(value, context = "version") {
  const parts = dottedNumericVersionParts(value, context);
  while (parts.length > 1 && parts.at(-1) === 0n) parts.pop();
  return parts.join(".");
}

export function compareDottedNumericVersions(left, right) {
  const leftParts = dottedNumericVersionParts(left, "left version");
  const rightParts = dottedNumericVersionParts(right, "right version");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

/**
 * Parses a NuGet/SemVer2 version once and exposes every derived identity used
 * by the catalog. Build metadata is accepted on upstream input but deliberately
 * omitted from the canonical persisted identity.
 */
export function parsePackageVersion(value, context = "package version") {
  const match = typeof value === "string" ? PACKAGE_VERSION_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error(`${context} must be a NuGet/SemVer2 package version`);
  }

  const numericCore = match[1].split(".").map((segment) => BigInt(segment));
  if (numericCore.some((segment) => segment > MAX_U64)) {
    throw new Error(`${context} contains a numeric segment larger than u64`);
  }

  const prerelease = match[2]?.toLowerCase().split(".") ?? null;
  if (
    prerelease?.some(
      (identifier) =>
        identifier.length > 1 && identifier.startsWith("0") && /^\d+$/u.test(identifier),
    )
  ) {
    throw new Error(`${context} has a non-canonical numeric prerelease identifier`);
  }

  while (numericCore.length < 3) numericCore.push(0n);
  if (numericCore.length === 4 && numericCore[3] === 0n) numericCore.pop();
  const canonicalCore = numericCore.join(".");
  const canonical =
    prerelease === null ? canonicalCore : `${canonicalCore}-${prerelease.join(".")}`;

  return Object.freeze({
    canonical,
    identity: canonical,
    numericCore: Object.freeze(numericCore),
    prerelease: prerelease === null ? null : Object.freeze(prerelease),
    channel: prerelease === null ? "stable" : "preview",
  });
}

export function normalizePackageVersion(value, context = "package version") {
  return parsePackageVersion(value, context).canonical;
}

export function packageVersionNumericCore(value, context = "package version") {
  return parsePackageVersion(value, context).numericCore.join(".");
}

export function packageVersionIdentity(value, context = "package version") {
  return parsePackageVersion(value, context).identity;
}

export function comparePackageVersions(left, right) {
  const leftVersion = parsePackageVersion(left, "left package version");
  const rightVersion = parsePackageVersion(right, "right package version");
  const length = Math.max(leftVersion.numericCore.length, rightVersion.numericCore.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.numericCore[index] ?? 0n;
    const rightPart = rightVersion.numericCore[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function comparePrerelease(left, right) {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      if (leftIdentifier === rightIdentifier) return 0;
      return leftIdentifier === undefined ? -1 : 1;
    }
    const ordering = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (ordering !== 0) return ordering;
  }
  return 0;
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
