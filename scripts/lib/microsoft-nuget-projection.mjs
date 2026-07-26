import { isDeepStrictEqual } from "node:util";

import { packageReleaseChannel } from "./library-catalog.mjs";
import { latestRfc3339Timestamp } from "./library-values.mjs";
import { assertLockSemantics, sdkLineForPackageVersion } from "./microsoft-nuget-lock.mjs";

const PRODUCT_PRESENTATION = Object.freeze({
  d3d12_agility: {
    technology: "d3d12_agility",
    displayName: "Microsoft D3D12 Agility SDK",
  },
  dxc: {
    technology: "microsoft_dxc",
    displayName: "Microsoft DirectX Shader Compiler",
  },
  directstorage: {
    technology: "direct_storage",
    displayName: "Microsoft DirectStorage",
  },
});

export function buildMicrosoftVendorSource(lock, config) {
  assertLockSemantics(lock, config);
  const products = new Map(config.products.map((product) => [product.key, product]));
  const artifacts = [];
  const packages = [];
  const legalDocuments = new Map();

  for (const release of lock.releases) {
    const product = products.get(release.product);
    const artifactsByArchitecture = new Map();
    const legalDocumentIds = collectLegalDocuments(release, legalDocuments);

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
      packages.push(buildPackage(release, product, architecture, unit, legalDocumentIds));
    }
  }

  return {
    schema_version: 1,
    vendor: { id: "microsoft", display_name: "Microsoft" },
    generated_at: latestRfc3339Timestamp(
      lock.releases.map((release) => release.published_at),
      "Microsoft catalog timestamp",
    ),
    legal_documents: [...legalDocuments.values()].sort((left, right) =>
      left.legal_document_id.localeCompare(right.legal_document_id),
    ),
    artifacts,
    packages,
  };
}

function collectLegalDocuments(release, legalDocuments) {
  return release.legal_documents
    .map((document) => {
      const legalDocumentId = `${document.kind}.${document.sha256}`;
      const value = {
        legal_document_id: legalDocumentId,
        kind: document.kind,
        title: document.title,
        format: document.format,
        file_name: document.file_name,
        content: { sha256: document.sha256, size_bytes: document.size_bytes },
      };
      const previous = legalDocuments.get(legalDocumentId);
      if (previous && !isDeepStrictEqual(previous, value)) {
        throw new Error(
          `${release.package_id}@${release.package_version}: duplicate legal document is inconsistent`,
        );
      }
      legalDocuments.set(legalDocumentId, value);
      return legalDocumentId;
    })
    .sort();
}

function buildPackage(release, product, architecture, unit, legalDocumentIds) {
  const ordered = product.files.flatMap((configured) => {
    const member = unit.find(
      ({ artifact }) => artifact.library_id === configured.library_id,
    );
    if (member) return [member];
    if (!configured.required) return [];
    throw new Error(
      `${releaseIdentity(release)}/${architecture}: missing ${configured.library_id}`,
    );
  });
  const target = { os: "windows", architecture };
  if (release.product === "d3d12_agility") {
    target.compatibility = {
      kind: "d3d12_sdk",
      version: sdkLineForPackageVersion(release.package_version),
    };
  }
  const presentation = PRODUCT_PRESENTATION[release.product];
  if (!presentation) throw new Error(`unsupported Microsoft product ${release.product}`);

  return {
    package_id: `${release.product}.${release.package_version}.${architecture.toLowerCase()}`,
    technology: presentation.technology,
    variant: ordered.length === 1 ? "runtime" : "runtime_bundle",
    display_name: presentation.displayName,
    release: {
      version: release.package_version,
      channel: packageReleaseChannel(
        release.package_version,
        `${release.package_id}: package_version`,
      ),
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
  };
}

function microsoftArtifactKey(release, artifact) {
  return `${release.product}.${release.package_version}.${artifact.architecture.toLowerCase()}.${artifact.library_id}`;
}

function releaseIdentity(release) {
  return `${release.package_id.toLowerCase()}@${release.package_version}`;
}
