import path from "node:path";

import { buildMicrosoftVendorSource } from "./microsoft-nuget.mjs";
import { buildGitHubReleaseTreeVendorSource } from "./github-release-tree.mjs";
import { generatedLibrarySourceKind } from "./library-source-kinds.mjs";

const BUILDERS = Object.freeze({
  nuget: Object.freeze({
    build: ({ lock, config }) => buildMicrosoftVendorSource(lock, config),
  }),
  "github-release-tree": Object.freeze({
    build: ({ lock, config, overlay }) =>
      buildGitHubReleaseTreeVendorSource(lock, config, overlay),
  }),
});

export function buildGeneratedLibraryVendorSource(vendor, inputs) {
  generatedLibrarySourceKind(vendor.sourceKind);
  const adapter = BUILDERS[vendor.sourceKind];
  if (!adapter) throw new Error(`no source builder for ${vendor.sourceKind}`);
  assertVendorProfile(vendor, inputs.config);
  return adapter.build(inputs);
}

export function generatedLibraryRefreshProvider(vendor) {
  const sourceKind = generatedLibrarySourceKind(vendor.sourceKind);
  if (!vendor.refreshName) {
    throw new Error(`${vendor.vendorId}: generated source has no refresh contract`);
  }
  const { script, passVendor, allowBackfillSignatures, allowProduct } = sourceKind.refresh;
  return Object.freeze({
    script,
    allowBackfillSignatures,
    allowProduct,
    argsPrefix: passVendor
      ? Object.freeze([`--vendor=${vendor.vendorId}`])
      : Object.freeze([]),
  });
}

export function generatedLibraryAggregateRefreshProviders(vendors) {
  assertLibraryVendorRegistry(vendors);
  const providers = new Map();
  for (const vendor of vendors) {
    if (vendor.sourceKind === "curated") continue;
    const refresh = generatedLibrarySourceKind(vendor.sourceKind).refresh;
    if (!refresh.aggregateName || providers.has(refresh.aggregateName)) continue;
    const { aggregateName, script, allowBackfillSignatures, allowProduct } = refresh;
    providers.set(
      aggregateName,
      Object.freeze({
        script,
        allowBackfillSignatures,
        allowProduct,
        argsPrefix: Object.freeze(["--all"]),
      }),
    );
  }
  return Object.freeze(Object.fromEntries(providers));
}

export function assertGeneratedLibraryVendorAdapters(vendors) {
  for (const vendor of vendors) {
    const sourceKind = generatedLibrarySourceKind(vendor.sourceKind);
    if (!BUILDERS[vendor.sourceKind]) {
      throw new Error(`${vendor.vendorId}: no source builder for ${vendor.sourceKind}`);
    }
    if (sourceKind.requiresProfile && typeof vendor.profile !== "string") {
      throw new Error(`${vendor.vendorId}: generated source profile is required`);
    }
  }
}

const REGISTRY_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const REPOSITORY_PATH_KEYS = Object.freeze([
  "sourceFile",
  "configFile",
  "lockFile",
  "overlayFile",
  "outputFile",
]);

function registryId(value, context) {
  if (typeof value !== "string" || !REGISTRY_ID_PATTERN.test(value)) {
    throw new Error(`${context} must be a lowercase registry id`);
  }
  return value;
}

function repositoryPath(value, context) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    path.posix.isAbsolute(value) ||
    path.win32.parse(value).root !== "" ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${context} must be a normalized relative repository path`);
  }
  return value;
}

function claimUnique(seen, value, context) {
  const key = value.toLowerCase();
  if (seen.has(key)) {
    throw new Error(`${context} collides with ${seen.get(key)}`);
  }
  seen.set(key, context);
}

export function assertLibraryVendorRegistry(vendors) {
  if (!Array.isArray(vendors) || vendors.length === 0) {
    throw new Error("library vendor registry must be a non-empty array");
  }

  const vendorIds = new Map();
  const refreshNames = new Map();
  const profiles = new Map();
  const paths = new Map();
  const aggregateNames = new Set();

  for (const [index, vendor] of vendors.entries()) {
    const context = `library vendor registry entry ${index}`;
    const vendorId = registryId(vendor?.vendorId, `${context}.vendorId`);
    claimUnique(vendorIds, vendorId, `${context}.vendorId`);

    if (vendor.sourceKind === "curated") {
      for (const field of ["sourceFile", "outputFile"]) {
        repositoryPath(vendor[field], `${vendorId}.${field}`);
      }
      if (vendor.refreshName !== undefined || vendor.profile !== undefined) {
        throw new Error(`${vendorId}: curated source cannot define refreshName or profile`);
      }
    } else {
      const sourceKind = generatedLibrarySourceKind(vendor.sourceKind);
      if (!BUILDERS[vendor.sourceKind]) {
        throw new Error(`${vendorId}: no source builder for ${vendor.sourceKind}`);
      }
      if (
        typeof sourceKind.configSchema !== "string" ||
        typeof sourceKind.lockSchema !== "string" ||
        typeof sourceKind.validatorScript !== "string" ||
        !Array.isArray(sourceKind.requiredPaths) ||
        typeof sourceKind.requiresProfile !== "boolean" ||
        typeof sourceKind.requiresRefreshConcurrency !== "boolean" ||
        !sourceKind.refresh ||
        typeof sourceKind.refresh.script !== "string" ||
        typeof sourceKind.refresh.passVendor !== "boolean" ||
        typeof sourceKind.refresh.allowBackfillSignatures !== "boolean" ||
        typeof sourceKind.refresh.allowProduct !== "boolean"
      ) {
        throw new Error(`${vendorId}: source kind has an incomplete adapter contract`);
      }
      const refreshName = registryId(vendor.refreshName, `${vendorId}.refreshName`);
      claimUnique(refreshNames, refreshName, `${vendorId}.refreshName`);
      if (sourceKind.requiresProfile) {
        const profile = registryId(vendor.profile, `${vendorId}.profile`);
        claimUnique(profiles, profile, `${vendorId}.profile`);
      } else if (vendor.profile !== undefined) {
        throw new Error(
          `${vendorId}: source kind ${vendor.sourceKind} does not accept a profile`,
        );
      }
      for (const field of sourceKind.requiredPaths) {
        repositoryPath(vendor[field], `${vendorId}.${field}`);
      }
      if (
        sourceKind.requiresRefreshConcurrency &&
        (!Number.isSafeInteger(vendor.refreshConcurrency) || vendor.refreshConcurrency <= 0)
      ) {
        throw new Error(`${vendorId}.refreshConcurrency must be a positive safe integer`);
      }
      if (
        !sourceKind.requiresRefreshConcurrency &&
        vendor.refreshConcurrency !== undefined
      ) {
        throw new Error(
          `${vendorId}: source kind ${vendor.sourceKind} does not accept refreshConcurrency`,
        );
      }
      if (sourceKind.refresh.aggregateName) {
        aggregateNames.add(
          registryId(
            sourceKind.refresh.aggregateName,
            `${vendorId}.sourceKind.aggregateName`,
          ).toLowerCase(),
        );
      }
    }

    for (const field of REPOSITORY_PATH_KEYS) {
      if (vendor[field] === undefined) continue;
      const value = repositoryPath(vendor[field], `${vendorId}.${field}`);
      claimUnique(paths, value, `${vendorId}.${field}`);
    }
  }

  for (const aggregateName of aggregateNames) {
    if (refreshNames.has(aggregateName)) {
      throw new Error(
        `aggregate refresh name ${aggregateName} collides with ${refreshNames.get(aggregateName)}`,
      );
    }
  }
  return vendors;
}

function assertVendorProfile(vendor, config) {
  const sourceKind = generatedLibrarySourceKind(vendor.sourceKind);
  if (sourceKind.requiresProfile && config?.profile !== vendor.profile) {
    throw new Error(
      `${vendor.vendorId}: configured profile ${JSON.stringify(config?.profile)} does not match registry profile ${JSON.stringify(vendor.profile)}`,
    );
  }
}

export function generatedLibraryValidatorScripts(vendors) {
  assertGeneratedLibraryVendorAdapters(vendors);
  return [
    ...new Set(
      vendors.map(
        (vendor) => generatedLibrarySourceKind(vendor.sourceKind).validatorScript,
      ),
    ),
  ];
}
