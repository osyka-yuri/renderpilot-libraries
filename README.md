<div align="center">
  <h1>🛩️ RenderPilot Libraries</h1>

  <p><strong>Catalog and CDN backing store for <a href="https://github.com/osyka-yuri/renderpilot">RenderPilot</a> — graphics upscaling libraries (DLSS · FSR · XeSS · Streamline · DirectStorage) and the JSON manifests the app fetches at runtime.</strong></p>

  <div>
    <a href="https://github.com/osyka-yuri/renderpilot-libraries/actions/workflows/publish.yml"><img src="https://github.com/osyka-yuri/renderpilot-libraries/actions/workflows/publish.yml/badge.svg" alt="Publish status" /></a>
  </div>

  <div style="margin-top: 10px;">
    <img src="https://img.shields.io/badge/CDN-Cloudflare_R2-F38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=1c1c1c" alt="Cloudflare R2" />
    <img src="https://img.shields.io/badge/Tooling-Node.js_20+-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1c1c1c" alt="Node.js" />
    <img src="https://img.shields.io/badge/Schema-JSON_Schema_2020--12-4a9eff?style=for-the-badge&labelColor=1c1c1c" alt="JSON Schema" />
  </div>
</div>

<br />

The **JSON manifests live in git** (the source of truth); the **binaries are stored
zstd-compressed and served from Cloudflare R2**. On every push to `main`, CI validates
every manifest against its JSON Schema and publishes the app-fetched JSON to the bucket.
Binaries are mirrored to R2 by the maintainer with the same Node tooling.

## 🗺️ Pipeline

```mermaid
flowchart LR
  subgraph REPO["📦 This repo (git)"]
    JSON["manifest.json<br/>dlss_*_presets.json"]
    SCHEMAS["schemas/*.schema.json"]
  end
  subgraph LOCAL["💻 Maintainer (local)"]
    BIN["cdn/*.dll.zst"]
  end
  subgraph CI["🤖 GitHub Actions"]
    V["validate<br/>(ajv)"]
    P["publish<br/>(--json-only)"]
  end
  subgraph R2["☁️ Cloudflare R2"]
    OBJ["pub-…r2.dev/*"]
  end
  APP(["🛩️ RenderPilot app"])

  JSON --> V
  SCHEMAS --> V
  V --> P --> OBJ
  BIN -->|npm run publish| OBJ
  OBJ --> APP

  classDef repo fill:#3b82f6,color:#fff,stroke:#1d4ed8,stroke-width:2px;
  classDef ci fill:#8b5cf6,color:#fff,stroke:#6d28d9,stroke-width:2px;
  classDef cdn fill:#f59e0b,color:#fff,stroke:#b45309,stroke-width:2px;
  class JSON,SCHEMAS repo;
  class V,P ci;
  class OBJ cdn;
```

## 📂 Repository layout

```
.
├── manifest.json                  Library catalog — DLLs → SHA-256 → R2 download URL
├── dlss_presets.json              DLSS Super Resolution render presets per version
├── dlss_g_presets.json            DLSS Frame Generation presets per version
├── dlss_d_presets.json            DLSS Ray Reconstruction presets per version
├── dlss_settings.json             NVAPI DLSS driver-settings catalog (bundled in-app)
├── schemas/                       JSON Schemas (draft 2020-12) for every manifest
├── renodx_library_manifest/       RenoDX install-manifest authoring source (not yet published)
├── scripts/                       Node tooling — validate.mjs · publish-r2.mjs · catalog.mjs
├── cdn/                           zstd binaries (git-ignored; mirrored to R2)
└── .github/workflows/publish.yml  validate → publish CI
```

## 🌐 Served from R2

Public origin: `https://pub-48612a35034d40f88f42b4181547925a.r2.dev/`

| Object | Purpose | Schema |
| :--- | :--- | :--- |
| `manifest.json` | Library catalog (DLLs + SHA-256 + download URLs) | `library_catalog.schema.json` |
| `dlss_presets.json` | DLSS Super Resolution presets | `dlss_preset_manifest.schema.json` |
| `dlss_g_presets.json` | DLSS Frame Generation presets | `dlss_preset_manifest.schema.json` |
| `dlss_d_presets.json` | DLSS Ray Reconstruction presets | `dlss_preset_manifest.schema.json` |
| `<id>_<version>.dll.zst` | zstd-compressed DLL payloads (one per catalog entry) | — |

> `dlss_settings.json` is **bundled into the app** at compile time, so it is validated
> here (as the source of that bundled copy) but **not** uploaded.

## 🎮 RenoDX manifest (authoring source — not yet published)

`renodx_library_manifest/` is the authoring source for `renodx_manifest.json`, the curated
RenoDX install manifest the app fetches from the R2 root. Schema: `schemas/renodx_manifest.schema.json`.

| File | Purpose |
| :--- | :--- |
| `renodx_manifest.json` | Generated manifest (238 titles · 210 recipes · 452 artifacts) |
| `generate_manifest.py` | Offline, data-driven generator |
| `wiki_games.json` | RenoDX wiki Mods table snapshot (one row per game) |
| `match_overlay.json` | Per-title Steam AppIDs / exe / risk / conflicts overlay |
| `pending_match.json` | Titles still lacking an AppID/exe (next-pass to-do) |
| `PUBLISHING.md` | Full mirror + hashing + publish pipeline |

> **Not served yet.** Every artifact still carries placeholder `sha256` / `size_bytes`, so
> the app would reject every install. Going live requires the steps in `PUBLISHING.md` —
> mirror the RenoDX add-ons + the add-on-enabled ReShade DLL to R2, substitute the real
> decompressed hashes/sizes, then serve `renodx_manifest.json` from the R2 root. Until then
> CI validates its structure but never uploads it.

## 🧰 Tooling

All tooling is **Node.js** — one toolchain, no platform-specific shells or external binaries.

```bash
npm install            # one-time: restore dev dependencies
npm run validate       # validate every JSON against its schema
node scripts/publish-r2.mjs --dry-run   # preview the upload set (no network, no creds)

# Publish (needs R2 credentials in the environment):
npm run publish:json   # JSON manifests only
npm run publish        # binaries (cdn/*.dll.zst) + JSON
```

| Script | Purpose |
| :--- | :--- |
| `scripts/validate.mjs` | Validates every manifest with **ajv** (draft 2020-12). |
| `scripts/publish-r2.mjs` | Uploads to R2 via the **AWS SDK** (S3-compatible); flags `--json-only`, `--dry-run`, `--force`. Skips objects already current (size + MD5) and verifies each upload. |
| `scripts/catalog.mjs` | Shared config — the file→schema map, the served set, and R2 coordinates. **Single source of truth** imported by both scripts. |

## 🤖 CI / Deployment

[`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. **validate** — on every push and PR, runs `npm run validate`; a schema violation fails the run.
2. **publish** — on `main` only, runs `npm run publish:json`, pushing the served JSON to R2.
   Binaries are not in git, so CI never uploads them — adding new DLLs is a local `npm run publish`.

**One-time setup (maintainer):** add the R2 S3 token as repository **Actions secrets**
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (Settings → Secrets and variables → Actions).
The token only needs object read/write on the bucket. Without them the publish job fails.

## 🧩 Schemas

JSON Schema (draft 2020-12), under `schemas/`:

| Schema | Validates |
| :--- | :--- |
| `library_catalog.schema.json` | `manifest.json` |
| `dlss_preset_manifest.schema.json` | the three `dlss_*_presets.json` |
| `dlss_settings_catalog.schema.json` | `dlss_settings.json` |
| `renodx_manifest.schema.json` | `renodx_library_manifest/renodx_manifest.json` |

## 📥 Adding a library version

1. zstd-compress the DLL into `cdn/<id>_<version>.dll.zst`.
2. Add its entry to `manifest.json` (`entry_id`, `library`, `version`, `build`, `files.dll`
   hash/size, `files.zst` size + R2 `download_url`, `signature`).
3. `npm run validate` to confirm the catalog still matches the schema.
4. `npm run publish` to mirror the new binary **and** the manifest to R2 (or push the manifest
   change to `main` and let CI publish the JSON — but the binary still needs a local `npm run publish`).

## 🛠️ Supported libraries

| Vendor | Libraries |
| :--- | :--- |
| **NVIDIA** | DLSS Super Resolution · Frame Generation · Ray Reconstruction · Streamline (`sl.*`) |
| **AMD** | FSR 3.1 (DX12 / Vulkan) · FSR Frame Generation · Loader · Radiance Cache · Denoiser |
| **Intel** | XeSS · XeSS Frame Generation · XeLL · XeSS DX11 |
| **Microsoft** | DirectStorage |

## 🔖 Licensing

The vendor DLLs are redistributables owned by NVIDIA / AMD / Intel / Microsoft under their
respective licenses; RenoDX is MIT and ReShade is BSD-3-Clause. The manifests and tooling in
this repository belong to the RenderPilot project — see the
[main repository](https://github.com/osyka-yuri/renderpilot).
