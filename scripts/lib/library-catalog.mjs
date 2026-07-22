import { sha256Hex } from "./hash.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.dll$/i;
const NUMERIC_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const ARCHITECTURES = new Set(["X64", "X86"]);
const MICROSOFT_PACKAGE_IDS = Object.freeze({
  d3d12_agility: "Microsoft.Direct3D.D3D12",
  direct_storage: "Microsoft.Direct3D.DirectStorage",
  microsoft_dxc: "Microsoft.Direct3D.DXC",
});

export const LIBRARY_INDEX_KEY = "libraries/v1/index.json";
export const LIBRARY_BLOB_PREFIX = "libraries/blobs/sha256";
export const LIBRARY_VENDOR_PREFIX = "libraries/v1/vendors";

export function jsonDocument(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function blobObjectKey(transportSha256) {
  assertSha256(transportSha256, "transport SHA-256");
  return `${LIBRARY_BLOB_PREFIX}/${transportSha256}.dll.zst`;
}

export function vendorSnapshotObjectKey(vendorId, snapshotSha256) {
  assertSafeId(vendorId, "vendor id");
  assertSha256(snapshotSha256, "vendor snapshot SHA-256");
  return `${LIBRARY_VENDOR_PREFIX}/${vendorId}/${snapshotSha256}.json`;
}

export function buildVendorSnapshot(source) {
  assertVendorSource(source);

  const artifactsByKey = new Map();
  const artifacts = source.artifacts.map((artifact) => {
    const artifactId = `sha256:${artifact.dll.sha256}`;
    artifactsByKey.set(artifact.artifact_key, { source: artifact, artifactId });
    return compactObject({
      artifact_id: artifactId,
      library_id: artifact.library_id,
      file_name: artifact.file_name,
      file_version: artifact.file_version,
      architecture: artifact.architecture,
      dll: artifact.dll,
      transport: {
        compression: "zstd",
        object_key: blobObjectKey(artifact.transport.sha256),
        sha256: artifact.transport.sha256,
        size_bytes: artifact.transport.size_bytes,
      },
      signature: artifact.signature,
      extensions: artifact.extensions,
    });
  });

  const packages = source.packages.map((sourcePackage) => {
    const members = sourcePackage.members.map((member) => {
      const artifact = artifactsByKey.get(member.artifact_key);
      if (!artifact) {
        throw new Error(
          `${source.vendor.id}/${sourcePackage.package_id}: unknown artifact key ${member.artifact_key}`,
        );
      }
      return {
        artifact_id: artifact.artifactId,
        role: member.role,
        install_as: member.install_as,
      };
    });
    const revisionInput = compactObject({
      package_id: sourcePackage.package_id,
      technology: sourcePackage.technology,
      variant: sourcePackage.variant,
      release: sourcePackage.release,
      target: sourcePackage.target,
      provenance: sourcePackage.provenance,
      members,
    });

    return compactObject({
      package_id: sourcePackage.package_id,
      revision_sha256: sha256Hex(canonicalJson(revisionInput)),
      technology: sourcePackage.technology,
      variant: sourcePackage.variant,
      display_name: sourcePackage.display_name,
      release: sourcePackage.release,
      target: sourcePackage.target,
      provenance: sourcePackage.provenance,
      members,
      extensions: sourcePackage.extensions,
    });
  });

  const snapshot = {
    schema_version: 1,
    vendor: source.vendor,
    generated_at: source.generated_at,
    artifacts,
    packages,
  };
  assertVendorSnapshot(snapshot);
  return snapshot;
}

export function buildLibraryIndex(vendorDocuments) {
  if (!Array.isArray(vendorDocuments) || vendorDocuments.length === 0) {
    throw new Error("library index requires at least one vendor snapshot");
  }

  const vendors = vendorDocuments
    .map(({ snapshot, body }) => {
      assertVendorSnapshot(snapshot);
      if (!Buffer.isBuffer(body)) {
        throw new Error(`${snapshot.vendor.id}: vendor snapshot body must be a Buffer`);
      }
      const snapshotSha256 = sha256Hex(body);
      return {
        vendor_id: snapshot.vendor.id,
        display_name: snapshot.vendor.display_name,
        snapshot_key: vendorSnapshotObjectKey(snapshot.vendor.id, snapshotSha256),
        snapshot_sha256: snapshotSha256,
        snapshot_size_bytes: body.length,
      };
    })
    .sort((left, right) => left.vendor_id.localeCompare(right.vendor_id));

  const duplicateVendor = firstDuplicate(vendors.map((vendor) => vendor.vendor_id));
  if (duplicateVendor)
    throw new Error(`duplicate vendor in library index: ${duplicateVendor}`);

  const packageOwners = new Map();
  for (const { snapshot } of vendorDocuments) {
    for (const packageValue of snapshot.packages) {
      const previousVendor = packageOwners.get(packageValue.package_id);
      if (previousVendor) {
        throw new Error(
          `duplicate package ${packageValue.package_id} across vendors ${previousVendor} and ${snapshot.vendor.id}`,
        );
      }
      packageOwners.set(packageValue.package_id, snapshot.vendor.id);
    }
  }

  const index = {
    schema_version: 1,
    generated_at: latestTimestamp(
      vendorDocuments.map(({ snapshot }) => snapshot.generated_at),
    ),
    vendors,
  };
  assertLibraryIndex(index);
  return index;
}

export function assertLibraryIndex(index) {
  if (index?.schema_version !== 1) {
    throw new Error("library index must use schema_version 1");
  }
  assertTimestamp(index.generated_at, "library index: generated_at");
  if (!Array.isArray(index.vendors) || index.vendors.length === 0) {
    throw new Error("library index requires at least one vendor");
  }

  const vendorIds = new Set();
  for (const vendor of index.vendors) {
    assertSafeId(vendor.vendor_id, "library index: vendor_id");
    if (vendorIds.has(vendor.vendor_id)) {
      throw new Error(`library index: duplicate vendor ${vendor.vendor_id}`);
    }
    vendorIds.add(vendor.vendor_id);
    if (typeof vendor.display_name !== "string" || !vendor.display_name.trim()) {
      throw new Error(`${vendor.vendor_id}: vendor display_name is required`);
    }
    assertSha256(vendor.snapshot_sha256, `${vendor.vendor_id}: snapshot SHA-256`);
    assertPositiveInteger(vendor.snapshot_size_bytes, `${vendor.vendor_id}: snapshot size`);
    if (
      vendor.snapshot_key !==
      vendorSnapshotObjectKey(vendor.vendor_id, vendor.snapshot_sha256)
    ) {
      throw new Error(`${vendor.vendor_id}: snapshot key is not content-addressed`);
    }
  }
}

export function assertVendorSource(source) {
  if (source?.schema_version !== 1) {
    throw new Error("library vendor source must use schema_version 1");
  }
  assertVendor(source.vendor);
  assertTimestamp(source.generated_at, `${source.vendor.id}: generated_at`);
  if (!Array.isArray(source.artifacts) || !Array.isArray(source.packages)) {
    throw new Error(`${source.vendor.id}: artifacts and packages must be arrays`);
  }

  const artifactKeys = new Set();
  const artifactsByKey = new Map();
  const artifactIds = new Set();
  for (const artifact of source.artifacts) {
    assertSafeId(artifact.artifact_key, `${source.vendor.id}: artifact_key`);
    if (artifactKeys.has(artifact.artifact_key)) {
      throw new Error(
        `${source.vendor.id}: duplicate artifact_key ${artifact.artifact_key}`,
      );
    }
    artifactKeys.add(artifact.artifact_key);
    artifactsByKey.set(artifact.artifact_key, artifact);
    assertArtifactCommon(artifact, `${source.vendor.id}/${artifact.artifact_key}`);
    if (artifactIds.has(artifact.dll.sha256)) {
      throw new Error(`${source.vendor.id}: duplicate DLL identity ${artifact.dll.sha256}`);
    }
    artifactIds.add(artifact.dll.sha256);
  }

  const packageIds = new Set();
  const referencedArtifactKeys = new Set();
  for (const packageValue of source.packages) {
    const context = `${source.vendor.id}/${packageValue.package_id}`;
    assertSafeId(packageValue.package_id, `${source.vendor.id}: package_id`);
    if (packageIds.has(packageValue.package_id)) {
      throw new Error(
        `${source.vendor.id}: duplicate package_id ${packageValue.package_id}`,
      );
    }
    packageIds.add(packageValue.package_id);
    assertPackageCommon(packageValue, context);

    const installTargets = new Set();
    let primaryCount = 0;
    for (const [memberIndex, member] of packageValue.members.entries()) {
      if (!artifactKeys.has(member.artifact_key)) {
        throw new Error(`${context}: unknown artifact ${member.artifact_key}`);
      }
      assertSafeId(member.role, `${context}: member role`);
      assertFileName(member.install_as, `${context}: install_as`);
      const target = member.install_as.toLowerCase();
      if (installTargets.has(target)) {
        throw new Error(`${context}: duplicate install target ${member.install_as}`);
      }
      installTargets.add(target);
      if (member.role === "primary") primaryCount += 1;
      if (member.role === "primary" && memberIndex !== 0) {
        throw new Error(`${context}: primary member must be listed first`);
      }
      referencedArtifactKeys.add(member.artifact_key);
      const artifact = artifactsByKey.get(member.artifact_key);
      if (artifact.architecture !== packageValue.target.architecture) {
        throw new Error(`${context}: member architecture differs from package target`);
      }
    }
    if (primaryCount !== 1) {
      throw new Error(`${context}: package must contain exactly one primary member`);
    }
  }
  for (const artifactKey of artifactKeys) {
    if (!referencedArtifactKeys.has(artifactKey)) {
      throw new Error(`${source.vendor.id}: unreferenced artifact ${artifactKey}`);
    }
  }
}

export function assertVendorSnapshot(snapshot) {
  if (snapshot?.schema_version !== 1) {
    throw new Error("library vendor snapshot must use schema_version 1");
  }
  assertVendor(snapshot.vendor);
  assertTimestamp(snapshot.generated_at, `${snapshot.vendor.id}: generated_at`);
  if (!Array.isArray(snapshot.artifacts) || !Array.isArray(snapshot.packages)) {
    throw new Error(`${snapshot.vendor.id}: artifacts and packages must be arrays`);
  }

  const artifacts = new Map();
  for (const artifact of snapshot.artifacts) {
    const context = `${snapshot.vendor.id}/${artifact.artifact_id}`;
    if (artifact.artifact_id !== `sha256:${artifact.dll?.sha256}`) {
      throw new Error(`${context}: artifact id must equal the DLL content identity`);
    }
    assertArtifactCommon(artifact, context);
    if (artifact.transport?.compression !== "zstd") {
      throw new Error(`${context}: unsupported transport compression`);
    }
    if (artifact.transport.object_key !== blobObjectKey(artifact.transport.sha256)) {
      throw new Error(`${context}: transport object key is not content-addressed`);
    }
    if (artifacts.has(artifact.artifact_id)) {
      throw new Error(`${snapshot.vendor.id}: duplicate artifact ${artifact.artifact_id}`);
    }
    artifacts.set(artifact.artifact_id, artifact);
  }

  const packageIds = new Set();
  const referencedArtifactIds = new Set();
  for (const packageValue of snapshot.packages) {
    const context = `${snapshot.vendor.id}/${packageValue.package_id}`;
    assertSafeId(packageValue.package_id, `${snapshot.vendor.id}: package_id`);
    assertSha256(packageValue.revision_sha256, `${context}: revision_sha256`);
    if (packageIds.has(packageValue.package_id)) {
      throw new Error(
        `${snapshot.vendor.id}: duplicate package ${packageValue.package_id}`,
      );
    }
    packageIds.add(packageValue.package_id);
    assertPackageCommon(packageValue, context);
    const revisionInput = compactObject({
      package_id: packageValue.package_id,
      technology: packageValue.technology,
      variant: packageValue.variant,
      release: packageValue.release,
      target: packageValue.target,
      provenance: packageValue.provenance,
      members: packageValue.members,
    });
    if (packageValue.revision_sha256 !== sha256Hex(canonicalJson(revisionInput))) {
      throw new Error(`${context}: revision_sha256 does not match package contract`);
    }

    const installTargets = new Set();
    let primaryCount = 0;
    for (const [memberIndex, member] of packageValue.members.entries()) {
      const artifact = artifacts.get(member.artifact_id);
      if (!artifact) throw new Error(`${context}: unknown artifact ${member.artifact_id}`);
      assertSafeId(member.role, `${context}: member role`);
      assertFileName(member.install_as, `${context}: install_as`);
      const target = member.install_as.toLowerCase();
      if (installTargets.has(target)) {
        throw new Error(`${context}: duplicate install target ${member.install_as}`);
      }
      installTargets.add(target);
      if (member.role === "primary") primaryCount += 1;
      if (member.role === "primary" && memberIndex !== 0) {
        throw new Error(`${context}: primary member must be listed first`);
      }
      referencedArtifactIds.add(member.artifact_id);
      if (artifact.architecture !== packageValue.target.architecture) {
        throw new Error(`${context}: member architecture differs from package target`);
      }
    }
    if (primaryCount !== 1) {
      throw new Error(`${context}: package must contain exactly one primary member`);
    }
  }
  for (const artifactId of artifacts.keys()) {
    if (!referencedArtifactIds.has(artifactId)) {
      throw new Error(`${snapshot.vendor.id}: unreferenced artifact ${artifactId}`);
    }
  }
}

function assertArtifactCommon(artifact, context) {
  assertSafeId(artifact.library_id, `${context}: library_id`);
  assertFileName(artifact.file_name, `${context}: file_name`);
  assertNumericVersion(artifact.file_version, `${context}: file_version`);
  if (!ARCHITECTURES.has(artifact.architecture)) {
    throw new Error(`${context}: unsupported architecture ${artifact.architecture}`);
  }
  assertSha256(artifact.dll?.sha256, `${context}: DLL SHA-256`);
  assertPositiveInteger(artifact.dll?.size_bytes, `${context}: DLL size`);
  assertSha256(artifact.transport?.sha256, `${context}: transport SHA-256`);
  assertPositiveInteger(artifact.transport?.size_bytes, `${context}: transport size`);
  if (
    !artifact.signature ||
    !new Set(["signed", "unsigned"]).has(artifact.signature.status)
  ) {
    throw new Error(`${context}: invalid signature status`);
  }
  if (artifact.signature.signed_at != null) {
    assertTimestamp(artifact.signature.signed_at, `${context}: signed_at`);
  }
  assertExtensions(artifact.extensions, `${context}: extensions`);
}

function assertPackageCommon(packageValue, context) {
  assertSafeId(packageValue.technology, `${context}: technology`);
  assertSafeId(packageValue.variant, `${context}: variant`);
  if (typeof packageValue.display_name !== "string" || !packageValue.display_name.trim()) {
    throw new Error(`${context}: display_name is required`);
  }
  assertNumericVersion(packageValue.release?.version, `${context}: release version`);
  if (!new Set(["stable", "beta", "debug"]).has(packageValue.release.channel)) {
    throw new Error(`${context}: invalid release channel`);
  }
  if (
    packageValue.release.label !== null &&
    packageValue.release.label !== undefined &&
    typeof packageValue.release.label !== "string"
  ) {
    throw new Error(`${context}: release label must be a string or null`);
  }
  if (packageValue.target?.os !== "windows") {
    throw new Error(`${context}: only Windows packages are supported in schema v1`);
  }
  if (!ARCHITECTURES.has(packageValue.target.architecture)) {
    throw new Error(`${context}: unsupported target architecture`);
  }
  const compatibility = packageValue.target.compatibility;
  if (packageValue.technology === "d3d12_agility") {
    if (
      compatibility?.kind !== "d3d12_sdk" ||
      !Number.isSafeInteger(compatibility.version) ||
      compatibility.version <= 0 ||
      Number(packageValue.release.version.split(".")[1]) !== compatibility.version
    ) {
      throw new Error(`${context}: D3D12 compatibility must match the release SDK line`);
    }
  } else if (compatibility !== undefined) {
    throw new Error(`${context}: compatibility is only valid for D3D12 Agility packages`);
  }
  if (!Array.isArray(packageValue.members) || packageValue.members.length === 0) {
    throw new Error(`${context}: package must contain members`);
  }
  if (packageValue.provenance !== undefined) {
    if (packageValue.provenance.kind !== "nuget") {
      throw new Error(`${context}: unsupported package provenance`);
    }
    if (
      typeof packageValue.provenance.package_id !== "string" ||
      !packageValue.provenance.package_id.trim()
    ) {
      throw new Error(`${context}: NuGet package id is required`);
    }
    assertNumericVersion(packageValue.provenance.version, `${context}: NuGet version`);
    if (packageValue.provenance.version !== packageValue.release.version) {
      throw new Error(`${context}: NuGet version must match the package release`);
    }
    if (!SHA512_BASE64_PATTERN.test(packageValue.provenance.package_sha512)) {
      throw new Error(`${context}: NuGet package SHA-512 is invalid`);
    }
  }
  const expectedPackageId = MICROSOFT_PACKAGE_IDS[packageValue.technology];
  if (
    expectedPackageId &&
    (packageValue.provenance?.kind !== "nuget" ||
      packageValue.provenance.package_id.toLowerCase() !== expectedPackageId.toLowerCase())
  ) {
    throw new Error(`${context}: Microsoft runtime provenance is missing or inconsistent`);
  }
  assertExtensions(packageValue.extensions, `${context}: extensions`);
}

function assertExtensions(value, label) {
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) {
    throw new Error(`${label} must be an object`);
  }
}

function assertVendor(vendor) {
  assertSafeId(vendor?.id, "vendor id");
  if (typeof vendor.display_name !== "string" || !vendor.display_name.trim()) {
    throw new Error(`${vendor.id}: vendor display_name is required`);
  }
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
  }
}

function assertFileName(value, label) {
  if (typeof value !== "string" || !SAFE_FILE_NAME_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertNumericVersion(value, label) {
  if (
    typeof value !== "string" ||
    !NUMERIC_VERSION_PATTERN.test(value) ||
    value.split(".").some((segment) => BigInt(segment) > MAX_U64)
  ) {
    throw new Error(`${label} must be a dotted numeric version`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not an RFC 3339 timestamp`);
  }
}

function latestTimestamp(values) {
  const timestamps = values.map((value) => {
    assertTimestamp(value, "catalog timestamp");
    return Date.parse(value);
  });
  return new Date(Math.max(...timestamps)).toISOString();
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
