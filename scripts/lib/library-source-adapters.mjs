import { buildMicrosoftVendorSource } from "./microsoft-nuget.mjs";
import { buildOpenVrVendorSource } from "./openvr-github.mjs";

const ADAPTERS = Object.freeze({
  "microsoft-nuget": Object.freeze({
    build: buildMicrosoftVendorSource,
    validatorScript: "validate-microsoft-nuget.mjs",
  }),
  "openvr-github": Object.freeze({
    build: buildOpenVrVendorSource,
    validatorScript: "validate-openvr-github.mjs",
  }),
});

export function buildGeneratedLibraryVendorSource(vendor, lock, config) {
  const adapter = ADAPTERS[vendor.sourceKind];
  if (!adapter) {
    throw new Error(`unsupported generated library source ${vendor.sourceKind}`);
  }
  return adapter.build(lock, config);
}

export function assertGeneratedLibraryVendorAdapters(vendors) {
  for (const vendor of vendors) {
    if (!ADAPTERS[vendor.sourceKind]) {
      throw new Error(
        `${vendor.vendorId}: no generated source adapter for ${vendor.sourceKind}`,
      );
    }
  }
}

export function generatedLibraryValidatorScripts(vendors) {
  assertGeneratedLibraryVendorAdapters(vendors);
  return vendors.map((vendor) => ADAPTERS[vendor.sourceKind].validatorScript);
}
