import { addCaseInsensitiveUnique } from "./overlay.mjs";

const WINDOWS_OS = "windows";
const DEFAULT_BRANCH = "default";
const DEFAULT_LAUNCH_TYPE = "default";

const EXE_EXTENSION_RE = /\.exe$/i;
const LIST_SEPARATOR_RE = /[,\s]+/;
const PATH_SEPARATOR_RE = /[\\/]/;

const QUOTED_EXE_RE = /["']([^"']*?\.exe)["']/i;
const PATH_EXE_RE = /(?:^|[\\/])([^\\/"']+?\.exe)(?=$|\s|["'])/i;

const NON_GAME_EXE_NAMES = new Set([
  "steam",
  "steamservice",
  "steamerrorreporter",
  "epicgameslauncher",
  "origin",
  "eadesktop",
  "ubisoftconnect",
  "gog galaxy",
  "galaxyclient",
  "battle.net",
  "rockstargameslauncher",
  "playnite",
  "game",
  "setup",
  "startup",
  "unins000",
  "unins001",
  "eosbootstrapper",
  "easyanticheat",
  "easyanticheat_setup",
  "battleye",
  "anticheatexpert",
  "activationui",
  "touchup",
  "oalinst",
  "chromed",
]);

const NON_GAME_SUFFIXES = [
  "launcher",
  "setup",
  "install",
  "uninstall",
  "crashreport",
  "crashhandler",
  "updater",
  "update",
  "redist",
  "dxsetup",
  "vcredist",
  "configure",
  "settings",
  "benchmark",
  "server",
  "dedicated",
  "editor",
  "helper",
  "support",
  "tool",
  "anticheat",
  "bootstrapper",
  "bootloader",
  "prereqsetup",
  "diag",
  "reporter",
  "protected",
];

const NON_GAME_SUBSTRINGS = [
  "crash",
  "redist",
  "helper",
  "support",
  "config",
  "setup",
  "install",
  "uninstall",
  "launcher",
  "updater",
  "dxsetup",
  "vcredist",
  "anticheat",
  "battleye",
  "bootstrapper",
  "prereq",
  "cleanup",
  "artbook",
  "soundtrack",
];

const NON_GAME_TOKEN_RE =
  /(^|[._\-\s])(autoplayer|benchmark|bootloader|debug|debugopt|dev|development|editor|nostats|protected|rtdbg|server|submission|test|testing|tool)([._\-\s]|$)/i;

const NON_GAME_SUFFIX_RE =
  /(debug|debugopt|dev|development|editor|nostats|protected|rtdbg|submission|test|testing)$/i;

const NON_GAME_DESCRIPTION_RE =
  /\b(artbook|autoplayer|benchmark|bonus content|custom game|debug|dedicated server|development|editor|for testing|guide|internal|multiplayer|profile|runtime\s*debug|sdk|server|soundtrack|strategy guide|test|testing|tool)\b/i;

const NON_GAME_ARGUMENT_RE = /(^|\s)-(autoplayer|dedicated|server)\b/i;

const NON_GAME_PATH_SEGMENT_RE = /(^|[\\/])(artbook|devtools|extras|profile|sdk)([\\/]|$)/i;

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasWrappingQuotes(value) {
  if (value.length < 2) return false;

  const first = value[0];
  const last = value[value.length - 1];

  return (first === `"` && last === `"`) || (first === `'` && last === `'`);
}

function stripWrappingQuotes(value) {
  const trimmed = asTrimmedString(value);
  return hasWrappingQuotes(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

function pathBasename(pathLike) {
  const cleaned = stripWrappingQuotes(pathLike);
  return cleaned.split(PATH_SEPARATOR_RE).pop()?.trim() ?? cleaned;
}

/**
 * Extracts an executable basename from Steam-like launch command/path values.
 *
 * Handles:
 * - C:\Game\Game.exe
 * - "C:\Game Dir\Game.exe"
 * - "C:\Game Dir\Game.exe" -arg
 * - C:\Game Dir\Game.exe -arg
 */
export function launchBasename(executable) {
  const raw = asTrimmedString(executable);
  if (raw === "") return "";

  const quotedExe = raw.match(QUOTED_EXE_RE);
  if (quotedExe) {
    return pathBasename(quotedExe[1]);
  }

  const cleaned = stripWrappingQuotes(raw);
  const exeInPath = cleaned.match(PATH_EXE_RE);

  return exeInPath ? exeInPath[1].trim() : pathBasename(cleaned);
}

function normalizedList(value) {
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];

  return values
    .flatMap((item) => item.split(LIST_SEPARATOR_RE))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function osListValues(oslist) {
  return normalizedList(oslist);
}

export function isWindowsLaunchEntry(entry) {
  const oslist = osListValues(entry?.config?.oslist);
  return oslist.length === 0 || oslist.includes(WINDOWS_OS);
}

function isBranchRestricted(entry) {
  const branchNames = normalizedList(entry?.config?.betakey);
  return branchNames.length > 0 && !branchNames.includes(DEFAULT_BRANCH);
}

function isDefaultLaunchEntry(entry) {
  return asTrimmedString(entry?.type).toLowerCase() === DEFAULT_LAUNCH_TYPE;
}

function stem(exe) {
  return exe.replace(EXE_EXTENSION_RE, "");
}

function hasAnySuffix(value, suffixes) {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

function hasAnySubstring(value, substrings) {
  return substrings.some((substring) => value.includes(substring));
}

function hasExecutable(entry) {
  return asTrimmedString(entry?.executable) !== "";
}

function isWindowsExecutableEntry(entry) {
  return hasExecutable(entry) && isWindowsLaunchEntry(entry);
}

export function isLikelyGameExeName(exe) {
  const basename = launchBasename(exe).toLowerCase();
  if (!EXE_EXTENSION_RE.test(basename)) return false;

  const exeStem = stem(basename);

  if (NON_GAME_EXE_NAMES.has(exeStem)) return false;
  if (hasAnySuffix(exeStem, NON_GAME_SUFFIXES)) return false;
  if (hasAnySubstring(exeStem, NON_GAME_SUBSTRINGS)) return false;
  if (NON_GAME_TOKEN_RE.test(exeStem)) return false;
  if (NON_GAME_SUFFIX_RE.test(exeStem)) return false;

  return true;
}

function entryDescription(entry) {
  return typeof entry?.description === "string" ? entry.description : "";
}

function entryArguments(entry) {
  return typeof entry?.arguments === "string" ? entry.arguments : "";
}

export function isLikelyGameLaunchEntry(entry) {
  const executable = asTrimmedString(entry?.executable);
  if (executable === "") return false;

  if (!isWindowsLaunchEntry(entry)) return false;
  if (NON_GAME_PATH_SEGMENT_RE.test(executable)) return false;

  if (!isLikelyGameExeName(executable)) return false;
  if (NON_GAME_DESCRIPTION_RE.test(entryDescription(entry))) return false;
  if (NON_GAME_ARGUMENT_RE.test(entryArguments(entry))) return false;

  return true;
}

function launchEntriesFromAppinfo(app) {
  const launch = app?.config?.launch;
  if (!launch || typeof launch !== "object") return [];

  return Object.values(launch).filter(isWindowsExecutableEntry);
}

function publicLaunchEntries(entries) {
  const unrestrictedEntries = entries.filter((entry) => !isBranchRestricted(entry));
  return unrestrictedEntries.length > 0 ? unrestrictedEntries : entries;
}

function preferredLaunchEntries(entries) {
  const defaultGameEntries = entries
    .filter(isDefaultLaunchEntry)
    .filter(isLikelyGameLaunchEntry);

  return defaultGameEntries.length > 0 ? defaultGameEntries : entries;
}

/** Keeps public Windows launch entries and returns deduped game exe basenames. */
export function gameExesFromAppinfo(app) {
  const windowsEntries = launchEntriesFromAppinfo(app);
  const visibleEntries = publicLaunchEntries(windowsEntries);
  const sourceEntries = preferredLaunchEntries(visibleEntries);

  const exes = [];

  for (const entry of sourceEntries) {
    if (!isLikelyGameLaunchEntry(entry)) continue;

    addCaseInsensitiveUnique(exes, launchBasename(entry.executable));
  }

  return exes;
}
