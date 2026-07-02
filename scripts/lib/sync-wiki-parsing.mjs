export const ADDON_URL_RE =
  /(https:\/\/[^/]+\/[^/]+\/renodx[a-zA-Z0-9_-]*\/releases\/download\/[^/]+\/renodx-[a-zA-Z0-9_-]+\.addon(?:32|64))/i;
export const NEXUS_URL_RE = /(https:\/\/www\.nexusmods\.com\/[^/]+\/mods\/\d+)/i;
export const DISCORD_URL_RE = /(https:\/\/(?:ptb\.)?discord\.com\/channels\/\d+\/\d+)/i;

export function splitMarkdownTableRow(line) {
  const cells = [];
  let cell = "";
  let escaped = false;

  // Trim leading and trailing pipes
  const inner = line.trim().replace(/^\||\|$/g, "");

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];

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

  for (let line of markdown.split(/\r?\n/)) {
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

    if (trimmed.startsWith("|")) {
      // skip separator rows
      if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|/.test(trimmed)) {
        continue;
      }

      const cells = splitMarkdownTableRow(trimmed);

      if (!currentTable) {
        currentTable = {
          headers: cells.map((c) => c.trim().toLowerCase()),
          rows: [],
          engineContext,
        };
        tables.push(currentTable);
      } else {
        currentTable.rows.push(cells.map((c) => c.trim()));
      }
    } else {
      currentTable = null;
    }
  }

  return tables;
}

export function getModsTableHeaderColumns(headers) {
  const nameIndex = headers.findIndex((h) => h === "name");
  const maintainerIndex = headers.findIndex((h) => h === "maintainer");
  const statusIndex = headers.findIndex((h) => h === "status");
  const linksIndex = headers.findIndex((h) => h === "links");
  const notesIndex = headers.findIndex((h) => h === "notes");

  // A valid mods table must at least have a Name column and one other characteristic column.
  const hasSupportingColumn = maintainerIndex >= 0 || statusIndex >= 0 || linksIndex >= 0;

  if (nameIndex < 0 || !hasSupportingColumn) {
    return null;
  }

  return {
    nameIndex,
    maintainerIndex,
    statusIndex,
    linksIndex,
    notesIndex,
  };
}

export function extractMarkdownLinkLabel(value) {
  const match = String(value).match(/\[([^\]]+)]\([^)]+\)/);
  return (match?.[1] ?? value).trim();
}

export function extractUrl(value, regex) {
  return (
    String(value)
      .match(regex)?.[1]
      ?.replace(/[.,;]+$/, "") ?? null
  );
}

export function parseStatus(statusColumn) {
  if (statusColumn.includes(":white_check_mark:") || statusColumn.includes("✅")) {
    return "working";
  }

  if (statusColumn.includes(":construction:") || statusColumn.includes("🚧")) {
    return "construction";
  }

  return "unknown";
}

function getCellValue(columns, index) {
  if (index >= 0 && index < columns.length) {
    return columns[index] ?? "";
  }
  return "";
}

export function parseWikiRow(columns, columnsMapping, engineContext) {
  if (columns.length < 2) {
    return null;
  }

  const name = extractMarkdownLinkLabel(getCellValue(columns, columnsMapping.nameIndex));

  if (!name) {
    return null;
  }

  const linksColumn = getCellValue(columns, columnsMapping.linksIndex);
  const notesColumn = getCellValue(columns, columnsMapping.notesIndex);
  const statusColumn = getCellValue(columns, columnsMapping.statusIndex);

  const addonMatch = linksColumn.match(ADDON_URL_RE);
  const addonUrl = addonMatch?.[1] ?? null;

  let arch = addonMatch?.[2] === "32" ? "X86" : "X64";
  if (!addonUrl && notesColumn.match(/\b32(-|\s)?bit\b/i)) {
    arch = "X86";
  }

  let addonSlug = addonUrl?.match(/renodx-([a-zA-Z0-9_-]+)\.addon(?:32|64)/i)?.[1] ?? null;

  // Fallback to generic engine slug if no explicit URL is found, but we are in an engine table
  if (!addonUrl) {
    if (engineContext === "unity") {
      addonSlug = "unityengine";
    } else if (engineContext === "unreal") {
      addonSlug = "unrealengine";
    }
  }

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
