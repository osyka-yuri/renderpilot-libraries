const SOURCE_KINDS = Object.freeze({
  nuget: Object.freeze({
    configSchema: "schemas/microsoft_nuget_config.schema.json",
    lockSchema: "schemas/microsoft_nuget_lock.schema.json",
    validatorScript: "validate-microsoft-nuget.mjs",
    requiresProfile: false,
    requiredPaths: Object.freeze(["configFile", "lockFile", "outputFile"]),
    requiresRefreshConcurrency: false,
    refresh: Object.freeze({
      script: "refresh-microsoft-nuget.mjs",
      passVendor: false,
      allowBackfillSignatures: true,
      allowProduct: true,
    }),
  }),
  "github-release-tree": Object.freeze({
    configSchema: "schemas/github_release_tree_config.schema.json",
    lockSchema: "schemas/github_release_tree_lock.schema.json",
    validatorScript: "validate-github-release-tree.mjs",
    requiresProfile: true,
    requiredPaths: Object.freeze(["configFile", "lockFile", "outputFile"]),
    requiresRefreshConcurrency: true,
    refresh: Object.freeze({
      script: "refresh-github-release-tree.mjs",
      passVendor: true,
      allowBackfillSignatures: true,
      allowProduct: false,
      aggregateName: "github",
    }),
  }),
});

export function generatedLibrarySourceKind(sourceKind) {
  const definition = SOURCE_KINDS[sourceKind];
  if (!definition) {
    throw new Error(`unsupported generated library source ${sourceKind}`);
  }
  return definition;
}
