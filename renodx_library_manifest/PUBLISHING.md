# RenoDX manifest — authoring & publishing

This folder is the **authoring source** for `renodx_manifest.json` (written to the
repo root, served from the R2 CDN, fetched by RenderPilot at runtime).

**No binaries, no hashes.** RenoDX add-ons are rolling per-game snapshots and some
are Discord-only, so RenderPilot fetches each add-on **live from upstream**
(`clshortfuse.github.io`, engine-generic repos) at install time. This manifest is a
pure **overrides + catalogue** document (schema v3): game→slug, match rules, per-game
overrides, the global ReShade sources, the engine-generic fallbacks, and a shared
`defaults` block. That makes it safe to publish as plain JSON — CI validates and
uploads it like any other served manifest; there is nothing to mirror or hash.

## Schema v3 — `defaults`

The per-title boilerplate that is identical for almost every game (`risk`,
`min_app_version`, `channel`, `compatibility.required_arch`) lives once in a
top-level `defaults` object. The generator emits a per-title field **only when it
deviates** from the default, and the app merges `defaults` onto each title at load
time. `compatibility.required_arch` is never emitted — it always equals `arch`, so
the app derives it. A verified singleplayer game with no overrides is therefore six
keys: `id`, `name`, `slug`, `arch`, `status`, `match`.

## Inputs

| File | What it holds |
| --- | --- |
| `wiki_games.json` | one row per RenoDX game: name, add-on `slug` (= upstream `src/games` folder = add-on file name), `arch`, wiki test-map `status` (working/construction/unknown) |
| `match_overlay.json` | per-game metadata the wiki lacks: Steam AppID(s)/exe, `risk`/`conflicts`/`notes_keys`/`required_api`/`proxy_dll_override`/`download_url` overrides, `split`, and category markers (`external` `{url,label_key}`, `native_hdr: true`, `blacklist: <key>`) |
| `pending_match.json` | generated: titles still lacking an AppID/exe (next-pass to-do). Category entries are excluded — they are intentional, not pending. |

## Build & publish

```bash
npm run generate:renodx   # regenerate renodx_manifest.json (repo root) + pending_match.json
npm run validate          # ajv schema check (offline)
npm run check:slugs       # assert every snapshot-hosted title's renodx-<slug>.addon* exists upstream (network)
# then push to main — CI validates and publishes renodx_manifest.json to the R2 root.
```

`check:slugs` is the **availability gate**: it fetches the clshortfuse `snapshot`
release asset list and fails on any title whose add-on isn't actually published
there. Titles carrying a `download_url` (third-party github.io / GitHub releases) and
`external` / `blacklist` entries are skipped — the snapshot gate doesn't apply to
them. Such snapshot-hosted titles must be resolved before they ship — either fix the
slug, add a `download_url`, mark the game `external` (Discord/Nexus) in the overlay,
or drop it. (It soft-passes when GitHub is unreachable so offline runs aren't blocked.)

`generate:renodx` is **reproducible**: set `SOURCE_DATE_EPOCH` to pin
`generated_at` (UTC midnight), e.g. `SOURCE_DATE_EPOCH=1782172800 npm run
generate:renodx`. It also warns on orphan overlay keys and unknown overlay fields
(likely typos) so a silent bad key can't drop a title's risk/conflicts.

## Editing the set

Overlay keys (under the title id) — all optional, merged onto the defaults:

| Key | Effect |
| --- | --- |
| `appid` / `appids` / `exe` | match identifiers that promote a wiki row from pending to a title |
| `slug` | override the wiki slug (rare; use when the add-on file name differs) |
| `download_url` | direct URL for an add-on hosted off the clshortfuse snapshot |
| `risk` | partial override merged onto `defaults.risk` (e.g. `{anticheat_engine:"eac",online:"coop",severity:"warn",message_key:"..."}`) |
| `conflicts` | add-on conflict ids → emitted as `compatibility.conflicts` |
| `required_api` | required graphics APIs → emitted as `compatibility.required_api` |
| `notes_keys` | localized note keys shown for the title |
| `proxy_dll_override` | override the injected proxy DLL file name |
| `split` | expand one shared-slug wiki row into one title per sub-game (`{suffix,name,appid}`) |
| `external` | `{url,label_key}` — off-platform install (Discord/Nexus); not a title |
| `native_hdr` | `true` — native HDR, RenoDX not offered; not a title |
| `blacklist` | `<reason_key>` — known-broken/unsupported; not a title |

- Keep changes additive; bump a title's `min_app_version` only when it needs a newer app.
- The generator only emits a title field when it differs from `defaults`, so most
  edits touch a single key.
