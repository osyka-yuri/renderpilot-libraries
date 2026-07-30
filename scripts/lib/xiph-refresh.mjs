import { assertXiphLock } from "./xiph-lock.mjs";

// One reviewed historical tuple per stable release step. This covers every
// known release without producing a Cartesian product.
export const REVIEWED_XIPH_HISTORICAL_PAIRS = Object.freeze([
  ["1.3.7", "1.3.6"],
  ["1.3.6", "1.3.5"],
  ["1.3.5", "1.3.4"],
  ["1.3.4", "1.3.3"],
  ["1.3.3", "1.3.2"],
  ["1.3.2", "1.3.1"],
  ["1.3.1", "1.3.0"],
  ["1.2.3", "1.2.2"],
  ["1.2.2", "1.2.1"],
  ["1.2.0", "1.2.0"],
  ["1.1.2", "1.1.4"],
  ["1.1.1", "1.1.3"],
  ["1.1.0", "1.1.2"],
  ["1.0.1", "1.1.1"],
  ["1.0", "1.1"],
  ["1.0", "1.0"],
]);

export function desiredXiphStablePairs(vorbisReleases, oggReleases) {
  const pairs = REVIEWED_XIPH_HISTORICAL_PAIRS.filter(
    ([vorbis, ogg]) => vorbisReleases.has(vorbis) && oggReleases.has(ogg),
  );
  const coveredVorbis = new Set(pairs.map(([version]) => version));
  const coveredOgg = new Set(pairs.map(([, version]) => version));
  const latestVorbis = [...vorbisReleases.keys()].sort(compareDottedVersions).at(-1);
  const latestOgg = [...oggReleases.keys()].sort(compareDottedVersions).at(-1);
  if (latestVorbis === undefined || latestOgg === undefined) {
    throw new Error("Xiph release discovery returned an empty component history");
  }

  for (const version of [...vorbisReleases.keys()].sort(compareDottedVersions)) {
    if (!coveredVorbis.has(version)) pairs.unshift([version, latestOgg]);
  }
  for (const version of [...oggReleases.keys()].sort(compareDottedVersions)) {
    if (!coveredOgg.has(version)) pairs.unshift([latestVorbis, version]);
  }
  return deduplicatePairs(pairs);
}

export function withXiphPairAdditions(lock, additions) {
  const planned = structuredClone(lock);
  planned.pairs.push(...structuredClone(additions));
  return assertXiphLock(planned);
}

export function planExceptionalXiphRebuild(lock, requested) {
  const planned = structuredClone(lock);
  const pair = selectXiphPair(planned, requested);
  if (!pair.builds.some((build) => build.build_revision === pair.build_revision)) {
    throw new Error(`cannot rebuild unmaterialized Xiph pair ${xiphPairKey(pair)}`);
  }
  pair.build_revision += 1;
  assertXiphLock(planned);
  return { lock: planned, pair };
}

export function pendingXiphPairs(lock) {
  return lock.pairs.filter(
    (pair) => !pair.builds.some((build) => build.build_revision === pair.build_revision),
  );
}

export function selectXiphPair(lock, requested) {
  if (!requested) {
    throw new Error("exceptional rebuild requires an explicit --pair=vorbis|ogg");
  }
  const pair = lock.pairs.find((candidate) => xiphPairKey(candidate) === requested);
  if (!pair) throw new Error(`unknown Xiph pair ${requested}`);
  return pair;
}

export function xiphPairKey(pair) {
  return `${pair.vorbis_version}|${pair.ogg_version}`;
}

export function parseXiphPendingLimit(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("pending-limit must be an integer from 1 through 32");
  }
  return value;
}

export function compareDottedVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function deduplicatePairs(pairs) {
  const seen = new Set();
  return pairs.filter(([vorbis, ogg]) => {
    const key = `${vorbis}|${ogg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
