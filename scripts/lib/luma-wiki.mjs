// Luma-specific parsing and reconciliation. The generic Markdown and network
// primitives are shared with RenoDX; the table meaning stays explicit here.

import { isPlainObject } from "./common.mjs";
import {
  extractMarkdownTables,
  normalizeWikiName,
  wikiStatusFromCell,
} from "./wiki-markdown.mjs";

const LUMA_ASSET_RE = /Luma-[A-Za-z0-9_.()-]+(?:-x32)?\.zip/i;
const UNREAL_ASSET = "Luma-Unreal_Engine.zip";

function extractAssetFromCell(cell) {
  return String(cell).match(LUMA_ASSET_RE)?.[0] ?? null;
}

function extractNameFromCell(cell) {
  const raw = String(cell).trim();
  if (!raw) return null;

  const linkLabel = raw.match(/\[([^\]]*)\]\([^)]*\)/)?.[1]?.trim();
  if (linkLabel && !linkLabel.startsWith("!") && !linkLabel.includes("shield")) {
    return linkLabel.replace(/\*\*/g, "").trim();
  }

  const stripped = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\*/g, "")
    .trim();
  return stripped || null;
}

function tableColumns(headers, type) {
  if (type === "completed") {
    return {
      name: headers.indexOf("name"),
      asset: headers.indexOf("download link"),
      status: headers.indexOf("status"),
    };
  }
  if (type === "wip") {
    return { name: headers.indexOf("name"), status: headers.indexOf("status") };
  }
  return {
    name: headers.indexOf("name"),
    dlss:
      headers.indexOf("dlss/fsr") >= 0
        ? headers.indexOf("dlss/fsr")
        : headers.indexOf("dlss"),
    hdr: headers.indexOf("hdr"),
  };
}

function tableType(headers) {
  const has = (name) => headers.includes(name);
  if (has("name") && has("download link") && has("status")) return "completed";
  if (has("name") && (has("dlss/fsr") || has("dlss"))) return "unreal";
  if (
    has("name") &&
    has("status") &&
    has("author") &&
    !has("download link") &&
    !has("dlss/fsr") &&
    !has("dlss")
  ) {
    return "wip";
  }
  return null;
}

export function parseLumaWikiRows(markdown) {
  const rows = [];

  for (const table of extractMarkdownTables(markdown)) {
    const type = tableType(table.headers);
    if (!type) continue;

    const columns = tableColumns(table.headers, type);
    if (columns.name < 0) continue;

    for (const cells of table.rows) {
      const name = extractNameFromCell(cells[columns.name] ?? "");
      if (!name) continue;

      if (type === "completed") {
        const status = wikiStatusFromCell(cells[columns.status] ?? "", null);
        if (status) {
          rows.push({
            name,
            status,
            asset: extractAssetFromCell(cells[columns.asset] ?? ""),
            section: type,
          });
        }
      } else if (type === "wip") {
        if (wikiStatusFromCell(cells[columns.status] ?? "", null) === "construction") {
          rows.push({ name, status: "construction", asset: null, section: type });
        }
      } else {
        const status =
          wikiStatusFromCell(cells[columns.dlss] ?? "", null) ??
          wikiStatusFromCell(cells[columns.hdr] ?? "", null) ??
          "working";
        rows.push({ name, status, asset: UNREAL_ASSET, section: type });
      }
    }
  }

  return rows;
}

function assertCuratedGames(curatedGames) {
  if (!Array.isArray(curatedGames)) {
    throw new Error("curated_games.json must be a JSON array");
  }

  for (const [index, game] of curatedGames.entries()) {
    const context = `curated_games.json[${index}]`;
    if (!isPlainObject(game)) throw new Error(`${context} must be an object`);
    if (typeof game.id !== "string" || game.id.trim() === "") {
      throw new Error(`${context}.id must be a non-empty string`);
    }
    if (typeof game.name !== "string" || game.name.trim() === "") {
      throw new Error(`${context}.name must be a non-empty string`);
    }
    if (game.wiki_aliases !== undefined) {
      if (!Array.isArray(game.wiki_aliases)) {
        throw new Error(`${context}.wiki_aliases must be an array when present`);
      }
      for (const alias of game.wiki_aliases) {
        if (typeof alias !== "string" || normalizeWikiName(alias) === "") {
          throw new Error(`${context}.wiki_aliases must contain non-empty names`);
        }
      }
    }
  }
}

function addCandidate(index, key, game) {
  if (!key) return;
  const candidates = index.get(key) ?? [];
  if (!candidates.includes(game)) candidates.push(game);
  index.set(key, candidates);
}

function buildIndexes(curatedGames) {
  const byAsset = new Map();
  const byName = new Map();

  for (const game of curatedGames) {
    if (typeof game.asset === "string" && game.asset.trim()) {
      addCandidate(byAsset, game.asset.toLowerCase(), game);
    }
    addCandidate(byName, normalizeWikiName(game.name), game);
    for (const alias of game.wiki_aliases ?? []) {
      addCandidate(byName, normalizeWikiName(alias), game);
    }
  }

  return { byAsset, byName };
}

function onlyCandidate(index, key) {
  const candidates = key ? (index.get(key) ?? []) : [];
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveWikiRow(row, indexes) {
  const byAsset = onlyCandidate(indexes.byAsset, row.asset?.toLowerCase());
  const byName = onlyCandidate(indexes.byName, normalizeWikiName(row.name));

  if (byAsset && byName && byAsset !== byName) {
    return { kind: "ambiguous", reason: "asset and name identify different curated games" };
  }
  if (byAsset || byName) return { kind: "matched", game: byAsset ?? byName };

  const assetCandidates = row.asset
    ? (indexes.byAsset.get(row.asset.toLowerCase()) ?? [])
    : [];
  const nameCandidates = indexes.byName.get(normalizeWikiName(row.name)) ?? [];
  if (assetCandidates.length > 1 || nameCandidates.length > 1) {
    return { kind: "ambiguous", reason: "wiki row has multiple curated candidates" };
  }
  return { kind: "unmatched" };
}

export function reconcileLumaStatuses({ curatedGames, wikiRows }) {
  assertCuratedGames(curatedGames);
  if (!Array.isArray(wikiRows)) throw new Error("wikiRows must be an array");

  const indexes = buildIndexes(curatedGames);
  const candidatesByGame = new Map();
  const notInCurated = [];
  const ambiguous = [];

  for (const row of wikiRows) {
    const resolution = resolveWikiRow(row, indexes);
    if (resolution.kind === "matched") {
      const candidates = candidatesByGame.get(resolution.game.id) ?? [];
      candidates.push(row);
      candidatesByGame.set(resolution.game.id, candidates);
    } else if (resolution.kind === "ambiguous") {
      ambiguous.push({ row, reason: resolution.reason });
    } else {
      notInCurated.push(row);
    }
  }

  const changes = [];
  const unchanged = [];
  const unmatched = [];
  const ambiguousGameIds = new Set();
  const statusById = new Map();

  for (const game of curatedGames) {
    const rows = candidatesByGame.get(game.id) ?? [];
    if (rows.length === 0) {
      unmatched.push(game.name);
      continue;
    }
    if (rows.length > 1) {
      ambiguousGameIds.add(game.id);
      ambiguous.push({
        game: game.name,
        reason: "multiple wiki rows identify the same curated game",
        rows,
      });
      continue;
    }

    const [row] = rows;
    statusById.set(game.id, row.status);
    if ((game.status ?? "unknown") === row.status) {
      unchanged.push(game.name);
    } else {
      changes.push({
        id: game.id,
        name: game.name,
        from: game.status ?? "unknown",
        to: row.status,
      });
    }
  }

  const nextCuratedGames = curatedGames.map((game) => {
    const status = statusById.get(game.id);
    return status && !ambiguousGameIds.has(game.id) ? { ...game, status } : { ...game };
  });

  return { nextCuratedGames, changes, unchanged, unmatched, notInCurated, ambiguous };
}
