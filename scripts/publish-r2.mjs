#!/usr/bin/env node
// Publishes the catalog to Cloudflare R2 (S3-compatible) via the AWS SDK — no
// external binary required. Uploads the served JSON manifests plus, unless
// --json-only, every cdn/*.dll.zst payload. Objects whose remote copy already
// matches (size + single-part MD5 ETag) are skipped, then each upload is
// verified with a HEAD.
//
//   node scripts/publish-r2.mjs              binaries + JSON (owner, local)
//   node scripts/publish-r2.mjs --json-only  JSON only (CI; no cdn/ needed)
//   node scripts/publish-r2.mjs --dry-run    list objects; no network/creds
//   node scripts/publish-r2.mjs --force      re-upload even if already current
//
// Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (object-scoped R2 token).

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { errorMessage } from "./lib/common.mjs";
import { parseCliArgs, wantsHelp } from "./lib/cli-args.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { md5Hex, sha256Hex } from "./lib/hash.mjs";
import { createR2Client } from "./lib/r2-client.mjs";
import { publishedJsonDocuments, r2, repoRoot } from "./catalog.mjs";

const CDN_DIR_NAME = "cdn";
const BINARY_SUFFIX = ".dll.zst";
const SINGLE_PART_MD5_ETAG = /^[0-9a-f]{32}$/;

async function main(options, env = process.env) {
  const objects = await resolveObjects(options);
  assertUniqueKeys(objects);

  if (options.dryRun) {
    printDryRun(objects, options);
    return;
  }

  const s3 = createR2Client(env);

  printHeader(objects, options);

  const summary = { uploaded: 0, skipped: 0 };

  for (const object of objects) {
    const result = await publishObject(s3, object, options);

    if (result.action === "skipped") {
      summary.skipped += 1;
      console.log(`  = ${object.key} (up to date)`);
    } else {
      summary.uploaded += 1;
      console.log(`  ↑ ${object.key} sha256:${result.sha256} (${result.bytes} bytes)`);
    }
  }

  console.log(`\nDone: ${summary.uploaded} uploaded, ${summary.skipped} already current.`);
}

function parseArgs(argv) {
  if (wantsHelp(argv)) {
    return { jsonOnly: false, dryRun: false, force: false, help: true };
  }

  const { values } = parseCliArgs(argv, {
    "json-only": { type: "boolean" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });

  return {
    jsonOnly: Boolean(values["json-only"]),
    dryRun: Boolean(values["dry-run"]),
    force: Boolean(values.force),
    help: false,
  };
}

// Object keys retain the catalog-relative path. Add-on catalogues are versioned
// under addons/v1/; library/DLSS documents remain at the bucket root.
async function resolveObjects({ jsonOnly }) {
  const objects = publishedJsonDocuments.map(({ file, r2Key }) => ({
    key: r2Key,
    abs: path.resolve(repoRoot, file),
  }));

  if (jsonOnly) {
    return objects;
  }

  const cdnDir = path.join(repoRoot, CDN_DIR_NAME);
  const entries = await readCdnEntries(cdnDir);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(BINARY_SUFFIX)) {
      continue;
    }

    objects.push({
      key: entry.name,
      abs: path.join(cdnDir, entry.name),
    });
  }

  return objects;
}

async function readCdnEntries(cdnDir) {
  try {
    return (await readdir(cdnDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `cdn/ not found at ${cdnDir} — use --json-only to publish manifests without the binaries.`,
      );
    }

    throw new Error(`failed to read cdn/ at ${cdnDir}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function assertUniqueKeys(objects) {
  const seen = new Map();

  for (const object of objects) {
    const previous = seen.get(object.key);

    if (previous) {
      throw new Error(
        `duplicate R2 object key "${object.key}" from ${previous.abs} and ${object.abs}`,
      );
    }

    seen.set(object.key, object);
  }
}

async function publishObject(s3, object, { force }) {
  const local = await readLocalObject(object);

  if (!force) {
    const remote = await headObject(s3, object.key);

    if (remoteMatchesLocal(remote, local)) {
      return { action: "skipped" };
    }
  }

  await putObject(s3, local);

  const remoteAfterUpload = await headObject(s3, object.key);
  assertVerifiedRemoteCopy(object.key, remoteAfterUpload, local);

  return {
    action: "uploaded",
    bytes: local.size,
    sha256: local.sha256Hex,
  };
}

async function readLocalObject(object) {
  let body;

  try {
    body = await readFile(object.abs);
  } catch (err) {
    throw new Error(`failed to read ${object.abs}: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  return {
    ...object,
    body,
    size: body.length,
    md5Hex: md5Hex(body),
    sha256Hex: sha256Hex(body),
    contentType: contentTypeForKey(object.key),
  };
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
      }),
    );
  } catch (err) {
    throw new Error(`upload failed for ${local.key}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

async function headObject(s3, key) {
  try {
    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: r2.bucket,
        Key: key,
      }),
    );

    return {
      size: typeof result.ContentLength === "number" ? result.ContentLength : null,
      etag: normalizeEtag(result.ETag),
    };
  } catch (err) {
    if (isMissingObjectError(err)) {
      return null;
    }

    throw new Error(`HEAD failed for ${key}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function remoteMatchesLocal(remote, local) {
  return (
    remote !== null &&
    remote.size === local.size &&
    isSinglePartMd5Etag(remote.etag) &&
    remote.etag === local.md5Hex
  );
}

function assertVerifiedRemoteCopy(key, remote, local) {
  const sizeOk = remote?.size === local.size;

  // R2/S3 ETags are not guaranteed to be MD5 in every situation. When the ETag
  // looks like a single-part MD5, require an exact match. Otherwise, keep the
  // original conservative fallback: verify existence + size.
  const etagOk =
    remote !== null && (!isSinglePartMd5Etag(remote.etag) || remote.etag === local.md5Hex);

  if (sizeOk && etagOk) {
    return;
  }

  const remoteSize = remote?.size ?? "missing";
  const remoteEtag = remote?.etag ? `, ETag ${remote.etag}` : "";

  throw new Error(
    `verification failed for ${key} (remote ${remoteSize} bytes${remoteEtag})`,
  );
}

function isMissingObjectError(err) {
  const statusCode = err?.$metadata?.httpStatusCode;
  const name = err?.name;
  const code = err?.Code ?? err?.code;

  return (
    statusCode === 404 ||
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NotFoundError" ||
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

function isSinglePartMd5Etag(etag) {
  return SINGLE_PART_MD5_ETAG.test(etag);
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".zst")) return "application/zstd";
  return "application/octet-stream";
}

function printHeader(objects, { jsonOnly }) {
  console.log(`Bucket   : ${r2.bucket}`);
  console.log(`Endpoint : ${r2.endpoint}`);
  console.log(`Objects  : ${objects.length}${jsonOnly ? " (JSON only)" : ""}\n`);
}

function printDryRun(objects, { jsonOnly }) {
  console.log(
    `Dry run — ${objects.length} object(s) would be considered${
      jsonOnly ? " (JSON only)" : ""
    }:`,
  );

  for (const object of objects) {
    console.log(`  ${object.key}`);
  }
}

function printHelp() {
  console.error(`Usage: node scripts/publish-r2.mjs [--json-only] [--dry-run] [--force]

  --json-only  Publish only the served JSON manifests (skip cdn/ binaries). CI uses this.
  --dry-run    List the objects that would be considered; no network, no credentials.
  --force      Upload every object even if the remote copy already matches.

  Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (object-scoped R2 S3 token).`);
}

runCliMain({
  parse: parseArgs,
  help: printHelp,
  main,
});
