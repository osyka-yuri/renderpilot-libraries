#!/usr/bin/env node
// Generates catalogs/addons/renodx/messages.json from the v2 manifest and
// reviewed translations.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRAZILIAN_PORTUGUESE_TRANSLATIONS,
  FRENCH_TRANSLATIONS,
  GERMAN_TRANSLATIONS,
  JAPANESE_TRANSLATIONS,
  RUSSIAN_TRANSLATIONS,
  SIMPLIFIED_CHINESE_TRANSLATIONS,
  SPANISH_TRANSLATIONS,
  TRADITIONAL_CHINESE_TRANSLATIONS,
} from "./lib/renodx-translations.mjs";
import { writeFormattedJsonFile } from "./lib/json.mjs";
import { buildV2Manifest } from "../catalogs/addons/renodx/lib/build-v2.mjs";
import { buildManifest } from "../catalogs/addons/renodx/lib/build-manifest.mjs";
import { createMatchRegistry } from "./lib/match-registry.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const WIKI_GAMES_PATH = path.join(ROOT, "catalogs/addons/renodx/wiki_games.json");
const WIKI_MESSAGES_PATH = path.join(ROOT, "catalogs/addons/renodx/wiki_messages.json");
const CURATED_GAMES_PATH = path.join(ROOT, "catalogs/addons/renodx/curated_games.json");
const OVERLAY_PATH = path.join(ROOT, "catalogs/addons/renodx/match_overlay.json");
const MATCH_REGISTRY_PATH = path.join(ROOT, "catalogs/games/match-registry.json");
const MESSAGES_OUTPUT_PATH = path.join(ROOT, "catalogs/addons/renodx/messages.json");

const LOCALES = Object.freeze([
  "de",
  "es",
  "fr",
  "ja",
  "pt-BR",
  "ru",
  "zh-Hans",
  "zh-Hant",
]);

export async function buildRenodxMessages(manifest) {
  const messagesMap = new Map();

  function record(item) {
    if (!item) return;
    const id = item.message_id || item.id || item.message?.id;
    const fallback = item.fallback_text || item.message?.fallback_text;
    const kind = item.kind || "compatibility";
    if (!id || !fallback) return;

    if (messagesMap.has(id)) {
      const existing = messagesMap.get(id);
      if (existing.fallback_text !== fallback || existing.kind !== kind) {
        throw new Error(`Message conflict for ${id}`);
      }
      return;
    }

    const ru = RUSSIAN_TRANSLATIONS[fallback];
    if (!ru) {
      throw new Error(`Missing Russian translation for: "${fallback}"`);
    }

    const de = GERMAN_TRANSLATIONS[fallback];
    if (!de) {
      throw new Error(`Missing German translation for: "${fallback}"`);
    }

    const fr = FRENCH_TRANSLATIONS[fallback];
    if (!fr) {
      throw new Error(`Missing French translation for: "${fallback}"`);
    }

    const es = SPANISH_TRANSLATIONS[fallback];
    if (!es) {
      throw new Error(`Missing Spanish translation for: "${fallback}"`);
    }

    const ja = JAPANESE_TRANSLATIONS[fallback];
    if (!ja) {
      throw new Error(`Missing Japanese translation for: "${fallback}"`);
    }

    const ptBr = BRAZILIAN_PORTUGUESE_TRANSLATIONS[fallback];
    if (!ptBr) {
      throw new Error(`Missing Brazilian Portuguese translation for: "${fallback}"`);
    }

    const zhHans = SIMPLIFIED_CHINESE_TRANSLATIONS[fallback];
    if (!zhHans) {
      throw new Error(`Missing Simplified Chinese translation for: "${fallback}"`);
    }

    const zhHant = TRADITIONAL_CHINESE_TRANSLATIONS[fallback];
    if (!zhHant) {
      throw new Error(`Missing Traditional Chinese translation for: "${fallback}"`);
    }

    const translations = {};
    for (const locale of LOCALES) {
      if (locale === "ru") {
        translations[locale] = ru;
      } else if (locale === "de") {
        translations[locale] = de;
      } else if (locale === "fr") {
        translations[locale] = fr;
      } else if (locale === "es") {
        translations[locale] = es;
      } else if (locale === "ja") {
        translations[locale] = ja;
      } else if (locale === "pt-BR") {
        translations[locale] = ptBr;
      } else if (locale === "zh-Hans") {
        translations[locale] = zhHans;
      } else if (locale === "zh-Hant") {
        translations[locale] = zhHant;
      } else {
        translations[locale] = fallback;
      }
    }

    messagesMap.set(id, {
      id,
      fallback_text: fallback,
      kind,
      context: `guidance.${kind}`,
      translations,
    });
  }

  manifest.page_guidance?.forEach(record);
  manifest.engine_profiles?.forEach((profile) => {
    record(profile.message);
    profile.guidance?.forEach(record);
  });
  manifest.games?.forEach((game) => {
    record(game.availability?.message);
    game.guidance?.forEach(record);
  });

  const sortedMessages = [...messagesMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema_version: 1,
    messages: sortedMessages,
  };
}

async function main() {
  const wikiGames = JSON.parse(await readFile(WIKI_GAMES_PATH, "utf8"));
  const wikiMessages = JSON.parse(await readFile(WIKI_MESSAGES_PATH, "utf8"));
  const curatedGames = JSON.parse(await readFile(CURATED_GAMES_PATH, "utf8"));
  const overlay = JSON.parse(await readFile(OVERLAY_PATH, "utf8"));
  const matchRegistry = JSON.parse(await readFile(MATCH_REGISTRY_PATH, "utf8"));
  const { manifest: v1Manifest } = buildManifest({
    wiki: wikiGames,
    curatedGames,
    overlay,
    registry: createMatchRegistry(matchRegistry),
    generatedAt: new Date().toISOString(),
  });
  const manifest = buildV2Manifest(v1Manifest, { wikiGames, wikiMessages });
  const catalog = await buildRenodxMessages(manifest);
  await writeFormattedJsonFile(MESSAGES_OUTPUT_PATH, catalog);
  console.log(
    `Wrote ${catalog.messages.length} RenoDX messages to ${MESSAGES_OUTPUT_PATH}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
