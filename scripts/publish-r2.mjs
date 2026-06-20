#!/usr/bin/env node
// Publishes the catalog to Cloudflare R2 (S3-compatible) via the AWS SDK — no
// external binary required. Uploads the served JSON manifests plus, unless
// --json-only, every cdn/*.dll.zst payload. Objects whose remote copy already
// matches (size + MD5) are skipped, then each upload is verified with a HEAD.
//
//   node scripts/publish-r2.mjs              binaries + JSON (owner, local)
//   node scripts/publish-r2.mjs --json-only  JSON only (CI; no cdn/ needed)
//   node scripts/publish-r2.mjs --dry-run    list objects; no network/creds
//   node scripts/publish-r2.mjs --force      re-upload even if already current
//
// Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (object-scoped R2 token).

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { repoRoot, servedJson, r2 } from './catalog.mjs';

const flags = new Set(process.argv.slice(2));
if (flags.has('--help') || flags.has('-h')) {
  printHelp();
  process.exit(0);
}
const jsonOnly = flags.has('--json-only');
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');

const md5Hex = (buf) => createHash('md5').update(buf).digest('hex');
const isMd5 = (s) => /^[0-9a-f]{32}$/.test(s);

function contentType(key) {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.zst')) return 'application/zstd';
  return 'application/octet-stream';
}

// Object key = file basename: everything is served from the bucket root, which
// is what the download URLs baked into manifest.json expect.
async function resolveObjects() {
  const objects = servedJson.map((rel) => ({ key: path.basename(rel), abs: path.join(repoRoot, rel) }));

  if (!jsonOnly) {
    const cdnDir = path.join(repoRoot, 'cdn');
    let names;
    try {
      names = await readdir(cdnDir);
    } catch {
      throw new Error(`cdn/ not found at ${cdnDir} — use --json-only to publish manifests without the binaries.`);
    }
    for (const name of names.filter((n) => n.endsWith('.dll.zst')).sort()) {
      objects.push({ key: name, abs: path.join(cdnDir, name) });
    }
  }
  return objects;
}

async function head(s3, key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }));
    return { size: r.ContentLength, etag: (r.ETag ?? '').replaceAll('"', '') };
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function main() {
  const objects = await resolveObjects();

  if (dryRun) {
    console.log(`Dry run — ${objects.length} object(s) would be considered${jsonOnly ? ' (JSON only)' : ''}:`);
    for (const o of objects) console.log(`  ${o.key}`);
    return;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: r2.endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log(`Bucket   : ${r2.bucket}`);
  console.log(`Endpoint : ${r2.endpoint}`);
  console.log(`Objects  : ${objects.length}${jsonOnly ? ' (JSON only)' : ''}\n`);

  let uploaded = 0;
  let skipped = 0;

  for (const { key, abs } of objects) {
    const body = await readFile(abs);
    const localMd5 = md5Hex(body);

    if (!force) {
      const remote = await head(s3, key);
      if (remote && remote.size === body.length && isMd5(remote.etag) && remote.etag === localMd5) {
        console.log(`  = ${key} (up to date)`);
        skipped += 1;
        continue;
      }
    }

    await s3.send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType(key),
      ContentLength: body.length,
    }));

    const after = await head(s3, key);
    const sizeOk = after && after.size === body.length;
    const etagOk = after && (!isMd5(after.etag) || after.etag === localMd5);
    if (!sizeOk || !etagOk) {
      throw new Error(`verification failed for ${key} (remote ${after?.size ?? 'missing'} bytes)`);
    }
    console.log(`  ↑ ${key} (${body.length} bytes)`);
    uploaded += 1;
  }

  console.log(`\nDone: ${uploaded} uploaded, ${skipped} already current.`);
}

function printHelp() {
  console.log(`Usage: node scripts/publish-r2.mjs [--json-only] [--dry-run] [--force]

  --json-only  Publish only the served JSON manifests (skip cdn/ binaries). CI uses this.
  --dry-run    List the objects that would be considered; no network, no credentials.
  --force      Upload every object even if the remote copy already matches.

Credentials: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (object-scoped R2 S3 token).`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
