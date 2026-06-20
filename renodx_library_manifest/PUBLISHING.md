# Publishing the RenoDX manifest

This folder is the **authoring source** for `renodx_manifest.json`, the curated
RenoDX install manifest RenderPilot fetches at runtime. It is destined for the
`osyka-yuri/renderpilot-libraries` repo and is served from the same pinned R2
CDN host as the library manifest.

## How the manifest is built (inputs)

`generate_manifest.py` is data-driven and runs offline (no network):

| Input | What it holds | Source |
| --- | --- | --- |
| `wiki_games.json` | every RenoDX game: name, add-on `slug` (= add-on file name), arch (x64/x86), status (working/in-progress) | scraped from the RenoDX wiki Mods table |
| `match_overlay.json` | per-title metadata the wiki lacks: Steam `appid`, optional `exe`, `risk` overrides, `conflicts`, note keys | resolved by matching names against the Steam app list, plus hand-verified entries |
| `pending_match.json` | games still lacking an AppID/exe (mostly emulator-only/non-Steam titles) | generated output — the to-do list for the next pass |

A title is emitted only when it has a usable match identifier (an AppID or an
exe). Add-on artifacts/recipes are de-duplicated by `slug`, so several games that
share one add-on build (the FromSoftware / RE-Engine universal add-ons) reuse a
single recipe. ReShade host DLLs are emitted per architecture (an x86 game needs
the x86 ReShade build).

## What is real vs. placeholder

`generate_manifest.py` produces a **structurally complete, review-ready**
manifest: the titles, Steam AppIDs, executable names, graphics APIs, risk
model, conflicts, recipes, `ReShade.ini` tweaks, file names, and provenance are
all real and curated.

Two fields are **placeholders** that the publishing pipeline MUST replace before
the manifest goes live:

| Field | Placeholder | Must become |
| --- | --- | --- |
| `artifacts[].sha256` | `00…0001`, `00…0002`, … (a counter) | lowercase 64-hex SHA-256 of the **decompressed** payload |
| `artifacts[].size_bytes` | round placeholders (`1572864`, `6815744`) | the real **decompressed** byte size |

The app verifies both at download time, so a manifest published with the
placeholders will refuse every install. This is intentional — it cannot silently
ship unverified bytes.

## Fetch & verification contract (read before computing hashes)

How the app fetches each artifact depends on its `compression`, and **`sha256`
and `size_bytes` are always over the *decompressed* payload** — get this wrong
and every install fails the integrity check:

- **`compression: "zstd"`** (the RenoDX add-ons): the app downloads the `.zst`
  from `download.url`, decompresses it to exactly `size_bytes`, then checks the
  SHA-256 of the **decompressed** bytes. So: compute `sha256`/`size_bytes` on the
  raw `.addon64`, but upload the **zstd-compressed** file to the `.zst` URL.
- **`compression: "none"`** (the ReShade host DLL): the app downloads the file
  and enforces its size **exactly equals** `size_bytes` (a mismatch aborts),
  then checks the SHA-256. So the mirrored file *is* the payload: `sha256`/
  `size_bytes` are of the exact bytes served at `download.url`.

The app fetches the manifest itself from the **CDN root**:
`https://<mirror-host>/renodx_manifest.json` (same convention as `manifest.json`).
Publish it to that exact path.

## Pipeline steps (libraries repo)

1. **Mirror the binaries** to R2 under the pinned host
   (`pub-48612a35034d40f88f42b4181547925a.r2.dev`):
   - each per-game RenoDX add-on → `renodx/<slug>-x64.addon64.zst` (zstd-compressed),
   - the addon-capable ReShade host DLL → `reshade/<ver>-addon-x64.dll`. Note
     `reshade.me` ships an **installer `.exe`**, not a bare DLL — extract the
     **add-on-enabled** ReShade DLL (the variant with the add-on API) from the
     installer/build before mirroring; that DLL is the payload.
   RenoDX is MIT and ReShade is BSD-3-Clause; both are mirrored **with the
   attribution already present in each artifact's `provenance`**.
2. **Compute** the SHA-256 and decompressed size of every mirrored payload and
   substitute them for the placeholders (the existing PowerShell publishing
   tooling that already does this for the library manifest can be extended).
3. **Validate** the result against *both* gatekeepers before publishing:
   ```sh
   # Canonical Rust validator (referential integrity, host pinning, sizes):
   cargo run -p renderpilot-orchestration --example validate_renodx_manifest -- renodx_manifest.json
   # JSON Schema (structure), e.g. with check-jsonschema or ajv:
   check-jsonschema --schemafile renodx_manifest.schema.json renodx_manifest.json
   ```
   (`renodx_manifest.schema.json` is the canonical spec, kept in the app repo at
   `crates/renderpilot-orchestration/renodx_manifest/`.)
4. **Publish** `renodx_manifest.json` to the CDN root (same path convention as
   `manifest.json`).

## Hosting note (ReShade)

The artifacts mirror the ReShade host DLL to R2 (`host_policy: "mirror"`), per the
locked decision, so the full reliability model (host pin + exact size + SHA-256 +
offline cache) holds. If you prefer to honor the ReShade "link, don't rehost"
norm instead, flip that one artifact to `host_policy: "upstream"` with a
`reshade.me` / `static.reshade.me` URL — the validator allows it and nothing else
changes.

## Verify the curated data before publishing

The titles, Steam AppIDs, executable names, and risk fields were curated from the
RenoDX wiki and general knowledge — **spot-check them against authoritative
sources** before going live, because wrong values cause silent mis-matches:

- **Steam AppIDs / exe names** — confirm against SteamDB and the RenoDX wiki Mods
  table. (The tiered matcher also falls back to `exe_name`, so an AppID typo is
  not fatal, but fix it anyway.)
- **`required_api`** — must list only DirectX APIs RenoDX can hook
  (`D3D9`/`D3D10`/`D3D11`/`D3D12`); never `Vulkan`/`OpenGl`. Pin engines that
  expose both a Vulkan and a DX backend (e.g. RDR2) to their DX API.
- **`risk`** — re-check current anti-cheat status. A title fronted by EAC/BattlEye
  should be `warn` with the engine set; the app *also* scans the game folder at
  install time and escalates to a confirm-gate if it finds EAC/BattlEye on disk,
  so this is defense-in-depth, not the only guard.
- **Add-on availability** — only ship a title once its RenoDX add-on actually
  exists and is mirrored; a recipe pointing at an unmirrored artifact will fail
  to fetch.

## Editing / growing the set

- **Resolve a pending title:** add an entry to `match_overlay.json` keyed by the
  title id (see `pending_match.json`) with a verified `appid` (preferred) and/or
  an `exe`, then re-run `generate_manifest.py`. Emulator-only titles (Switch
  games run via Cemu/Ryujinx, etc.) have no Steam AppID — match them by the
  emulator/exe scheme once that path is designed.
- **Add a new game:** it appears in `wiki_games.json` after re-scraping the wiki;
  give it overlay metadata as above.
- **Refresh from the wiki:** re-scrape the Mods table into `wiki_games.json`
  (keep one row per game, preserving shared slugs).

Overlay entry shapes (`match_overlay.json`, keyed by title id):
- `appid` / `appids` — one or several Steam AppIDs (several = the same game with
  duplicate regional store entries; all become tier-100 rules on one title).
- `exe` — exe-name backstop (tier 70); the robust route for delisted or
  non-Steam-store titles an owner still has on disk.
- `split` — a list of `{suffix, name, appid}` that expands one wiki row covering
  several games on a shared add-on (e.g. the Falcom-engine Trails titles) into a
  title per game, all reusing that add-on's recipe.
- `risk` / `conflicts` / `notes` — overrides merged onto the defaults.

Keep changes **additive** (new titles/recipes/artifacts) and bump
`min_app_version` only when a title needs a newer app; older clients safely
ignore entries they cannot handle.
