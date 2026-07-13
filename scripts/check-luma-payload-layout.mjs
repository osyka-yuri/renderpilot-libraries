#!/usr/bin/env node
// Verify that each Luma release asset still has the exact root .addon named by
// the manifest. This reads only ZIP metadata through bounded HTTP ranges.

import path from "node:path";

import { repoRoot } from "./catalog.mjs";
import { forEachConcurrent } from "./lib/common.mjs";
import { printIssues } from "./lib/checks.mjs";
import { readJsonFileAsync } from "./lib/json.mjs";
import { AssetUnavailableError } from "./lib/luma-asset-checks.mjs";
import {
  ZIP_EOCD_TAIL_BYTES,
  assertPartialResponse,
  centralDirectoryFromTail,
  collectAssetPayloadIdentities,
  rootAddonFromCentralDirectory,
} from "./lib/luma-payload-layout.mjs";

const LATEST_DOWNLOAD_BASE =
  "https://github.com/Filoppi/Luma-Framework/releases/latest/download";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 4;

class PayloadLayoutError extends Error {}

async function readBodyBounded(body, maxBytes) {
  if (!body) throw new PayloadLayoutError("asset response has no body");

  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PayloadLayoutError(`range response exceeds ${maxBytes} byte safety limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

async function resolveAsset(asset) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  const url = `${LATEST_DOWNLOAD_BASE}/${encodeURIComponent(asset)}`;

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new PayloadLayoutError(`asset HEAD returned HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(total) || total < 22) {
      throw new PayloadLayoutError("asset HEAD did not return a valid Content-Length");
    }
    return { url: response.url, total };
  } catch (error) {
    if (error instanceof PayloadLayoutError) throw error;
    if (error?.name === "AbortError") {
      throw new AssetUnavailableError(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new AssetUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function requestRange(url, range, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      headers: { Range: range },
      signal: controller.signal,
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      bytes: await readBodyBounded(response.body, maxBytes),
    };
  } catch (error) {
    if (error instanceof PayloadLayoutError) throw error;
    if (error?.name === "AbortError") {
      throw new AssetUnavailableError(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new AssetUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function rootAddonFromRemoteAsset(asset) {
  const remote = await resolveAsset(asset);
  const tailStart = Math.max(0, remote.total - ZIP_EOCD_TAIL_BYTES);
  const tailExpected = { start: tailStart, end: remote.total - 1, total: remote.total };
  const tail = await requestRange(
    remote.url,
    `bytes=${tailExpected.start}-${tailExpected.end}`,
    ZIP_EOCD_TAIL_BYTES,
  );
  const tailRange = assertPartialResponse({
    status: tail.status,
    contentRange: tail.contentRange,
    bytesLength: tail.bytes.length,
    expected: tailExpected,
    maxBytes: ZIP_EOCD_TAIL_BYTES,
  });
  const descriptor = centralDirectoryFromTail(tail.bytes, tailRange);
  if (descriptor.size > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new PayloadLayoutError(
      `ZIP central directory exceeds ${MAX_CENTRAL_DIRECTORY_BYTES} byte safety limit`,
    );
  }

  const central = await requestRange(
    remote.url,
    `bytes=${descriptor.start}-${descriptor.end}`,
    MAX_CENTRAL_DIRECTORY_BYTES,
  );
  assertPartialResponse({
    status: central.status,
    contentRange: central.contentRange,
    bytesLength: central.bytes.length,
    expected: descriptor,
    maxBytes: MAX_CENTRAL_DIRECTORY_BYTES,
  });
  return rootAddonFromCentralDirectory(central.bytes, descriptor);
}

async function checkPayload({ asset, addonFile }) {
  try {
    const actual = await rootAddonFromRemoteAsset(asset);
    return actual === addonFile
      ? { asset, ok: true }
      : {
          asset,
          ok: false,
          reason: `manifest expects ${addonFile}, archive contains ${actual}`,
        };
  } catch (error) {
    if (error instanceof AssetUnavailableError) throw error;
    return {
      asset,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const manifest = await readJsonFileAsync(
    path.join(repoRoot, "luma_manifest.json"),
    "luma_manifest.json",
  );
  const payloads = collectAssetPayloadIdentities(manifest);
  console.log(`Checking root payload identity for ${payloads.length} Luma asset(s)...`);

  const results = [];
  let networkFailure = null;
  await forEachConcurrent(payloads, CONCURRENCY, async (payload) => {
    try {
      results.push(await checkPayload(payload));
    } catch (error) {
      if (error instanceof AssetUnavailableError) {
        networkFailure ??= error;
        results.push({
          asset: payload.asset,
          ok: false,
          reason: error.message,
          networkIssue: true,
        });
        return;
      }
      throw error;
    }
  });

  if (networkFailure && results.every((result) => result.networkIssue)) {
    console.warn(
      `Skipping Luma payload-layout check -- could not reach GitHub: ${networkFailure.message}`,
    );
    return;
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    printIssues(
      `\nFAIL ${failures.length} Luma payload layout check(s):`,
      failures.map((failure) => `${failure.asset}: ${failure.reason}`),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`OK all ${results.length} Luma assets match their root payload identity.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
