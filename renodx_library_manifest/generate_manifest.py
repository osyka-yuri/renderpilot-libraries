#!/usr/bin/env python3
"""Generate the RenoDX production manifest from authoritative inputs.

Data-driven and reproducible offline (no network), so the libraries repo can
regenerate the manifest at publish time:

  wiki_games.json    the full RenoDX Mods list scraped from the wiki — the
                     authoritative game name, add-on `slug` (= add-on file
                     name), architecture (x64/x86), and status. One row per game.
  match_overlay.json per-game metadata that the wiki does NOT carry: Steam AppID
                     (resolved by matching names against the Steam app list),
                     optional `exe` name, risk overrides for online/anti-cheat
                     titles, conflicts, and post-install note keys. Grown
                     incrementally, one curation pass at a time.

A title is emitted only when it has a usable match identifier (an AppID or an
exe name); games still lacking one are written to `pending_match.json` so the
next pass can resolve them. The add-on artifacts/recipes always come straight
from the wiki, so file names and architectures are correct from day one.

`sha256`/`size_bytes` are deterministic placeholders the publishing pipeline
fills from the mirrored bytes (see PUBLISHING.md).
"""

import json
import re
import unicodedata
from datetime import datetime, timezone

MIRROR_HOST = "pub-48612a35034d40f88f42b4181547925a.r2.dev"

# Addon-capable ReShade host DLL, one per architecture (an x86 game needs the
# x86 ReShade build). Reused by every recipe of the matching architecture.
RESHADE_VERSION = "6.7.3"
RENODX_ADDON_VERSION = "snapshot-2026.06"
MIN_RESHADE = "6.0.0"
ADDON_SIZE = 1_572_864
RESHADE_SIZE = 6_815_744

RENODX_CREDIT = "RenoDX by clshortfuse and contributors"
RENODX_SOURCE = "https://github.com/clshortfuse/renodx/wiki/Mods"

_counter = 0


def placeholder_sha256() -> str:
    global _counter
    _counter += 1
    return f"{_counter:064x}"


def addon_ext(arch: str) -> str:
    return "addon32" if arch == "X86" else "addon64"


def reshade_artifact(arch: str, sha: str) -> dict:
    tag = "x86" if arch == "X86" else "x64"
    return {
        "sha256": sha,
        "kind": "reshade_dll",
        "arch": arch,
        "version": RESHADE_VERSION,
        "size_bytes": RESHADE_SIZE,
        "compression": "none",
        "download": {
            "url": f"https://{MIRROR_HOST}/reshade/{RESHADE_VERSION}-addon-{tag}.dll",
            "host_policy": "mirror",
        },
        "provenance": {
            "author": "crosire",
            "license": "BSD-3-Clause",
            "credit": "ReShade by crosire (addon build, mirrored with attribution)",
            "source_url": "https://reshade.me",
            "upstream_version": RESHADE_VERSION,
        },
    }


def addon_artifact(slug: str, arch: str, sha: str) -> dict:
    tag = "x86" if arch == "X86" else "x64"
    ext = addon_ext(arch)
    return {
        "sha256": sha,
        "kind": "renodx_addon",
        "arch": arch,
        "version": RENODX_ADDON_VERSION,
        "size_bytes": ADDON_SIZE,
        "compression": "zstd",
        "download": {
            "url": f"https://{MIRROR_HOST}/renodx/{slug}-{tag}.{ext}.zst",
            "host_policy": "mirror",
        },
        "provenance": {
            "author": "clshortfuse and contributors",
            "license": "MIT",
            "credit": RENODX_CREDIT,
            "source_url": RENODX_SOURCE,
            "upstream_version": RENODX_ADDON_VERSION,
        },
    }


def recipe(slug: str, arch: str, addon_sha: str, reshade_sha: str, notes: list) -> dict:
    r = {
        "id": f"recipe.{slug}",
        "addon_ref": f"sha256:{addon_sha}",
        "reshade_ref": f"sha256:{reshade_sha}",
        "addon_file_name": f"renodx-{slug}.{addon_ext(arch)}",
        "min_reshade_version": MIN_RESHADE,
        "reshade_ini": {
            "disabled_addons": ["Generic Depth", "Effect Runtime Sync"],
            "addon_path": ".",
        },
    }
    if notes:
        r["notes_keys"] = notes
    return r


def default_risk() -> dict:
    return {
        "anticheat_engine": "none",
        "online": "singleplayer",
        "severity": "info",
        "message_key": "renodx.risk.sp_safe",
        "confidence": "medium",
        "source": RENODX_SOURCE,
    }


def make_title(title_id, name, status, recipe_ref, arch, appids=None, exe=None, ov=None):
    """Builds one title: exact store-id rules (tier 100) plus an optional
    exe-name backstop (tier 70). `appids` may list several ids for the same game
    (e.g. duplicate regional store entries)."""
    ov = ov or {}
    match = [{"kind": "steam_appid", "value": a, "tier": 100} for a in (appids or [])]
    if exe:
        match.append({"kind": "exe_name", "value": exe, "tier": 70})

    compatibility = {"required_arch": arch}
    if "apis" in ov:
        compatibility["required_api"] = ov["apis"]
    if "conflicts" in ov:
        compatibility["conflicts"] = ov["conflicts"]

    risk = default_risk()
    if "risk" in ov:
        risk.update(ov["risk"])

    return {
        "id": f"title.{title_id}",
        "name": name,
        # Working titles ship stable; in-progress / untested ones on beta.
        "channel": "stable" if status == "working" else "beta",
        "min_app_version": "1.0.0",
        "match": match,
        "compatibility": compatibility,
        "risk": risk,
        "recipe_ref": recipe_ref,
    }


def main() -> None:
    wiki = json.load(open("wiki_games.json", encoding="utf-8"))
    overlay = json.load(open("match_overlay.json", encoding="utf-8"))

    artifacts, recipes, titles, pending = [], [], [], []

    # Shared ReShade hosts, materialised lazily per architecture.
    reshade_sha = {}

    def reshade_for(arch: str) -> str:
        if arch not in reshade_sha:
            sha = placeholder_sha256()
            reshade_sha[arch] = sha
            artifacts.append(reshade_artifact(arch, sha))
        return reshade_sha[arch]

    # Add-on artifacts and recipes are de-duplicated by slug: several games can
    # share one add-on build (e.g. the FromSoftware/RE engines), so the recipe
    # layer is keyed by slug and reused by every title that points at it.
    recipe_by_slug = {}

    def recipe_for(slug: str, arch: str, notes: list) -> str:
        if slug not in recipe_by_slug:
            asha = placeholder_sha256()
            artifacts.append(addon_artifact(slug, arch, asha))
            recipes.append(recipe(slug, arch, asha, reshade_for(arch), notes))
            recipe_by_slug[slug] = f"recipe.{slug}"
        return recipe_by_slug[slug]

    for g in wiki:
        tid, slug, arch, status = g["id"], g["slug"], g["arch"], g["status"]
        ov = overlay.get(tid, {})

        # A "split" entry expands one wiki row that covers several distinct games
        # sharing a single add-on (e.g. the Falcom-engine Trails titles) into one
        # title per game, all pointing at the same recipe.
        if "split" in ov:
            recipe_ref = recipe_for(slug, arch, ov.get("notes", []))
            for sub in ov["split"]:
                titles.append(make_title(
                    f"{tid}-{sub['suffix']}", sub["name"], status, recipe_ref, arch,
                    appids=[sub["appid"]], ov=ov))
            continue

        appid = ov.get("appid")
        appids = ov.get("appids", [appid] if appid else [])
        exe = ov.get("exe")

        if not appids and not exe:
            pending.append({"id": tid, "name": g["name"], "slug": slug, "arch": arch})
            continue

        recipe_ref = recipe_for(slug, arch, ov.get("notes", []))
        titles.append(make_title(tid, g["name"], status, recipe_ref, arch,
                                 appids=appids, exe=exe, ov=ov))

    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z"),
        "artifacts": artifacts,
        "recipes": recipes,
        "titles": titles,
    }

    with open("renodx_manifest.json", "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    with open("pending_match.json", "w", encoding="utf-8") as fh:
        json.dump(pending, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    print(f"manifest: {len(artifacts)} artifacts, {len(recipes)} recipes, {len(titles)} titles")
    print(f"pending (no AppID/exe yet): {len(pending)} -> pending_match.json")


if __name__ == "__main__":
    main()
