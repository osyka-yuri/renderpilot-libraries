import { readFileSync } from "node:fs";
import path from "node:path";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const SAFE_DLL_NAME = /^[A-Za-z0-9_-]+\.dll$/u;
const SUPPORTED_SECURITY_REQUIREMENTS = new Set([
  "dynamic_base",
  "guard_cf",
  "high_entropy_va",
  "nx_compat",
]);
const POLICY = deepFreeze(
  assertXiphVerificationPolicy(
    JSON.parse(
      readFileSync(new URL("../xiph/verification-policy.json", import.meta.url), "utf8"),
    ),
  ),
);
const ARCHITECTURES = POLICY.matrix.architectures;
const PROFILES = POLICY.matrix.profiles;
const TOPOLOGIES = POLICY.matrix.topologies;

export const XIPH_POLICY = POLICY;
export const XIPH_SOURCE_IDS = POLICY.sources;
export const XIPH_COMPONENT_IDS = Object.freeze([
  ...new Set(Object.values(TOPOLOGIES).flat()),
]);
export const XIPH_ALLOWED_SYSTEM_IMPORTS = POLICY.allowed_system_imports;
export const XIPH_ALLOWED_SYSTEM_IMPORT_PREFIXES = POLICY.allowed_system_import_prefixes;
export const XIPH_FORBIDDEN_IMPORTS = POLICY.forbidden_imports;

export const XIPH_BUILD_MATRIX = Object.freeze({
  architectures: ARCHITECTURES,
  profiles: PROFILES,
  topologies: TOPOLOGIES,
});

export function canonicalXiphReleaseVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u.test(value)
  ) {
    throw new Error(`invalid Xiph source version: ${value}`);
  }
  const segments = value.split(".");
  while (segments.length < 3) segments.push("0");
  if (segments.length === 4 && segments[3] === "0") segments.pop();
  return segments.join(".");
}

export function xiphBuildConfigurations() {
  return ARCHITECTURES.flatMap((architecture) =>
    Object.entries(TOPOLOGIES).flatMap(([topology, components]) =>
      PROFILES.map((profile) =>
        Object.freeze({ architecture, topology, profile, components }),
      ),
    ),
  );
}

export function xiphAliasesForProfile(profile) {
  const aliases = POLICY.aliases[profile];
  if (!aliases) throw new Error(`unknown Xiph alias profile ${profile}`);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(aliases).map(([component, template]) => [
        component,
        template.replace("{abi_major}", String(POLICY.abi_majors[component])),
      ]),
    ),
  );
}

export function xiphExpectedImports(topology, component, aliases) {
  const importPolicy = POLICY.imports[topology]?.[component];
  if (!importPolicy) {
    throw new Error(`unknown Xiph import policy ${topology}/${component}`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(importPolicy).map(([importKind, dependencies]) => [
        importKind,
        Object.freeze(dependencies.map((dependency) => aliases[dependency]).sort()),
      ]),
    ),
  );
}

export function xiphKnownLibraryNames() {
  return new Set(
    PROFILES.flatMap((profile) => Object.values(xiphAliasesForProfile(profile))),
  );
}

export function isXiphForbiddenImport(imported) {
  return XIPH_FORBIDDEN_IMPORTS.some((pattern) => globMatches(imported, pattern));
}

export function isXiphAllowedSystemImport(imported) {
  return (
    XIPH_ALLOWED_SYSTEM_IMPORTS.includes(imported) ||
    XIPH_ALLOWED_SYSTEM_IMPORT_PREFIXES.some((prefix) => imported.startsWith(prefix))
  );
}

export function isXiphPublishableRunner(value) {
  return new RegExp(POLICY.toolchain.publication_runner_image_pattern, "u").test(value);
}

export function isXiphIntegrationRunner(value) {
  return new RegExp(POLICY.toolchain.integration_runner_image_pattern, "u").test(value);
}

export function assertXiphPublishableVendor(vendor) {
  for (const packageValue of vendor.packages) {
    if (
      packageValue.technology === "xiph_vorbis" &&
      !isXiphPublishableRunner(packageValue.provenance?.toolchain?.runner_image)
    ) {
      throw new Error(
        `${packageValue.package_id}: Xiph catalog is not publication-eligible`,
      );
    }
  }
  return vendor;
}

export function assertXiphPublicationPath(relative) {
  const normalized = relative.split(path.sep).join("/");
  if (POLICY.publication.forbidden_suffixes.some((suffix) => normalized.endsWith(suffix))) {
    throw new Error(`${relative}: forbidden Xiph publication suffix`);
  }
  if (!POLICY.publication.allowed_suffixes.some((suffix) => normalized.endsWith(suffix))) {
    throw new Error(`${relative}: unsupported Xiph publication suffix`);
  }
  return relative;
}

export function xiphArtifactKey(pair, buildRevision, record) {
  return (
    `vorbis-${pair.vorbis_version}.ogg-${pair.ogg_version}` +
    `.r${buildRevision}.${record.architecture.toLowerCase()}` +
    `.${record.topology}.${record.profile}.${record.component}`
  );
}

export function xiphCatalogArtifactKey(dllSha256) {
  return `dll.${dllSha256}`;
}

export function expectedXiphArtifactKeys(pair, buildRevision) {
  return xiphBuildConfigurations()
    .flatMap((configuration) =>
      configuration.components.map((component) =>
        xiphArtifactKey(pair, buildRevision, { ...configuration, component }),
      ),
    )
    .sort();
}

export function assertXiphManifestMatrix(manifest) {
  if (!Array.isArray(manifest?.artifacts)) {
    throw new Error("Xiph build manifest artifacts must be an array");
  }
  const expected = new Set(
    xiphBuildConfigurations().flatMap((configuration) =>
      configuration.components.map(
        (component) =>
          `${configuration.architecture}|${configuration.topology}|` +
          `${configuration.profile}|${component}`,
      ),
    ),
  );
  const observed = new Set();
  for (const record of manifest.artifacts) {
    const identity = `${record.architecture}|${record.topology}|${record.profile}|${record.component}`;
    if (!expected.has(identity)) {
      throw new Error(`Xiph build manifest has an unexpected matrix member: ${identity}`);
    }
    if (observed.has(identity)) {
      throw new Error(`Xiph build manifest has a duplicate matrix member: ${identity}`);
    }
    observed.add(identity);
  }
  const missing = [...expected].filter((identity) => !observed.has(identity));
  if (missing.length !== 0) {
    throw new Error(`Xiph build manifest is missing matrix members: ${missing.join(", ")}`);
  }
  return manifest;
}

export function assertXiphVerificationPolicy(policy) {
  assertExactObjectKeys(
    policy,
    [
      "abi_majors",
      "aliases",
      "allowed_system_import_prefixes",
      "allowed_system_imports",
      "forbidden_imports",
      "imports",
      "matrix",
      "publication",
      "reproducibility",
      "required_security",
      "schema_version",
      "sources",
      "target_os",
      "toolchain",
    ],
    "verification policy",
  );
  if (!isRecord(policy) || policy.schema_version !== 2 || policy.target_os !== "windows") {
    throw new Error("invalid Xiph verification policy header");
  }
  assertUniqueIds(policy.sources, "sources");
  if (policy.sources.join("\0") !== "ogg\0vorbis") {
    throw new Error("invalid Xiph source set");
  }
  assertExactObjectKeys(
    policy.matrix,
    ["architectures", "profiles", "topologies"],
    "verification matrix",
  );
  assertUniqueStrings(policy.matrix.architectures, "architectures");
  assertUniqueIds(policy.matrix.profiles, "profiles");
  if (
    policy.matrix.architectures.join("\0") !== "X86\0X64" ||
    policy.matrix.profiles.join("\0") !== "plain\0lib\0abi"
  ) {
    throw new Error("unsupported Xiph build matrix");
  }
  if (
    !isRecord(policy.matrix.topologies) ||
    Object.keys(policy.matrix.topologies).length === 0
  ) {
    throw new Error("Xiph verification policy requires topologies");
  }
  assertExactObjectKeys(policy.matrix.topologies, ["embedded_ogg", "shared"], "topologies");
  const expectedTopologies = {
    shared: ["vorbis", "vorbisfile", "vorbisenc", "ogg"],
    embedded_ogg: ["vorbis", "vorbisfile", "vorbisenc"],
  };
  for (const [topology, components] of Object.entries(policy.matrix.topologies)) {
    if (!SAFE_ID.test(topology)) throw new Error(`invalid Xiph topology ${topology}`);
    assertUniqueIds(components, `${topology} components`);
    if (components.join("\0") !== expectedTopologies[topology].join("\0")) {
      throw new Error(`unsupported Xiph topology ${topology}`);
    }
  }
  const components = [...new Set(Object.values(policy.matrix.topologies).flat())].sort();
  assertExactObjectKeys(policy.aliases, [...policy.matrix.profiles].sort(), "aliases");
  for (const profile of policy.matrix.profiles) {
    assertExactObjectKeys(policy.aliases[profile], components, `${profile} aliases`);
    for (const alias of Object.values(policy.aliases[profile])) {
      if (typeof alias !== "string" || !alias.endsWith(".dll")) {
        throw new Error(`${profile}: invalid Xiph DLL alias`);
      }
    }
  }
  assertExactObjectKeys(policy.abi_majors, components, "ABI majors");
  if (
    Object.values(policy.abi_majors).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new Error("invalid Xiph ABI majors");
  }
  for (const profile of policy.matrix.profiles) {
    const resolvedAliases = Object.entries(policy.aliases[profile]).map(
      ([component, alias]) =>
        alias.replace("{abi_major}", String(policy.abi_majors[component])),
    );
    if (
      resolvedAliases.some((alias) => !SAFE_DLL_NAME.test(alias)) ||
      new Set(resolvedAliases).size !== resolvedAliases.length
    ) {
      throw new Error(`${profile}: Xiph DLL aliases must be safe and unique`);
    }
  }
  assertExactObjectKeys(
    policy.imports,
    Object.keys(policy.matrix.topologies).sort(),
    "import topologies",
  );
  for (const [topology, topologyComponents] of Object.entries(policy.matrix.topologies)) {
    assertExactObjectKeys(
      policy.imports[topology],
      [...topologyComponents].sort(),
      `${topology} imports`,
    );
    for (const [component, importPolicy] of Object.entries(policy.imports[topology])) {
      assertExactObjectKeys(
        importPolicy,
        ["delay", "regular"],
        `${topology}/${component} imports`,
      );
      for (const importKind of ["regular", "delay"]) {
        const dependencies = importPolicy[importKind];
        assertUniqueIds(
          dependencies,
          `${topology}/${component} ${importKind} imports`,
          true,
        );
        if (dependencies.some((dependency) => !topologyComponents.includes(dependency))) {
          throw new Error(
            `${topology}/${component}: ${importKind} dependency is outside the topology`,
          );
        }
      }
    }
  }
  assertExactObjectKeys(
    policy.required_security,
    ["all", ...policy.matrix.architectures].sort(),
    "required security profiles",
  );
  const commonSecurity = policy.required_security.all;
  assertUniqueIds(commonSecurity, "common required security");
  if (commonSecurity.length === 0) {
    throw new Error("Xiph verification policy requires common PE security flags");
  }
  for (const securityProfile of ["all", ...policy.matrix.architectures]) {
    const requirements = policy.required_security[securityProfile];
    assertUniqueIds(requirements, `${securityProfile} required security`, true);
    if (
      requirements.some((requirement) => !SUPPORTED_SECURITY_REQUIREMENTS.has(requirement))
    ) {
      throw new Error(`unsupported Xiph security requirement for ${securityProfile}`);
    }
    if (
      securityProfile !== "all" &&
      requirements.some((requirement) => commonSecurity.includes(requirement))
    ) {
      throw new Error(`duplicate Xiph security requirement for ${securityProfile}`);
    }
  }
  assertUniqueStrings(policy.allowed_system_imports, "allowed system imports", true);
  assertUniqueStrings(
    policy.allowed_system_import_prefixes,
    "allowed system import prefixes",
    true,
  );
  assertUniqueStrings(policy.forbidden_imports, "forbidden imports", true);
  assertExactObjectKeys(
    policy.reproducibility,
    ["build_count", "comparison"],
    "reproducibility policy",
  );
  if (
    !Number.isSafeInteger(policy.reproducibility.build_count) ||
    policy.reproducibility.build_count < 2 ||
    policy.reproducibility.comparison !== "raw_sha256"
  ) {
    throw new Error("invalid Xiph reproducibility policy");
  }
  assertExactObjectKeys(
    policy.toolchain,
    ["integration_runner_image_pattern", "publication_runner_image_pattern"],
    "toolchain policy",
  );
  for (const pattern of Object.values(policy.toolchain)) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("invalid Xiph runner-image pattern");
    }
    new RegExp(pattern, "u");
  }
  assertExactObjectKeys(
    policy.publication,
    ["allowed_suffixes", "forbidden_suffixes"],
    "publication policy",
  );
  assertUniqueStrings(policy.publication.allowed_suffixes, "allowed publication suffixes");
  assertUniqueStrings(
    policy.publication.forbidden_suffixes,
    "forbidden publication suffixes",
  );
  if (
    policy.publication.allowed_suffixes.some((suffix) =>
      policy.publication.forbidden_suffixes.includes(suffix),
    )
  ) {
    throw new Error("Xiph publication suffix cannot be both allowed and forbidden");
  }
  return policy;
}

function assertUniqueIds(value, label, allowEmpty = false) {
  assertUniqueStrings(value, label, allowEmpty);
  if (value.some((entry) => !SAFE_ID.test(entry))) throw new Error(`invalid Xiph ${label}`);
}

function assertUniqueStrings(value, label, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`invalid Xiph ${label}`);
  }
}

function assertExactObjectKeys(value, expected, label) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw new Error(`invalid Xiph ${label}`);
  }
}

function globMatches(value, pattern) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
