#!/usr/bin/env node

import { microsoftLibraryVendor } from "./catalog.mjs";
import { runCliMain } from "./lib/cli-main.mjs";
import { buildLibraryCatalogPlan } from "./lib/library-generation.mjs";
import { writeJsonFilesBatchWithRollback } from "./lib/json.mjs";
import { jsonDocument } from "./lib/library-catalog.mjs";
import {
  formatLifecyclePlan,
  loadMicrosoftCatalogState,
  MICROSOFT_WITHDRAWAL_HELP,
  parseMicrosoftWithdrawalArgs,
} from "./lib/microsoft-lifecycle.mjs";
import {
  assessNuGetReleaseAvailability,
  assertLockExtendsBaseline,
  assertLockSemantics,
  assertMicrosoftWithdrawalEvidence,
  microsoftPrunePlan,
  registrationReleases,
  sortLock,
} from "./lib/microsoft-nuget.mjs";

async function main(options) {
  const { config, lock: baseline, lockFile } = await loadMicrosoftCatalogState();
  const releaseIndex = baseline.releases.findIndex(
    (release) =>
      release.package_id.toLowerCase() === options.packageId.toLowerCase() &&
      release.package_version === options.packageVersion,
  );
  if (releaseIndex < 0) {
    throw new Error(
      `${options.packageId}@${options.packageVersion}: active release does not exist`,
    );
  }
  const release = baseline.releases[releaseIndex];
  const registration = await registrationReleases(release.package_id);
  const assessment = await assessNuGetReleaseAvailability(
    release.package_id,
    release.package_version,
    registration,
  );
  const upstreamReason =
    assessment.state === "unlisted" || assessment.state === "hard_delete"
      ? assessment.state
      : null;
  const reason = options.reason ?? upstreamReason;
  if (!reason) {
    throw new Error(
      `${release.package_id}@${release.package_version}: NuGet still reports ${assessment.state}; manual security/legal withdrawal requires --reason and --evidence`,
    );
  }
  if (reason === "unlisted" || reason === "hard_delete") {
    if (assessment.state !== reason) {
      throw new Error(
        `${release.package_id}@${release.package_version}: requested ${reason}, NuGet confirms ${assessment.state}`,
      );
    }
  }
  assertMicrosoftWithdrawalEvidence(
    reason,
    options.evidence,
    `${release.package_id}@${release.package_version}: evidence`,
  );

  const next = structuredClone(baseline);
  next.releases.splice(releaseIndex, 1);
  next.withdrawn.push({
    product: release.product,
    package_id: release.package_id,
    package_version: release.package_version,
    reason,
    confirmed_at: new Date().toISOString(),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    transport_object_keys: [
      ...new Set(release.artifacts.map((artifact) => artifact.r2.object_key)),
    ].sort(),
  });
  sortLock(next);
  assertLockSemantics(next, config);
  assertLockExtendsBaseline(next, baseline);
  const catalogPlan = await buildLibraryCatalogPlan(
    new Map([[microsoftLibraryVendor.lockFile, next]]),
  );
  const prunePlan = microsoftPrunePlan(
    next,
    release.package_id,
    release.package_version,
    catalogPlan.activeTransportObjectKeys,
  );
  console.log(
    formatLifecyclePlan(options.write ? "withdraw" : "dry_run", {
      release: {
        package_id: release.package_id,
        package_version: release.package_version,
        reason,
      },
      evidence: options.evidence ?? null,
      prune_plan: prunePlan,
    }),
  );
  if (!options.write) return;

  await writeJsonFilesBatchWithRollback([
    { file: lockFile, body: jsonDocument(next) },
    ...catalogPlan.outputs.map(({ file, body }) => ({ file, body })),
  ]);
  console.log(
    "Withdrawal and all v1 snapshots were replaced as one rollback-protected batch.",
  );
}

function printHelp() {
  console.error(MICROSOFT_WITHDRAWAL_HELP);
}

runCliMain({ parse: parseMicrosoftWithdrawalArgs, help: printHelp, main });
