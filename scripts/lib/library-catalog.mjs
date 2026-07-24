import { TextDecoder, isDeepStrictEqual } from "node:util";

import { sha256Hex } from "./hash.mjs";
import {
  compareDottedNumericVersions,
  dottedNumericVersionParts,
  latestRfc3339Timestamp,
  normalizeRfc3339Timestamp,
} from "./library-values.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.dll$/i;
const LABEL_VERSION_PATTERN = /\d+(?:\.\d+)+/gu;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const ARCHITECTURES = new Set(["X64", "X86"]);
const PACKAGE_REVISION_SCHEMA_VERSION = 1;
export const MAX_LEGAL_DOCUMENT_SIZE = 16 * 1024 * 1024;
const MAX_LEGAL_DOCUMENT_TITLE_LENGTH = 256;
const MAX_LEGAL_DOCUMENT_FILE_NAME_LENGTH = 128;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MICROSOFT_PACKAGE_IDS = Object.freeze({
  d3d12_agility: "Microsoft.Direct3D.D3D12",
  direct_storage: "Microsoft.Direct3D.DirectStorage",
  microsoft_dxc: "Microsoft.Direct3D.DXC",
});

export const LIBRARY_INDEX_KEY = "libraries/v1/index.json";
export const LIBRARY_BLOB_PREFIX = "libraries/blobs/sha256";
export const LIBRARY_LEGAL_PREFIX = "libraries/legal/sha256";
export const LIBRARY_VENDOR_PREFIX = "libraries/v1/vendors";

export function jsonDocument(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function blobObjectKey(transportSha256) {
  assertSha256(transportSha256, "transport SHA-256");
  return `${LIBRARY_BLOB_PREFIX}/${transportSha256}.dll.zst`;
}

export function recordImmutableObjectIdentity(objects, objectKey, identity, context) {
  const previous = objects.get(objectKey);
  if (previous && !isDeepStrictEqual(previous, identity)) {
    throw new Error(`${context}: shared asset object has inconsistent metadata`);
  }
  objects.set(objectKey, identity);
}

export function legalDocumentObjectKey(contentSha256, format) {
  assertSha256(contentSha256, "legal document SHA-256");
  if (!new Set(["text", "pdf"]).has(format)) {
    throw new Error(`unsupported legal document format ${JSON.stringify(format)}`);
  }
  return `${LIBRARY_LEGAL_PREFIX}/${contentSha256}.${format === "pdf" ? "pdf" : "txt"}`;
}

export function assertLegalDocumentDescriptor(document, context) {
  if (!new Set(["license", "notice"]).has(document?.kind)) {
    throw new Error(`${context}: unsupported legal document kind`);
  }
  if (
    typeof document.title !== "string" ||
    !document.title.trim() ||
    document.title !== document.title.trim() ||
    [...document.title].length > MAX_LEGAL_DOCUMENT_TITLE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(document.title)
  ) {
    throw new Error(`${context}: title must be concise, printable, and trimmed`);
  }
  if (!new Set(["text", "pdf"]).has(document.format)) {
    throw new Error(`${context}: unsupported legal document format`);
  }
  if (
    typeof document.file_name !== "string" ||
    document.file_name.length > MAX_LEGAL_DOCUMENT_FILE_NAME_LENGTH ||
    !/^[A-Za-z0-9._-]+\.(?:md|pdf|txt)$/iu.test(document.file_name)
  ) {
    throw new Error(`${context}: unsafe legal document file name`);
  }
  const lowerFileName = document.file_name.toLowerCase();
  if (
    (document.format === "pdf" && !lowerFileName.endsWith(".pdf")) ||
    (document.format === "text" &&
      !lowerFileName.endsWith(".md") &&
      !lowerFileName.endsWith(".txt"))
  ) {
    throw new Error(`${context}: file name extension does not match document format`);
  }
}

export function assertLegalDocumentContentIdentity(document, context) {
  assertSha256(document?.sha256, `${context}: content SHA-256`);
  assertPositiveInteger(document?.size_bytes, `${context}: content size`);
  if (document.size_bytes > MAX_LEGAL_DOCUMENT_SIZE) {
    throw new Error(`${context}: content exceeds ${MAX_LEGAL_DOCUMENT_SIZE} bytes`);
  }
  if (
    document.object_key !== undefined &&
    document.object_key !== legalDocumentObjectKey(document.sha256, document.format)
  ) {
    throw new Error(`${context}: object key is not content-addressed`);
  }
}

export function assertLegalDocumentPayload(bytes, format, context) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_LEGAL_DOCUMENT_SIZE
  ) {
    throw new Error(`${context}: payload must contain 1..${MAX_LEGAL_DOCUMENT_SIZE} bytes`);
  }
  if (format === "text") {
    let text;
    try {
      text = FATAL_UTF8_DECODER.decode(bytes);
    } catch {
      throw new Error(`${context}: text payload is not valid UTF-8`);
    }
    if (text.includes("\0")) {
      throw new Error(`${context}: text payload contains a NUL byte`);
    }
    return;
  }
  if (format === "pdf") {
    const header = bytes.subarray(0, 8).toString("ascii");
    if (!/^%PDF-(?:1\.\d|2\.0)$/u.test(header)) {
      throw new Error(`${context}: PDF payload has no canonical PDF header`);
    }
    return;
  }
  throw new Error(`${context}: unsupported legal document format`);
}

export function vendorSnapshotObjectKey(vendorId, snapshotSha256) {
  assertSafeId(vendorId, "vendor id");
  assertSha256(snapshotSha256, "vendor snapshot SHA-256");
  return `${LIBRARY_VENDOR_PREFIX}/${vendorId}/${snapshotSha256}.json`;
}

export function buildVendorSnapshot(source) {
  assertVendorSource(source);

  const legalDocuments = source.legal_documents.map((document) => ({
    legal_document_id: document.legal_document_id,
    kind: document.kind,
    title: document.title,
    format: document.format,
    file_name: document.file_name,
    content: document.content,
    object_key: legalDocumentObjectKey(document.content.sha256, document.format),
  }));
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
      pe_named_exports: artifact.pe_named_exports,
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
    const revisionInput = packageRevisionInput(sourcePackage, members);

    return compactObject({
      package_id: sourcePackage.package_id,
      revision_sha256: sha256Hex(canonicalJson(revisionInput)),
      technology: sourcePackage.technology,
      variant: sourcePackage.variant,
      display_name: sourcePackage.display_name,
      release: sourcePackage.release,
      target: sourcePackage.target,
      provenance: sourcePackage.provenance,
      legal_document_ids: sourcePackage.legal_document_ids,
      members,
      extensions: sourcePackage.extensions,
    });
  });

  const snapshot = {
    schema_version: 1,
    vendor: source.vendor,
    generated_at: source.generated_at,
    legal_documents: legalDocuments,
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
  if (
    !Array.isArray(source.legal_documents) ||
    !Array.isArray(source.artifacts) ||
    !Array.isArray(source.packages)
  ) {
    throw new Error(
      `${source.vendor.id}: legal_documents, artifacts, and packages must be arrays`,
    );
  }
  const legalDocumentIds = assertLegalDocuments(source.legal_documents, source.vendor.id);

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
  const referencedLegalDocumentIds = new Set();
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
    assertPackageLegalReferences(packageValue, legalDocumentIds, context);
    for (const id of packageValue.legal_document_ids ?? []) {
      referencedLegalDocumentIds.add(id);
    }

    const installTargets = new Set();
    const resolvedArtifacts = [];
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
      resolvedArtifacts.push(artifact);
      if (artifact.architecture !== packageValue.target.architecture) {
        throw new Error(`${context}: member architecture differs from package target`);
      }
    }
    if (primaryCount !== 1) {
      throw new Error(`${context}: package must contain exactly one primary member`);
    }
    assertOpenVrPackage(packageValue, resolvedArtifacts, context);
  }
  for (const artifactKey of artifactKeys) {
    if (!referencedArtifactKeys.has(artifactKey)) {
      throw new Error(`${source.vendor.id}: unreferenced artifact ${artifactKey}`);
    }
  }
  for (const legalDocumentId of legalDocumentIds) {
    if (!referencedLegalDocumentIds.has(legalDocumentId)) {
      throw new Error(
        `${source.vendor.id}: unreferenced legal document ${legalDocumentId}`,
      );
    }
  }
}

export function assertVendorSnapshot(snapshot) {
  if (snapshot?.schema_version !== 1) {
    throw new Error("library vendor snapshot must use schema_version 1");
  }
  assertVendor(snapshot.vendor);
  assertTimestamp(snapshot.generated_at, `${snapshot.vendor.id}: generated_at`);
  if (
    !Array.isArray(snapshot.legal_documents) ||
    !Array.isArray(snapshot.artifacts) ||
    !Array.isArray(snapshot.packages)
  ) {
    throw new Error(
      `${snapshot.vendor.id}: legal_documents, artifacts, and packages must be arrays`,
    );
  }
  const legalDocumentIds = assertLegalDocuments(
    snapshot.legal_documents,
    snapshot.vendor.id,
  );

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
  const referencedLegalDocumentIds = new Set();
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
    assertPackageLegalReferences(packageValue, legalDocumentIds, context);
    for (const id of packageValue.legal_document_ids ?? []) {
      referencedLegalDocumentIds.add(id);
    }
    assertPackageCommon(packageValue, context);
    const revisionInput = packageRevisionInput(packageValue, packageValue.members);
    if (packageValue.revision_sha256 !== sha256Hex(canonicalJson(revisionInput))) {
      throw new Error(`${context}: revision_sha256 does not match package contract`);
    }

    const installTargets = new Set();
    const resolvedArtifacts = [];
    let primaryCount = 0;
    for (const [memberIndex, member] of packageValue.members.entries()) {
      const artifact = artifacts.get(member.artifact_id);
      if (!artifact) throw new Error(`${context}: unknown artifact ${member.artifact_id}`);
      resolvedArtifacts.push(artifact);
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
    assertOpenVrPackage(packageValue, resolvedArtifacts, context);
  }
  for (const artifactId of artifacts.keys()) {
    if (!referencedArtifactIds.has(artifactId)) {
      throw new Error(`${snapshot.vendor.id}: unreferenced artifact ${artifactId}`);
    }
  }
  for (const legalDocumentId of legalDocumentIds) {
    if (!referencedLegalDocumentIds.has(legalDocumentId)) {
      throw new Error(
        `${snapshot.vendor.id}: unreferenced legal document ${legalDocumentId}`,
      );
    }
  }
}

function assertArtifactCommon(artifact, context) {
  assertSafeId(artifact.library_id, `${context}: library_id`);
  assertFileName(artifact.file_name, `${context}: file_name`);
  if (artifact.file_version !== null) {
    assertNumericVersion(artifact.file_version, `${context}: file_version`);
  }
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
  if (artifact.pe_named_exports !== undefined) {
    assertPeNamedExports(artifact.pe_named_exports, `${context}: pe_named_exports`);
  }
  assertExtensions(artifact.extensions, `${context}: extensions`);
}

function assertPackageCommon(packageValue, context) {
  assertSafeId(packageValue.technology, `${context}: technology`);
  assertSafeId(packageValue.variant, `${context}: variant`);
  if (
    typeof packageValue.display_name !== "string" ||
    !packageValue.display_name ||
    packageValue.display_name !== packageValue.display_name.trim()
  ) {
    throw new Error(`${context}: display_name must be a non-blank trimmed string`);
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
  if (typeof packageValue.release.label === "string") {
    const label = packageValue.release.label;
    if (!label || label !== label.trim()) {
      throw new Error(`${context}: release label must be a non-blank trimmed annotation`);
    }
    if (
      normalizePresentationText(label) ===
      normalizePresentationText(packageValue.display_name)
    ) {
      throw new Error(`${context}: release label repeats the package display name`);
    }
    if (
      (label.match(LABEL_VERSION_PATTERN) ?? []).some((candidate) =>
        isVersionPrefix(candidate, packageValue.release.version),
      )
    ) {
      throw new Error(
        `${context}: release label repeats the package version; keep only supplemental information`,
      );
    }
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
    if (packageValue.provenance.kind === "nuget") {
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
    } else if (packageValue.provenance.kind === "github_release") {
      if (
        typeof packageValue.provenance.repository !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(packageValue.provenance.repository) ||
        typeof packageValue.provenance.tag !== "string" ||
        !packageValue.provenance.tag.trim() ||
        typeof packageValue.provenance.commit_sha !== "string" ||
        !/^[0-9a-f]{40}$/u.test(packageValue.provenance.commit_sha)
      ) {
        throw new Error(`${context}: GitHub release provenance is invalid`);
      }
    } else {
      throw new Error(`${context}: unsupported package provenance`);
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

function assertLegalDocuments(documents, vendorId) {
  const ids = new Set();
  const identities = new Set();
  for (const document of documents) {
    const context = `${vendorId}/${document?.legal_document_id ?? "<unknown legal document>"}`;
    assertSafeId(document?.legal_document_id, `${context}: legal_document_id`);
    if (ids.has(document.legal_document_id)) {
      throw new Error(
        `${vendorId}: duplicate legal document ${document.legal_document_id}`,
      );
    }
    ids.add(document.legal_document_id);
    assertLegalDocumentDescriptor(document, context);
    assertLegalDocumentContentIdentity(
      {
        ...document.content,
        format: document.format,
        object_key: document.object_key,
      },
      context,
    );
    const expectedDocumentId = `${document.kind}.${document.content.sha256}`;
    if (document.legal_document_id !== expectedDocumentId) {
      throw new Error(`${context}: legal document id is not content-addressed`);
    }
    if (
      document.object_key !== undefined &&
      document.object_key !==
        legalDocumentObjectKey(document.content.sha256, document.format)
    ) {
      throw new Error(`${context}: object key is not content-addressed`);
    }
    const identity = `${document.kind}\0${document.content.sha256}`;
    if (identities.has(identity)) {
      throw new Error(`${vendorId}: duplicate legal document content identity`);
    }
    identities.add(identity);
  }
  const sorted = [...ids].sort();
  if (sorted.some((id, index) => id !== documents[index]?.legal_document_id)) {
    throw new Error(`${vendorId}: legal documents must be sorted by id`);
  }
  return ids;
}

function assertPackageLegalReferences(packageValue, legalDocumentIds, context) {
  if (packageValue.legal_document_ids === undefined) return;
  if (
    !Array.isArray(packageValue.legal_document_ids) ||
    packageValue.legal_document_ids.length === 0
  ) {
    throw new Error(`${context}: legal_document_ids must be a non-empty array`);
  }
  let previous = null;
  for (const id of packageValue.legal_document_ids) {
    assertSafeId(id, `${context}: legal document id`);
    if (!legalDocumentIds.has(id)) {
      throw new Error(`${context}: unknown legal document ${id}`);
    }
    if (previous !== null && previous >= id) {
      throw new Error(`${context}: legal document ids must be sorted and unique`);
    }
    previous = id;
  }
}

function assertOpenVrPackage(packageValue, artifacts, context) {
  if (packageValue.technology !== "openvr") return;
  if (
    packageValue.provenance?.kind !== "github_release" ||
    packageValue.provenance.repository !== "ValveSoftware/openvr"
  ) {
    throw new Error(`${context}: OpenVR requires official GitHub release provenance`);
  }
  if (
    packageValue.members.length !== 1 ||
    packageValue.members[0].install_as.toLowerCase() !== "openvr_api.dll"
  ) {
    throw new Error(`${context}: OpenVR must contain exactly one openvr_api.dll`);
  }
  const artifact = artifacts[0];
  if (
    artifact?.library_id !== "openvr_api" ||
    artifact.file_name.toLowerCase() !== "openvr_api.dll" ||
    artifact.architecture !== packageValue.target.architecture
  ) {
    throw new Error(`${context}: OpenVR artifact contract is inconsistent`);
  }
  assertPeNamedExports(artifact.pe_named_exports, `${context}: OpenVR exports`);
}

export function assertPeNamedExports(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16_384) {
    throw new Error(`${label} must contain 1..16384 names`);
  }
  const seen = new Set();
  let previous = null;
  for (const name of value) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      Buffer.byteLength(name, "ascii") > 256 ||
      !/^[\x20-\x7e]+$/u.test(name)
    ) {
      throw new Error(`${label} contains an invalid ASCII export name`);
    }
    if (seen.has(name)) throw new Error(`${label} contains duplicate ${name}`);
    if (previous !== null && previous >= name) {
      throw new Error(`${label} must be sorted and unique`);
    }
    seen.add(name);
    previous = name;
  }
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
  dottedNumericVersionParts(value, label);
}

export function compareNumericVersions(left, right) {
  return compareDottedNumericVersions(left, right);
}

function releaseIdentity(release) {
  return {
    version: release.version,
    channel: release.channel,
  };
}

function packageRevisionInput(packageValue, members) {
  return compactObject({
    schema_version: PACKAGE_REVISION_SCHEMA_VERSION,
    package_id: packageValue.package_id,
    technology: packageValue.technology,
    variant: packageValue.variant,
    release: releaseIdentity(packageValue.release),
    target: packageValue.target,
    provenance: packageValue.provenance,
    members,
  });
}

function isVersionPrefix(candidate, version) {
  const candidateSegments = candidate.split(".");
  const versionSegments = version.split(".");
  return (
    candidateSegments.length <= versionSegments.length &&
    candidateSegments.every(
      (segment, index) => BigInt(segment) === BigInt(versionSegments[index]),
    )
  );
}

function normalizePresentationText(value) {
  return value.replace(/\s+/gu, " ").toLowerCase();
}

function assertTimestamp(value, label) {
  normalizeRfc3339Timestamp(value, label);
}

function latestTimestamp(values) {
  return latestRfc3339Timestamp(values, "catalog timestamp");
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
