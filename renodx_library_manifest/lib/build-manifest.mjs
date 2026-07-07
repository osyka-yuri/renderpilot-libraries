import {
  categoryOf,
  collectMatchedAppids,
  inheritedSplitOverlay,
  normalizeAppids,
  normalizeExeName,
  normalizeSlug,
  validateOverlay,
} from "./overlay.mjs";
import {
  assertPlainObject,
  deepFreeze,
  requiredNonEmptyString,
} from "../../scripts/lib/common.mjs";
import { RESHADE_STABLE, RESHADE_NIGHTLY } from "../../scripts/lib/reshade-sources.mjs";
import {
  DEFAULTS,
  VALID_STATUSES,
  applyChannel,
  applyMinAppVersion,
  assertUniqueMatchRules,
  countTitlesByCategoryKind,
  createDerivedExeResolver,
  makeMatchRules,
  normalizeExeCache,
  normalizedStatus,
  reserveOutputId,
} from "../../scripts/lib/build-manifest-shared.mjs";

export const SCHEMA_VERSION = 3;

export const RESHADE = deepFreeze({
  stable: RESHADE_STABLE,
  nightly: RESHADE_NIGHTLY,
});

export const GENERICS = deepFreeze([
  {
    engine: "unity",
    slug: "unityengine",
    url64:
      "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon64",
    url32:
      "https://github.com/NotVoosh/renodx-unity/releases/download/snapshot/renodx-unityengine.addon32",
    label_key: "renodx.generic.unity",
  },
  {
    engine: "unreal",
    slug: "unrealengine",
    label_key: "renodx.generic.universal",
  },
]);

export function buildManifest({
  wiki,
  overlay = {},
  exeCache = {},
  generatedAt,
  warn = console.warn,
} = {}) {
  const wikiGames = normalizeWikiGames(wiki);
  const overlayById = assertOverlayShape(overlay);
  const wikiIds = new Set(wikiGames.map((game) => game.id));

  validateOverlay(overlayById, wikiIds, warn);

  const activeAppids = collectMatchedAppids(wikiGames, overlayById);
  const { exeToAppids, exeCache: normalizedExeCache } = normalizeExeCache(
    exeCache,
    activeAppids,
  );

  const { uniqueExesForAppids, ambiguousDerivedExeKeys } = createDerivedExeResolver(
    normalizedExeCache,
    exeToAppids,
  );

  const titles = [];
  const pending = [];
  const seenOutputIds = new Set();

  const emit = ({ id, name, slug, arch, status, entry, context }) => {
    reserveOutputId(seenOutputIds, id, context);

    const appids = normalizeAppids(entry, context);
    const exe = normalizeExeName(entry.exe, `${context}.exe`);

    if (entry.ignore) {
      // Cleanly skip duplicate or broken wiki entries so they don't clutter pending_match
      return;
    }

    if (appids.length === 0 && !exe) {
      pending.push({ id, name, slug, arch });
      return;
    }

    titles.push(
      makeTitle({
        id,
        name,
        slug,
        arch,
        status,
        appids,
        exe,
        derivedExes: uniqueExesForAppids(appids),
        overlay: entry,
        category: categoryOf(entry, context),
      }),
    );
  };

  for (const game of wikiGames) {
    const entry = overlayById[game.id] ?? {};
    const baseSlug = normalizeSlug(entry.slug ?? game.slug, `overlay "${game.id}".slug`);

    if (Array.isArray(entry.split)) {
      emitSplits({ game, entry, emit });
      continue;
    }

    emit({
      id: game.id,
      name: game.name,
      slug: baseSlug,
      arch: game.arch,
      status: game.status,
      entry,
      context: `overlay "${game.id}"`,
    });
  }

  assertUniqueMatchRules(titles);

  return {
    manifest: {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      reshade: RESHADE,
      generics: GENERICS,
      defaults: DEFAULTS,
      titles,
    },
    pending,
    stats: buildStats(titles, pending, ambiguousDerivedExeKeys),
  };
}

function emitSplits({ game, entry, emit }) {
  for (const [index, split] of entry.split.entries()) {
    const context = `overlay "${game.id}".split[${index}]`;
    const splitOverlay = inheritedSplitOverlay(entry, split);
    const suffix = requiredNonEmptyString(split.suffix, `${context}.suffix`);
    const name = requiredNonEmptyString(split.name, `${context}.name`);
    const slug = normalizeSlug(splitOverlay.slug ?? game.slug, `${context}.slug`);

    emit({
      id: `${game.id}-${suffix}`,
      name,
      slug,
      arch: game.arch,
      status: game.status,
      entry: splitOverlay,
      context,
    });
  }
}

function makeTitle({
  id,
  name,
  slug,
  arch,
  status,
  appids,
  exe,
  derivedExes,
  overlay,
  category,
}) {
  const titleStatus = normalizedStatus(status, VALID_STATUSES);
  const title = {
    id,
    name,
    slug,
    arch,
    status: titleStatus,
  };

  if (category) {
    title.category = category;
  }

  title.match = makeMatchRules({ id, appids, exe, derivedExes });

  applyChannel(title, titleStatus);
  applyMinAppVersion(title, overlay);
  applyCompatibility(title, overlay);
  applyOptionalOverlayFields(title, overlay);

  return title;
}

function applyCompatibility(title, overlay) {
  const compatibility = {};

  if (overlay.required_api) {
    compatibility.required_api = overlay.required_api;
  }

  if (overlay.conflicts) {
    compatibility.conflicts = overlay.conflicts;
  }

  if (overlay.compatibility_source) {
    compatibility.source = overlay.compatibility_source;
  }

  if (Object.keys(compatibility).length > 0) {
    title.compatibility = compatibility;
  }
}

function applyOptionalOverlayFields(title, overlay) {
  if (overlay.proxy_dll_override) {
    title.proxy_dll_override = overlay.proxy_dll_override;
  }

  if (overlay.notes_keys) {
    title.notes_keys = overlay.notes_keys;
  }

  if (overlay.download_url) {
    title.download_url = overlay.download_url;
  }
}

function normalizeWikiGames(wiki) {
  if (!Array.isArray(wiki)) {
    throw new Error("wiki_games.json must be an array");
  }

  return wiki.map((game, index) => normalizeWikiGame(game, index));
}

function normalizeWikiGame(game, index) {
  const context = `wiki_games.json[${index}]`;

  assertPlainObject(game, context);

  return {
    ...game,
    id: requiredNonEmptyString(game.id, `${context}.id`),
    name: requiredNonEmptyString(game.name, `${context}.name`),
    slug: normalizeSlug(
      requiredNonEmptyString(game.slug, `${context}.slug`),
      `${context}.slug`,
    ),
    arch: requiredNonEmptyString(game.arch, `${context}.arch`),
  };
}

function assertOverlayShape(overlay) {
  assertPlainObject(overlay, "match_overlay.json");
  return overlay;
}

function buildStats(titles, pending, ambiguousDerivedExeKeys) {
  return {
    titles: titles.length,
    pending: pending.length,
    generics: GENERICS.length,
    ambiguousDerivedExes: ambiguousDerivedExeKeys.size,
    external: countTitlesByCategoryKind(titles, "external"),
    native_hdr: countTitlesByCategoryKind(titles, "native_hdr"),
    blacklist: countTitlesByCategoryKind(titles, "blacklist"),
  };
}
