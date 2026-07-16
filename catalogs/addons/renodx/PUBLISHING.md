# RenoDX curation

`wiki_games.json` is the upstream snapshot; `match_overlay.json` contains explicit RenderPilot curation such as store identities, executable names, variants, source URLs, and availability exceptions. Rows without a trustworthy match become `pending_match.json`. Availability/category metadata alone is not a match: add `appid`/`appids`/`exe`, a resolved split, or an explicit `ignore`.

Run:

```powershell
pnpm run sync:renodx-wiki:check
pnpm run sync:renodx-wiki
pnpm run check:slugs
```

`sync:renodx-wiki` writes the wiki snapshot/overlay and regenerates `addons/v1/renodx.json`.

The generator emits the canonical `addons/v1/renodx.json` document. Do not invent a parallel root-level compatibility file.

Use structured availability and localized messages in v1. Engine-wide fallbacks belong in `engine_profiles`; concrete games carry only concrete match rules. Explicit source URLs must resolve to the same canonical add-on file name as their slug and architecture.
