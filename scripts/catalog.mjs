// Single source of truth for tooling:
//
// - which JSON file is validated against which schema;
// - which JSON file is published to R2;
// - where the R2 bucket, endpoint, and public host live.
//
// Both validation and publication scripts should import from this module so
// validation and publishing rules cannot drift apart.

import path from "node:path";

import { assertLibraryVendorRegistry } from "./lib/library-source-adapters.mjs";
import { generatedLibrarySourceKind } from "./lib/library-source-kinds.mjs";

const moduleDir = import.meta.dirname;

export const repoRoot = path.resolve(moduleDir, "..");

export const resolveRepoPath = (...segments) => path.join(repoRoot, ...segments);

export const sharedFiles = Object.freeze({
  steamExeCache: resolveRepoPath("scripts", "steam-appid-exe.json"),
});

const defineLibraryVendors = (vendors) => {
  assertLibraryVendorRegistry(vendors);
  return Object.freeze(vendors.map((vendor) => Object.freeze({ ...vendor })));
};

// Every library vendor and every repository path needed to build its public
// snapshot. Generated providers use their own config/lock instead of a
// curated vendor document, but follow the same explicit output contract.
export const libraryVendors = defineLibraryVendors([
  {
    vendorId: "nvidia",
    sourceKind: "curated",
    sourceFile: "catalogs/libraries/nvidia.json",
    outputFile: "libraries/v1/vendors/nvidia.json",
  },
  {
    vendorId: "amd",
    sourceKind: "github-release-tree",
    profile: "amd_fidelityfx",
    refreshName: "amd",
    configFile: "catalogs/libraries/amd-fidelityfx.config.json",
    lockFile: "catalogs/libraries/amd-fidelityfx.lock.json",
    overlayFile: "catalogs/libraries/amd.overlays.json",
    outputFile: "libraries/v1/vendors/amd.json",
    refreshConcurrency: 2,
  },
  {
    vendorId: "intel",
    sourceKind: "github-release-tree",
    profile: "intel_xess",
    refreshName: "intel",
    configFile: "catalogs/libraries/intel-xess.config.json",
    lockFile: "catalogs/libraries/intel-xess.lock.json",
    overlayFile: "catalogs/libraries/intel.overlays.json",
    outputFile: "libraries/v1/vendors/intel.json",
    refreshConcurrency: 1,
  },
  {
    vendorId: "microsoft",
    sourceKind: "nuget",
    refreshName: "microsoft",
    configFile: "catalogs/libraries/microsoft-nuget.config.json",
    lockFile: "catalogs/libraries/microsoft-nuget.lock.json",
    outputFile: "libraries/v1/vendors/microsoft.json",
  },
  {
    vendorId: "valve",
    sourceKind: "github-release-tree",
    profile: "openvr",
    refreshName: "openvr",
    configFile: "catalogs/libraries/valve-openvr.config.json",
    lockFile: "catalogs/libraries/valve-openvr.lock.json",
    outputFile: "libraries/v1/vendors/valve.json",
    refreshConcurrency: 4,
  },
]);

export const curatedLibraryVendors = Object.freeze(
  libraryVendors.filter(({ sourceKind }) => sourceKind === "curated"),
);

export const generatedLibraryVendors = Object.freeze(
  libraryVendors.filter(({ sourceKind }) => sourceKind !== "curated"),
);

export const githubReleaseTreeVendors = Object.freeze(
  libraryVendors.filter(({ sourceKind }) => sourceKind === "github-release-tree"),
);

export const microsoftLibraryVendor = libraryVendors.find(
  ({ sourceKind }) => sourceKind === "nuget",
);

export const libraryIndexFile = "libraries/v1/index.json";

const SCHEMAS = Object.freeze({
  libraryCatalog: "schemas/library_catalog.schema.json",
  libraryIndexV1: "schemas/library_index_v1.schema.json",
  libraryVendorV1: "schemas/library_vendor_v1.schema.json",
  libraryVendorSource: "schemas/library_vendor_source.schema.json",
  dlssPresetManifest: "schemas/dlss_preset_manifest.schema.json",
  dlssSettingsCatalog: "schemas/dlss_settings_catalog.schema.json",
  renodxManifestV1: "catalogs/addons/renodx/manifest-v1.schema.json",
  lumaManifestV1: "catalogs/addons/luma/manifest-v1.schema.json",
  reshadeManifestV1: "catalogs/addons/reshade/manifest-v1.schema.json",
});

const defineDocuments = (documents) =>
  Object.freeze(documents.map((document) => Object.freeze({ ...document })));

/**
 * Repository JSON documents.
 *
 * `publishedToR2: true` means the app fetches this document from R2 and CI
 * should publish it.
 *
 * `dlss_settings.json` is intentionally not published because it is bundled into
 * the app at compile time.
 *
 * Current add-on catalogues are versioned under `addons/v1/`.
 */
export const jsonDocuments = defineDocuments([
  ...curatedLibraryVendors.map(({ sourceFile }) => ({
    file: sourceFile,
    schema: SCHEMAS.libraryVendorSource,
    publishedToR2: false,
  })),
  ...generatedLibraryVendors.flatMap((vendor) => [
    {
      file: vendor.configFile,
      schema: generatedLibrarySourceKind(vendor.sourceKind).configSchema,
      publishedToR2: false,
    },
    {
      file: vendor.lockFile,
      schema: generatedLibrarySourceKind(vendor.sourceKind).lockSchema,
      publishedToR2: false,
    },
    ...(vendor.overlayFile
      ? [
          {
            file: vendor.overlayFile,
            schema: SCHEMAS.libraryVendorSource,
            publishedToR2: false,
          },
        ]
      : []),
  ]),
  {
    file: "manifest.json",
    schema: SCHEMAS.libraryCatalog,
    publishedToR2: false,
  },
  ...libraryVendors.map(({ outputFile }) => ({
    file: outputFile,
    schema: SCHEMAS.libraryVendorV1,
    publishedToR2: false,
  })),
  {
    file: libraryIndexFile,
    schema: SCHEMAS.libraryIndexV1,
    r2Key: "libraries/v1/index.json",
    publishedToR2: true,
  },
  {
    file: "dlss_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    r2Key: "dlss_presets.json",
    publishedToR2: true,
  },
  {
    file: "dlss_g_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    r2Key: "dlss_g_presets.json",
    publishedToR2: true,
  },
  {
    file: "dlss_d_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    r2Key: "dlss_d_presets.json",
    publishedToR2: true,
  },
  {
    file: "dlss_settings.json",
    schema: SCHEMAS.dlssSettingsCatalog,
    publishedToR2: false,
  },
  {
    file: "addons/v1/renodx.json",
    schema: SCHEMAS.renodxManifestV1,
    r2Key: "addons/v1/renodx.json",
    publishedToR2: true,
  },
  {
    file: "addons/v1/luma.json",
    schema: SCHEMAS.lumaManifestV1,
    r2Key: "addons/v1/luma.json",
    publishedToR2: true,
  },
  {
    file: "addons/v1/reshade.json",
    schema: SCHEMAS.reshadeManifestV1,
    r2Key: "addons/v1/reshade.json",
    publishedToR2: true,
  },
]);

// file -> schema. Every JSON document in `jsonDocuments` is validated.
// This is the list consumed by both the CI `validate` job and `npm run validate`.
export const schemaChecks = Object.freeze(
  jsonDocuments.map(({ file, schema }) => Object.freeze({ file, schema })),
);

// The JSON files the app fetches from R2 — the only documents CI publishes.
export const publishedJsonDocuments = Object.freeze(
  jsonDocuments
    .filter(({ publishedToR2 }) => publishedToR2)
    .map(({ file, r2Key }) => Object.freeze({ file, r2Key })),
);

const documentByFile = new Map(jsonDocuments.map((document) => [document.file, document]));

function generatedDocument(file) {
  const document = documentByFile.get(file);
  if (!document) {
    throw new Error(`Unknown generated document: ${file}`);
  }
  return Object.freeze({
    file: resolveRepoPath(...file.split("/")),
    relativeFile: document.file,
    schema: resolveRepoPath(...document.schema.split("/")),
    r2Key: document.r2Key ?? null,
  });
}

const addonCatalog = (name, sources, outputs) =>
  Object.freeze({
    directory: resolveRepoPath("catalogs", "addons", name),
    sources: Object.freeze(
      Object.fromEntries(
        Object.entries(sources).map(([key, file]) => [
          key,
          resolveRepoPath("catalogs", "addons", name, file),
        ]),
      ),
    ),
    outputs: Object.freeze(
      Object.fromEntries(
        Object.entries(outputs).map(([key, file]) => [key, generatedDocument(file)]),
      ),
    ),
  });

/**
 * Complete add-on repository layout. Generators, synchronizers, matchers, and
 * remote tooling import this registry instead of reconstructing paths or R2
 * object keys independently.
 */
export const addonCatalogs = Object.freeze({
  luma: addonCatalog(
    "luma",
    {
      curatedGames: "curated_games.json",
      pending: "pending_match.json",
      unmatched: "unmatched.json",
    },
    { manifest: "addons/v1/luma.json" },
  ),
  renodx: addonCatalog(
    "renodx",
    {
      wiki: "wiki_games.json",
      overlay: "match_overlay.json",
      pending: "pending_match.json",
      unmatched: "unmatched.json",
    },
    { manifest: "addons/v1/renodx.json" },
  ),
  reshade: addonCatalog("reshade", {}, { manifest: "addons/v1/reshade.json" }),
});

const DEFAULT_R2 = Object.freeze({
  bucket: "renderpilot-libraries",
  endpoint: "https://800edac17c30f2ff42e0d8c01dd22a3a.r2.cloudflarestorage.com",
  publicHost: "pub-48612a35034d40f88f42b4181547925a.r2.dev",
});

const envOrDefault = (name, fallback) => {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
};

const normalizeUrlOrigin = (value, envName) => {
  try {
    return new URL(value).origin;
  } catch (cause) {
    throw new Error(
      `Invalid ${envName}: expected an absolute URL, got ${JSON.stringify(value)}`,
      { cause },
    );
  }
};

const normalizeHost = (value, envName) => {
  const trimmed = value.trim().replace(/\/+$/, "");
  const valueWithProtocol = /^[a-z][a-z\d+\-.]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(valueWithProtocol).host;
  } catch (cause) {
    throw new Error(
      `Invalid ${envName}: expected a hostname, got ${JSON.stringify(value)}`,
      { cause },
    );
  }
};

// Cloudflare R2.
//
// The public host is the pinned download origin baked into manifest URLs.
// The S3 endpoint and bucket are used only for uploads.
//
// All three values are overridable via env for tests or alternate buckets.
export const r2 = Object.freeze({
  bucket: envOrDefault("R2_BUCKET", DEFAULT_R2.bucket),
  endpoint: normalizeUrlOrigin(
    envOrDefault("R2_ENDPOINT", DEFAULT_R2.endpoint),
    "R2_ENDPOINT",
  ),
  publicHost: normalizeHost(
    envOrDefault("R2_PUBLIC_HOST", DEFAULT_R2.publicHost),
    "R2_PUBLIC_HOST",
  ),
});
