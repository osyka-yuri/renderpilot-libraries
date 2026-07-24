# Add-on Catalogues

RenderPilot consumes versioned manifests for RenoDX, Luma Framework, and the shared ReShade host.

## Published Contracts

| R2 key                   | Consumer            | Contract   |
| ------------------------ | ------------------- | ---------- |
| `addons/v1/renodx.json`  | Current RenderPilot | RenoDX v1  |
| `addons/v1/luma.json`    | Current RenderPilot | Luma v1    |
| `addons/v1/reshade.json` | Current RenderPilot | ReShade v1 |

Legacy root keys such as `renodx_manifest.json` and `reshade_manifest.json` are no longer published by current tooling.

## Authoring Sources

| Path                       | Role                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| `catalogs/addons/renodx/`  | Wiki snapshot, reviewed matching overlay, schema, generator, and tests |
| `catalogs/addons/luma/`    | Curated profiles, reviewed Wiki data, managed dependencies, and tests  |
| `catalogs/addons/reshade/` | ReShade channel model, schema, and generator inputs                    |

Generated `unmatched.json` files are local review aids created by `match-pending`. They are gitignored and never act as a source of truth.

## Localized Text

Published add-on guidance uses structured localized text:

- `id` is a stable key resolved by the application;
- `fallback_text` is mandatory reviewed English text;
- the fallback remains authoritative when no application translation exists;
- raw Wiki notes and revision records are not exposed as user-facing guidance.

## Curation Rules

- Match rules describe concrete game identities. Engine-wide RenoDX fallbacks belong in `engine_profiles`.
- Luma game-specific payloads omit `profile`; engine profiles explicitly use `"unreal"` or `"unity"`.
- Public Luma v1 restricts the profile enum to `"game" | "unreal" | "unity"`.
- Luma feature status is required only for Unreal profiles and is never inferred from free-form Wiki text.
- Guidance must be concise, reviewed, and action-oriented. Exact code, archive paths, hashes, and URLs are retained where required.
- A missing AppID or executable name creates a pending review entry rather than an installable public profile.
- Generic Unreal Luma profiles retain the manual `-dx11` requirement when DirectX 12 is detected.
- A manifest never authorizes edits to game INI files, executables, shortcuts, or launcher settings.

## Synchronization

RenoDX and Luma Wiki synchronization has separate write and check modes. Pull-request CI runs the check mode; the scheduled drift workflow additionally classifies failures and only opens or updates issues for explicit catalogue drift.

Soft network skips and unclassified upstream failures do not create catalogue-drift issues. Scheduled upstream-health checks separately probe pinned ReShade channels and Luma dependency archives.

ReShade stable refresh rewrites only its reviewed source module and generated v1 manifest. Scheduled refresh workflows open a pull request when data changes; they do not push directly to `main` or publish to R2.

See [Operations and Publishing](operations.md) for the exact commands and automation boundaries.
