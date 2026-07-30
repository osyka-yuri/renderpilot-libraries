#!/usr/bin/env node

import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { parseCliArgs } from "./lib/cli-args.mjs";
import { UsageError } from "./lib/common.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import {
  XIPH_ASSET_BUNDLE_KIND,
  XIPH_CATALOG_BUNDLE_KIND,
  applyVerifiedBundle,
  createXiphCiBundles,
  verifyXiphAssetBundle,
  verifyXiphCatalogBundle,
} from "./lib/xiph-ci-bundle.mjs";

runCliMain({
  parse: (argv) => {
    const [command, ...rest] = argv;
    if (
      !new Set(["create", "verify", "verify-catalog", "apply-assets", "apply-catalog"]).has(
        command,
      )
    ) {
      throw new UsageError(`unsupported Xiph CI bundle command: ${command ?? "<missing>"}`);
    }
    const { values } = parseCliArgs(rest, {
      "assets-root": { type: "string" },
      "catalog-root": { type: "string" },
      "destination-root": { type: "string" },
      "baseline-vendor": { type: "string" },
    });
    return { command, ...values };
  },
  main: async (args) => {
    const catalogRoot = resolveRequired(args["catalog-root"], "catalog-root");
    switch (args.command) {
      case "create": {
        const assetsRoot = resolveRequired(args["assets-root"], "assets-root");
        const baselineVendorFile = resolveRequired(
          args["baseline-vendor"],
          "baseline-vendor",
        );
        await createXiphCiBundles({
          repoRoot,
          assetsRoot,
          catalogRoot,
          baselineVendorFile,
        });
        return;
      }
      case "verify": {
        const assetsRoot = resolveRequired(args["assets-root"], "assets-root");
        await verifyXiphAssetBundle(assetsRoot, catalogRoot, resolveBaselineVendor(args));
        return;
      }
      case "verify-catalog":
        await verifyXiphCatalogBundle(catalogRoot);
        return;
      case "apply-assets": {
        const assetsRoot = resolveRequired(args["assets-root"], "assets-root");
        await verifyXiphAssetBundle(assetsRoot, catalogRoot, resolveBaselineVendor(args));
        await applyVerifiedBundle({
          bundleRoot: assetsRoot,
          destinationRoot: resolveDestination(args),
          expectedKind: XIPH_ASSET_BUNDLE_KIND,
        });
        return;
      }
      case "apply-catalog":
        await verifyXiphCatalogBundle(catalogRoot);
        await applyVerifiedBundle({
          bundleRoot: catalogRoot,
          destinationRoot: resolveDestination(args),
          expectedKind: XIPH_CATALOG_BUNDLE_KIND,
        });
        return;
    }
  },
});

function resolveRequired(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new UsageError(`--${name} is required`);
  }
  return path.resolve(value);
}

function resolveDestination(args) {
  return args["destination-root"] ? path.resolve(args["destination-root"]) : repoRoot;
}

function resolveBaselineVendor(args) {
  return args["baseline-vendor"]
    ? path.resolve(args["baseline-vendor"])
    : path.join(repoRoot, "libraries", "v1", "vendors", "xiph.json");
}
