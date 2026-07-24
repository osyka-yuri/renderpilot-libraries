import { assertNumericVersion, compareNumericVersions } from "./library-catalog.mjs";

const AMD_EXCLUSIONS = new Map([
  ["v1.0.0", "release commit does not contain distributable FidelityFX runtime DLLs"],
  ["fsr3-v3.0.3", "release commit does not contain distributable FidelityFX runtime DLLs"],
  ["fsr3-v3.0.4", "release commit does not contain distributable FidelityFX runtime DLLs"],
]);
const OPENVR_REVISION_TAGS = new Set(["v1.1.3b", "v1.6.10b"]);

const AMD_COMPONENTS = Object.freeze({
  "amd_fidelityfx_dx12.dll": Object.freeze({
    technology: "amd_fsr",
    variant: "dx12_runtime",
    displayName: "AMD FidelityFX Super Resolution",
  }),
  "amd_fidelityfx_vk.dll": Object.freeze({
    technology: "amd_fsr",
    variant: "vulkan_runtime",
    displayName: "AMD FidelityFX Super Resolution",
  }),
  "amd_fidelityfx_loader_dx12.dll": Object.freeze({
    technology: "amd_fsr_loader",
    variant: "runtime",
    displayName: "AMD FidelityFX Loader",
  }),
  "amd_fidelityfx_upscaler_dx12.dll": Object.freeze({
    technology: "amd_fsr_upscaler",
    variant: "runtime",
    displayName: "AMD FidelityFX Upscaler",
  }),
  "amd_fidelityfx_framegeneration_dx12.dll": Object.freeze({
    technology: "amd_fsr_frame_generation",
    variant: "runtime",
    displayName: "AMD FidelityFX Frame Generation",
  }),
  "amd_fidelityfx_denoiser_dx12.dll": Object.freeze({
    technology: "amd_fsr_ray_regeneration",
    variant: "runtime",
    displayName: "AMD FidelityFX Ray Regeneration",
  }),
  "amd_fidelityfx_radiancecache_dx12.dll": Object.freeze({
    technology: "amd_fsr_radiance_cache",
    variant: "runtime",
    displayName: "AMD FidelityFX Radiance Cache",
  }),
});

const INTEL_COMPONENTS = Object.freeze({
  "libxess.dll": Object.freeze({
    technology: "intel_xess",
    variant: "dx12_runtime",
    displayName: "Intel XeSS",
  }),
  "libxess_dx11.dll": Object.freeze({
    technology: "intel_xess",
    variant: "dx11_runtime",
    displayName: "Intel XeSS",
  }),
  "libxess_fg.dll": Object.freeze({
    technology: "intel_xefg",
    variant: "dx12_runtime",
    displayName: "Intel Xe Frame Generation",
  }),
  "libxell.dll": Object.freeze({
    technology: "intel_xell",
    variant: "runtime",
    displayName: "Intel Xe Low Latency",
  }),
});

function parseNumericTag(tag, pattern, profileName) {
  if (typeof tag !== "string") throw new Error(`${profileName} release tag is missing`);
  const match = pattern.exec(tag);
  if (!match) throw new Error(`unsupported stable ${profileName} tag ${tag}`);
  assertNumericVersion(match[1], `${tag}: release version`);
  return { version: match[1], label: null };
}

function amdReleasePlan(release) {
  const exclusionReason = AMD_EXCLUSIONS.get(release.tag);
  if (exclusionReason) {
    return { disposition: "excluded", exclusionReason };
  }

  let dllDirectory;
  let dllNames;
  let licensePath;
  if (/^v1\.1\.[0-4]$/u.test(release.tag)) {
    dllDirectory = "PrebuiltSignedDLL";
    dllNames = ["amd_fidelityfx_dx12.dll", "amd_fidelityfx_vk.dll"];
    licensePath = "docs/license.md";
  } else if (release.tag === "v2.0.0") {
    dllDirectory = "Kits/FidelityFX/signedbin";
    dllNames = [
      "amd_fidelityfx_framegeneration_dx12.dll",
      "amd_fidelityfx_loader_dx12.dll",
      "amd_fidelityfx_upscaler_dx12.dll",
    ];
    licensePath = "docs/license.md";
  } else if (/^v2\.(?:1\.[01]|2\.0|3\.0)$/u.test(release.tag)) {
    dllDirectory = "Kits/FidelityFX/signedbin";
    dllNames = [
      "amd_fidelityfx_denoiser_dx12.dll",
      "amd_fidelityfx_framegeneration_dx12.dll",
      "amd_fidelityfx_loader_dx12.dll",
      "amd_fidelityfx_radiancecache_dx12.dll",
      "amd_fidelityfx_upscaler_dx12.dll",
    ];
    licensePath = "Kits/FidelityFX/docs/license.md";
  } else {
    throw new Error(`unreviewed AMD FidelityFX release layout ${release.tag}`);
  }

  const legalDocuments = [
    {
      kind: "license",
      title: "AMD FidelityFX SDK License",
      format: "text",
      file_name: "LICENSE.md",
      repository_path: licensePath,
    },
  ];
  if (release.tag === "v2.3.0") {
    legalDocuments.push({
      kind: "notice",
      title: "AMD FidelityFX SDK Third-Party Notices",
      format: "text",
      file_name: "THIRD-PARTY-NOTICES.md",
      repository_path: "3rdpartynotice.md",
    });
  }
  return {
    disposition: "imported",
    artifacts: dllNames.map((fileName) => ({
      component: fileName.slice(0, -4),
      architecture: "X64",
      repository_path: `${dllDirectory}/${fileName}`,
    })),
    legalDocuments,
  };
}

function intelReleasePlan(release) {
  const major = Number(release.version.split(".")[0]);
  if (major === 1) {
    return {
      disposition: "imported",
      artifacts: [
        {
          component: "libxess",
          architecture: "X64",
          repository_path: "bin/libxess.dll",
        },
      ],
      legalDocuments: [
        {
          kind: "license",
          title: "Intel XeSS SDK License",
          format: "pdf",
          file_name: "LICENSE.pdf",
          repository_path: "licenses/LICENSE.pdf",
        },
        {
          kind: "notice",
          title: "Intel XeSS SDK Third-Party Programs",
          format: "text",
          file_name: "THIRD-PARTY-PROGRAMS.txt",
          repository_path: "licenses/third-party-programs.txt",
        },
      ],
    };
  }
  if (major === 2 || major === 3) {
    return {
      disposition: "imported",
      artifacts: ["libxell", "libxess", "libxess_dx11", "libxess_fg"].map((component) => ({
        component,
        architecture: "X64",
        repository_path: `bin/${component}.dll`,
      })),
      legalDocuments: [
        {
          kind: "license",
          title: "Intel XeSS SDK License",
          format: "text",
          file_name: "LICENSE.txt",
          repository_path: "LICENSE.txt",
        },
        {
          kind: "notice",
          title: "Intel XeSS SDK Third-Party Programs",
          format: "text",
          file_name: "THIRD-PARTY-PROGRAMS.txt",
          repository_path: "third-party-programs.txt",
        },
      ],
    };
  }
  throw new Error(`unreviewed Intel XeSS release layout ${release.tag}`);
}

function openVrReleasePlan() {
  return {
    disposition: "imported",
    artifacts: [
      {
        component: "openvr_api",
        architecture: "X64",
        repository_path: "bin/win64/openvr_api.dll",
      },
      {
        component: "openvr_api",
        architecture: "X86",
        repository_path: "bin/win32/openvr_api.dll",
      },
    ],
    legalDocuments: [
      {
        kind: "license",
        title: "OpenVR SDK License",
        format: "text",
        file_name: "LICENSE.txt",
        repository_path: "LICENSE",
      },
    ],
  };
}

function supplementalAmdLabel(release, fileName) {
  if (/^v1\.1\.[0-4]$/u.test(release.tag)) {
    return `FSR 3.1.${release.version.split(".").at(-1)}`;
  }
  if (release.tag === "v2.0.0" && fileName === "amd_fidelityfx_loader_dx12.dll") {
    return "FidelityFX SDK 2.0.0";
  }
  if (fileName === "amd_fidelityfx_radiancecache_dx12.dll") return "preview";
  return null;
}

function singleArtifactPackage(
  release,
  artifact,
  legalDocumentIds,
  descriptor,
  releaseLabel = null,
) {
  const fileName = `${artifact.component}.dll`;
  const peVersion = requiredPeVersion(artifact, `${release.tag}/${fileName}`);
  const artifactKey = `${artifact.component}.${artifact.dll_sha256}`;
  return {
    package_id: `${artifact.component}_${peVersion}`,
    technology: descriptor.technology,
    variant: descriptor.variant,
    display_name: descriptor.displayName,
    release: {
      version: peVersion,
      channel: "stable",
      label: releaseLabel,
    },
    target: { os: "windows", architecture: artifact.architecture },
    provenance: githubProvenance(release),
    legal_document_ids: legalDocumentIds,
    members: [{ artifact_key: artifactKey, role: "primary", install_as: fileName }],
  };
}

function buildAmdPackages(release, artifacts, legalDocumentIds) {
  const packages = artifacts.map((artifact) => {
    const fileName = `${artifact.component}.dll`;
    const descriptor = AMD_COMPONENTS[fileName];
    if (!descriptor) throw new Error(`${release.tag}: unknown AMD component ${fileName}`);
    return singleArtifactPackage(
      release,
      artifact,
      legalDocumentIds,
      descriptor,
      supplementalAmdLabel(release, fileName),
    );
  });
  const byComponent = new Map(artifacts.map((artifact) => [artifact.component, artifact]));
  const bundleComponents = [
    "amd_fidelityfx_upscaler_dx12",
    "amd_fidelityfx_loader_dx12",
    "amd_fidelityfx_framegeneration_dx12",
  ];
  if (bundleComponents.every((component) => byComponent.has(component))) {
    const [upscaler, loader, frameGeneration] = bundleComponents.map((component) =>
      byComponent.get(component),
    );
    const version = requiredPeVersion(upscaler, `${release.tag}: upscaler`);
    packages.push({
      package_id: `fsr_dx12_sdk.${version}`,
      technology: "amd_fsr",
      variant: "sdk_bundle",
      display_name: "AMD FidelityFX SDK DirectX 12",
      release: { version, channel: "stable", label: null },
      target: { os: "windows", architecture: "X64" },
      provenance: githubProvenance(release),
      legal_document_ids: legalDocumentIds,
      members: [
        {
          artifact_key: artifactKey(upscaler),
          role: "primary",
          install_as: "amd_fidelityfx_upscaler_dx12.dll",
        },
        {
          artifact_key: artifactKey(loader),
          role: "loader",
          install_as: "amd_fidelityfx_dx12.dll",
        },
        {
          artifact_key: artifactKey(frameGeneration),
          role: "frame_generation",
          install_as: "amd_fidelityfx_framegeneration_dx12.dll",
        },
      ],
    });
  }
  return packages;
}

function buildIntelPackages(release, artifacts, legalDocumentIds) {
  return artifacts.map((artifact) => {
    const fileName = `${artifact.component}.dll`;
    const descriptor = INTEL_COMPONENTS[fileName];
    if (!descriptor) throw new Error(`${release.tag}: unknown Intel component ${fileName}`);
    return singleArtifactPackage(release, artifact, legalDocumentIds, descriptor);
  });
}

function buildOpenVrPackages(release, artifacts, legalDocumentIds) {
  return artifacts.map((artifact) => ({
    package_id: `openvr.${release.tag.replace(/^v/u, "").toLowerCase()}.${artifact.architecture.toLowerCase()}`,
    technology: "openvr",
    variant: "runtime",
    display_name: "OpenVR SDK",
    release: {
      version: release.version,
      channel: "stable",
      label: release.label,
    },
    target: { os: "windows", architecture: artifact.architecture },
    provenance: githubProvenance(release),
    legal_document_ids: legalDocumentIds,
    members: [
      {
        artifact_key: artifactKey(artifact),
        role: "primary",
        install_as: "openvr_api.dll",
      },
    ],
  }));
}

function githubProvenance(release) {
  return {
    kind: "github_release",
    repository: release.repository,
    tag: release.tag,
    commit_sha: release.commit_sha,
  };
}

function artifactKey(artifact) {
  return `${artifact.component}.${artifact.dll_sha256}`;
}

function requiredPeVersion(artifact, context) {
  if (artifact.pe_version === null) throw new Error(`${context}: PE version is required`);
  return artifact.pe_version;
}

const PROFILES = Object.freeze({
  amd_fidelityfx: Object.freeze({
    id: "amd_fidelityfx",
    repository: "GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",
    vendor: Object.freeze({ id: "amd", display_name: "AMD" }),
    parseTag: (tag) =>
      parseNumericTag(tag, /^(?:fsr3-)?v(\d+(?:\.\d+)+)$/u, "AMD FidelityFX"),
    releasePlan: amdReleasePlan,
    buildPackages: buildAmdPackages,
    publishExports: false,
    deduplicatePackagesByContent: true,
    authenticodeMode: "RequireSigned",
    allowsUnsigned: false,
    maxDllSize: 128 * 1024 * 1024,
  }),
  intel_xess: Object.freeze({
    id: "intel_xess",
    repository: "intel/xess",
    vendor: Object.freeze({ id: "intel", display_name: "Intel" }),
    parseTag: (tag) => parseNumericTag(tag, /^v(\d+(?:\.\d+)+)$/u, "Intel XeSS"),
    releasePlan: intelReleasePlan,
    buildPackages: buildIntelPackages,
    publishExports: false,
    deduplicatePackagesByContent: true,
    authenticodeMode: "RequireSigned",
    allowsUnsigned: false,
    maxDllSize: 128 * 1024 * 1024,
  }),
  openvr: Object.freeze({
    id: "openvr",
    repository: "ValveSoftware/openvr",
    vendor: Object.freeze({ id: "valve", display_name: "Valve" }),
    parseTag(tag) {
      if (typeof tag !== "string") throw new Error("OpenVR release tag is missing");
      const match = /^v?(\d+(?:\.\d+)+)(b)?$/u.exec(tag);
      if (!match) throw new Error(`unsupported stable OpenVR tag ${tag}`);
      if (match[2] && !OPENVR_REVISION_TAGS.has(tag)) {
        throw new Error(`unreviewed OpenVR revision tag ${tag}`);
      }
      assertNumericVersion(match[1], `${tag}: release version`);
      return { version: match[1], label: match[2] ? "revision b" : null };
    },
    releasePlan: openVrReleasePlan,
    buildPackages: buildOpenVrPackages,
    publishExports: true,
    deduplicatePackagesByContent: false,
    authenticodeMode: "AllowUnsigned",
    allowsUnsigned: true,
    maxDllSize: 16 * 1024 * 1024,
  }),
});

export function githubReleaseTreeProfile(profileId) {
  const profile = PROFILES[profileId];
  if (!profile) {
    throw new Error(`unsupported GitHub release-tree profile ${JSON.stringify(profileId)}`);
  }
  return profile;
}

export function compareProfileReleases(left, right) {
  return (
    compareNumericVersions(left.version, right.version) ||
    String(left.tag).localeCompare(String(right.tag))
  );
}
