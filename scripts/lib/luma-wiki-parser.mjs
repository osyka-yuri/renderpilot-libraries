import { createHash } from "node:crypto";

import { UNREAL_ASSET } from "../../catalogs/addons/luma/lib/v1.mjs";
import { extractMarkdownTables, wikiStatusFromCell } from "./wiki-markdown.mjs";

const LUMA_ASSET_RE = /Luma-[A-Za-z0-9_.()-]+(?:-x32)?\.zip/i;

// Exact apart from punctuation and spacing. Aliases handle actual title
// changes without conflating names such as Shenmue I & II and Shenmue III.
export function normalizeLumaName(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function featureStatusFromCell(cell) {
  const value = String(cell);
  if (value.includes(":white_check_mark:") || value.includes("✅")) {
    return "supported";
  }
  if (value.includes(":construction:") || value.includes("🚧")) {
    return "experimental";
  }
  if (value.includes("⛔")) return "unsupported";
  return "unknown";
}

function unrealStatus(features) {
  if (Object.values(features).includes("supported")) return "working";
  if (Object.values(features).includes("experimental")) return "construction";
  return "unknown";
}

function extractAssetFromCell(cell) {
  return String(cell).match(LUMA_ASSET_RE)?.[0] ?? null;
}

function extractNameFromCell(cell) {
  const raw = String(cell).trim();
  if (!raw) return null;

  const linkLabel = raw.match(/\[([^\]]*)\]\([^)]+\)/)?.[1]?.trim();
  if (linkLabel && !linkLabel.startsWith("!") && !linkLabel.includes("shield")) {
    return linkLabel.replace(/\*\*/g, "").trim();
  }

  const stripped = raw
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/\*/g, "")
    .trim();
  return stripped || null;
}

export function normalizeLumaWikiNote(value) {
  return String(value)
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/?(?:details|summary)[^>]*>/giu, "\n")
    .replace(/\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/\*{1,3}|_{1,3}/gu, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[•‣]\s*/u, "- ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

export function lumaWikiNoteFingerprint(note) {
  return createHash("sha256").update(normalizeLumaWikiNote(note), "utf8").digest("hex");
}

function tableColumns(headers, type) {
  if (type === "completed") {
    return {
      name: headers.indexOf("name"),
      asset: headers.indexOf("download link"),
      status: headers.indexOf("status"),
      notes: headers.indexOf("special notes"),
    };
  }
  if (type === "wip") {
    return { name: headers.indexOf("name"), status: headers.indexOf("status"), notes: -1 };
  }
  return {
    name: headers.indexOf("name"),
    dlss:
      headers.indexOf("dlss/fsr") >= 0
        ? headers.indexOf("dlss/fsr")
        : headers.indexOf("dlss"),
    hdr: headers.indexOf("hdr"),
    notes: headers.indexOf("notes"),
  };
}

function tableType(headers) {
  const has = (name) => headers.includes(name);
  if (has("name") && has("download link") && has("status")) return "completed";
  if (has("name") && (has("dlss/fsr") || has("dlss") || has("hdr"))) {
    return "unreal";
  }
  if (
    has("name") &&
    has("status") &&
    has("author") &&
    !has("download link") &&
    !has("dlss/fsr") &&
    !has("dlss") &&
    !has("hdr")
  ) {
    return "wip";
  }
  return null;
}

function noteFromCells(cells, index) {
  if (index < 0) return null;
  const note = normalizeLumaWikiNote(cells[index] ?? "");
  return note || null;
}

export function parseLumaWikiRows(markdown) {
  const rows = [];

  for (const table of extractMarkdownTables(markdown)) {
    const section = tableType(table.headers);
    if (!section) continue;

    const columns = tableColumns(table.headers, section);
    if (columns.name < 0) continue;

    for (const cells of table.rows) {
      const name = extractNameFromCell(cells[columns.name] ?? "");
      if (!name) continue;

      if (section === "completed") {
        rows.push({
          name,
          status: wikiStatusFromCell(cells[columns.status] ?? "", "unknown"),
          asset: extractAssetFromCell(cells[columns.asset] ?? ""),
          section,
          note: noteFromCells(cells, columns.notes),
        });
      } else if (section === "wip") {
        rows.push({ name, status: "construction", asset: null, section, note: null });
      } else {
        const features = {
          dlss_fsr: featureStatusFromCell(cells[columns.dlss] ?? ""),
          hdr: featureStatusFromCell(cells[columns.hdr] ?? ""),
        };
        rows.push({
          name,
          status: unrealStatus(features),
          asset: UNREAL_ASSET,
          section,
          features,
          note: noteFromCells(cells, columns.notes),
        });
      }
    }
  }

  return rows;
}
