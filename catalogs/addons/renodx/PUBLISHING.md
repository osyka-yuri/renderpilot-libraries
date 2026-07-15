# RenoDX curation

`wiki_games.json` is the upstream snapshot; `match_overlay.json` contains explicit RenderPilot curation such as store identities, executable names, variants, source URLs, and availability exceptions. Rows without a trustworthy match become `pending_match.json`. Availability/category metadata alone is not a match: add `appid`/`appids`/`exe`, a resolved split, or an explicit `ignore`.

Run:

```powershell
pnpm run sync:renodx-wiki:check
pnpm run generate:renodx
pnpm run check:slugs
```

The generator emits canonical `addons/v1/renodx.json` and derives the root `renodx_manifest.json` v3 compatibility projection. Never edit the latter: it is part of the supported legacy contract until a separately announced EOL.

Use structured availability and localized messages in v1. Engine-wide fallbacks belong in `engine_profiles`; concrete games carry only concrete match rules. Explicit source URLs must resolve to the same canonical add-on file name as their slug and architecture.
