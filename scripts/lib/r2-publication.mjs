import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { libraryIndexFile, publishedJsonDocuments, r2, repoRoot } from "../catalog.mjs";
import { UsageError, errorMessage } from "./common.mjs";
import { parseCliArgs, wantsHelp } from "./cli-args.mjs";
import { md5Hex, sha256Hex } from "./hash.mjs";
import {
  LIBRARY_INDEX_KEY,
  assertLibraryIndex,
  assertVendorSnapshot,
} from "./library-catalog.mjs";

const CDN_DIR = path.join(repoRoot, "cdn");
const INDEX_FILE = path.join(repoRoot, libraryIndexFile);
const VENDOR_DIR = path.join(repoRoot, "libraries", "v1", "vendors");
const SINGLE_PART_MD5_ETAG = /^[0-9a-f]{32}$/;
const zstdDecompressAsync = promisify(zstdDecompress);

export function parsePublicationArgs(argv) {
  if (wantsHelp(argv)) {
    return { jsonOnly: false, binaryOnly: false, dryRun: false, force: false, help: true };
  }
  const { values } = parseCliArgs(argv, {
    "json-only": { type: "boolean" },
    "binary-only": { type: "boolean" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  const jsonOnly = Boolean(values["json-only"]);
  const binaryOnly = Boolean(values["binary-only"]);
  if (jsonOnly && binaryOnly) {
    throw new UsageError("--json-only and --binary-only are mutually exclusive");
  }
  return {
    jsonOnly,
    binaryOnly,
    dryRun: Boolean(values["dry-run"]),
    force: Boolean(values.force),
    help: false,
  };
}

export async function publishCatalog(s3, options) {
  return publishResolvedCatalog(s3, options, await resolvePublicationPhases(options));
}

export async function publishResolvedCatalog(s3, options, phases) {
  assertUniqueKeys([
    ...phases.blobs,
    ...phases.jsonBeforeIndex,
    ...phases.vendorSnapshots,
    ...phases.index,
  ]);
  if (options.dryRun) {
    printDryRun(phases, options);
    return;
  }

  const summary = { uploaded: 0, skipped: 0 };
  printHeader(phases, options);
  await preflightBlobObjects(phases.blobs);
  await publishPhase(s3, "Content-addressed library blobs", phases.blobs, options, summary);
  await publishPhase(s3, "Independent JSON", phases.jsonBeforeIndex, options, summary);
  await publishPhase(
    s3,
    "Immutable vendor snapshots",
    phases.vendorSnapshots,
    options,
    summary,
  );
  await verifyRequiredObjects(s3, phases.requiredBlobs, "library blob");
  await publishPhase(s3, "Library index (commit point)", phases.index, options, summary);
  console.log(`\nDone: ${summary.uploaded} uploaded, ${summary.skipped} already current.`);
}

export async function resolvePublicationPhases({ jsonOnly, binaryOnly }) {
  const indexSnapshot = await readJsonSnapshot(INDEX_FILE);
  assertLibraryIndex(indexSnapshot.value);
  const vendorSnapshots = await Promise.all(
    indexSnapshot.value.vendors.map(async (vendor) => {
      const abs = path.join(VENDOR_DIR, `${vendor.vendor_id}.json`);
      const snapshot = await readJsonSnapshot(abs);
      assertVendorSnapshot(snapshot.value);
      if (snapshot.value.vendor.id !== vendor.vendor_id) {
        throw new Error(`${vendor.vendor_id}: index and vendor snapshot identity differ`);
      }
      if (
        snapshot.body.length !== vendor.snapshot_size_bytes ||
        sha256Hex(snapshot.body) !== vendor.snapshot_sha256
      ) {
        throw new Error(`${vendor.vendor_id}: index does not match generated vendor bytes`);
      }
      return {
        key: vendor.snapshot_key,
        abs,
        body: snapshot.body,
        snapshot: snapshot.value,
        requiredChecksum: vendor.snapshot_sha256,
        checksumLabel: "library index",
      };
    }),
  );

  const expectedBlobs = collectBlobExpectations(vendorSnapshots);
  const requiredBlobs = [...expectedBlobs.values()].map((blob) => ({
    key: blob.key,
    size: blob.compressedSize,
    sha256: blob.transportSha256,
  }));
  let blobExpectations = jsonOnly ? [] : [...expectedBlobs.values()];
  if (binaryOnly) {
    blobExpectations = (
      await Promise.all(
        blobExpectations.map(async (expected) =>
          (await fileExists(path.join(CDN_DIR, ...expected.key.split("/"))))
            ? expected
            : null,
        ),
      )
    ).filter(Boolean);
  }
  const blobs = blobExpectations.map((expected) => ({
    key: expected.key,
    abs: path.join(CDN_DIR, ...expected.key.split("/")),
    requiredChecksum: expected.transportSha256,
    checksumLabel: "vendor snapshot",
    expectedBinary: expected,
  }));

  if (binaryOnly) {
    return {
      blobs,
      jsonBeforeIndex: [],
      vendorSnapshots: [],
      index: [],
      requiredBlobs,
    };
  }

  const staticJson = await Promise.all(
    publishedJsonDocuments.map(async ({ file, r2Key }) => {
      const abs = path.resolve(repoRoot, file);
      const body = abs === INDEX_FILE ? indexSnapshot.body : await readFile(abs);
      return {
        key: r2Key,
        abs,
        body,
        requiredChecksum: sha256Hex(body),
        checksumLabel: "resolved JSON publication snapshot",
      };
    }),
  );
  const index = staticJson.filter((object) => object.key === LIBRARY_INDEX_KEY);
  if (index.length !== 1) throw new Error("library index must be the single commit point");

  return {
    blobs,
    jsonBeforeIndex: staticJson.filter((object) => object.key !== LIBRARY_INDEX_KEY),
    vendorSnapshots: vendorSnapshots.map(({ snapshot: _snapshot, ...object }) => object),
    index,
    requiredBlobs,
  };
}

function collectBlobExpectations(vendorSnapshots) {
  const expectations = new Map();
  for (const { snapshot } of vendorSnapshots) {
    for (const artifact of snapshot.artifacts) {
      const value = {
        key: artifact.transport.object_key,
        compressedSize: artifact.transport.size_bytes,
        transportSha256: artifact.transport.sha256,
        dllSize: artifact.dll.size_bytes,
        dllSha256: artifact.dll.sha256,
      };
      const existing = expectations.get(value.key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new Error(`${value.key}: conflicting artifact transport identities`);
      }
      expectations.set(value.key, value);
    }
  }
  return expectations;
}

async function readJsonSnapshot(file) {
  const body = await readFile(file);
  return { body, value: JSON.parse(body.toString("utf8")) };
}

async function preflightBlobObjects(objects) {
  if (objects.length === 0) return;
  console.log(`\nPreflight: validating ${objects.length} local library blob(s)`);
  for (const object of objects) await readLocalObject(object);
  console.log("  OK every local blob matches its transport and DLL identities");
}

async function publishPhase(s3, label, objects, options, summary) {
  if (objects.length === 0) return;
  console.log(`\n${label}:`);
  for (const object of objects) {
    const result = await publishObject(s3, object, options);
    summary[result.action === "skipped" ? "skipped" : "uploaded"] += 1;
    if (result.action === "skipped") console.log(`  = ${object.key} (up to date)`);
    else console.log(`  ↑ ${object.key} sha256:${result.sha256} (${result.bytes} bytes)`);
  }
}

async function publishObject(s3, object, { force }) {
  const local = await readLocalObject(object);
  if (!force) {
    const remote = await headObject(s3, object.key);
    if (remoteMatchesLocal(remote, local, Boolean(object.requiredChecksum))) {
      return { action: "skipped" };
    }
  }
  await putObject(s3, local);
  const remote = await headObject(s3, object.key);
  assertVerifiedRemoteCopy(object.key, remote, local);
  return { action: "uploaded", bytes: local.size, sha256: local.sha256Hex };
}

async function verifyRequiredObjects(s3, required, label) {
  if (required.length === 0) return;
  console.log(`\nVerifying ${required.length} remote ${label}(s) before index:`);
  for (const object of required) {
    const remote = await headObject(s3, object.key);
    if (remote?.size !== object.size || remote?.sha256Metadata !== object.sha256) {
      throw new Error(
        `${object.key}: remote prerequisite mismatch (expected ${object.size} bytes and sha256 ${object.sha256})`,
      );
    }
  }
  console.log(`  OK all required ${label}s exist with locked size and SHA-256 metadata`);
}

async function readLocalObject(object) {
  let body;
  try {
    body = object.body ?? (await readFile(object.abs));
  } catch (error) {
    throw new Error(`failed to read ${object.abs}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const local = {
    ...object,
    body,
    size: body.length,
    md5Hex: md5Hex(body),
    sha256Hex: sha256Hex(body),
    contentType: contentTypeForKey(object.key),
  };
  if (object.requiredChecksum && object.requiredChecksum !== local.sha256Hex) {
    throw new Error(
      `${object.key}: local bytes do not match ${object.checksumLabel ?? "required"} SHA-256`,
    );
  }
  if (object.expectedBinary) await validateBinaryPayload(local, object.expectedBinary);
  return local;
}

async function validateBinaryPayload(local, expected) {
  if (local.size !== expected.compressedSize) {
    throw new Error(
      `${local.key}: compressed size mismatch (expected ${expected.compressedSize}, got ${local.size})`,
    );
  }
  let dll;
  try {
    dll = await zstdDecompressAsync(local.body, {
      maxOutputLength: expected.dllSize + 1,
    });
  } catch (error) {
    throw new Error(`${local.key}: invalid ZST payload`, { cause: error });
  }
  if (dll.length !== expected.dllSize) {
    throw new Error(
      `${local.key}: DLL size mismatch (expected ${expected.dllSize}, got ${dll.length})`,
    );
  }
  const dllSha256 = sha256Hex(dll);
  if (dllSha256 !== expected.dllSha256) {
    throw new Error(
      `${local.key}: DLL SHA-256 mismatch (expected ${expected.dllSha256}, got ${dllSha256})`,
    );
  }
}

async function putObject(s3, local) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: local.key,
        Body: local.body,
        ContentType: local.contentType,
        ContentLength: local.size,
        Metadata: { sha256: local.sha256Hex },
      }),
    );
  } catch (error) {
    throw new Error(`upload failed for ${local.key}: ${objectStoreErrorMessage(error)}`, {
      cause: error,
    });
  }
}

async function headObject(s3, key) {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }));
    return {
      size: typeof result.ContentLength === "number" ? result.ContentLength : null,
      etag: normalizeEtag(result.ETag),
      sha256Metadata: String(result.Metadata?.sha256 ?? "").toLowerCase() || null,
    };
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw new Error(`HEAD failed for ${key}: ${objectStoreErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function objectStoreErrorMessage(error) {
  const details = [];
  const statusCode = error?.$metadata?.httpStatusCode;
  const requestId = error?.$metadata?.requestId;
  if (Number.isInteger(statusCode)) details.push(`HTTP ${statusCode}`);
  if (typeof requestId === "string" && requestId.trim()) {
    details.push(`request ${requestId.trim()}`);
  }
  const message = errorMessage(error);
  return details.length === 0 ? message : `${message} (${details.join(", ")})`;
}

function remoteMatchesLocal(remote, local, requireChecksumMetadata) {
  if (remote?.size !== local.size) return false;
  if (requireChecksumMetadata) return remote.sha256Metadata === local.sha256Hex;
  return (
    remote.sha256Metadata === local.sha256Hex ||
    (SINGLE_PART_MD5_ETAG.test(remote.etag) && remote.etag === local.md5Hex)
  );
}

function assertVerifiedRemoteCopy(key, remote, local) {
  if (remote?.size === local.size && remote.sha256Metadata === local.sha256Hex) return;
  throw new Error(
    `verification failed for ${key} (remote ${remote?.size ?? "missing"} bytes, sha256 metadata ${remote?.sha256Metadata ?? "missing"})`,
  );
}

function assertUniqueKeys(objects) {
  const seen = new Map();
  for (const object of objects) {
    const previous = seen.get(object.key);
    if (previous) {
      throw new Error(`duplicate R2 object key ${object.key} from two publication phases`);
    }
    seen.set(object.key, object);
  }
}

function isMissingObjectError(error) {
  const statusCode = error?.$metadata?.httpStatusCode;
  const name = error?.name;
  const code = error?.Code ?? error?.code;
  return (
    statusCode === 404 ||
    name === "NotFound" ||
    name === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchKey"
  );
}

function normalizeEtag(etag) {
  return String(etag ?? "")
    .replaceAll('"', "")
    .trim()
    .toLowerCase();
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".zst")) return "application/zstd";
  return "application/octet-stream";
}

function printHeader(phases, options) {
  const count =
    phases.blobs.length +
    phases.jsonBeforeIndex.length +
    phases.vendorSnapshots.length +
    phases.index.length;
  console.log(`Bucket   : ${r2.bucket}`);
  console.log(`Endpoint : ${r2.endpoint}`);
  console.log(
    `Objects  : ${count}${options.jsonOnly ? " (JSON only)" : options.binaryOnly ? " (blobs only)" : ""}`,
  );
}

function printDryRun(phases, options) {
  printHeader(phases, options);
  for (const [label, objects] of [
    ["1. content-addressed blobs", phases.blobs],
    ["2. independent JSON", phases.jsonBeforeIndex],
    ["3. immutable vendor snapshots", phases.vendorSnapshots],
    ["4. index commit point", phases.index],
  ]) {
    console.log(`${label}: ${objects.length}`);
    for (const object of objects) console.log(`  ${object.key}`);
  }
  console.log(`HEAD-verified catalog blobs: ${phases.requiredBlobs.length}`);
}

export function printPublicationHelp() {
  console.error(`Usage: node scripts/publish-library-catalog.mjs [--json-only | --binary-only] [--dry-run] [--force]

  --json-only    Publish JSON snapshots and index; verify every referenced blob.
  --binary-only  Publish locally available blobs, then verify every catalog blob.
  --dry-run      Print ordered publication phases without network access.
  --force        Re-upload objects even when the remote copy matches.`);
}
