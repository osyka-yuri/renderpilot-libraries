// Pure helpers for the RenoDX slug/add-on availability guard.
//
// Kept free of IO and network access so the name-derivation, classification,
// and mismatch logic is unit-testable. The wrapper script
// (scripts/check-renodx-slugs.mjs) owns the manifest read, the GitHub snapshot
// fetch, the console output, and `main`.

import path from "node:path";

export const OFF_SNAPSHOT_TITLE_KINDS = new Set(["external", "native_hdr", "blacklist"]);

export const ADDON_EXTENSION_BY_ARCH = new Map([
  ["X64", "addon64"],
  ["X86", "addon32"],
]);

export const MAX_ISSUES_TO_PRINT = 40;

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

export function assertManifestShape(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("renodx_manifest.json must contain a JSON object");
  }

  if (!Array.isArray(manifest.titles)) {
    throw new Error("renodx_manifest.json must contain a `titles` array");
  }

  if (!Array.isArray(manifest.generics)) {
    throw new Error("renodx_manifest.json must contain a `generics` array");
  }
}

export function assertTitle(title, index) {
  if (!isRecord(title)) {
    throw new Error(`titles[${index}] must be an object`);
  }
}

export function assertGeneric(generic, index) {
  if (!isRecord(generic)) {
    throw new Error(`generics[${index}] must be an object`);
  }
}

export function titleLabel(title, index) {
  return typeof title.id === "string" && title.id.trim() !== ""
    ? title.id.trim()
    : `titles[${index}]`;
}

export function genericLabel(generic, index) {
  return typeof generic.engine === "string" && generic.engine.trim() !== ""
    ? `generic:${generic.engine.trim()}`
    : `generics[${index}]`;
}

export function isOffSnapshotTitle(title) {
  if (title.download_url) {
    return true;
  }

  return OFF_SNAPSHOT_TITLE_KINDS.has(title.category?.kind);
}

export function isSnapshotHostedGeneric(generic) {
  return Boolean(generic.slug) && !generic.url64 && !generic.url32 && !generic.download_url;
}

export function addonFile(slug, arch) {
  const extension = ADDON_EXTENSION_BY_ARCH.get(arch);

  if (!extension) {
    throw new Error(
      `Unsupported RenoDX architecture "${arch}". Expected one of: ${[
        ...ADDON_EXTENSION_BY_ARCH.keys(),
      ].join(", ")}`,
    );
  }

  return `renodx-${slug}.${extension}`;
}

export function addonBasenameFromUrl(url, fieldName) {
  const value = requiredString(url, fieldName);
  let parsed;

  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`${fieldName} must be a valid URL: ${err.message}`, {
      cause: err,
    });
  }

  const basename = path.posix.basename(parsed.pathname);

  if (!basename || basename === "." || basename === "/") {
    throw new Error(`${fieldName} must end with an add-on file name`);
  }

  return basename;
}

export function sameFileName(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function expectedTitleAddon(title, index) {
  const label = titleLabel(title, index);
  const slug = requiredString(title.slug, `${label}.slug`);
  const arch = requiredString(title.arch, `${label}.arch`);

  return addonFile(slug, arch);
}

export function expectedGenericAddon(generic, index) {
  const label = genericLabel(generic, index);
  const slug = requiredString(generic.slug, `${label}.slug`);

  return addonFile(slug, "X64");
}

export function checkTitles(titles, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, title] of titles.entries()) {
    assertTitle(title, index);

    if (isOffSnapshotTitle(title)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedTitleAddon(title, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${titleLabel(title, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

export function checkGenerics(generics, assets) {
  const missing = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, generic] of generics.entries()) {
    assertGeneric(generic, index);

    if (!isSnapshotHostedGeneric(generic)) {
      skipped++;
      continue;
    }

    checked++;

    const expectedAddon = expectedGenericAddon(generic, index);

    if (!assets.has(expectedAddon)) {
      missing.push(`${genericLabel(generic, index)} (${expectedAddon})`);
    }
  }

  return { checked, skipped, missing };
}

export function checkExplicitTitleAddonNames(titles) {
  const mismatches = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, title] of titles.entries()) {
    assertTitle(title, index);

    if (!title.download_url) {
      skipped++;
      continue;
    }

    checked++;

    const label = titleLabel(title, index);
    const expected = expectedTitleAddon(title, index);
    const actual = addonBasenameFromUrl(title.download_url, `${label}.download_url`);

    if (!sameFileName(actual, expected)) {
      mismatches.push(`${label}: ${actual} should be ${expected}`);
    }
  }

  return { checked, skipped, mismatches, structural: [] };
}

export function checkExplicitGenericAddonNames(generics) {
  const mismatches = [];
  const structural = [];
  let checked = 0;
  let skipped = 0;

  for (const [index, generic] of generics.entries()) {
    assertGeneric(generic, index);

    const label = genericLabel(generic, index);

    if (Boolean(generic.url64) !== Boolean(generic.url32)) {
      structural.push(`${label}: url64 and url32 must be provided together`);
      continue;
    }

    if (!generic.url64 && !generic.url32) {
      skipped++;
      continue;
    }

    if (!generic.slug) {
      skipped++;
      continue;
    }

    const localSlug = requiredString(generic.slug, `${label}.slug`);

    for (const [field, arch] of [
      ["url64", "X64"],
      ["url32", "X86"],
    ]) {
      if (!generic[field]) {
        continue;
      }

      checked++;

      const expected = addonFile(localSlug, arch);
      const actual = addonBasenameFromUrl(generic[field], `${label}.${field}`);

      if (!sameFileName(actual, expected)) {
        mismatches.push(`${label}.${field}: ${actual} should be ${expected}`);
      }
    }
  }

  return { checked, skipped, mismatches, structural };
}

export function checkExplicitAddonNames(manifest) {
  const titleResult = checkExplicitTitleAddonNames(manifest.titles);
  const genericResult = checkExplicitGenericAddonNames(manifest.generics);

  return {
    checked: titleResult.checked + genericResult.checked,
    skipped: titleResult.skipped + genericResult.skipped,
    mismatches: [...titleResult.mismatches, ...genericResult.mismatches],
    structural: [...titleResult.structural, ...genericResult.structural],
  };
}
