// Single source of truth for tooling:
//
// - which JSON file is validated against which schema;
// - which JSON file is published to R2;
// - where the R2 bucket, endpoint, and public host live.
//
// Both validate.mjs and publish-r2.mjs should import from this module so
// validation and publishing rules cannot drift apart.

import path from "node:path";

const moduleDir = import.meta.dirname;

export const repoRoot = path.resolve(moduleDir, "..");

const SCHEMAS = Object.freeze({
  libraryCatalog: "schemas/library_catalog.schema.json",
  dlssPresetManifest: "schemas/dlss_preset_manifest.schema.json",
  dlssSettingsCatalog: "schemas/dlss_settings_catalog.schema.json",
  renodxManifest: "schemas/renodx_manifest.schema.json",
  lumaManifest: "schemas/luma_manifest.schema.json",
  reshadeManifest: "schemas/reshade_manifest.schema.json",
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
 * `renodx_manifest.json` is safe to publish because it carries no hashes or
 * binaries; add-ons are fetched live from upstream. The slug-availability check
 * guards its contents.
 */
export const jsonDocuments = defineDocuments([
  {
    file: "manifest.json",
    schema: SCHEMAS.libraryCatalog,
    publishedToR2: true,
  },
  {
    file: "dlss_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    publishedToR2: true,
  },
  {
    file: "dlss_g_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    publishedToR2: true,
  },
  {
    file: "dlss_d_presets.json",
    schema: SCHEMAS.dlssPresetManifest,
    publishedToR2: true,
  },
  {
    file: "dlss_settings.json",
    schema: SCHEMAS.dlssSettingsCatalog,
    publishedToR2: false,
  },
  {
    file: "renodx_manifest.json",
    schema: SCHEMAS.renodxManifest,
    publishedToR2: true,
  },
  {
    file: "luma_manifest.json",
    schema: SCHEMAS.lumaManifest,
    publishedToR2: true,
  },
  {
    file: "reshade_manifest.json",
    schema: SCHEMAS.reshadeManifest,
    publishedToR2: true,
  },
]);

// file -> schema. Every JSON document in `jsonDocuments` is validated.
// This is the list consumed by both the CI `validate` job and `npm run validate`.
export const schemaChecks = Object.freeze(
  jsonDocuments.map(({ file, schema }) => Object.freeze({ file, schema })),
);

// The JSON files the app fetches from R2 — the only documents CI publishes.
export const servedJson = Object.freeze(
  jsonDocuments.filter(({ publishedToR2 }) => publishedToR2).map(({ file }) => file),
);

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
