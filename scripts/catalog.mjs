// Single source of truth for the tooling: which JSON is validated against which
// schema, which JSON is served from R2, and where R2 lives. Both validate.mjs
// and publish-r2.mjs import from here so the lists can never drift apart.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// file -> schema. Every JSON document in the repo is validated; this is the
// list the CI `validate` job and the local `npm run validate` both consume.
export const schemaChecks = [
  { file: 'manifest.json', schema: 'schemas/library_catalog.schema.json' },
  { file: 'dlss_presets.json', schema: 'schemas/dlss_preset_manifest.schema.json' },
  { file: 'dlss_g_presets.json', schema: 'schemas/dlss_preset_manifest.schema.json' },
  { file: 'dlss_d_presets.json', schema: 'schemas/dlss_preset_manifest.schema.json' },
  { file: 'dlss_settings.json', schema: 'schemas/dlss_settings_catalog.schema.json' },
  {
    file: 'renodx_library_manifest/renodx_manifest.json',
    schema: 'schemas/renodx_manifest.schema.json',
  },
];

// The JSON the app fetches from R2 — the only documents CI publishes.
// Deliberately excluded:
//   - dlss_settings.json     bundled into the app at compile time, not fetched.
//   - renodx_manifest.json   placeholder hashes; publishing it would break installs.
export const servedJson = [
  'manifest.json',
  'dlss_presets.json',
  'dlss_g_presets.json',
  'dlss_d_presets.json',
];

// Cloudflare R2. The public host is the pinned download origin baked into every
// manifest URL; the S3 endpoint/bucket are used only for uploads. All three are
// overridable via env for testing against a different bucket.
export const r2 = {
  bucket: process.env.R2_BUCKET ?? 'renderpilot-libraries',
  endpoint: process.env.R2_ENDPOINT ?? 'https://800edac17c30f2ff42e0d8c01dd22a3a.r2.cloudflarestorage.com',
  publicHost: 'pub-48612a35034d40f88f42b4181547925a.r2.dev',
};
