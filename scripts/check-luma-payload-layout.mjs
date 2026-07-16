#!/usr/bin/env node
// Verify that each Luma release asset still has the exact root .addon named by
// the manifest. This reads only ZIP metadata through bounded HTTP ranges.

import { addonCatalogs } from "./catalog.mjs";
import { errorMessage, forEachConcurrent } from "./lib/common.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { printIssues } from "./lib/checks.mjs";
import { PAYLOAD_TIMEOUT_MS, UpstreamNetworkError, fetchWithTimeout } from "./lib/http.mjs";
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

function toAssetUnavailable(error) {
  if (error instanceof UpstreamNetworkError) {
    return new AssetUnavailableError(error.message, { cause: error });
  }
  return new AssetUnavailableError(errorMessage(error), {
    cause: error,
  });
}

async function resolveAsset(asset) {
  const url = `${LATEST_DOWNLOAD_BASE}/${encodeURIComponent(asset)}`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      redirect: "follow",
      timeoutMs: PAYLOAD_TIMEOUT_MS,
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
    throw toAssetUnavailable(error);
  }
}

async function requestRange(url, range, maxBytes) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      timeoutMs: PAYLOAD_TIMEOUT_MS,
      headers: { Range: range },
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      bytes: await readBodyBounded(response.body, maxBytes),
    };
  } catch (error) {
    if (error instanceof PayloadLayoutError) throw error;
    throw toAssetUnavailable(error);
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
      reason: errorMessage(error),
    };
  }
}

async function main() {
  const manifest = await readJsonFileAsync(
    addonCatalogs.luma.outputs.manifest.file,
    "addons/v1/luma.json",
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
      `SKIP Luma payload-layout check — could not reach GitHub: ${errorMessage(networkFailure)}`,
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

runCliMain({
  parse: () => ({}),
  main,
});
