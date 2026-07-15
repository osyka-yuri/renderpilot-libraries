import {
  UNREAL_ASSET,
  UNITY_ASSET,
  UNITY_ASSET_X32,
} from "../../catalogs/addons/luma/lib/v1.mjs";
import { isPlainObject } from "./common.mjs";
import { auditLumaWiki } from "./luma-wiki-audit.mjs";
import { normalizeLumaName } from "./luma-wiki-parser.mjs";

const SHARED_ENGINE_ASSETS = new Set([UNREAL_ASSET, UNITY_ASSET, UNITY_ASSET_X32]);

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
        if (typeof alias !== "string" || normalizeLumaName(alias) === "") {
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
    addCandidate(byName, normalizeLumaName(game.name), game);
    for (const alias of game.wiki_aliases ?? []) {
      addCandidate(byName, normalizeLumaName(alias), game);
    }
  }
  return { byAsset, byName };
}

function resolveUnique(candidates, description) {
  if (candidates.length === 1) return { kind: "matched", game: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", reason: description };
  return null;
}

function resolveWikiRow(row, indexes) {
  const nameCandidates = indexes.byName.get(normalizeLumaName(row.name)) ?? [];

  if (row.section === "unreal") {
    const unrealCandidates = nameCandidates.filter((game) => game.profile === "unreal");
    const resolution = resolveUnique(
      unrealCandidates,
      "UE wiki row has multiple Unreal profile name/alias candidates",
    );
    if (resolution) return resolution;
    if (nameCandidates.length > 0) {
      return { kind: "ambiguous", reason: "UE wiki name resolves to a non-Unreal profile" };
    }
    return { kind: "unmatched" };
  }

  const assetCandidates = row.asset
    ? (indexes.byAsset.get(row.asset.toLowerCase()) ?? [])
    : [];
  const byName = resolveUnique(
    nameCandidates,
    "wiki row has multiple name/alias candidates",
  );
  const byAsset = SHARED_ENGINE_ASSETS.has(row.asset)
    ? null
    : resolveUnique(assetCandidates, "wiki row asset has multiple curated candidates");

  if (byName?.kind === "ambiguous" || byAsset?.kind === "ambiguous") {
    return byName?.kind === "ambiguous" ? byName : byAsset;
  }
  if (byName && byAsset && byName.game !== byAsset.game) {
    return { kind: "ambiguous", reason: "asset and name identify different curated games" };
  }
  return byName ?? byAsset ?? { kind: "unmatched" };
}

function resolveGameRows(game, rows) {
  if (rows.length === 1) return { kind: "matched", row: rows[0] };

  if (game.profile === "unreal") {
    const unrealRows = rows.filter((row) => row.section === "unreal");
    if (unrealRows.length === 1) return { kind: "matched", row: unrealRows[0] };
  }

  const [first] = rows;
  if (
    rows.every(
      (row) =>
        row.status === first.status &&
        row.note === null &&
        row.section === first.section &&
        row.features === undefined,
    )
  ) {
    return { kind: "matched", row: first };
  }
  return { kind: "ambiguous", reason: "multiple wiki rows identify the same curated game" };
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
  const featuresById = new Map();

  for (const game of curatedGames) {
    const rows = candidatesByGame.get(game.id) ?? [];
    if (rows.length === 0) {
      unmatched.push(game.name);
      continue;
    }
    const resolution = resolveGameRows(game, rows);
    if (resolution.kind === "ambiguous") {
      ambiguousGameIds.add(game.id);
      ambiguous.push({ game: game.name, reason: resolution.reason, rows });
      continue;
    }

    const { row } = resolution;
    statusById.set(game.id, row.status);
    if (row.section === "unreal") featuresById.set(game.id, row.features);
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

  const featureChanges = [];
  const nextCuratedGames = curatedGames.map((game) => {
    const next = { ...game };
    const status = statusById.get(game.id);
    if (status && !ambiguousGameIds.has(game.id)) next.status = status;

    if (game.profile === "unreal" && !ambiguousGameIds.has(game.id)) {
      const features = featuresById.get(game.id);
      if (features) {
        if (
          game.features?.dlss_fsr !== features.dlss_fsr ||
          game.features?.hdr !== features.hdr
        ) {
          featureChanges.push({
            id: game.id,
            name: game.name,
            from: game.features,
            to: features,
          });
        }
        next.features = features;
      }
    } else {
      delete next.features;
    }
    return next;
  });

  const audit = auditLumaWiki({
    curatedGames,
    candidatesByGame,
    wikiRows,
    notInCurated,
    ambiguous,
    unmatched,
  });

  return {
    nextCuratedGames,
    changes,
    featureChanges,
    unchanged,
    unmatched,
    notInCurated,
    ambiguous,
    ...audit,
  };
}
