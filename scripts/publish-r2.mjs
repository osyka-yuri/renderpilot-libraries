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

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { errorMessage, UsageError } from "./lib/common.mjs";
import { r2, repoRoot, servedJson } from "./catalog.mjs";

const CDN_DIR_NAME = "cdn";
const BINARY_SUFFIX = ".dll.zst";
const SINGLE_PART_MD5_ETAG = /^[0-9a-f]{32}$/;

const KNOWN_FLAGS = new Map([
  ["--json-only", "jsonOnly"],
  ["--dry-run", "dryRun"],
  ["--force", "force"],
  ["--help", "help"],
  ["-h", "help"],
]);

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

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
      console.log(`  ↑ ${object.key} (${result.bytes} bytes)`);
    }
  }

  console.log(`\nDone: ${summary.uploaded} uploaded, ${summary.skipped} already current.`);
}

function parseArgs(argv) {
  const options = {
    jsonOnly: false,
    dryRun: false,
    force: false,
    help: false,
  };

  const unknown = [];

  for (const arg of argv) {
    const optionName = KNOWN_FLAGS.get(arg);

    if (!optionName) {
      unknown.push(arg);
      continue;
    }

    options[optionName] = true;
  }

  if (unknown.length > 0) {
    throw new UsageError(`unknown option(s): ${unknown.join(", ")}`);
  }

  return options;
}

// Object key = file basename: everything is served from the bucket root, which
// is what the download URLs baked into manifest.json expect.
async function resolveObjects({ jsonOnly }) {
  const objects = servedJson.map((rel) => ({
    key: objectKeyFromRelativePath(rel),
    abs: path.resolve(repoRoot, rel),
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

function objectKeyFromRelativePath(relPath) {
  // catalog paths are repo-relative and usually POSIX-style. Normalize here so
  // key derivation remains stable across platforms.
  const normalized = relPath.replaceAll(path.win32.sep, path.posix.sep);
  return path.posix.basename(normalized);
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

function createR2Client(env) {
  assertNonEmptyConfig("r2.bucket", r2.bucket);
  assertNonEmptyConfig("r2.endpoint", r2.endpoint);

  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials missing: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: r2.endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function assertNonEmptyConfig(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${name}: expected a non-empty string.`);
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

function md5Hex(buf) {
  return createHash("md5").update(buf).digest("hex");
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
  console.log(`Usage: node scripts/publish-r2.mjs [--json-only] [--dry-run] [--force]

  --json-only  Publish only the served JSON manifests (skip cdn/ binaries). CI uses this.
  --dry-run    List the objects that would be considered; no network, no credentials.
  --force      Upload every object even if the remote copy already matches.

  Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (object-scoped R2 S3 token).`);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`Usage error: ${err.message}`);
    console.error("Run with --help for usage.");
  } else {
    console.error(errorMessage(err));
  }

  process.exitCode = 1;
});
