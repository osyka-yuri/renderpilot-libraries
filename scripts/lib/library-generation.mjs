import path from "node:path";

import {
  curatedLibraryVendors,
  generatedLibraryVendors,
  libraryIndexFile,
  repoRoot,
} from "../catalog.mjs";
import {
  buildLibraryIndex,
  buildVendorSnapshot,
  jsonDocument,
} from "./library-catalog.mjs";
import {
  assertGeneratedLibraryVendorAdapters,
  buildGeneratedLibraryVendorSource,
} from "./library-source-adapters.mjs";
import { readJsonFileAsync } from "./json.mjs";

/**
 * Resolves every v1 vendor snapshot and the index from one coherent input set.
 * Overrides let audited operations stage a lock mutation before any file is replaced.
 */
export async function buildLibraryCatalogPlan(inputOverrides = new Map()) {
  assertGeneratedLibraryVendorAdapters(generatedLibraryVendors);
  if (!(inputOverrides instanceof Map)) {
    throw new TypeError("library catalog input overrides must be a Map");
  }
  const readSource = (relativeFile) =>
    inputOverrides.has(relativeFile)
      ? structuredClone(inputOverrides.get(relativeFile))
      : readJsonFileAsync(path.join(repoRoot, relativeFile));

  const [curatedSources, generatedSources] = await Promise.all([
    Promise.all(
      curatedLibraryVendors.map(async (vendor) => ({
        vendor,
        source: await readSource(vendor.sourceFile),
      })),
    ),
    Promise.all(
      generatedLibraryVendors.map(async (vendor) => {
        const [lock, config, overlay] = await Promise.all([
          readSource(vendor.lockFile),
          readSource(vendor.configFile),
          vendor.overlayFile ? readSource(vendor.overlayFile) : Promise.resolve(null),
        ]);
        return {
          vendor,
          source: buildGeneratedLibraryVendorSource(vendor, {
            lock,
            config,
            overlay,
          }),
        };
      }),
    ),
  ]);

  const vendorDocuments = [...curatedSources, ...generatedSources]
    .sort((left, right) => {
      const leftFile = left.vendor.outputFile;
      const rightFile = right.vendor.outputFile;
      return leftFile.localeCompare(rightFile);
    })
    .map(({ vendor, source }) => {
      if (source?.vendor?.id !== vendor.vendorId) {
        throw new Error(
          `${vendor.sourceFile ?? vendor.lockFile}: expected vendor ${vendor.vendorId}, got ${source?.vendor?.id ?? "missing"}`,
        );
      }
      const snapshot = buildVendorSnapshot(source);
      return { vendor, snapshot, body: jsonDocument(snapshot) };
    });
  const indexedVendorDocuments = vendorDocuments.filter(
    ({ vendor, snapshot }) =>
      !vendor.indexWhenPopulated ||
      (snapshot.packages.length !== 0 && snapshot.artifacts.length !== 0),
  );
  const index = buildLibraryIndex(indexedVendorDocuments);
  const values = [
    ...vendorDocuments.map(({ vendor, snapshot }) => ({
      file: vendor.outputFile,
      value: snapshot,
    })),
    { file: libraryIndexFile, value: index },
  ];
  const outputs = values.map(({ file, value }) => {
    const frozenValue = deepFreezeJson(value);
    const preparedBody = jsonDocument(frozenValue);
    return Object.freeze({
      relativeFile: file,
      file: path.join(repoRoot, file),
      value: frozenValue,
      get body() {
        return Buffer.from(preparedBody);
      },
    });
  });
  return Object.freeze({
    outputs: Object.freeze(outputs),
    activeTransportObjectKeys: readonlySet(
      activeCatalogTransportObjectKeys(outputs.slice(0, -1)),
    ),
  });
}

/**
 * Builds the global live-reference set from active packages in every generated
 * vendor snapshot. Prune callers must use this complete set rather than a
 * vendor-local lock because transport blobs are globally content-addressed.
 */
export function activeCatalogTransportObjectKeys(generatedValues) {
  if (!Array.isArray(generatedValues)) {
    throw new TypeError("generated catalog values must be an array");
  }
  const objectKeys = new Set();
  for (const [index, { value }] of generatedValues.entries()) {
    if (!Array.isArray(value?.packages) || !Array.isArray(value?.artifacts)) {
      throw new Error(
        `generated catalog value ${index} must be a vendor snapshot with packages and artifacts`,
      );
    }
    const artifacts = new Map();
    for (const artifact of value.artifacts) {
      if (artifacts.has(artifact.artifact_id)) {
        throw new Error(`duplicate active catalog artifact ${artifact.artifact_id}`);
      }
      artifacts.set(artifact.artifact_id, artifact);
    }
    for (const packageValue of value.packages) {
      for (const member of packageValue.members ?? []) {
        const artifact = artifacts.get(member.artifact_id);
        const objectKey = artifact?.transport?.object_key;
        if (typeof objectKey !== "string" || objectKey.length === 0) {
          throw new Error(
            `${packageValue.package_id ?? "catalog package"}: active member ${member.artifact_id ?? "missing"} has no transport object`,
          );
        }
        objectKeys.add(objectKey);
      }
    }
  }
  return objectKeys;
}

function deepFreezeJson(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

class ReadonlySetView {
  #set;

  constructor(values) {
    this.#set = new Set(values);
    Object.freeze(this);
  }

  get size() {
    return this.#set.size;
  }

  has(value) {
    return this.#set.has(value);
  }

  values() {
    return this.#set.values();
  }

  keys() {
    return this.#set.keys();
  }

  entries() {
    return this.#set.entries();
  }

  forEach(callback, thisArg) {
    this.#set.forEach((value) => callback.call(thisArg, value, value, this));
  }

  [Symbol.iterator]() {
    return this.#set[Symbol.iterator]();
  }

  get [Symbol.toStringTag]() {
    return "Set";
  }
}

function readonlySet(values) {
  return new ReadonlySetView(values);
}
