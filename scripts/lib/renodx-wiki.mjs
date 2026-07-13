import { isPlainObject } from "./common.mjs";
import {
  extractMarkdownLinkLabel,
  extractMarkdownTables,
  normalizeWikiName,
  wikiStatusFromCell,
} from "./wiki-markdown.mjs";

export const ADDON_URL_RE =
  /(https:\/\/[^/]+\/[^/]+\/renodx[a-zA-Z0-9_-]*\/releases\/download\/[^/]+\/renodx-[a-zA-Z0-9_-]+\.addon(?:32|64))/i;
export const NEXUS_URL_RE = /(https:\/\/www\.nexusmods\.com\/[^/]+\/mods\/\d+)/i;
export const DISCORD_URL_RE = /(https:\/\/(?:ptb\.)?discord\.com\/channels\/\d+\/\d+)/i;

export function getModsTableHeaderColumns(headers) {
  const nameIndex = headers.findIndex((header) => header === "name");
  const maintainerIndex = headers.findIndex((header) => header === "maintainer");
  const statusIndex = headers.findIndex((header) => header === "status");
  const linksIndex = headers.findIndex((header) => header === "links");
  const notesIndex = headers.findIndex((header) => header === "notes");
  const hasSupportingColumn = maintainerIndex >= 0 || statusIndex >= 0 || linksIndex >= 0;

  if (nameIndex < 0 || !hasSupportingColumn) return null;

  return { nameIndex, maintainerIndex, statusIndex, linksIndex, notesIndex };
}

export function extractUrl(value, regex) {
  return (
    String(value)
      .match(regex)?.[1]
      ?.replace(/[.,;]+$/, "") ?? null
  );
}

export function parseStatus(statusColumn) {
  return wikiStatusFromCell(statusColumn);
}

function getCellValue(columns, index) {
  return index >= 0 && index < columns.length ? (columns[index] ?? "") : "";
}

export function parseWikiRow(columns, columnsMapping, engineContext) {
  if (columns.length < 2) return null;

  const name = extractMarkdownLinkLabel(getCellValue(columns, columnsMapping.nameIndex));
  if (!name) return null;

  const linksColumn = getCellValue(columns, columnsMapping.linksIndex);
  const notesColumn = getCellValue(columns, columnsMapping.notesIndex);
  const statusColumn = getCellValue(columns, columnsMapping.statusIndex);
  const addonMatch = linksColumn.match(ADDON_URL_RE);
  const addonUrl = addonMatch?.[1] ?? null;

  let arch = addonMatch?.[2] === "32" ? "X86" : "X64";
  if (!addonUrl && notesColumn.match(/\b32(-|\s)?bit\b/i)) arch = "X86";

  let addonSlug = addonUrl?.match(/renodx-([a-zA-Z0-9_-]+)\.addon(?:32|64)/i)?.[1] ?? null;
  if (!addonUrl && engineContext === "unity") addonSlug = "unityengine";
  if (!addonUrl && engineContext === "unreal") addonSlug = "unrealengine";

  return {
    name,
    status: parseStatus(statusColumn),
    addonUrl,
    arch,
    addonSlug,
    nexusUrl: extractUrl(linksColumn, NEXUS_URL_RE),
    discordUrl: extractUrl(linksColumn, DISCORD_URL_RE),
  };
}

// ── RenoDX catalogue and overlay reconciliation ────────────────────────────

export const EXTERNAL_LABELS = Object.freeze({
  nexus: "renodx.external.nexus",
  discord: "renodx.external.discord",
});

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseRenodxWikiRows(markdown) {
  const rows = [];
  let sawModsTable = false;

  for (const table of extractMarkdownTables(markdown)) {
    const columnsMapping = getModsTableHeaderColumns(table.headers);
    if (!columnsMapping) continue;

    sawModsTable = true;
    for (const cells of table.rows) {
      const row = parseWikiRow(cells, columnsMapping, table.engineContext);
      if (row) rows.push(row);
    }
  }

  if (!sawModsTable) throw new Error("Could not find the Mods table in the RenoDX wiki.");
  if (rows.length === 0) {
    throw new Error("Found the Mods table, but parsed zero game rows.");
  }
  return rows;
}

function buildIdLookups(existingWiki) {
  const nameToId = new Map();
  const strippedNameToId = new Map();
  const gameById = new Map();

  for (const game of existingWiki) {
    if (
      !isPlainObject(game) ||
      typeof game.name !== "string" ||
      typeof game.id !== "string"
    ) {
      continue;
    }

    nameToId.set(game.name, game.id);
    const stripped = normalizeWikiName(game.name);
    if (stripped && !strippedNameToId.has(stripped)) {
      strippedNameToId.set(stripped, game.id);
    }
    gameById.set(game.id, game);
  }

  return { nameToId, strippedNameToId, gameById };
}

function resolveId(name, lookups) {
  const id =
    lookups.nameToId.get(name) ??
    lookups.strippedNameToId.get(normalizeWikiName(name)) ??
    slugify(name);
  if (!id) throw new Error(`Could not resolve a non-empty id for game name: ${name}`);
  return id;
}

function getOverlayEntry(overlay, id) {
  const entry = overlay[id];
  if (entry === undefined) return undefined;
  if (!isPlainObject(entry)) {
    throw new Error(`Overlay entry "${id}" must be a JSON object.`);
  }
  return entry;
}

function preferredSlugForGame({ id, row, overlayEntry, oldGame }) {
  const slug = overlayEntry?.slug ?? row.addonSlug ?? oldGame?.slug ?? id;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Could not resolve a non-empty slug for "${row.name}" (${id}).`);
  }
  return slug;
}

function addonAssetName(slug, arch) {
  return `renodx-${slug}.${arch === "X86" ? "addon32" : "addon64"}`;
}

function isOfficialAddonUrl(addonUrl) {
  if (!addonUrl) return false;
  try {
    const url = new URL(addonUrl);
    return (
      url.hostname.toLowerCase() === "clshortfuse.github.io" ||
      (url.hostname.toLowerCase() === "github.com" &&
        url.pathname.toLowerCase().startsWith("/clshortfuse/renodx/"))
    );
  } catch {
    return false;
  }
}

function uniqueNonEmpty(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value.length > 0)),
  ];
}

function resolveOfficialAddon({ addonUrl, slug, arch, name, officialAssets }) {
  let isOfficial = isOfficialAddonUrl(addonUrl);
  if (officialAssets.size > 0 && officialAssets.has(addonAssetName(slug, arch))) {
    isOfficial = true;
  }
  if (officialAssets.size === 0 || isOfficial) return { isOfficial, slug, arch };

  for (const candidateSlug of uniqueNonEmpty([normalizeWikiName(name), slugify(name)])) {
    for (const bits of ["32", "64"]) {
      if (officialAssets.has(`renodx-${candidateSlug}.addon${bits}`)) {
        return {
          isOfficial: true,
          slug: candidateSlug,
          arch: bits === "32" ? "X86" : "X64",
        };
      }
    }
  }

  return { isOfficial: false, slug, arch };
}

function deleteIfEmpty(overlay, id) {
  if (overlay[id] && Object.keys(overlay[id]).length === 0) delete overlay[id];
}

function clearAvailabilityMarkers(overlay, id) {
  const entry = getOverlayEntry(overlay, id);
  if (!entry) return "official";
  delete entry.external;
  delete entry.blacklist;
  delete entry.download_url;
  deleteIfEmpty(overlay, id);
  return "official";
}

function ensureOverlayEntry(overlay, id) {
  return getOverlayEntry(overlay, id) ?? (overlay[id] = {});
}

function applyOverlayAvailability({
  overlay,
  id,
  isOfficial,
  addonUrl,
  nexusUrl,
  discordUrl,
}) {
  if (isOfficial) return clearAvailabilityMarkers(overlay, id);

  if (addonUrl) {
    const entry = ensureOverlayEntry(overlay, id);
    entry.download_url = addonUrl;
    delete entry.external;
    delete entry.blacklist;
    return "download_url";
  }

  const externalUrl = nexusUrl ?? discordUrl;
  if (externalUrl) {
    const entry = ensureOverlayEntry(overlay, id);
    entry.external = {
      url: externalUrl,
      label_key: externalUrl === nexusUrl ? EXTERNAL_LABELS.nexus : EXTERNAL_LABELS.discord,
    };
    delete entry.blacklist;
    delete entry.download_url;
    return "external";
  }

  return "unchanged";
}

export function reconcileRenodxWiki({ rows, existingWiki, overlay, officialAssets }) {
  if (!Array.isArray(rows) || !Array.isArray(existingWiki) || !isPlainObject(overlay)) {
    throw new Error(
      "RenoDX reconciliation expects rows, existingWiki, and overlay JSON values",
    );
  }
  if (!(officialAssets instanceof Set)) throw new Error("officialAssets must be a Set");

  const nextOverlay = structuredClone(overlay);
  const lookups = buildIdLookups(existingWiki);
  const wikiGames = [];
  const seenIds = new Set();
  const warnings = [];
  const stats = { official: 0, download_url: 0, external: 0, unchanged: 0 };

  for (const row of rows) {
    const id = resolveId(row.name, lookups);
    if (seenIds.has(id)) {
      warnings.push(
        `Wiki produced duplicate id "${id}" while processing "${row.name}", skipping duplicate row.`,
      );
      continue;
    }
    seenIds.add(id);

    const overlayEntry = getOverlayEntry(nextOverlay, id);
    const preferredSlug = preferredSlugForGame({
      id,
      row,
      overlayEntry,
      oldGame: lookups.gameById.get(id),
    });
    const resolved = resolveOfficialAddon({
      addonUrl: row.addonUrl,
      slug: preferredSlug,
      arch: row.arch,
      name: row.name,
      officialAssets,
    });

    wikiGames.push({
      name: row.name,
      slug: resolved.slug,
      arch: resolved.arch,
      status: row.status,
      id,
    });
    const availability = applyOverlayAvailability({
      overlay: nextOverlay,
      id,
      isOfficial: resolved.isOfficial,
      addonUrl: row.addonUrl,
      nexusUrl: row.nexusUrl,
      discordUrl: row.discordUrl,
    });
    stats[availability] += 1;
  }

  return { wikiGames, overlay: nextOverlay, stats, warnings };
}
