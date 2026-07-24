#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { microsoftLibraryVendor, repoRoot } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { UsageError, mapConcurrent } from "./lib/common.mjs";
import { appendGithubOutput } from "./lib/github-actions.mjs";
import { fetchWithTimeout } from "./lib/http.mjs";
import { sha256Hex } from "./lib/hash.mjs";
import { readJsonFileAsync, writeJsonFileAtomic } from "./lib/json.mjs";
import { assertLegalDocumentPayload } from "./lib/library-catalog.mjs";
import {
  canonicalAuthenticodeSignature,
  canonicalPeVersion,
  inspectPeFiles,
  persistCompressedDll,
  persistLegalDocument,
  reconcileLockedAuthenticodeSignature,
  writeImmutableObject,
} from "./lib/library-artifact-io.mjs";
import {
  assertLockBackfillsSignatures,
  assertLockSemantics,
  assertLockExtendsBaseline,
  assertReleaseContentIdentity,
  assertReleaseBackfillsSignatures,
  fetchPackageSha512,
  listedStableReleases,
  pathForPackageMember,
  selectPackageFiles,
  sortLock,
  verifyPackageSha512,
} from "./lib/microsoft-nuget.mjs";
import { parseRefreshArgs } from "./lib/refresh-cli.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = path.join(repoRoot, microsoftLibraryVendor.configFile);
const LOCK_FILE = path.join(repoRoot, microsoftLibraryVendor.lockFile);
const CDN_DIR = path.join(repoRoot, "cdn");
const PACKAGE_CACHE_DIR = path.join(repoRoot, "scripts", ".cache", "nuget");

async function main(options) {
  const [config, lock] = await Promise.all([
    readJsonFileAsync(CONFIG_FILE),
    readJsonFileAsync(LOCK_FILE),
  ]);
  assertLockSemantics(lock, config);
  const immutableBaseline = structuredClone(lock);

  const products = options.product
    ? config.products.filter((product) => product.key === options.product)
    : config.products;
  if (products.length === 0) {
    throw new UsageError(`unknown Microsoft product ${options.product}`);
  }

  const missing = [];
  const upstreamByPackage = new Map();
  for (const product of products) {
    const upstream = await listedStableReleases(product.package_id);
    upstreamByPackage.set(product.package_id, upstream);
    if (upstream.length < product.expected_listed_stable_releases) {
      throw new Error(
        `${product.package_id}: expected at least ${product.expected_listed_stable_releases} listed stable releases, got ${upstream.length}`,
      );
    }
    const locked = new Set(
      lock.releases
        .filter((release) => release.package_id === product.package_id)
        .map((release) => release.package_version),
    );
    for (const release of upstream) {
      if (!locked.has(release.packageVersion)) missing.push({ product, release });
    }
    console.log(
      `${product.package_id}: ${upstream.length} listed stable, ${upstream.length - missing.filter((item) => item.product === product).length} locked`,
    );
  }

  await appendGithubOutput({
    status: missing.length === 0 ? "current" : "update_available",
    count: String(missing.length),
  });
  if (options.mode === "materialize-locked" || options.mode === "migrate-transport") {
    await rebuildLockedReleases(
      products,
      lock,
      immutableBaseline,
      upstreamByPackage,
      config,
      { migrateTransport: options.mode === "migrate-transport" },
    );
    return;
  }
  if (options.mode === "backfill-signatures") {
    if (missing.length > 0) {
      throw new Error(
        "signature backfill requires a current lock; import missing releases with --write first",
      );
    }
    await backfillLockedSignatureMetadata(
      products,
      lock,
      immutableBaseline,
      upstreamByPackage,
      config,
    );
    return;
  }
  if (missing.length === 0) {
    console.log("Microsoft NuGet lock is current.");
    return;
  }
  console.log(`Missing listed stable releases: ${missing.length}`);
  if (options.mode !== "write") {
    for (const { product, release } of missing) {
      console.log(`  ${product.key}: ${release.packageVersion}`);
    }
    return;
  }

  await mkdir(CDN_DIR, { recursive: true });
  let completed = 0;
  const importedReleases = await mapConcurrent(missing, 4, async (item) => {
    const imported = await importRelease(item);
    completed += 1;
    console.log(
      `[${completed}/${missing.length}] ${item.product.package_id} ${item.release.packageVersion}`,
    );
    return imported;
  });
  lock.releases.push(...importedReleases);
  sortLock(lock);
  assertLockSemantics(lock, config);
  assertLockExtendsBaseline(lock, immutableBaseline);
  await writeJsonFileAtomic(LOCK_FILE, lock);

  console.log(
    `Updated ${path.relative(repoRoot, LOCK_FILE)} with ${missing.length} release(s).`,
  );
}

async function importRelease(
  { product, release },
  { expectedRelease = null, mode = "new" } = {},
) {
  if (
    !new Set(["new", "materialize-locked", "migrate-transport", "signature-backfill"]).has(
      mode,
    )
  ) {
    throw new Error(`unsupported Microsoft import mode ${mode}`);
  }
  if ((mode === "new") !== (expectedRelease === null)) {
    throw new Error(`${mode} import mode has inconsistent expected release state`);
  }
  const identity = `${release.packageId} ${release.packageVersion}`;
  const expectedSha512 = await fetchPackageSha512(release.catalogEntry);
  const nupkg = await readOrDownloadPackage(
    release.packageContent,
    expectedSha512,
    identity,
  );

  const temporary = await mkdtemp(path.join(tmpdir(), "renderpilot-nuget-"));
  try {
    const packageFile = path.join(temporary, "package.nupkg");
    const extractRoot = path.join(temporary, "extract");
    await mkdir(extractRoot);
    await writeFile(packageFile, nupkg);
    const { stdout } = await execFileAsync("tar", ["-tf", packageFile], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const packagePaths = stdout.split(/\r?\n/).filter(Boolean);
    const selections = selectPackageFiles(packagePaths, product);
    const selected = selections.flatMap(({ architecture, members }) =>
      members.map((member) => ({ architecture, member })),
    );
    const legalSelections = selectLegalDocuments(packagePaths, product, identity);
    await execFileAsync("tar", [
      "-xf",
      packageFile,
      "-C",
      extractRoot,
      "--",
      ...selected.map(({ member }) => member.package_path),
      ...legalSelections.map(({ package_path }) => package_path),
    ]);
    const paths = selected.map(({ member }) =>
      pathForPackageMember(extractRoot, member.package_path),
    );
    const legalPaths = legalSelections.map(({ package_path }) =>
      pathForPackageMember(extractRoot, package_path),
    );
    const extractedPaths = [...paths, ...legalPaths];
    const extractedStats = await Promise.all(
      extractedPaths.map((filePath) => lstat(filePath)),
    );
    for (const [index, stats] of extractedStats.entries()) {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(
          `${identity}: selected package member is not a regular file: ${extractedPaths[index]}`,
        );
      }
    }
    const inspections = await inspectPeFiles(paths);
    const artifacts = [];

    for (const [index, selectedMember] of selected.entries()) {
      const filePath = paths[index];
      const inspection = inspections[index];
      if (inspection.architecture !== selectedMember.architecture.catalog_architecture) {
        throw new Error(
          `${identity}: ${selectedMember.member.package_path} is ${inspection.architecture}, expected ${selectedMember.architecture.catalog_architecture}`,
        );
      }
      const dll = await readFile(filePath);
      const dllSha256 = sha256Hex(dll);
      const artifact = {
        architecture: inspection.architecture,
        package_path: selectedMember.member.package_path,
        library_id: selectedMember.member.library_id,
        file_name: selectedMember.member.file_name,
        pe_version: canonicalPeVersion(inspection.pe_version),
        dll_sha256: dllSha256,
        dll_size_bytes: dll.length,
        signature: canonicalAuthenticodeSignature(inspection.signature),
        r2: null,
      };
      const expectedArtifact = expectedRelease?.artifacts.find(
        (candidate) =>
          candidate.architecture === artifact.architecture &&
          candidate.library_id === artifact.library_id,
      );
      if (expectedRelease && !expectedArtifact) {
        throw new Error(
          `${identity}: locked artifact ${artifact.architecture}/${artifact.library_id} is missing`,
        );
      }
      if (expectedArtifact) {
        artifact.signature = reconcileLockedAuthenticodeSignature(
          artifact.signature,
          expectedArtifact.signature,
          {
            allowTimestampBackfill: mode === "signature-backfill",
            context: `${identity}/${artifact.architecture}/${artifact.library_id}`,
          },
        );
      }

      if (mode === "signature-backfill") {
        artifact.r2 = structuredClone(expectedArtifact.r2);
      } else {
        artifact.r2 = await persistCompressedDll(dll, {
          cdnDirectory: CDN_DIR,
          compressionLevel: expectedArtifact?.r2.compression_level ?? 12,
          expectedTransport: mode === "materialize-locked" ? expectedArtifact?.r2 : null,
        });
      }

      artifacts.push(artifact);
    }

    const legalDocuments = [];
    for (const [index, configured] of legalSelections.entries()) {
      const bytes = await readFile(legalPaths[index]);
      assertLegalDocumentPayload(
        bytes,
        configured.format,
        `${identity}/${configured.package_path}`,
      );
      const sha256 = sha256Hex(bytes);
      const expectedDocument = expectedRelease?.legal_documents?.find(
        (document) => document.package_path === configured.package_path,
      );
      if (
        expectedDocument &&
        (expectedDocument.sha256 !== sha256 || expectedDocument.size_bytes !== bytes.length)
      ) {
        throw new Error(
          `${identity}: immutable legal document ${configured.package_path} changed`,
        );
      }
      const persisted =
        mode === "signature-backfill" && expectedDocument
          ? {
              object_key: expectedDocument.object_key,
              sha256: expectedDocument.sha256,
              size_bytes: expectedDocument.size_bytes,
            }
          : await persistLegalDocument(bytes, configured.format, {
              cdnDirectory: CDN_DIR,
            });
      legalDocuments.push({
        ...configured,
        sha256: persisted.sha256,
        size_bytes: persisted.size_bytes,
        object_key: persisted.object_key,
      });
    }

    const imported = {
      product: product.key,
      package_id: release.packageId,
      package_version: release.packageVersion,
      package_sha512: expectedSha512,
      published_at: release.publishedAt,
      artifacts,
      legal_documents: legalDocuments,
    };
    if (expectedRelease) {
      if (mode === "signature-backfill") {
        assertReleaseBackfillsSignatures(imported, expectedRelease);
      } else assertReleaseContentIdentity(imported, expectedRelease);
    }
    return imported;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readOrDownloadPackage(url, expectedSha512, identity) {
  const cacheKey = sha256Hex(Buffer.from(expectedSha512, "utf8"));
  const cacheFile = path.join(PACKAGE_CACHE_DIR, `${cacheKey}.nupkg`);
  try {
    const cached = await readFile(cacheFile);
    verifyPackageSha512(cached, expectedSha512, `${identity} cached nupkg`);
    return cached;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const response = await fetchWithTimeout(url, { timeoutMs: 10 * 60_000 });
  if (!response.ok) {
    throw new Error(`${identity}: nupkg download failed (${response.status})`);
  }
  const nupkg = Buffer.from(await response.arrayBuffer());
  verifyPackageSha512(nupkg, expectedSha512, identity);
  await writeImmutableObject(cacheFile, nupkg);
  return nupkg;
}

function selectLegalDocuments(packagePaths, product, identity) {
  const normalized = packagePaths.map((value) =>
    value.replaceAll("\\", "/").replace(/^\.\//u, ""),
  );
  return product.legal_documents.map((document) => {
    const matches = normalized.filter(
      (candidate) => candidate.toLowerCase() === document.package_path.toLowerCase(),
    );
    if (matches.length !== 1 || matches[0] !== document.package_path) {
      throw new Error(
        `${identity}: expected exact legal document path ${document.package_path}`,
      );
    }
    return { ...document };
  });
}

async function backfillLockedSignatureMetadata(
  products,
  lock,
  immutableBaseline,
  upstreamByPackage,
  config,
) {
  const productByKey = new Map(products.map((product) => [product.key, product]));
  const targets = lock.releases.filter(
    (release) =>
      productByKey.has(release.product) &&
      release.artifacts.some((artifact) => artifact.signature.signed_at === null),
  );
  if (targets.length === 0) {
    console.log("Every selected Microsoft artifact already has signature metadata.");
    return;
  }

  let completed = 0;
  const rebuiltByRelease = new Map();
  await mapConcurrent(targets, 4, async (expectedRelease) => {
    const product = productByKey.get(expectedRelease.product);
    const release = upstreamByPackage
      .get(expectedRelease.package_id)
      ?.find((candidate) => candidate.packageVersion === expectedRelease.package_version);
    if (!release) {
      throw new Error(
        `${expectedRelease.package_id} ${expectedRelease.package_version}: locked release is absent from Registration API`,
      );
    }

    const enriched = await importRelease(
      { product, release },
      {
        expectedRelease,
        mode: "signature-backfill",
      },
    );
    rebuiltByRelease.set(expectedRelease, enriched);

    completed += 1;
    console.log(
      `[${completed}/${targets.length}] verified signatures ${release.packageId} ${release.packageVersion}`,
    );
  });

  for (const expectedRelease of targets) {
    const index = lock.releases.indexOf(expectedRelease);
    const enriched = rebuiltByRelease.get(expectedRelease);
    if (index < 0 || !enriched) {
      throw new Error(
        `${expectedRelease.package_id} ${expectedRelease.package_version}: rebuilt signature metadata was lost`,
      );
    }
    lock.releases[index] = enriched;
  }
  sortLock(lock);
  assertLockSemantics(lock, config);
  assertLockBackfillsSignatures(lock, immutableBaseline);
  await writeJsonFileAtomic(LOCK_FILE, lock);

  const remaining = lock.releases
    .filter((release) => productByKey.has(release.product))
    .flatMap((release) => release.artifacts)
    .filter((artifact) => artifact.signature.signed_at === null);
  console.log(
    `Verified signature metadata for ${targets.length} locked release(s); ${remaining.length} artifact timestamp(s) are genuinely absent.`,
  );
}

async function rebuildLockedReleases(
  products,
  lock,
  immutableBaseline,
  upstreamByPackage,
  config,
  { migrateTransport },
) {
  await mkdir(CDN_DIR, { recursive: true });
  const productByKey = new Map(products.map((product) => [product.key, product]));
  const targets = lock.releases.filter(
    (release) => productByKey.has(release.product) && release.artifacts.length > 0,
  );
  let completed = 0;
  const rebuiltByRelease = new Map();

  await mapConcurrent(targets, 4, async (expectedRelease) => {
    const product = productByKey.get(expectedRelease.product);
    const release = upstreamByPackage
      .get(expectedRelease.package_id)
      ?.find((candidate) => candidate.packageVersion === expectedRelease.package_version);
    if (!release) {
      throw new Error(
        `${expectedRelease.package_id} ${expectedRelease.package_version}: locked release is absent from Registration API`,
      );
    }
    const rebuilt = await importRelease(
      { product, release },
      {
        expectedRelease,
        mode: migrateTransport ? "migrate-transport" : "materialize-locked",
      },
    );
    rebuiltByRelease.set(expectedRelease, rebuilt);
    completed += 1;
    console.log(
      `[${completed}/${targets.length}] materialized ${release.packageId} ${release.packageVersion}`,
    );
  });

  for (const expectedRelease of targets) {
    const index = lock.releases.indexOf(expectedRelease);
    const rebuilt = rebuiltByRelease.get(expectedRelease);
    if (index < 0 || !rebuilt) {
      throw new Error(
        `${expectedRelease.package_id} ${expectedRelease.package_version}: rebuilt release was lost`,
      );
    }
    lock.releases[index] = rebuilt;
  }
  sortLock(lock);
  assertLockSemantics(lock, config);
  assertLockExtendsBaseline(lock, immutableBaseline);
  const changed = !isDeepStrictEqual(lock, immutableBaseline);
  if (changed) await writeJsonFileAtomic(LOCK_FILE, lock);
  if (migrateTransport) {
    console.log(
      `Migrated transport metadata for ${targets.length} release(s)` +
        (changed ? "." : "; every identity was already canonical."),
    );
  } else {
    if (changed) {
      throw new Error("locked materialization unexpectedly changed the lock");
    }
    console.log(
      `Materialized ${targets.length} release(s) without changing locked transport identity.`,
    );
  }
}

function parseArgs(argv) {
  return parseRefreshArgs(argv, {
    allowBackfillSignatures: true,
    allowProduct: true,
  });
}

runCliMain({ parse: parseArgs, main });
