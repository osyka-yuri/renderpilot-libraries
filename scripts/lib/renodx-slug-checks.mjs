// Pure helpers for the RenoDX slug/add-on availability guard against the
// canonical v1 catalogue (`addons/v1/renodx.json`).
//
// Kept free of IO and network access so the name-derivation, classification,
// and mismatch logic is unit-testable. The wrapper script
// (scripts/check-renodx-slugs.mjs) owns the manifest read, the GitHub snapshot
// fetch, the console output, and `main`.

import {
  isPlainObject as isRecord,
  requiredNonEmptyString as requiredString,
} from "./common.mjs";
import { addonFile, addonBasenameFromUrl, sameFileName } from "./addon-naming.mjs";

/** v1 availability kinds that are never installed from the official snapshot. */
export const OFF_SNAPSHOT_AVAILABILITY_KINDS = new Set([
  "external",
  "native_hdr",
  "blocked",
]);

export function assertManifestShape(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("addons/v1/renodx.json must contain a JSON object");
  }

  if (!Array.isArray(manifest.games)) {
    throw new Error("addons/v1/renodx.json must contain a `games` array");
  }

  if (!Array.isArray(manifest.engine_profiles)) {
    throw new Error("addons/v1/renodx.json must contain an `engine_profiles` array");
  }
}

export function assertGame(game, index) {
  if (!isRecord(game)) {
    throw new Error(`games[${index}] must be an object`);
  }
}

export function assertProfile(profile, index) {
  if (!isRecord(profile)) {
    throw new Error(`engine_profiles[${index}] must be an object`);
  }
}

export function gameLabel(game, index) {
  return typeof game.id === "string" && game.id.trim() !== ""
    ? game.id.trim()
    : `games[${index}]`;
}

export function profileLabel(profile, index) {
  return typeof profile.engine === "string" && profile.engine.trim() !== ""
    ? `engine_profile:${profile.engine.trim()}`
    : `engine_profiles[${index}]`;
}

export function isOffSnapshotGame(game) {
  if (game?.addon?.source) {
    return true;
  }

  return OFF_SNAPSHOT_AVAILABILITY_KINDS.has(game?.availability?.kind);
}

/** Snapshot-hosted engine profile: has slug, no explicit per-arch sources. */
export function isSnapshotHostedProfile(profile) {
  return Boolean(profile?.addon?.slug) && !profile?.addon?.sources;
}

export function expectedGameAddon(game, index) {
  const label = gameLabel(game, index);
  const slug = requiredString(game?.addon?.slug, `${label}.addon.slug`);
  const arch = requiredString(game?.architecture, `${label}.architecture`);

  return addonFile(slug, arch);
}

export function expectedProfileAddon(profile, index) {
  const label = profileLabel(profile, index);
  const slug = requiredString(profile?.addon?.slug, `${label}.addon.slug`);

  return addonFile(slug, "X64");
}

export function checkGames(games, engineProfiles, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  const offSnapshotSlugs = new Set(
    engineProfiles
      .filter((profile) => !isSnapshotHostedProfile(profile))
      .map((profile) => profile?.addon?.slug)
      .filter((slug) => typeof slug === "string" && slug.length > 0),
  );

  for (const [index, game] of games.entries()) {
    assertGame(game, index);

    if (isOffSnapshotGame(game) || offSnapshotSlugs.has(game?.addon?.slug)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedGameAddon(game, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${gameLabel(game, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

export function checkProfiles(engineProfiles, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, profile] of engineProfiles.entries()) {
    assertProfile(profile, index);

    if (!isSnapshotHostedProfile(profile)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedProfileAddon(profile, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${profileLabel(profile, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

export function checkExplicitGameAddonNames(games) {
  const mismatches = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, game] of games.entries()) {
    assertGame(game, index);

    if (!game?.addon?.source) {
      skipped++;
      continue;
    }

    checked++;

    const label = gameLabel(game, index);
    const expected = expectedGameAddon(game, index);
    const actual = addonBasenameFromUrl(game.addon.source, `${label}.addon.source`);

    if (!sameFileName(actual, expected)) {
      mismatches.push(`${label}: ${actual} should be ${expected}`);
    }
  }

  return { checked, skipped, mismatches };
}

export function checkExplicitProfileAddonNames(engineProfiles) {
  const mismatches = [];
  const structural = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, profile] of engineProfiles.entries()) {
    assertProfile(profile, index);

    const label = profileLabel(profile, index);
    const sources = profile?.addon?.sources;

    if (!sources) {
      skipped++;
      continue;
    }

    if (!isRecord(sources)) {
      structural.push(`${label}: addon.sources must be an object`);
      continue;
    }

    const has64 = Boolean(sources.x64);
    const has32 = Boolean(sources.x86);

    if (has64 !== has32) {
      structural.push(`${label}: addon.sources.x64 and x86 must be provided together`);
      continue;
    }

    if (!has64 && !has32) {
      skipped++;
      continue;
    }

    if (!profile?.addon?.slug) {
      skipped++;
      continue;
    }

    const localSlug = requiredString(profile.addon.slug, `${label}.addon.slug`);

    for (const [field, arch] of [
      ["x64", "X64"],
      ["x86", "X86"],
    ]) {
      if (!sources[field]) {
        continue;
      }

      checked++;

      const expected = addonFile(localSlug, arch);
      const actual = addonBasenameFromUrl(
        sources[field],
        `${label}.addon.sources.${field}`,
      );

      if (!sameFileName(actual, expected)) {
        mismatches.push(`${label}.addon.sources.${field}: ${actual} should be ${expected}`);
      }
    }
  }

  return { checked, skipped, mismatches, structural };
}

export function checkExplicitAddonNames(manifest) {
  const gameResult = checkExplicitGameAddonNames(manifest.games);
  const profileResult = checkExplicitProfileAddonNames(manifest.engine_profiles);

  return {
    checked: gameResult.checked + profileResult.checked,
    skipped: gameResult.skipped + profileResult.skipped,
    mismatches: [...gameResult.mismatches, ...profileResult.mismatches],
    structural: profileResult.structural,
  };
}
