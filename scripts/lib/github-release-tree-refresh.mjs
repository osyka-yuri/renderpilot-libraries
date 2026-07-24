/**
 * Registry-wide refresh orchestration. Discovery is intentionally completed
 * for every selected vendor before any importer or lock writer is invoked.
 */
export async function runGitHubReleaseTreeRefreshBatch(
  vendors,
  options,
  { discoverVendor, prepareVendor, writeResults, reportResults },
) {
  const discoveries = [];
  for (const vendor of vendors) {
    discoveries.push(await discoverVendor(vendor));
  }

  if (options.mode === "backfill-signatures") {
    const incomplete = discoveries.filter(({ missing }) => missing.length > 0);
    if (incomplete.length > 0) {
      const summary = incomplete
        .map(({ vendor, missing }) => `${vendor.vendorId} (${missing.length})`)
        .join(", ");
      throw new Error(
        `signature backfill requires every selected lock to be current; import missing releases first: ${summary}`,
      );
    }
  }

  const results = [];
  for (const discovery of discoveries) {
    results.push(await prepareVendor(discovery, options));
  }
  const changed = results.filter((result) => result.changed);
  if (changed.length > 0) await writeResults(changed);
  await reportResults(results);
  return results;
}
