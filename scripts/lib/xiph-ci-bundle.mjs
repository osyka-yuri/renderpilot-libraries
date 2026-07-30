import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  copyFile,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "./hash.mjs";
import { assertVendorSnapshot, buildVendorSnapshot } from "./library-catalog.mjs";
import { validateLibraryAssetPayload } from "./library-asset-validation.mjs";
import { assertXiphCatalogMatchesLock } from "./xiph-catalog-state.mjs";
import { assertXiphPublicationPath, assertXiphPublishableVendor } from "./xiph-matrix.mjs";

const execFileAsync = promisify(execFile);
const REPARSE_CHECK_SCRIPT = fileURLToPath(
  new URL("../xiph/assert-no-reparse-points.ps1", import.meta.url),
);

export const XIPH_CATALOG_BUNDLE_PATHS = Object.freeze([
  "catalogs/libraries/xiph.json",
  "catalogs/libraries/xiph.lock.json",
  "libraries/v1/index.json",
  "libraries/v1/vendors/xiph.json",
]);

export const BUNDLE_MANIFEST_FILE = "bundle-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const ASSET_KIND = "xiph-assets";
const CATALOG_KIND = "xiph-catalog";
const SHA256 = /^[0-9a-f]{64}$/u;

export async function createXiphCiBundles({
  repoRoot,
  assetsRoot,
  catalogRoot,
  baselineVendorFile,
}) {
  await assertEmptyDirectory(assetsRoot);
  await assertEmptyDirectory(catalogRoot);

  const catalogFiles = [];
  for (const relative of XIPH_CATALOG_BUNDLE_PATHS) {
    catalogFiles.push(
      await copyRegularFileIntoBundle({
        sourceRoot: repoRoot,
        relative,
        bundleRoot: catalogRoot,
      }),
    );
  }
  await writeManifest(catalogRoot, CATALOG_KIND, catalogFiles);

  const vendor = JSON.parse(
    await readFile(path.join(repoRoot, "libraries", "v1", "vendors", "xiph.json"), "utf8"),
  );
  assertVendorSnapshot(vendor);
  assertXiphPublishableVendor(vendor);
  const baselineVendor = JSON.parse(await readFile(baselineVendorFile, "utf8"));
  assertVendorSnapshot(baselineVendor);
  assertXiphPublishableVendor(baselineVendor);
  const expectedAssets = collectXiphAssetDelta(baselineVendor, vendor);
  const assetFiles = [];
  for (const [objectKey, expected] of [...expectedAssets].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const relative = `cdn/${objectKey}`;
    const source = path.join(repoRoot, ...relative.split("/"));
    const record = await copyRegularFileIntoBundle({
      sourceRoot: repoRoot,
      relative,
      bundleRoot: assetsRoot,
    });
    if (
      record.size_bytes !== expected.storedSize ||
      record.sha256 !== expected.storedSha256
    ) {
      throw new Error(`${relative}: local asset differs from the generated Xiph catalog`);
    }
    await validateLibraryAssetPayload(objectKey, await readFile(source), expected);
    assetFiles.push(record);
  }
  await writeManifest(assetsRoot, ASSET_KIND, assetFiles);
  return { assetFiles, catalogFiles };
}

export async function verifyXiphCatalogBundle(root) {
  const manifest = await verifyBundle(root, CATALOG_KIND);
  const observed = manifest.files.map(({ path: relative }) => relative);
  if (
    observed.length !== XIPH_CATALOG_BUNDLE_PATHS.length ||
    observed.some((relative, index) => relative !== XIPH_CATALOG_BUNDLE_PATHS[index])
  ) {
    throw new Error(
      "Xiph catalog bundle does not contain the exact reviewed path allowlist",
    );
  }
  const [vendorValue, source, lock] = await Promise.all([
    readFile(path.join(root, "libraries", "v1", "vendors", "xiph.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "catalogs", "libraries", "xiph.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "catalogs", "libraries", "xiph.lock.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  assertVendorSnapshot(vendorValue);
  const vendor = assertXiphPublishableVendor(vendorValue);
  assertXiphCatalogMatchesLock(source, lock);
  if (!isDeepStrictEqual(buildVendorSnapshot(source), vendor)) {
    throw new Error(
      "Xiph catalog bundle vendor snapshot does not match its reviewed source catalog",
    );
  }
  return { manifest, vendor, source, lock };
}

export async function verifyXiphAssetBundle(assetsRoot, catalogRoot, baselineVendorFile) {
  const [{ manifest }, { vendor }] = await Promise.all([
    verifyBundle(assetsRoot, ASSET_KIND).then((manifest) => ({ manifest })),
    verifyXiphCatalogBundle(catalogRoot),
  ]);
  const baselineVendor = JSON.parse(await readFile(baselineVendorFile, "utf8"));
  assertVendorSnapshot(baselineVendor);
  assertXiphPublishableVendor(baselineVendor);
  const expected = collectXiphAssetDelta(baselineVendor, vendor);
  for (const record of manifest.files) {
    if (!record.path.startsWith("cdn/")) {
      throw new Error(`Xiph asset bundle path is outside cdn/: ${record.path}`);
    }
  }
  const observedKeys = manifest.files.map((record) => record.path.slice("cdn/".length));
  const expectedKeys = [...expected.keys()].sort();
  if (
    observedKeys.length !== expectedKeys.length ||
    observedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Xiph asset bundle does not contain the exact catalog asset delta");
  }
  for (const record of manifest.files) {
    const objectKey = record.path.slice("cdn/".length);
    const catalogRecord = expected.get(objectKey);
    if (!catalogRecord) {
      throw new Error(`${record.path}: asset is not referenced by the Xiph catalog`);
    }
    if (
      record.size_bytes !== catalogRecord.storedSize ||
      record.sha256 !== catalogRecord.storedSha256
    ) {
      throw new Error(`${record.path}: bundle identity differs from the Xiph catalog`);
    }
    const file = path.join(assetsRoot, ...record.path.split("/"));
    await validateLibraryAssetPayload(objectKey, await readFile(file), catalogRecord);
  }
  return manifest;
}

export async function verifyBundle(root, expectedKind) {
  const resolvedRoot = path.resolve(root);
  await assertDirectoryPath(resolvedRoot);
  await assertNoWindowsReparsePoints(resolvedRoot);
  const manifestPath = path.join(resolvedRoot, BUNDLE_MANIFEST_FILE);
  await assertRegularPath(manifestPath, resolvedRoot);
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 2 * 1024 * 1024) {
    throw new Error(`${manifestPath}: bundle manifest is too large`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assertManifest(manifest, expectedKind);

  const actualPaths = await walkBundleFiles(resolvedRoot);
  const expectedPaths = [
    ...manifest.files.map((record) => record.path),
    BUNDLE_MANIFEST_FILE,
  ].sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((relative, index) => relative !== expectedPaths[index])
  ) {
    throw new Error("bundle contains missing, extra, or unmanifested files");
  }

  for (const record of manifest.files) {
    const file = path.join(resolvedRoot, ...record.path.split("/"));
    await assertRegularPath(file, resolvedRoot);
    const bytes = await readFile(file);
    if (bytes.length !== record.size_bytes || sha256Hex(bytes) !== record.sha256) {
      throw new Error(`${record.path}: bundle file hash or size mismatch`);
    }
  }
  return manifest;
}

export async function applyVerifiedBundle({ bundleRoot, destinationRoot, expectedKind }) {
  const manifest = await verifyBundle(bundleRoot, expectedKind);
  for (const record of manifest.files) {
    const destination = path.join(destinationRoot, ...record.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(bundleRoot, ...record.path.split("/")), destination);
  }
  return manifest;
}

export const XIPH_ASSET_BUNDLE_KIND = ASSET_KIND;
export const XIPH_CATALOG_BUNDLE_KIND = CATALOG_KIND;

export function collectXiphAssetExpectations(vendor) {
  const values = new Map();
  for (const artifact of vendor.artifacts) {
    addExpectation(values, artifact.transport.object_key, {
      kind: "dll",
      key: artifact.transport.object_key,
      storedSize: artifact.transport.size_bytes,
      storedSha256: artifact.transport.sha256,
      dllSize: artifact.dll.size_bytes,
      dllSha256: artifact.dll.sha256,
    });
  }
  for (const document of vendor.legal_documents) {
    addExpectation(values, document.object_key, {
      kind: "legal",
      key: document.object_key,
      storedSize: document.content.size_bytes,
      storedSha256: document.content.sha256,
      format: document.format,
    });
  }
  return values;
}

export function collectXiphAssetDelta(baselineVendor, candidateVendor) {
  const baseline = collectXiphAssetExpectations(baselineVendor);
  const candidate = collectXiphAssetExpectations(candidateVendor);
  for (const [key, baselineAsset] of baseline) {
    const candidateAsset = candidate.get(key);
    if (!candidateAsset) {
      throw new Error(`${key}: candidate Xiph catalog removed an existing asset`);
    }
    if (JSON.stringify(candidateAsset) !== JSON.stringify(baselineAsset)) {
      throw new Error(`${key}: candidate Xiph catalog changed an existing asset identity`);
    }
  }
  return new Map([...candidate].filter(([key]) => !baseline.has(key)));
}

function addExpectation(values, objectKey, expected) {
  assertSafeRelativePath(objectKey);
  const previous = values.get(objectKey);
  if (previous && JSON.stringify(previous) !== JSON.stringify(expected)) {
    throw new Error(`${objectKey}: conflicting Xiph asset identities`);
  }
  values.set(objectKey, expected);
}

async function copyRegularFileIntoBundle({ sourceRoot, relative, bundleRoot }) {
  assertSafeRelativePath(relative);
  assertXiphPublicationPath(relative);
  const source = path.join(sourceRoot, ...relative.split("/"));
  await assertRegularPath(source, sourceRoot);
  const bytes = await readFile(source);
  const destination = path.join(bundleRoot, ...relative.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  return {
    path: relative,
    size_bytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

async function assertNoWindowsReparsePoints(root) {
  if (process.platform !== "win32") return;
  await execFileAsync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      REPARSE_CHECK_SCRIPT,
      "-Root",
      root,
    ],
    { windowsHide: true },
  );
}

async function writeManifest(root, kind, records) {
  const files = [...records].sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(
    path.join(root, BUNDLE_MANIFEST_FILE),
    `${JSON.stringify({ schema_version: MANIFEST_SCHEMA_VERSION, kind, files }, null, 2)}\n`,
    { flag: "wx" },
  );
}

function assertManifest(manifest, expectedKind) {
  if (
    manifest?.schema_version !== MANIFEST_SCHEMA_VERSION ||
    manifest.kind !== expectedKind ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`invalid ${expectedKind} bundle manifest`);
  }
  const paths = new Set();
  for (const record of manifest.files) {
    assertSafeRelativePath(record?.path);
    assertXiphPublicationPath(record.path);
    if (paths.has(record.path)) throw new Error(`duplicate bundle path ${record.path}`);
    paths.add(record.path);
    if (
      !Number.isSafeInteger(record.size_bytes) ||
      record.size_bytes < 0 ||
      !SHA256.test(record.sha256)
    ) {
      throw new Error(`${record.path}: invalid bundle identity`);
    }
  }
  const sorted = [...paths].sort();
  if (sorted.some((relative, index) => relative !== manifest.files[index].path)) {
    throw new Error("bundle manifest paths must be sorted");
  }
}

function assertSafeRelativePath(relative) {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.includes(":") ||
    relative
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe bundle path ${JSON.stringify(relative)}`);
  }
}

async function assertRegularPath(file, root) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${file}: expected a regular non-reparse file`);
  }
  const [resolvedFile, resolvedRoot] = await Promise.all([realpath(file), realpath(root)]);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${file}: resolved path escapes its trusted root`);
  }
}

async function assertDirectoryPath(directory) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${directory}: expected a non-reparse directory`);
  }
}

async function walkBundleFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`${path.join(directory, entry.name)}: reparse entries are forbidden`);
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkBundleFiles(root, absolute)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`${absolute}: unsupported bundle entry type`);
    files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files.sort();
}

async function assertEmptyDirectory(directory) {
  try {
    const entries = await readdir(directory);
    if (entries.length !== 0) {
      throw new Error(`${directory}: bundle output directory must be empty`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
  }
}
