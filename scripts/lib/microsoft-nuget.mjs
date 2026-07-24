import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { fetchWithTimeout } from "./http.mjs";
import {
  assertLegalDocumentContentIdentity,
  assertLegalDocumentDescriptor,
  assertNumericVersion,
  blobObjectKey,
  compareNumericVersions,
  legalDocumentObjectKey,
  recordImmutableObjectIdentity,
} from "./library-catalog.mjs";
import {
  dottedNumericVersionParts,
  latestRfc3339Timestamp,
  normalizeDottedNumericVersion,
  normalizeRfc3339Timestamp,
} from "./library-values.mjs";

const REGISTRATION_BASE = "https://api.nuget.org/v3/registration5-gz-semver2";
const WINDOWS_ARCHITECTURES = new Set(["X64", "X86"]);
const MICROSOFT_SIGNATURE_KEYS = new Set(["status", "subject", "thumbprint", "signed_at"]);
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

export async function listedStableReleases(packageId, fetchImpl = fetch) {
  const normalizedId = packageId.toLowerCase();
  const index = await fetchJson(
    `${REGISTRATION_BASE}/${encodeURIComponent(normalizedId)}/index.json`,
    fetchImpl,
  );
  const leaves = [];

  for (const page of index.items ?? []) {
    const resolved = page.items ? page : await fetchJson(page["@id"], fetchImpl);
    leaves.push(...(resolved.items ?? []));
  }

  return leaves
    .map((leaf) => leaf.catalogEntry)
    .filter(
      (entry) =>
        entry &&
        entry.listed !== false &&
        isStableNuGetVersion(entry.version) &&
        typeof entry.packageContent === "string" &&
        typeof entry["@id"] === "string",
    )
    .map((entry) => ({
      packageId: entry.id,
      packageVersion: entry.version,
      packageContent: entry.packageContent,
      catalogEntry: entry["@id"],
      publishedAt: new Date(entry.published).toISOString(),
    }))
    .sort((left, right) =>
      compareNumericVersions(left.packageVersion, right.packageVersion),
    );
}

export async function fetchPackageSha512(catalogEntryUrl, fetchImpl = fetch) {
  const details = await fetchJson(catalogEntryUrl, fetchImpl);
  const algorithm = details.packageHashAlgorithm;
  const hash = details.packageHash;

  if (typeof algorithm !== "string" || algorithm.toUpperCase() !== "SHA512") {
    throw new Error(
      `NuGet catalog entry ${catalogEntryUrl} uses unsupported package hash ${algorithm}`,
    );
  }
  if (typeof hash !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(hash)) {
    throw new Error(
      `NuGet catalog entry ${catalogEntryUrl} has malformed SHA-512 metadata`,
    );
  }

  return hash;
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
  const normalized = paths.map((value) => ({
    original: value,
    normalized: value.replaceAll("\\", "/").replace(/^\.\//, ""),
  }));
  const configuredFileNames = new Set(
    product.files.map((file) => file.file_name.toLowerCase()),
  );
  for (const candidate of normalized) {
    const segments = candidate.normalized.split("/");
    if (!configuredFileNames.has(segments.at(-1)?.toLowerCase())) continue;
    if (
      path.posix.isAbsolute(candidate.normalized) ||
      path.win32.isAbsolute(candidate.normalized) ||
      candidate.normalized.includes(":") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`${product.package_id}: unsafe package path ${candidate.original}`);
    }
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    const matchingArchitectures = product.architectures.filter((architecture) =>
      lowerSegments.includes(architecture.package_directory.toLowerCase()),
    );
    if (matchingArchitectures.length > 1) {
      throw new Error(
        `${product.package_id}: ambiguous architecture path ${candidate.original}`,
      );
    }
  }
  const selections = [];

  for (const architecture of product.architectures) {
    const members = [];

    for (const file of product.files) {
      const matches = normalized.filter(({ normalized: candidate }) => {
        const segments = candidate.toLowerCase().split("/");
        const fileNameMatches = segments.at(-1) === file.file_name.toLowerCase();
        const architectureMatches = segments.includes(
          architecture.package_directory.toLowerCase(),
        );
        return fileNameMatches && architectureMatches;
      });

      if (matches.length > 1) {
        throw new Error(
          `${product.package_id}: ambiguous ${architecture.package_directory}/${file.file_name}: ${matches.map((match) => match.original).join(", ")}`,
        );
      }
      if (matches.length === 1) {
        members.push({ ...file, package_path: matches[0].normalized });
      }
    }

    if (members.length === 0 && !architecture.required) {
      continue;
    }
    if (members.length !== product.files.length) {
      const found = new Set(members.map((member) => member.file_name.toLowerCase()));
      const missing = product.files
        .filter((file) => !found.has(file.file_name.toLowerCase()))
        .map((file) => file.file_name);
      throw new Error(
        `${product.package_id}: incomplete ${architecture.package_directory} install unit; missing ${missing.join(", ")}`,
      );
    }

    selections.push({ architecture, members });
  }

  return selections;
}

export function buildMicrosoftVendorSource(lock, config) {
  assertLockSemantics(lock, config);
  const products = new Map(config.products.map((product) => [product.key, product]));
  const artifacts = [];
  const packages = [];
  const legalDocuments = new Map();

  for (const release of lock.releases) {
    const product = products.get(release.product);
    const artifactsByArchitecture = new Map();
    const legalDocumentIds = release.legal_documents
      .map((document) => {
        const legal_document_id = `${document.kind}.${document.sha256}`;
        const value = {
          legal_document_id,
          kind: document.kind,
          title: document.title,
          format: document.format,
          file_name: document.file_name,
          content: { sha256: document.sha256, size_bytes: document.size_bytes },
        };
        const previous = legalDocuments.get(legal_document_id);
        if (previous && !isDeepStrictEqual(previous, value)) {
          throw new Error(
            `${release.package_id}@${release.package_version}: duplicate legal document is inconsistent`,
          );
        }
        legalDocuments.set(legal_document_id, value);
        return legal_document_id;
      })
      .sort();

    for (const artifact of release.artifacts) {
      const artifactKey = microsoftArtifactKey(release, artifact);
      artifacts.push({
        artifact_key: artifactKey,
        library_id: artifact.library_id,
        file_name: artifact.file_name,
        file_version: artifact.pe_version,
        architecture: artifact.architecture,
        dll: {
          sha256: artifact.dll_sha256,
          size_bytes: artifact.dll_size_bytes,
        },
        transport: {
          sha256: artifact.r2.zst_sha256,
          size_bytes: artifact.r2.zst_size_bytes,
        },
        signature: artifact.signature,
      });
      const unit = artifactsByArchitecture.get(artifact.architecture) ?? [];
      unit.push({ artifact, artifactKey });
      artifactsByArchitecture.set(artifact.architecture, unit);
    }

    for (const [architecture, unit] of artifactsByArchitecture) {
      const ordered = product.files.map((configured) => {
        const member = unit.find(
          ({ artifact }) => artifact.library_id === configured.library_id,
        );
        if (!member) {
          throw new Error(
            `${releaseIdentity(release)}/${architecture}: missing ${configured.library_id}`,
          );
        }
        return member;
      });
      const target = { os: "windows", architecture };
      if (release.product === "d3d12_agility") {
        target.compatibility = {
          kind: "d3d12_sdk",
          version: sdkLineForPackageVersion(release.package_version),
        };
      }
      packages.push({
        package_id: microsoftPackageId(release, architecture),
        technology: microsoftTechnology(release.product),
        variant: ordered.length === 1 ? "runtime" : "runtime_bundle",
        display_name: microsoftDisplayName(release.product),
        release: {
          version: release.package_version,
          channel: "stable",
          label: null,
        },
        target,
        provenance: {
          kind: "nuget",
          package_id: release.package_id,
          version: release.package_version,
          package_sha512: release.package_sha512,
        },
        legal_document_ids: legalDocumentIds,
        members: ordered.map(({ artifact, artifactKey }, index) => ({
          artifact_key: artifactKey,
          role: index === 0 ? "primary" : artifact.library_id,
          install_as: artifact.file_name,
        })),
      });
    }
  }

  return {
    schema_version: 1,
    vendor: { id: "microsoft", display_name: "Microsoft" },
    generated_at: latestTimestamp(lock.releases.map((release) => release.published_at)),
    legal_documents: [...legalDocuments.values()].sort((left, right) =>
      left.legal_document_id.localeCompare(right.legal_document_id),
    ),
    artifacts,
    packages,
  };
}

export function assertLockSemantics(lock, config) {
  if (lock?.schema_version !== 3 || !Array.isArray(lock.releases)) {
    throw new Error("Microsoft NuGet lock must use schema_version 3 and a releases array");
  }

  if (config) assertMicrosoftConfig(config);

  const releaseKeys = new Set();
  const assetObjects = new Map();
  const products = config
    ? new Map(config.products.map((product) => [product.key, product]))
    : null;

  for (const release of lock.releases) {
    assertNumericVersion(release.package_version, `${release.package_id}: package_version`);
    const releaseKey = releaseIdentity(release);
    if (releaseKeys.has(releaseKey)) {
      throw new Error(`duplicate Microsoft NuGet release ${releaseKey}`);
    }
    releaseKeys.add(releaseKey);

    const product = products?.get(release.product);
    if (products && (!product || product.package_id !== release.package_id)) {
      throw new Error(`${releaseKey}: product/package identity does not match config`);
    }

    const expectedUnits = product ? expectedProductUnits(product) : null;
    const units = new Map();
    for (const artifact of release.artifacts) {
      assertNumericVersion(artifact.pe_version, `${releaseKey}: artifact pe_version`);
      assertMicrosoftSignature(
        artifact.signature,
        `${releaseKey}: artifact signature`,
        config,
      );
      const memberKey = `${artifact.architecture}/${artifact.library_id}`;
      if (units.has(memberKey)) {
        throw new Error(`${releaseKey}: duplicate artifact ${memberKey}`);
      }
      units.set(memberKey, artifact);

      if (expectedUnits) {
        const expected = expectedUnits.get(memberKey);
        if (!expected) {
          throw new Error(`${releaseKey}: unexpected artifact ${memberKey}`);
        }
        assertArtifactMatchesProduct(release, artifact, expected, product);
      }

      if (!Number.isInteger(artifact.r2.compression_level)) {
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

    if (
      !Array.isArray(release.legal_documents) ||
      release.legal_documents.length !== product.legal_documents.length
    ) {
      throw new Error(`${releaseKey}: legal document set is incomplete`);
    }
    const configuredDocuments = new Map(
      product.legal_documents.map((document) => [document.package_path, document]),
    );
    for (const document of release.legal_documents) {
      const documentContext = `${releaseKey}/${document?.package_path ?? "<unknown document>"}`;
      assertLegalDocumentDescriptor(document, documentContext);
      assertLegalDocumentContentIdentity(document, documentContext);
      const configured = configuredDocuments.get(document?.package_path);
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
        `${releaseKey}/${document.package_path}`,
      );
    }

    if (product) {
      for (const architecture of product.architectures) {
        const present = product.files.filter((file) =>
          units.has(`${architecture.catalog_architecture}/${file.library_id}`),
        );
        if (present.length === 0 && !architecture.required) continue;
        if (present.length !== product.files.length) {
          throw new Error(
            `${releaseKey}: incomplete ${architecture.catalog_architecture} ${product.key} install unit`,
          );
        }
      }
    }
  }
}

function assertMicrosoftSignature(signature, context, config) {
  const keys = Object.keys(signature ?? {});
  if (
    signature?.status !== "signed" ||
    keys.length !== 4 ||
    !keys.every((key) => MICROSOFT_SIGNATURE_KEYS.has(key)) ||
    !config.trusted_signer_subjects.includes(signature.subject) ||
    typeof signature.thumbprint !== "string" ||
    !/^[A-F0-9]{40,64}$/u.test(signature.thumbprint) ||
    (signature.signed_at !== null && !isNormalizedTimestamp(signature.signed_at))
  ) {
    throw new Error(`${context} must use the strict signed Authenticode contract`);
  }
}

export function assertMicrosoftConfig(config) {
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
  const signerSubjects = new Set();
  for (const subject of config.trusted_signer_subjects) {
    if (
      typeof subject !== "string" ||
      !subject.trim() ||
      subject !== subject.trim() ||
      signerSubjects.has(subject)
    ) {
      throw new Error("Microsoft trusted signer subjects are invalid");
    }
    signerSubjects.add(subject);
  }
  if (
    [...signerSubjects]
      .sort()
      .some((subject, index) => subject !== config.trusted_signer_subjects[index])
  ) {
    throw new Error("Microsoft trusted signer subjects must be sorted");
  }
  const products = new Set();
  for (const product of config.products) {
    const contract = PRODUCT_CONTRACTS[product?.key];
    if (!contract || products.has(product.key)) {
      throw new Error(`unsupported or duplicate Microsoft product ${product?.key}`);
    }
    products.add(product.key);
    if (
      product.package_id !== contract.packageId ||
      product.compatibility !== contract.compatibility
    ) {
      throw new Error(
        `${product.key}: package identity or compatibility differs from contract`,
      );
    }
    if (
      !Number.isSafeInteger(product.expected_listed_stable_releases) ||
      product.expected_listed_stable_releases <= 0
    ) {
      throw new Error(`${product.key}: expected release floor must be a positive integer`);
    }
    if (!Array.isArray(product.architectures) || product.architectures.length === 0) {
      throw new Error(`${product.key}: at least one architecture is required`);
    }
    const packageDirectories = new Set();
    const catalogArchitectures = new Set();
    for (const architecture of product.architectures) {
      if (
        typeof architecture.package_directory !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(architecture.package_directory) ||
        !WINDOWS_ARCHITECTURES.has(architecture.catalog_architecture) ||
        typeof architecture.required !== "boolean" ||
        packageDirectories.has(architecture.package_directory.toLowerCase()) ||
        catalogArchitectures.has(architecture.catalog_architecture)
      ) {
        throw new Error(`${product.key}: invalid or duplicate architecture mapping`);
      }
      packageDirectories.add(architecture.package_directory.toLowerCase());
      catalogArchitectures.add(architecture.catalog_architecture);
    }
    if (!Array.isArray(product.files) || product.files.length === 0) {
      throw new Error(`${product.key}: at least one runtime file is required`);
    }
    const libraryIds = new Set();
    const fileNames = new Set();
    for (const file of product.files) {
      if (
        typeof file.library_id !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(file.library_id) ||
        typeof file.file_name !== "string" ||
        !/^[A-Za-z0-9._-]+\.dll$/.test(file.file_name) ||
        libraryIds.has(file.library_id) ||
        fileNames.has(file.file_name.toLowerCase())
      ) {
        throw new Error(`${product.key}: invalid or duplicate runtime file mapping`);
      }
      libraryIds.add(file.library_id);
      fileNames.add(file.file_name.toLowerCase());
    }
    if (!Array.isArray(product.legal_documents) || product.legal_documents.length === 0) {
      throw new Error(`${product.key}: at least one legal document is required`);
    }
    const legalPaths = new Set();
    for (const document of product.legal_documents) {
      normalizedPackagePath(document?.package_path ?? "", product.key);
      assertLegalDocumentDescriptor(document, `${product.key}/${document.package_path}`);
      if (legalPaths.has(document.package_path)) {
        throw new Error(`${product.key}: invalid or duplicate legal document`);
      }
      legalPaths.add(document.package_path);
    }
  }
}

/// Enforces append-only lock evolution against a previously published lock.
/// NuGet packages and extracted DLL identities are immutable. The ZST object is
/// deliberately excluded: it is a replaceable, content-addressed transport
/// representation whose integrity is validated independently before publish.
export function assertLockExtendsBaseline(lock, baseline) {
  const current = new Map(
    lock.releases.map((release) => [releaseIdentity(release), release]),
  );
  for (const previous of baseline.releases) {
    const key = releaseIdentity(previous);
    const next = current.get(key);
    if (!next) throw new Error(`${key}: immutable release was removed from the lock`);
    assertReleaseContentIdentity(next, previous);
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

/// One-time repair policy used only while re-reading the original signed DLLs.
/// Release membership must remain exact and the only permitted difference is
/// replacing an unknown signature time with a verified date-time string.
export function assertLockBackfillsSignatures(lock, baseline) {
  if (lock.releases.length !== baseline.releases.length) {
    throw new Error("signature backfill changed release membership");
  }
  const current = new Map(
    lock.releases.map((release) => [releaseIdentity(release), release]),
  );
  for (const previous of baseline.releases) {
    const key = releaseIdentity(previous);
    const next = current.get(key);
    if (!next) throw new Error(`${key}: signature backfill removed an immutable release`);
    assertReleaseBackfillsSignatures(next, previous);
  }
}

function withoutTransport(release) {
  const comparable = structuredClone(release);
  for (const artifact of comparable.artifacts ?? []) delete artifact.r2;
  return comparable;
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

function artifactIdentity(artifact) {
  return `${artifact.architecture}/${artifact.library_id}`;
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
      return {
        path: `${current}.${key}`,
        left: left[key],
        right: right[key],
      };
    }
    if (!isDeepStrictEqual(left[key], right[key])) {
      return firstDifference(left[key], right[key], `${current}.${key}`);
    }
  }
  return { path: current, left, right };
}

function releaseIdentity(release) {
  return `${release.package_id.toLowerCase()}@${normalizedNumericVersion(release.package_version)}`;
}

function expectedProductUnits(product) {
  const expected = new Map();
  for (const architecture of product.architectures) {
    for (const file of product.files) {
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
  if (value.includes("\\")) {
    throw new Error(`${releaseKey}: package_path must use forward slashes`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${releaseKey}: unsafe package_path ${value}`);
  }
  return segments;
}

export function releaseCounts(lock) {
  const counts = new Map();
  for (const release of lock.releases) {
    counts.set(release.product, (counts.get(release.product) ?? 0) + 1);
  }
  return counts;
}

export function sortLock(lock) {
  lock.releases.sort((left, right) => {
    const packageOrder = left.package_id.localeCompare(right.package_id);
    return (
      packageOrder || compareNumericVersions(left.package_version, right.package_version)
    );
  });
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
  return lock;
}

export function sdkLineForPackageVersion(version) {
  const parts = dottedNumericVersionParts(version, "D3D12 package version");
  if (parts.length < 2 || parts[1] > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`D3D12 package version has no SDK line: ${version}`);
  }
  return Number(parts[1]);
}

function normalizedNumericVersion(version) {
  return normalizeDottedNumericVersion(version);
}

function isStableNuGetVersion(version) {
  return /^\d+(?:\.\d+){0,3}$/.test(version);
}

function latestTimestamp(values) {
  return latestRfc3339Timestamp(values);
}

function isNormalizedTimestamp(value) {
  try {
    return normalizeRfc3339Timestamp(value, "signature timestamp") === value;
  } catch {
    return false;
  }
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchWithTimeout(url, {
    fetchFn: fetchImpl,
    timeoutMs: 30_000,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`request failed (${response.status}) for ${url}`);
  return response.json();
}

function microsoftArtifactKey(release, artifact) {
  return `${release.product}.${release.package_version}.${artifact.architecture.toLowerCase()}.${artifact.library_id}`;
}

function microsoftPackageId(release, architecture) {
  return `${release.product}.${release.package_version}.${architecture.toLowerCase()}`;
}

function microsoftTechnology(product) {
  const technologies = {
    d3d12_agility: "d3d12_agility",
    dxc: "microsoft_dxc",
    directstorage: "direct_storage",
  };
  const technology = technologies[product];
  if (!technology) throw new Error(`unsupported Microsoft product ${product}`);
  return technology;
}

function microsoftDisplayName(product) {
  const names = {
    d3d12_agility: "Microsoft D3D12 Agility SDK",
    dxc: "Microsoft DirectX Shader Compiler",
    directstorage: "Microsoft DirectStorage",
  };
  const name = names[product];
  if (!name) throw new Error(`unsupported Microsoft product ${product}`);
  return name;
}

export const pathForPackageMember = (extractRoot, packagePath) =>
  path.join(extractRoot, ...packagePath.split("/"));
