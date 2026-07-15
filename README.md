# RenderPilot Libraries

Source and publication tooling for RenderPilot's graphics-library catalogues and add-on manifests.

## Layout

- `manifest.json`, `dlss_*.json`, `schemas/` — binary-library and DLSS catalogues; their existing wire contracts are unchanged.
- `catalogs/addons/luma` — curated Luma profiles, Wiki review data, schema, generator, and tests.
- `catalogs/addons/renodx` — RenoDX Wiki snapshot, curated overrides, schemas, generator, and tests.
- `catalogs/addons/reshade` — ReShade channel model and schemas.
- `addons/v1/` — published v1 manifests consumed by current RenderPilot builds.
- `scripts/` — shared validation, generation, publishing, and upstream checks.

## Published add-on contracts

| R2 key                   | Consumer              | Schema                              |
| ------------------------ | --------------------- | ----------------------------------- |
| `addons/v1/luma.json`    | Current RenderPilot   | Luma v1                             |
| `addons/v1/renodx.json`  | Current RenderPilot   | RenoDX v1                           |
| `addons/v1/reshade.json` | Current RenderPilot   | ReShade v1                          |
| `renodx_manifest.json`   | Legacy RenoDX clients | RenoDX v3 compatibility projection  |
| `reshade_manifest.json`  | Legacy RenoDX clients | ReShade v1 compatibility projection |

Luma has no legacy manifest. RenoDX v3 and legacy ReShade v1 are generated from the v1 data and remain release requirements until a separately announced end of life. Do not edit legacy files directly.

Current add-on manifests use structured localized text: an application resolves `id` locally and uses the reviewed English `fallback_text` when no translation exists. Luma's reviewed guidance is published; raw Wiki notes and revision records are not.

## Commands

```powershell
pnpm install
pnpm run generate:reshade
pnpm run generate:renodx
pnpm run generate:luma
pnpm run check
pnpm run publish:json:dry-run
```

`pnpm run check` formats-checks, validates every public JSON file, verifies generated outputs, runs unit tests, checks RenoDX snapshot slugs, and checks Luma release assets/payload layout. CI runs that command for every pull request, then publishes JSON from `main`.

`scripts/catalog.mjs` is the repository and publication registry: generators, synchronizers, matchers, validators, and remote checks take add-on source/output paths, schemas, and explicit R2 keys from it. Versioned object paths are preserved during publication; compatibility documents intentionally remain at the bucket root.

## Curation rules

- Match rules describe only concrete game identities. Engine-wide RenoDX fallbacks live in `engine_profiles`.
- Luma authoring omits `profile` for game-specific payloads and uses explicit `"unreal"`/`"unity"` engine profiles. Public v1 publishes the strict `"game" | "unreal" | "unity"` enum.
- Luma feature status is required only on Unreal profiles and is never inferred from free-form Wiki text.
- Luma guidance is concise, reviewed, and action-oriented. Exact code, archive paths, hashes, and URLs are retained.
- A missing AppID or executable name creates a generated pending entry; it is not silently published as installable.
- `-dx11` remains a manual Luma requirement for Generic Unreal profiles when D3D12 is detected. The manifest does not authorize changes to game INI files, executables, shortcuts, or launcher settings.

## Publishing

`pnpm run publish:json` uploads only JSON with R2 credentials. `pnpm run publish` also uploads local `cdn/*.dll.zst` payloads. The uploader verifies each object after upload. Use `pnpm run check:published-json` after a release when a byte-for-byte remote verification is needed.
