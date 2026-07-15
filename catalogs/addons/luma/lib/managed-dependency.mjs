// Normalization for Luma managed external dependencies (currently dgVoodoo2).
// Kept separate from the catalogue builder so install/config/source rules stay
// in one focused module.

import {
  assertPlainObject,
  requiredNonEmptyString,
} from "../../../../scripts/lib/common.mjs";
import {
  DIRECTX_GRAPHICS_APIS,
  LOWERCASE_SHA256_RE,
  RESHADE_PROXY_DLLS,
  assertSemver,
  assertSingleLineString,
  assertOptionalNonEmptyStringArray,
  assertAllowedValue,
  assertAllowedValues,
  assertUniqueStringValues,
} from "../../../../scripts/lib/validators.mjs";

const EXTERNAL_REQUIREMENT_KIND = "dgvoodoo2";
const WINDOWS_FILE_FORBIDDEN_RE = /[<>:"/\\|?*\x00-\x1f]/u;

export function normalizeExternalRequirement(value, context) {
  if (value === undefined) {
    return null;
  }

  assertPlainObject(value, context);

  const kind = requiredNonEmptyString(value.kind, `${context}.kind`);
  if (kind !== EXTERNAL_REQUIREMENT_KIND) {
    throw new Error(`${context}.kind must be "${EXTERNAL_REQUIREMENT_KIND}"`);
  }

  const version = assertSemver(
    requiredNonEmptyString(value.version, `${context}.version`),
    `${context}.version`,
  );

  const source = normalizeManagedSource(value.source, `${context}.source`);
  const installMap = normalizeInstallMap(value.install_map, `${context}.install_map`);
  const configFile = normalizeGameDirectoryFile(
    value.config_file,
    `${context}.config_file`,
  );
  ensureNoInstallTargetConflict(
    [...installMap.map((entry) => entry.dest), configFile],
    `${context}.install_map/config_file`,
  );

  return {
    kind,
    version,
    accepted_detected_apis: normalizeAcceptedDetectedApis(
      value.accepted_detected_apis,
      `${context}.accepted_detected_apis`,
    ),
    reshade_proxy_dll: normalizeExternalProxyDll(
      value.reshade_proxy_dll,
      `${context}.reshade_proxy_dll`,
    ),
    source,
    install_map: installMap,
    config_file: configFile,
    config: normalizeExternalConfig(value.config, `${context}.config`),
  };
}

function normalizeAcceptedDetectedApis(value, context) {
  const apis = assertOptionalNonEmptyStringArray(value, context);
  if (apis.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }
  assertAllowedValues(apis, DIRECTX_GRAPHICS_APIS, context);
  return assertUniqueStringValues(apis, context);
}

function normalizeExternalProxyDll(value, context) {
  return assertAllowedValue(
    requiredNonEmptyString(value, context).toLowerCase(),
    RESHADE_PROXY_DLLS,
    context,
  );
}

function normalizeExternalConfig(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  return value.map((section, index) =>
    normalizeExternalConfigSection(section, `${context}[${index}]`),
  );
}

function normalizeExternalConfigSection(value, context) {
  assertPlainObject(value, context);
  return {
    section: assertSingleLineString(value.section, `${context}.section`),
    entries: normalizeExternalConfigEntries(value.entries, `${context}.entries`),
  };
}

function normalizeExternalConfigEntries(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  return value.map((entry, index) =>
    normalizeExternalConfigEntry(entry, `${context}[${index}]`),
  );
}

function normalizeExternalConfigEntry(value, context) {
  assertPlainObject(value, context);
  const entry = {
    key: assertSingleLineString(value.key, `${context}.key`),
    value: assertSingleLineString(value.value, `${context}.value`),
  };

  if (value.comment !== undefined) {
    throw new Error(
      `${context}.comment is not supported in managed config entries; comments belong in authoring documentation`,
    );
  }

  return entry;
}

function normalizeManagedSource(value, context) {
  assertPlainObject(value, context);

  const url = requiredNonEmptyString(value.url, `${context}.url`);
  if (!url.startsWith("https://")) {
    throw new Error(`${context}.url must be an HTTPS URL`);
  }

  return { url, ...assertPinnedBlob(value, context) };
}

function normalizeInstallMap(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }

  const entries = value.map((entry, index) =>
    normalizeInstallMapEntry(entry, `${context}[${index}]`),
  );
  ensureUniqueBy(entries, (entry) => entry.source.toLowerCase(), `${context}.source`);
  ensureUniqueBy(entries, (entry) => entry.dest.toLowerCase(), `${context}.dest`);
  return entries;
}

function normalizeInstallMapEntry(value, context) {
  assertPlainObject(value, context);

  const source = normalizeArchivePath(
    requiredNonEmptyString(value.source, `${context}.source`),
    `${context}.source`,
  );
  const dest = normalizeGameDirectoryFile(
    requiredNonEmptyString(value.dest, `${context}.dest`),
    `${context}.dest`,
  );

  return { source, dest, ...assertPinnedBlob(value, context) };
}

/** Validates a content-addressed blob: lowercase SHA-256 + positive size. */
function assertPinnedBlob(value, context) {
  const sha256 = requiredNonEmptyString(value.sha256, `${context}.sha256`).toLowerCase();
  if (!LOWERCASE_SHA256_RE.test(sha256)) {
    throw new Error(`${context}.sha256 must be a 64-character hex string`);
  }

  const size = Number(value.size);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`${context}.size must be a positive integer`);
  }

  return { sha256, size };
}

function normalizeArchivePath(value, context) {
  const path = assertSingleLineString(value, context);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${context} must be a safe relative archive path`);
  }
  return path;
}

export function normalizeGameDirectoryFile(value, context) {
  const file = assertSingleLineString(value, context);
  if (file === "." || file === ".." || WINDOWS_FILE_FORBIDDEN_RE.test(file)) {
    throw new Error(`${context} must be a safe game-directory filename`);
  }
  return file;
}

function ensureUniqueBy(items, keyOf, context) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      throw new Error(`${context} contains duplicate "${key}"`);
    }
    seen.add(key);
  }
}

function ensureNoInstallTargetConflict(destinations, context) {
  ensureUniqueBy(destinations, (value) => value.toLowerCase(), context);
}
