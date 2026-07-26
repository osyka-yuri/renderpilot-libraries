import { isDeepStrictEqual } from "node:util";

import {
  assertLegalDocumentContentIdentity,
  assertLegalDocumentDescriptor,
  assertNumericVersion,
  assertPackageVersion,
  blobObjectKey,
  comparePackageVersions,
  recordImmutableObjectIdentity,
} from "./library-catalog.mjs";
import {
  dottedNumericVersionParts,
  normalizeRfc3339Timestamp,
  packageVersionIdentity,
  packageVersionNumericCore,
  parsePackageVersion,
} from "./library-values.mjs";

const WINDOWS_ARCHITECTURES = new Set(["X64", "X86"]);
const MICROSOFT_SIGNATURE_KEYS = new Set(["status", "subject", "thumbprint", "signed_at"]);
export const MICROSOFT_WITHDRAWAL_REASONS = Object.freeze([
  "unlisted",
  "hard_delete",
  "security",
  "legal",
]);
const WITHDRAWAL_REASONS = new Set(MICROSOFT_WITHDRAWAL_REASONS);
const TRANSPORT_OBJECT_PATTERN = /^libraries\/blobs\/sha256\/[0-9a-f]{64}\.dll\.zst$/u;
const MAX_WITHDRAWAL_EVIDENCE_LENGTH = 2048;
const PRODUCT_CONTRACTS = Object.freeze({
  d3d12_agility: {
    packageId: "Microsoft.Direct3D.D3D12",
    compatibility: "d3d12_sdk",
  },
  dxc: { packageId: "Microsoft.Direct3D.DXC", compatibility: null },
  directstorage: {
    packageId: "Microsoft.Direct3D.DirectStorage",
    compatibility: null,
  },
});

export function assertLockSemantics(lock, config) {
  if (
    lock?.schema_version !== 4 ||
    !Array.isArray(lock.releases) ||
    !Array.isArray(lock.withdrawn)
  ) {
    throw new Error(
      "Microsoft NuGet lock must use schema_version 4 with releases and withdrawn arrays",
    );
  }
  const compiled = compileMicrosoftConfig(config);
  const releaseKeys = new Set();
  const assetObjects = new Map();

  for (const release of lock.releases) {
    assertPackageVersion(
      release?.package_version,
      `${release?.package_id ?? "Microsoft release"}: package_version`,
    );
    const releaseKey = releaseIdentity(release);
    if (releaseKeys.has(releaseKey)) {
      throw new Error(`duplicate Microsoft NuGet release ${releaseKey}`);
    }
    releaseKeys.add(releaseKey);

    const product = compiled.products.get(release.product);
    if (!product || product.value.package_id !== release.package_id) {
      throw new Error(`${releaseKey}: product/package identity does not match config`);
    }
    if (!Array.isArray(release.artifacts) || release.artifacts.length === 0) {
      throw new Error(`${releaseKey}: release must contain artifacts`);
    }

    const units = validateReleaseArtifacts(
      release,
      releaseKey,
      product,
      compiled.trustedSignerSubjects,
      assetObjects,
    );
    validateReleaseLegalDocuments(release, releaseKey, product, assetObjects);
    validateProductCapabilities(releaseKey, product, units);
  }
  assertWithdrawnTombstones(lock.withdrawn, releaseKeys, compiled.products);
}

export function assertMicrosoftConfig(config) {
  compileMicrosoftConfig(config);
}

export function assertMicrosoftWithdrawalEvidence(
  reason,
  evidence,
  context = "withdrawal evidence",
) {
  const manual = reason === "security" || reason === "legal";
  if (evidence === undefined) {
    if (manual) {
      throw new Error(`${context} is required for ${reason} withdrawal`);
    }
    return;
  }
  if (
    typeof evidence !== "string" ||
    evidence.length === 0 ||
    evidence !== evidence.trim() ||
    [...evidence].length > MAX_WITHDRAWAL_EVIDENCE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(evidence)
  ) {
    throw new Error(
      `${context} must be a trimmed printable string of at most ${MAX_WITHDRAWAL_EVIDENCE_LENGTH} characters`,
    );
  }
}

export function assertLockExtendsBaseline(lock, baseline) {
  const current = indexReleases(lock.releases);
  const previousReleases = indexReleases(baseline.releases);
  const previousWithdrawn = indexReleases(baseline.withdrawn ?? []);
  const currentWithdrawn = indexReleases(lock.withdrawn);

  for (const previous of baseline.releases) {
    const key = releaseIdentity(previous);
    const next = current.get(key);
    if (next) {
      assertReleaseContentIdentity(next, previous);
      continue;
    }

    const tombstone = currentWithdrawn.get(key);
    if (!tombstone) {
      throw new Error(`${key}: immutable release was removed without a tombstone`);
    }
    const expectedTransportKeys = uniqueSorted(
      previous.artifacts.map((artifact) => artifact.r2.object_key),
    );
    if (
      !isDeepStrictEqual([...tombstone.transport_object_keys].sort(), expectedTransportKeys)
    ) {
      throw new Error(`${key}: withdrawal tombstone lost transport object identity`);
    }
  }

  for (const previous of baseline.withdrawn ?? []) {
    const key = releaseIdentity(previous);
    const next = currentWithdrawn.get(key);
    if (!next || !isDeepStrictEqual(next, previous)) {
      throw new Error(`${key}: immutable withdrawal tombstone changed or disappeared`);
    }
  }
  for (const [key] of currentWithdrawn) {
    if (!previousWithdrawn.has(key) && !previousReleases.has(key)) {
      throw new Error(`${key}: new withdrawal tombstone has no active baseline release`);
    }
  }
}

export function assertReleaseContentIdentity(release, baseline) {
  const comparable = withoutTransport(release);
  const previous = withoutTransport(baseline);
  if (!isDeepStrictEqual(comparable, previous)) {
    const difference = firstDifference(comparable, previous);
    throw new Error(
      `${releaseIdentity(baseline)}: immutable release content changed at ${difference.path} (${JSON.stringify(difference.left)} != ${JSON.stringify(difference.right)})`,
    );
  }
}

export function assertLockBackfillsSignatures(lock, baseline) {
  if (lock.releases.length !== baseline.releases.length) {
    throw new Error("signature backfill changed release membership");
  }
  const current = indexReleases(lock.releases);
  for (const previous of baseline.releases) {
    const key = releaseIdentity(previous);
    const next = current.get(key);
    if (!next) throw new Error(`${key}: signature backfill removed an immutable release`);
    assertReleaseBackfillsSignatures(next, previous);
  }
}

export function assertReleaseBackfillsSignatures(release, baseline) {
  const comparable = structuredClone(release);
  const previousArtifacts = new Map(
    baseline.artifacts.map((artifact) => [artifactIdentity(artifact), artifact]),
  );
  for (const artifact of comparable.artifacts ?? []) {
    const previous = previousArtifacts.get(artifactIdentity(artifact));
    if (
      previous?.signature?.signed_at === null &&
      typeof artifact.signature?.signed_at === "string" &&
      !Number.isNaN(Date.parse(artifact.signature.signed_at))
    ) {
      artifact.signature.signed_at = null;
    }
  }
  if (!isDeepStrictEqual(comparable, baseline)) {
    throw new Error(
      `${releaseIdentity(baseline)}: signature backfill changed immutable release data`,
    );
  }
}

export function knownReleaseCounts(lock) {
  return countKnownReleases(lock, () => true);
}

export function knownPreviewReleaseCounts(lock) {
  return countKnownReleases(
    lock,
    (release) => parsePackageVersion(release.package_version).channel === "preview",
  );
}

export function assertMicrosoftKnownReleaseCoverage(product, registration, withdrawn) {
  const identities = registrationIdentitySet(registration);
  const previewIdentities = registrationIdentitySet(
    registration.filter(
      (release) => parsePackageVersion(release.packageVersion).channel === "preview",
    ),
  );
  for (const tombstone of withdrawn) {
    if (tombstone.product !== product.key) continue;
    const identity = packageVersionIdentity(tombstone.package_version);
    identities.add(identity);
    if (parsePackageVersion(tombstone.package_version).channel === "preview") {
      previewIdentities.add(identity);
    }
  }
  assertCoverageFloor(
    product.package_id,
    "known releases",
    identities.size,
    product.minimum_known_releases,
  );
  assertCoverageFloor(
    product.package_id,
    "known preview releases",
    previewIdentities.size,
    product.minimum_known_preview_releases,
  );
}

export function upstreamRelistedWithdrawals(product, registration, withdrawn) {
  const upstreamWithdrawn = new Set(
    withdrawn
      .filter(
        (entry) =>
          entry.product === product.key &&
          (entry.reason === "unlisted" || entry.reason === "hard_delete"),
      )
      .map((entry) => packageVersionIdentity(entry.package_version)),
  );
  return registration.filter(
    (release) =>
      release.listed &&
      upstreamWithdrawn.has(packageVersionIdentity(release.packageVersion)),
  );
}

export function microsoftPrunePlan(
  lock,
  packageId,
  packageVersion,
  activeCatalogObjectKeys,
) {
  if (!activeCatalogObjectKeys || typeof activeCatalogObjectKeys.has !== "function") {
    throw new TypeError(
      "Microsoft prune planning requires the complete active catalog object set",
    );
  }
  const identity = `${packageId.toLowerCase()}@${packageVersionIdentity(packageVersion)}`;
  const tombstone = lock.withdrawn.find((entry) => releaseIdentity(entry) === identity);
  if (!tombstone) {
    throw new Error(`${identity}: withdrawal tombstone does not exist`);
  }
  const partitioned = { delete: [], retained: [] };
  for (const key of tombstone.transport_object_keys) {
    partitioned[activeCatalogObjectKeys.has(key) ? "retained" : "delete"].push(key);
  }
  return {
    package_id: tombstone.package_id,
    package_version: tombstone.package_version,
    reason: tombstone.reason,
    delete_object_keys: partitioned.delete,
    retained_shared_object_keys: partitioned.retained,
  };
}

export function sortLock(lock) {
  lock.releases.sort(compareLockEntries);
  for (const release of lock.releases) {
    release.artifacts.sort(
      (left, right) =>
        left.architecture.localeCompare(right.architecture) ||
        left.library_id.localeCompare(right.library_id),
    );
    release.legal_documents.sort((left, right) =>
      left.package_path.localeCompare(right.package_path),
    );
  }
  lock.withdrawn.sort(compareLockEntries);
  return lock;
}

export function sdkLineForPackageVersion(version) {
  const parts = dottedNumericVersionParts(
    packageVersionNumericCore(version, "D3D12 package version"),
    "D3D12 package version",
  );
  if (parts.length < 2 || parts[1] > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`D3D12 package version has no SDK line: ${version}`);
  }
  return Number(parts[1]);
}

function compileMicrosoftConfig(config) {
  if (
    config?.schema_version !== 1 ||
    !Array.isArray(config.trusted_signer_subjects) ||
    config.trusted_signer_subjects.length === 0 ||
    !Array.isArray(config.products) ||
    config.products.length === 0
  ) {
    throw new Error(
      "Microsoft NuGet config must use schema_version 1 and a products array",
    );
  }
  const trustedSignerSubjects = validateSignerSubjects(config.trusted_signer_subjects);
  const products = new Map();
  for (const product of config.products) {
    const compiled = compileProduct(product);
    if (products.has(product.key)) {
      throw new Error(`unsupported or duplicate Microsoft product ${product.key}`);
    }
    products.set(product.key, compiled);
  }
  return { trustedSignerSubjects, products };
}

function validateSignerSubjects(subjects) {
  const unique = new Set();
  for (const subject of subjects) {
    if (
      typeof subject !== "string" ||
      !subject.trim() ||
      subject !== subject.trim() ||
      unique.has(subject)
    ) {
      throw new Error("Microsoft trusted signer subjects are invalid");
    }
    unique.add(subject);
  }
  if ([...unique].sort().some((subject, index) => subject !== subjects[index])) {
    throw new Error("Microsoft trusted signer subjects must be sorted");
  }
  return unique;
}

function compileProduct(product) {
  const contract = PRODUCT_CONTRACTS[product?.key];
  if (!contract) {
    throw new Error(`unsupported or duplicate Microsoft product ${product?.key}`);
  }
  if (
    product.package_id !== contract.packageId ||
    product.compatibility !== contract.compatibility
  ) {
    throw new Error(
      `${product.key}: package identity or compatibility differs from contract`,
    );
  }
  validateCoverageFloors(product);
  const architectures = validateArchitectures(product);
  const files = validateRuntimeFiles(product);
  const legalDocuments = validateLegalDocuments(product);
  return {
    value: product,
    architectures,
    files,
    requiredFiles: files.filter((file) => file.required),
    expectedUnits: expectedProductUnits(architectures, files),
    legalDocuments,
  };
}

function validateCoverageFloors(product) {
  if (
    !Number.isSafeInteger(product.minimum_known_releases) ||
    product.minimum_known_releases <= 0
  ) {
    throw new Error(`${product.key}: expected release floor must be a positive integer`);
  }
  if (
    !Number.isSafeInteger(product.minimum_known_preview_releases) ||
    product.minimum_known_preview_releases < 0 ||
    product.minimum_known_preview_releases > product.minimum_known_releases
  ) {
    throw new Error(
      `${product.key}: expected preview floor must be an integer between zero and the release floor`,
    );
  }
}

function validateArchitectures(product) {
  if (!Array.isArray(product.architectures) || product.architectures.length === 0) {
    throw new Error(`${product.key}: at least one architecture is required`);
  }
  const packageDirectories = new Set();
  const catalogArchitectures = new Set();
  for (const architecture of product.architectures) {
    const packageDirectory =
      typeof architecture?.package_directory === "string"
        ? architecture.package_directory.toLowerCase()
        : null;
    if (
      typeof architecture?.package_directory !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(architecture.package_directory) ||
      !WINDOWS_ARCHITECTURES.has(architecture.catalog_architecture) ||
      typeof architecture.required !== "boolean" ||
      packageDirectories.has(packageDirectory) ||
      catalogArchitectures.has(architecture.catalog_architecture)
    ) {
      throw new Error(`${product.key}: invalid or duplicate architecture mapping`);
    }
    packageDirectories.add(packageDirectory);
    catalogArchitectures.add(architecture.catalog_architecture);
  }
  return product.architectures;
}

function validateRuntimeFiles(product) {
  if (!Array.isArray(product.files) || product.files.length === 0) {
    throw new Error(`${product.key}: at least one runtime file is required`);
  }
  const libraryIds = new Set();
  const fileNames = new Set();
  for (const file of product.files) {
    const lowerFileName =
      typeof file?.file_name === "string" ? file.file_name.toLowerCase() : null;
    if (
      typeof file?.library_id !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(file.library_id) ||
      typeof file.file_name !== "string" ||
      !/^[A-Za-z0-9._-]+\.dll$/.test(file.file_name) ||
      typeof file.required !== "boolean" ||
      libraryIds.has(file.library_id) ||
      fileNames.has(lowerFileName)
    ) {
      throw new Error(`${product.key}: invalid or duplicate runtime file mapping`);
    }
    libraryIds.add(file.library_id);
    fileNames.add(lowerFileName);
  }
  if (!product.files.some((file) => file.required)) {
    throw new Error(`${product.key}: at least one runtime file must be required`);
  }
  return product.files;
}

function validateLegalDocuments(product) {
  if (!Array.isArray(product.legal_documents) || product.legal_documents.length === 0) {
    throw new Error(`${product.key}: at least one legal document is required`);
  }
  const legalDocuments = new Map();
  for (const document of product.legal_documents) {
    normalizedPackagePath(document?.package_path ?? "", product.key);
    assertLegalDocumentDescriptor(document, `${product.key}/${document.package_path}`);
    if (legalDocuments.has(document.package_path)) {
      throw new Error(`${product.key}: invalid or duplicate legal document`);
    }
    legalDocuments.set(document.package_path, document);
  }
  return legalDocuments;
}

function validateReleaseArtifacts(
  release,
  releaseKey,
  product,
  trustedSignerSubjects,
  assetObjects,
) {
  const units = new Map();
  for (const artifact of release.artifacts) {
    assertNumericVersion(artifact.pe_version, `${releaseKey}: artifact pe_version`);
    assertMicrosoftSignature(
      artifact.signature,
      `${releaseKey}: artifact signature`,
      trustedSignerSubjects,
    );
    const memberKey = artifactIdentity(artifact);
    if (units.has(memberKey)) {
      throw new Error(`${releaseKey}: duplicate artifact ${memberKey}`);
    }
    units.set(memberKey, artifact);

    const expected = product.expectedUnits.get(memberKey);
    if (!expected) {
      throw new Error(`${releaseKey}: unexpected artifact ${memberKey}`);
    }
    assertArtifactMatchesProduct(release, artifact, expected, product.value);
    assertArtifactTransport(releaseKey, memberKey, artifact, assetObjects);
  }
  return units;
}

function assertArtifactTransport(releaseKey, memberKey, artifact, assetObjects) {
  if (!Number.isInteger(artifact.r2?.compression_level)) {
    throw new Error(`${releaseKey}/${memberKey}: compression level is not locked`);
  }
  const expectedObjectKey = blobObjectKey(artifact.r2.zst_sha256);
  if (artifact.r2.object_key !== expectedObjectKey) {
    throw new Error(
      `${releaseKey}/${memberKey}: R2 key does not match compressed content identity`,
    );
  }
  recordImmutableObjectIdentity(
    assetObjects,
    artifact.r2.object_key,
    {
      kind: "dll",
      dll_sha256: artifact.dll_sha256,
      dll_size_bytes: artifact.dll_size_bytes,
      zst_sha256: artifact.r2.zst_sha256,
      zst_size_bytes: artifact.r2.zst_size_bytes,
      compression_level: artifact.r2.compression_level,
    },
    `${releaseKey}/${memberKey}`,
  );
}

function validateReleaseLegalDocuments(release, releaseKey, product, assetObjects) {
  if (
    !Array.isArray(release.legal_documents) ||
    release.legal_documents.length !== product.legalDocuments.size
  ) {
    throw new Error(`${releaseKey}: legal document set is incomplete`);
  }
  for (const document of release.legal_documents) {
    const documentContext = `${releaseKey}/${document?.package_path ?? "<unknown document>"}`;
    assertLegalDocumentDescriptor(document, documentContext);
    assertLegalDocumentContentIdentity(document, documentContext);
    const configured = product.legalDocuments.get(document?.package_path);
    if (
      !configured ||
      document.kind !== configured.kind ||
      document.title !== configured.title ||
      document.format !== configured.format ||
      document.file_name !== configured.file_name
    ) {
      throw new Error(`${releaseKey}: legal document contract is invalid`);
    }
    recordImmutableObjectIdentity(
      assetObjects,
      document.object_key,
      {
        kind: "legal",
        sha256: document.sha256,
        size_bytes: document.size_bytes,
        format: document.format,
      },
      documentContext,
    );
  }
}

function validateProductCapabilities(releaseKey, product, units) {
  for (const architecture of product.architectures) {
    const present = product.files.filter((file) =>
      units.has(`${architecture.catalog_architecture}/${file.library_id}`),
    );
    if (present.length === 0 && !architecture.required) continue;
    const missingRequired = product.requiredFiles.filter(
      (file) => !units.has(`${architecture.catalog_architecture}/${file.library_id}`),
    );
    if (missingRequired.length > 0) {
      throw new Error(
        `${releaseKey}: incomplete ${architecture.catalog_architecture} ${product.value.key} install unit`,
      );
    }
  }
}

function assertWithdrawnTombstones(withdrawn, activeReleaseKeys, products) {
  const identities = new Set();
  for (const tombstone of withdrawn) {
    assertPackageVersion(
      tombstone?.package_version,
      `${tombstone?.package_id ?? "withdrawn package"}: package_version`,
    );
    const identity = releaseIdentity(tombstone);
    if (
      identities.has(identity) ||
      activeReleaseKeys.has(identity) ||
      !WITHDRAWAL_REASONS.has(tombstone.reason) ||
      !isNormalizedTimestamp(tombstone.confirmed_at) ||
      !Array.isArray(tombstone.transport_object_keys) ||
      tombstone.transport_object_keys.length === 0 ||
      new Set(tombstone.transport_object_keys).size !==
        tombstone.transport_object_keys.length ||
      tombstone.transport_object_keys.some(
        (key) => typeof key !== "string" || !TRANSPORT_OBJECT_PATTERN.test(key),
      )
    ) {
      throw new Error(`${identity}: invalid Microsoft withdrawal tombstone`);
    }
    assertMicrosoftWithdrawalEvidence(
      tombstone.reason,
      tombstone.evidence,
      `${identity}: evidence`,
    );
    const product = products.get(tombstone.product);
    if (!product || product.value.package_id !== tombstone.package_id) {
      throw new Error(`${identity}: withdrawn product/package identity is invalid`);
    }
    identities.add(identity);
  }
}

function assertMicrosoftSignature(signature, context, trustedSignerSubjects) {
  const keys = Object.keys(signature ?? {});
  if (
    signature?.status !== "signed" ||
    keys.length !== MICROSOFT_SIGNATURE_KEYS.size ||
    !keys.every((key) => MICROSOFT_SIGNATURE_KEYS.has(key)) ||
    !trustedSignerSubjects.has(signature.subject) ||
    typeof signature.thumbprint !== "string" ||
    !/^[A-F0-9]{40,64}$/u.test(signature.thumbprint) ||
    (signature.signed_at !== null && !isNormalizedTimestamp(signature.signed_at))
  ) {
    throw new Error(`${context} must use the strict signed Authenticode contract`);
  }
}

function expectedProductUnits(architectures, files) {
  const expected = new Map();
  for (const architecture of architectures) {
    for (const file of files) {
      expected.set(`${architecture.catalog_architecture}/${file.library_id}`, {
        architecture,
        file,
      });
    }
  }
  return expected;
}

function assertArtifactMatchesProduct(release, artifact, expected, product) {
  const releaseKey = releaseIdentity(release);
  if (artifact.file_name !== expected.file.file_name) {
    throw new Error(
      `${releaseKey}: ${artifact.architecture}/${artifact.library_id} has unexpected filename`,
    );
  }
  const segments = normalizedPackagePath(artifact.package_path, releaseKey);
  const architectureSegments = product.architectures.filter((architecture) =>
    segments.some(
      (segment) => segment.toLowerCase() === architecture.package_directory.toLowerCase(),
    ),
  );
  if (
    segments.at(-1).toLowerCase() !== expected.file.file_name.toLowerCase() ||
    architectureSegments.length !== 1 ||
    architectureSegments[0] !== expected.architecture
  ) {
    throw new Error(
      `${releaseKey}: ${artifact.package_path} does not match its configured architecture/file`,
    );
  }
  if (product.compatibility === "d3d12_sdk") {
    const packageLine = sdkLineForPackageVersion(release.package_version);
    const peParts = artifact.pe_version.split(".");
    if (peParts.length < 2 || Number(peParts[1]) !== packageLine) {
      throw new Error(
        `${releaseKey}: ${artifact.architecture}/${artifact.library_id} PE version is outside SDK line ${packageLine}`,
      );
    }
  }
}

function normalizedPackagePath(value, releaseKey) {
  if (typeof value !== "string" || value.includes("\\")) {
    throw new Error(`${releaseKey}: package_path must use forward slashes`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${releaseKey}: unsafe package_path ${value}`);
  }
  return segments;
}

function countKnownReleases(lock, predicate) {
  const counts = new Map();
  for (const release of [...lock.releases, ...lock.withdrawn]) {
    if (!predicate(release)) continue;
    counts.set(release.product, (counts.get(release.product) ?? 0) + 1);
  }
  return counts;
}

function registrationIdentitySet(registration) {
  return new Set(
    registration.map((release) => packageVersionIdentity(release.packageVersion)),
  );
}

function assertCoverageFloor(packageId, label, actual, minimum) {
  if (actual < minimum) {
    throw new Error(`${packageId}: expected at least ${minimum} ${label}, got ${actual}`);
  }
}

function compareLockEntries(left, right) {
  return (
    left.package_id.localeCompare(right.package_id) ||
    comparePackageVersions(left.package_version, right.package_version)
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function indexReleases(releases) {
  return new Map(releases.map((release) => [releaseIdentity(release), release]));
}

function withoutTransport(release) {
  const comparable = structuredClone(release);
  for (const artifact of comparable.artifacts ?? []) delete artifact.r2;
  return comparable;
}

function artifactIdentity(artifact) {
  return `${artifact.architecture}/${artifact.library_id}`;
}

function releaseIdentity(release) {
  return `${release.package_id.toLowerCase()}@${packageVersionIdentity(release.package_version)}`;
}

function firstDifference(left, right, current = "$") {
  if (isDeepStrictEqual(left, right)) return { path: current, left, right };
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return { path: current, left, right };
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return { path: `${current}.${key}`, left: left[key], right: right[key] };
    }
    if (!isDeepStrictEqual(left[key], right[key])) {
      return firstDifference(left[key], right[key], `${current}.${key}`);
    }
  }
  return { path: current, left, right };
}

function isNormalizedTimestamp(value) {
  try {
    return normalizeRfc3339Timestamp(value, "signature timestamp") === value;
  } catch {
    return false;
  }
}
