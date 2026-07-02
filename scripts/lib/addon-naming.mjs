import path from "node:path";
import { requiredNonEmptyString as requiredString } from "./common.mjs";

export const ADDON_EXTENSION_BY_ARCH = new Map([
  ["X64", "addon64"],
  ["X86", "addon32"],
]);

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
