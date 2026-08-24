# Add-on catalogs

RenderPilot consumes versioned manifests for RenoDX, Luma Framework, and the shared ReShade host. This repository owns their producer contracts and reviewed source data; installation behavior remains in the main RenderPilot repository.

## Published contracts

| R2 key                   | Consumer            | Contract   |
| ------------------------ | ------------------- | ---------- |
| `addons/v1/renodx.json`  | Current RenderPilot | RenoDX v1  |
| `addons/v1/luma.json`    | Current RenderPilot | Luma v1    |
| `addons/v1/reshade.json` | Current RenderPilot | ReShade v1 |

Legacy root keys such as `renodx_manifest.json` and `reshade_manifest.json` are not published by current tooling. `scripts/catalog.mjs` is the registry for current document paths, schemas, generated outputs, and R2 keys.

## Authoring sources

| Path                       | Responsibility                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `catalogs/addons/renodx/`  | Wiki snapshot, reviewed matching overlay, pending identities, schema, generator, and tests |
| `catalogs/addons/luma/`    | Curated profiles, reviewed Wiki data, managed dependencies, schema, generator, and tests   |
| `catalogs/addons/reshade/` | ReShade channel contract, schema, generator, and provider-local tests                      |

Generated `unmatched.json` files are local review aids created by `match-pending`. They are gitignored, are never published, and do not act as sources of truth.

## Published guidance

Add-on guidance uses structured localized text:

- `id` is a stable key resolved by the application;
- `fallback_text` is mandatory reviewed English text;
- the fallback remains authoritative when no application translation exists;
- raw Wiki notes and revision records are not exposed as user-facing guidance.

A public manifest can describe reviewed requirements or instructions. It does not authorize the producer to edit game INI files, executables, shortcuts, or launcher settings.

## Curation rules

- Match rules describe concrete game identities. Engine-wide RenoDX fallbacks belong in `engine_profiles`.
- Luma game-specific payloads omit `profile`; engine profiles explicitly use `"unreal"` or `"unity"`.
- Public Luma v1 restricts the profile enum to `"game" | "unreal" | "unity"`.
- Luma feature status is required only for Unreal profiles and is never inferred from free-form Wiki text.
- Guidance must be concise, reviewed, and action-oriented. Exact code, archive paths, hashes, and URLs remain structured where the contract requires them.
- A missing trustworthy AppID or executable identity creates a pending review entry instead of an installable public profile.
- Generic Unreal Luma profiles retain the manual `-dx11` requirement when DirectX 12 is detected.

Detailed authoring rules live beside each source:

- [RenoDX curation](../catalogs/addons/renodx/PUBLISHING.md)
- [Luma curation](../catalogs/addons/luma/PUBLISHING.md)
- [ReShade source catalogs](../catalogs/addons/reshade/PUBLISHING.md)

## Synchronization

RenoDX and Luma Wiki synchronization has separate write and check modes. Pull-request validation runs check mode. The scheduled Wiki drift workflow additionally classifies failures and only opens or updates an issue for explicit catalog drift.

Soft network skips and unclassified upstream failures do not become catalog-drift issues. Scheduled upstream-health checks separately probe pinned ReShade channels and Luma dependency archives.

ReShade stable refresh rewrites only its reviewed source module and generated v1 manifest. Scheduled refresh workflows open a pull request when data changes; they do not push directly to `main` or publish JSON to R2.

See [Operations and publishing](operations.md#refreshing-add-ons) for the exact commands and automation boundary.

## Sources of truth

- [Catalog registry](../scripts/catalog.mjs)
- [RenoDX manifest schema](../catalogs/addons/renodx/manifest-v1.schema.json)
- [Luma manifest schema](../catalogs/addons/luma/manifest-v1.schema.json)
- [ReShade manifest schema](../catalogs/addons/reshade/manifest-v1.schema.json)
- [Wiki drift workflow](../.github/workflows/wiki-drift.yml)
