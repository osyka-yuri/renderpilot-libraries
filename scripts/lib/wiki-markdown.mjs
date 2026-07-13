// Shared Markdown primitives for upstream wiki synchronizers. Tool-specific
// table layouts and reconciliation rules deliberately live in their own
// modules; this file only handles Markdown's common wire shape.

export function normalizeWikiName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

export function splitMarkdownTableRow(line) {
  const cells = [];
  let cell = "";
  let escaped = false;

  const inner = line.trim().replace(/^\||\|$/g, "");

  for (const char of inner) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    cell += char;
  }

  cells.push(cell.trim());
  return cells;
}

export function extractMarkdownTables(markdown) {
  const tables = [];
  let currentTable = null;
  let engineContext = null;

  for (const line of String(markdown).split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("### ")) {
      const heading = trimmed.substring(4).toLowerCase();
      if (heading.includes("unity")) {
        engineContext = "unity";
      } else if (heading.includes("unreal")) {
        engineContext = "unreal";
      } else {
        engineContext = null;
      }
    }

    if (!trimmed.startsWith("|")) {
      currentTable = null;
      continue;
    }

    if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|/.test(trimmed)) {
      continue;
    }

    const cells = splitMarkdownTableRow(trimmed);
    if (!currentTable) {
      currentTable = {
        headers: cells.map((cell) => cell.trim().toLowerCase()),
        rows: [],
        engineContext,
      };
      tables.push(currentTable);
    } else {
      currentTable.rows.push(cells.map((cell) => cell.trim()));
    }
  }

  return tables;
}

export function extractMarkdownLinkLabel(value) {
  const match = String(value).match(/\[([^\]]+)]\([^)]+\)/);
  return (match?.[1] ?? value).trim();
}

export function wikiStatusFromCell(value, fallback = "unknown") {
  const cell = String(value);
  if (cell.includes(":white_check_mark:") || cell.includes("✅")) {
    return "working";
  }
  if (cell.includes(":construction:") || cell.includes("🚧")) {
    return "construction";
  }
  return fallback;
}
