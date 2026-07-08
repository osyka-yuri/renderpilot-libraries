# Luma Framework manifest — authoring & publishing

This folder is the **authoring source** for `luma_manifest.json` (written to the
repo root, served from the R2 CDN, fetched by RenderPilot at runtime).

**No Luma payload hashes.** Luma Framework (Filoppi) ships a single rolling
GitHub Release — there is no per-game upstream repository and no snapshot to
mirror — so RenderPilot fetches the add-on **live from upstream**
(`github.com/Filoppi/Luma-Framework/releases/latest/download/<asset>`) at
install time. This manifest is an **overrides + catalogue** document (schema
v1): game → release asset file name, match rules, per-game overrides, the
minimum ReShade host version Luma requires when reusing a detected host,
optional managed dependency sources, and a shared `defaults` block. ReShade
download sources live in the standalone `reshade_manifest.json`.

Unlike the RenoDX manifest, there is **no top-level `generics` fallback list**.
Every Generic-Mod-compatible game (Unreal Engine, Unity Engine) is an explicit
`titles[]` entry with `generic: true`, sharing the same asset file name as
every other title curated onto that Generic Mod — resolution never falls back
to an engine guess the way RenoDX's `generics` do. There is also no
`external`/`native_hdr` category (every Luma asset lives on the same GitHub
Release) and no `slug`/`compatibility`/`proxy_dll_override`/`download_url`
field. A title that needs an installer-owned wrapper can instead carry an
`external_requirement`.

## ReShade host policy

`min_reshade_version` stays in the Luma manifest because it belongs to Luma's
add-on-loader compatibility: if an already-present ReShade host is older than
this, RenderPilot repairs/replaces it instead of reusing it. ReShade download
URLs are intentionally not duplicated here; Luma always installs the nightly
host through the shared `reshade_manifest.json` runtime source.

Changing ReShade download URLs means editing `scripts/lib/reshade-sources.mjs`
and regenerating the shared documents (`pnpm run generate:reshade && pnpm run
generate:renodx`) — `generate:luma` is not part of that source update.

## Schema v1 — `defaults`

The per-title boilerplate that is identical for almost every game (`min_app_version`,
`channel`) lives once in a top-level `defaults` object. The
generator emits a per-title field **only when it deviates** from the default,
and the app merges `defaults` onto each title at load time. A verified
single-player game with no overrides is five keys: `id`, `name`, `asset`,
`arch`, `match` (`status` defaults to `unknown` when omitted).

## Schema v1 — categories and pending

A curated game lives in `titles[]` once it has a usable match identifier.
Non-installable routing is carried by `title.category`:

- omitted `category` — normal installable Luma add-on;
- `blacklist` — known-broken, or requires an external prerequisite this
  installer cannot use as a manual bridge.

An installable title may additionally declare `external_requirement` for a
managed dependency that RenderPilot downloads, verifies, and installs alongside
Luma. The current supported kind is `dgvoodoo2`: it declares the pinned version,
the archive source URL with SHA-256 integrity, an install map from archive
paths to game directory filenames, the ReShade proxy DLL slot
(`reshade_proxy_dll`), the dependency config filename (`config_file`), and
config keys to merge into it. RenderPilot handles the full install pipeline:
download, verify, extract, install wrapper DLL with backup, and config merge.

`pending_match.json` is a generated todo-list for curated rows that still lack
a Steam AppID or exact executable basename. A blacklisted row still stays
pending until the app can match it to an installed game.

## Inputs

| File                 | What it holds                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curated_games.json` | one row per Luma-compatible game: name, release `asset` file name, `arch`, wiki test-map `status` (working/construction/unknown), `generic`, `launch_args`, `external_requirement`, `notes_keys`, `blacklist` reason — all hand-curated directly (there is no auto-scraped wiki file to layer overrides onto) |
| `match_overlay.json` | **only** the Steam AppID(s)/exe a curated row needs to become installable — nothing else lives here, unlike RenoDX's overlay                                                                                                                                                                                  |
| `pending_match.json` | generated todo-list: curated rows still lacking an AppID/exe match                                                                                                                                                                                                                                            |

The Steam AppID → executable cache (`scripts/steam-appid-exe.json`) is shared
with the RenoDX pipeline — see the repo root README. Both generators filter it
down to their own overlay's AppIDs, so a single `pnpm run enrich:exe` refresh
covers every title either tool curates.

## Build & publish

```bash
pnpm run enrich:exe         # refresh scripts/steam-appid-exe.json from Steam appinfo (network)
pnpm run generate:luma      # regenerate luma_manifest.json (repo root) + pending_match.json
pnpm run check:luma-assets  # HEAD every referenced asset against the live "latest" release (network)
pnpm run check              # format, schema, generated output, tests, asset gates
# then push to main — CI validates and publishes luma_manifest.json to the R2 root.
```

`check:luma-assets` is the **availability gate** — Luma has no snapshot asset
list to fetch (unlike RenoDX's `check:slugs`), so it HEADs
`.../releases/latest/download/<asset>` for every asset referenced by
`titles[]`, follows the redirect to the concrete `latest-<N>` tag, and asserts
that redirect target both names the same asset and ultimately resolves (200).
It soft-passes when GitHub is unreachable so offline runs aren't blocked.

`generate:luma` is **reproducible**: set `SOURCE_DATE_EPOCH` to pin
`generated_at` (UTC midnight), e.g. `SOURCE_DATE_EPOCH=1782172800 pnpm run
generate:luma`. It also warns on orphan overlay keys and unknown overlay
fields (likely typos) so a silent bad key can't drop a title's match.

`check:luma-generated` rebuilds using the current `generated_at` value and
fails if either generated output is stale.

## Resolving pending games

`scripts/match-pending.mjs --tool=luma` resolves as many `pending_match.json`
rows as it can via the Steam Store search API (exact-name match only) and
writes the result into `match_overlay.json`. Anything it can't resolve is
logged to `unmatched.json` for manual lookup — prefer leaving a row pending
over guessing an AppID; duplicate match rules are rejected by the generator.

## Editing the set

Curated-game fields (on the `curated_games.json` row itself) — all optional
except `id`/`name`/`asset`/`arch`:

| Field                  | Effect                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`               | `working` / `construction` / `unknown` — drives the derived `channel` (working → stable, else beta)                                                                                 |
| `generic`              | `true` when `asset` is a shared Generic-Mod build (Unreal/Unity) rather than a dedicated build                                                                                      |
| `launch_args`          | required launch arguments (e.g. `-dx11`, `-nod3d9ex`), shown as a copyable callout                                                                                                  |
| `external_requirement` | managed dependency metadata; currently `dgvoodoo2` with `version`, `accepted_detected_apis`, `reshade_proxy_dll`, `source`, `install_map`, `config_file`, and config merge `config` |
| `notes_keys`           | localized note keys shown for the title                                                                                                                                             |
| `blacklist`            | i18n reason key → emitted as `title.category`                                                                                                                                       |
| `min_app_version`      | override the default minimum app version                                                                                                                                            |

Overlay keys (under the game id, in `match_overlay.json`):

| Key                | Effect                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `appid` / `appids` | Steam AppID(s) — promotes a curated row from pending to a title   |
| `exe`              | exact executable basename match, when no Steam AppID is available |
| `ignore`           | cleanly skip this row entirely (e.g. a duplicate curation entry)  |

- Keep changes additive; bump a title's `min_app_version` only when it needs a
  newer app.
- The generator only emits a title field when it differs from `defaults`, so
  most edits touch a single key.
- A game that needs a wrapper is installable only when the Luma profile can
  still install useful files and the requirement declares every managed
  download, installed file, and config key RenderPilot must own. Otherwise leave
  it out of `curated_games.json` or blacklist it with a clear reason.
