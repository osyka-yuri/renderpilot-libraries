// Shared output helpers for the build-time guard scripts
// (`scripts/check-renodx-slugs.mjs` and `scripts/check-luma-assets.mjs`).
// Both list a trimmed set of failure reasons to stderr; the trim threshold
// and the "…and N more" footer are identical so the two guards report in the
// same shape.

export const MAX_ISSUES_TO_PRINT = 40;

/**
 * Prints `header` followed by up to `max` issue lines to stderr. Any excess
 * is summarised as a single `…and N more` footer so a failing guard never
 * floods the log. No-op when `issues` is empty.
 */
export function printIssues(header, issues, max = MAX_ISSUES_TO_PRINT) {
  if (issues.length === 0) {
    return;
  }

  console.error(header);

  for (const item of issues.slice(0, max)) {
    console.error(`  - ${item}`);
  }

  if (issues.length > max) {
    console.error(`  …and ${issues.length - max} more`);
  }
}
