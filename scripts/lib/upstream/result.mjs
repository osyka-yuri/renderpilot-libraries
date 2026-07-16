// Shared outcome helpers for upstream health / refresh tooling.

export const CHECK_STATUS = Object.freeze({
  ok: "ok",
  soft: "soft",
  hard: "hard",
});

/**
 * @param {string} id
 * @param {"ok"|"soft"|"hard"} status
 * @param {string} detail
 */
export function checkResult(id, status, detail) {
  if (!Object.values(CHECK_STATUS).includes(status)) {
    throw new Error(`invalid check status: ${status}`);
  }
  return Object.freeze({ id, status, detail: String(detail ?? "") });
}

function hasStatus(results, status) {
  return results.some((result) => result.status === status);
}

function messagesForStatus(results, status) {
  return results
    .filter((result) => result.status === status)
    .map((result) => `${result.id}: ${result.detail}`);
}

export function hasHardFailure(results) {
  return hasStatus(results, CHECK_STATUS.hard);
}

export function hasSoftFailure(results) {
  return hasStatus(results, CHECK_STATUS.soft);
}

/** Human-readable lines for CLI / Actions summaries. */
export function formatCheckResults(results) {
  return results.map((result) => {
    const tag = result.status.toUpperCase().padEnd(4);
    return `${tag} ${result.id}: ${result.detail}`;
  });
}

export function hardFailureMessages(results) {
  return messagesForStatus(results, CHECK_STATUS.hard);
}

export function softFailureMessages(results) {
  return messagesForStatus(results, CHECK_STATUS.soft);
}
