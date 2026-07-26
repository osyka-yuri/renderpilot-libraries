import { createHash } from "node:crypto";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { normalizePackageVersion } from "./library-values.mjs";

const MAX_NUSPEC_BYTES = 1024 * 1024;
const NUSPEC_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

export function selectPackageNuspec(packagePaths, identity) {
  const candidates = packagePaths
    .filter((packagePath) => archiveBasename(packagePath).endsWith(".nuspec"))
    .map((packagePath) => normalizeArchivePath(packagePath, identity))
    .filter(
      ({ segments, normalized }) =>
        segments.length === 1 && normalized.toLowerCase().endsWith(".nuspec"),
    );
  if (candidates.length !== 1) {
    throw new Error(
      `${identity}: expected exactly one root .nuspec, got ${candidates.length}`,
    );
  }
  return candidates[0].original;
}

export function assertNuGetPackageIdentity(
  bytes,
  expectedPackageId,
  expectedPackageVersion,
  identity,
) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_NUSPEC_BYTES) {
    throw new Error(`${identity}: .nuspec must be between 1 and ${MAX_NUSPEC_BYTES} bytes`);
  }
  const text = bytes.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw new Error(
      `${identity}: .nuspec document type and entity declarations are forbidden`,
    );
  }
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    throw new Error(`${identity}: invalid .nuspec XML: ${validation.err.msg}`);
  }

  let parsed;
  try {
    parsed = NUSPEC_PARSER.parse(text);
  } catch (error) {
    throw new Error(`${identity}: invalid .nuspec XML`, { cause: error });
  }
  const metadata = parsed?.package?.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    typeof metadata.id !== "string" ||
    typeof metadata.version !== "string"
  ) {
    throw new Error(`${identity}: .nuspec has no scalar package metadata id/version`);
  }

  const actualId = metadata.id.trim();
  const actualVersion = normalizePackageVersion(
    metadata.version.trim(),
    `${identity}: .nuspec version`,
  );
  const expectedVersion = normalizePackageVersion(
    expectedPackageVersion,
    `${identity}: expected version`,
  );
  if (
    actualId.toLowerCase() !== expectedPackageId.toLowerCase() ||
    actualVersion !== expectedVersion
  ) {
    throw new Error(
      `${identity}: .nuspec identity is ${actualId}@${actualVersion}, expected ${expectedPackageId}@${expectedVersion}`,
    );
  }
}

export function verifyPackageSha512(bytes, expectedBase64, identity) {
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== expectedBase64) {
    throw new Error(
      `${identity}: package SHA-512 mismatch (expected ${expectedBase64}, got ${actual})`,
    );
  }
}

export function selectPackageFiles(paths, product) {
  const capabilities = compileProductCapabilities(product);
  const relevant = paths
    .filter((value) => capabilities.fileNames.has(archiveBasename(value)))
    .map((value) => normalizeArchivePath(value, product.package_id));

  for (const candidate of relevant) {
    const matchingArchitectures = matchingArchitecturesForPath(
      candidate,
      capabilities.architectures,
    );
    if (matchingArchitectures.length > 1) {
      throw new Error(
        `${product.package_id}: ambiguous architecture path ${candidate.original}`,
      );
    }
  }

  return capabilities.architectures.flatMap((architecture) => {
    const members = capabilities.files.flatMap((file) => {
      const matches = relevant.filter(
        (candidate) =>
          candidate.segments.at(-1).toLowerCase() === file.file_name.toLowerCase() &&
          candidate.lowerSegments.includes(architecture.packageDirectory),
      );
      if (matches.length > 1) {
        throw new Error(
          `${product.package_id}: ambiguous ${architecture.value.package_directory}/${file.file_name}: ${matches.map((match) => match.original).join(", ")}`,
        );
      }
      return matches.length === 0 ? [] : [{ ...file, package_path: matches[0].normalized }];
    });

    if (members.length === 0 && !architecture.value.required) return [];
    const memberIds = new Set(members.map((member) => member.library_id));
    const missing = capabilities.requiredFiles
      .filter((file) => !memberIds.has(file.library_id))
      .map((file) => file.file_name);
    if (missing.length > 0) {
      throw new Error(
        `${product.package_id}: incomplete ${architecture.value.package_directory} install unit; missing ${missing.join(", ")}`,
      );
    }
    return [{ architecture: architecture.value, members }];
  });
}

export const pathForPackageMember = (extractRoot, packagePath) =>
  path.join(extractRoot, ...packagePath.split("/"));

function compileProductCapabilities(product) {
  const files = product.files.map((file) => ({ ...file }));
  return {
    files,
    requiredFiles: files.filter((file) => file.required),
    fileNames: new Set(files.map((file) => file.file_name.toLowerCase())),
    architectures: product.architectures.map((architecture) => ({
      value: architecture,
      packageDirectory: architecture.package_directory.toLowerCase(),
    })),
  };
}

function matchingArchitecturesForPath(candidate, architectures) {
  return architectures.filter((architecture) =>
    candidate.lowerSegments.includes(architecture.packageDirectory),
  );
}

function archiveBasename(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
}

function normalizeArchivePath(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}: unsafe package path ${String(value)}`);
  }
  const slashNormalized = value.replaceAll("\\", "/");
  const normalized = slashNormalized.replace(/^\.\//u, "");
  const segments = normalized.split("/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized.includes(":") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${context}: unsafe package path ${value}`);
  }
  return {
    original: value,
    normalized,
    segments,
    lowerSegments: segments.map((segment) => segment.toLowerCase()),
  };
}
