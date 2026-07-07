import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage, isMissingFileError } from "./lib/common.mjs";
import { readJsonFileAsync, stringifyFormattedJson } from "./lib/json.mjs";
import { repoRoot } from "./catalog.mjs";
import { searchSteamStore, normalize } from "./lib/steam-search.mjs";
import { collectOverlayAppids as collectRenoOverlayAppids } from "../renodx_library_manifest/lib/overlay.mjs";
import { collectOverlayAppids as collectLumaOverlayAppids } from "../luma_library_manifest/lib/overlay.mjs";

// Every per-tool manifest pipeline (RenoDX, Luma, …) shares the same
// pending-match workflow: `generate-manifest.mjs` lists unmatched games in
// `pending_match.json`; this script resolves as many as it can via the Steam
// Store search API and writes the result into `match_overlay.json`.
const TOOLS = Object.freeze({
  renodx: Object.freeze({
    manifestDir: "renodx_library_manifest",
    manifestFile: "renodx_manifest.json",
    collectOverlayAppids: collectRenoOverlayAppids,
  }),
  luma: Object.freeze({
    manifestDir: "luma_library_manifest",
    manifestFile: "luma_manifest.json",
    collectOverlayAppids: collectLumaOverlayAppids,
  }),
});

const DEFAULT_TOOL = "renodx";

const UNMATCHED_REASON = {
  apiFailed: "API Request Failed",
  noExactMatch: "No exact match found in Steam Store search",
};

export function parseToolArg(argv) {
  const toolArg = argv.find((arg) => arg.startsWith("--tool="));
  const tool = toolArg ? toolArg.slice("--tool=".length) : DEFAULT_TOOL;

  if (!Object.hasOwn(TOOLS, tool)) {
    throw new Error(
      `Unknown --tool "${tool}"; expected one of: ${Object.keys(TOOLS).join(", ")}`,
    );
  }

  return tool;
}

export function filesForTool(tool) {
  const { manifestDir, manifestFile } = TOOLS[tool];
  const manifestDirPath = path.join(repoRoot, manifestDir);

  return {
    pendingMatch: path.join(manifestDirPath, "pending_match.json"),
    matchOverlay: path.join(manifestDirPath, "match_overlay.json"),
    unmatched: path.join(manifestDirPath, "unmatched.json"),
    manifest: path.join(repoRoot, manifestFile),
  };
}

async function main(argv = process.argv.slice(2)) {
  const tool = parseToolArg(argv);
  const toolConfig = TOOLS[tool];
  const FILES = filesForTool(tool);

  console.log(`Resolving pending matches for: ${tool}`);

  const pendingGames = await readJsonFile(FILES.pendingMatch, validatePendingGames);

  const matchOverlay = await readOptionalJsonFile(
    FILES.matchOverlay,
    () => new Map(),
    validateMatchOverlay,
    "No existing match_overlay.json found, starting fresh.",
  );

  const globallyClaimedAppIds = await readOptionalJsonFile(
    FILES.manifest,
    () => new Set(),
    collectManifestSteamAppIds,
    `No existing ${path.basename(FILES.manifest)} found. Skipping global duplicate check.`,
  );

  const locallyClaimedAppIds = collectOverlaySteamAppIds(
    matchOverlay,
    toolConfig.collectOverlayAppids,
  );
  const unmatchedGames = [];

  let matchCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;

  for (const [index, game] of pendingGames.entries()) {
    if (matchOverlay.has(game.id)) {
      skippedCount++;
      continue;
    }

    console.log(`[${index + 1}/${pendingGames.length}] Checking ${game.name}...`);

    const searchResult = await findExactSteamApp(game.name);

    if (searchResult.kind === "error") {
      console.warn(`  -> Steam search failed: ${errorMessage(searchResult.error)}`);

      unmatchedGames.push({
        id: game.id,
        name: game.name,
        reason: UNMATCHED_REASON.apiFailed,
      });

      continue;
    }

    if (searchResult.kind === "not-found") {
      console.log("  -> No exact match found.");

      unmatchedGames.push({
        id: game.id,
        name: game.name,
        reason: UNMATCHED_REASON.noExactMatch,
      });

      continue;
    }

    const appid = String(searchResult.item.id);

    console.log(`  -> Matched Steam AppID ${appid} (${searchResult.item.name})`);

    const isDuplicate = locallyClaimedAppIds.has(appid) || globallyClaimedAppIds.has(appid);

    if (isDuplicate) {
      duplicateCount++;

      console.warn(
        `  -> Warning: AppID ${appid} is already mapped to another title. Marking as ignored duplicate.`,
      );

      matchOverlay.set(game.id, { ignore: true });
      continue;
    }

    matchOverlay.set(game.id, { appids: [appid] });
    locallyClaimedAppIds.add(appid);
    matchCount++;
  }

  await writeJsonFileAtomic(FILES.matchOverlay, mapToSortedObject(matchOverlay));
  await writeJsonFileAtomic(FILES.unmatched, unmatchedGames);

  console.log(`\nSuccessfully mapped ${matchCount} Steam games.`);
  console.log(`Skipped ${skippedCount} games already present in match_overlay.json.`);
  console.log(`Ignored ${duplicateCount} duplicate Steam AppID mappings.`);
  console.log(`Failed to map ${unmatchedGames.length} games (logged to unmatched.json).`);
}

async function findExactSteamApp(gameName) {
  let items;

  try {
    items = await searchSteamStore(gameName);
  } catch (error) {
    return { kind: "error", error };
  }

  if (!Array.isArray(items)) {
    return {
      kind: "error",
      error: new TypeError("Steam search returned a non-array response."),
    };
  }

  const normalizedTarget = normalize(gameName);

  const item = items.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.type === "app" &&
      candidate.id != null &&
      typeof candidate.name === "string" &&
      normalize(candidate.name) === normalizedTarget,
  );

  if (!item) {
    return { kind: "not-found" };
  }

  return { kind: "match", item };
}

async function readJsonFile(filePath, validate) {
  const parsedJson = await readJsonFileAsync(filePath, toRepoRelativePath(filePath));

  return validate(parsedJson, filePath);
}

async function readOptionalJsonFile(filePath, fallback, validate, missingMessage) {
  try {
    return await readJsonFile(filePath, validate);
  } catch (error) {
    if (isMissingFileError(error)) {
      console.log(missingMessage);
      return fallback();
    }

    throw error;
  }
}

function validatePendingGames(value, filePath) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${toRepoRelativePath(filePath)} must contain an array.`);
  }

  const seenIds = new Set();

  return value.map((game, index) => {
    if (!isRecord(game)) {
      throw new TypeError(`pending_match.json item #${index + 1} must be an object.`);
    }

    const id = toNonEmptyString(game.id);
    const name = toNonEmptyString(game.name);

    if (!id) {
      throw new TypeError(`pending_match.json item #${index + 1} has an invalid id.`);
    }

    if (!name) {
      throw new TypeError(`pending_match.json item #${index + 1} has an invalid name.`);
    }

    if (seenIds.has(id)) {
      throw new TypeError(`pending_match.json contains duplicate id: ${id}`);
    }

    seenIds.add(id);

    return {
      ...game,
      id,
      name,
    };
  });
}

export function validateMatchOverlay(value, filePath) {
  if (!isRecord(value)) {
    throw new TypeError(`${toRepoRelativePath(filePath)} must contain an object.`);
  }

  const overlay = new Map();

  for (const [gameId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new TypeError(`match_overlay.json entry "${gameId}" must be an object.`);
    }

    const normalizedEntry = { ...entry };

    if ("appids" in normalizedEntry) {
      if (!Array.isArray(normalizedEntry.appids)) {
        throw new TypeError(
          `match_overlay.json entry "${gameId}".appids must be an array.`,
        );
      }

      normalizedEntry.appids = normalizedEntry.appids.map(String);
    }

    if ("ignore" in normalizedEntry && typeof normalizedEntry.ignore !== "boolean") {
      throw new TypeError(`match_overlay.json entry "${gameId}".ignore must be boolean.`);
    }

    overlay.set(String(gameId), normalizedEntry);
  }

  return overlay;
}

export function collectManifestSteamAppIds(manifest, filePath) {
  const appIds = new Set();
  const label = path.basename(filePath);

  if (!isRecord(manifest)) {
    throw new TypeError(`${label} must contain an object.`);
  }

  if (manifest.titles == null) {
    return appIds;
  }

  if (!Array.isArray(manifest.titles)) {
    throw new TypeError(`${label} titles must be an array.`);
  }

  for (const title of manifest.titles) {
    if (!isRecord(title) || !Array.isArray(title.match)) {
      continue;
    }

    for (const rule of title.match) {
      if (isSteamAppIdRule(rule)) {
        appIds.add(String(rule.value));
      }
    }
  }

  return appIds;
}

export function collectOverlaySteamAppIds(matchOverlay, collectOverlayAppids) {
  if (typeof collectOverlayAppids !== "function") {
    throw new TypeError("collectOverlayAppids must be a function");
  }

  const appIds = new Set();
  collectOverlayAppids(mapToSortedObject(matchOverlay), appIds);

  return appIds;
}

async function writeJsonFileAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await writeFile(tempPath, await stringifyFormattedJson(value, filePath), "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function mapToSortedObject(map) {
  const sortedObject = Object.create(null);

  for (const [key, value] of [...map.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sortedObject[key] = value;
  }

  return sortedObject;
}

function isSteamAppIdRule(value) {
  return isRecord(value) && value.kind === "steam_appid" && value.value != null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value) {
  if (value == null) {
    return "";
  }

  return String(value).trim();
}

function toRepoRelativePath(filePath) {
  return path.relative(repoRoot, filePath) || filePath;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
