// Maps a URL probe to a frozen upstream check result (ok / hard / soft).

import { errorMessage } from "../common.mjs";
import { UpstreamNetworkError, probeUrl } from "../http.mjs";
import { CHECK_STATUS, checkResult } from "./result.mjs";

/**
 * Probes `url` and maps the outcome to a frozen check result.
 *
 * - HTTP ok (or redirect when `redirectOk`) тЖТ ok
 * - HTTP non-ok тЖТ `missingStatus` (hard or soft by caller policy)
 * - network / timeout тЖТ `networkStatus` (default soft)
 */
export async function checkUrlHealth(id, url, options = {}) {
  const {
    fetchFn,
    timeoutMs,
    method,
    redirectOk = false,
    missingStatus,
    networkStatus = CHECK_STATUS.soft,
  } = options;

  if (missingStatus !== CHECK_STATUS.hard && missingStatus !== CHECK_STATUS.soft) {
    throw new Error(
      `checkUrlHealth: missingStatus must be hard or soft, got ${missingStatus}`,
    );
  }

  try {
    const probe = await probeUrl(url, { fetchFn, timeoutMs, method, redirectOk });
    if (probe.ok) {
      const detail = probe.location
        ? `HTTP ${probe.status} (redirect)`
        : `HTTP ${probe.status}`;
      return checkResult(id, CHECK_STATUS.ok, detail);
    }
    return checkResult(id, missingStatus, `HTTP ${probe.status} for ${url}`);
  } catch (error) {
    const detail =
      error instanceof UpstreamNetworkError ? error.message : errorMessage(error);
    return checkResult(id, networkStatus, detail);
  }
}
