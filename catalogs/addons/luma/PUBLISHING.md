# Luma curation

`curated_games.json` is the Luma authoring catalogue. It holds profiles, verified install identities, requirements, features, reviewed guidance, and the upstream note-review audit. Omit `profile` for a game-specific payload; set it explicitly to `"unreal"` or `"unity"` for an engine profile. The obsolete `generic` flag is rejected.

Only reviewed `guidance` reaches the public v1 manifest. Unmatched records are written to `pending_match.json` and are not published as installable. Set `match_ignore: true` on a profile to permanently skip Steam matching (for example after a duplicate AppID); ignored profiles are neither pending nor published.

Run:

```powershell
pnpm run sync:luma-wiki:check
pnpm run sync:luma-wiki
pnpm run check:luma-assets
pnpm run check:luma-payload-layout
```

`sync:luma-wiki` updates curated status/features from the wiki (never raw notes) and regenerates `addons/v1/luma.json`.

The generated contract is `addons/v1/luma.json`. `minimum_reshade_version` is the host compatibility floor, `package` identifies the exact release asset and root add-on, and public `profile` is the strict `"game" | "unreal" | "unity"` enum. Unreal requires `Luma-Unreal_Engine.zip` plus `features`; Unity requires the exact architecture-specific shared asset and forbids `features`; game profiles forbid all shared engine assets and `features`.

Guidance must have a stable `id`, reviewed English fallback, allowed kind, and exact code only for INI or launch-argument instructions.

Do not publish raw Wiki notes. Keep dgVoodoo requirements fully pinned: archive URL, SHA-256, size, extracted file hashes, and managed configuration.
