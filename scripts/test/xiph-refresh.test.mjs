import assert from "node:assert/strict";
import test from "node:test";

import {
  desiredXiphStablePairs,
  parseXiphPendingLimit,
  pendingXiphPairs,
  withXiphPairAdditions,
} from "../lib/xiph-refresh.mjs";

test("Xiph refresh planning covers histories without a Cartesian product", () => {
  const vorbis = new Map(["1.0", "1.3.7", "1.4.0"].map((version) => [version, {}]));
  const ogg = new Map(["1.0", "1.3.6", "1.4.0"].map((version) => [version, {}]));
  const pairs = desiredXiphStablePairs(vorbis, ogg);
  assert.ok(
    pairs.some(
      ([vorbisVersion, oggVersion]) => vorbisVersion === "1.0" && oggVersion === "1.0",
    ),
  );
  assert.ok(
    pairs.some(
      ([vorbisVersion, oggVersion]) => vorbisVersion === "1.4.0" && oggVersion === "1.4.0",
    ),
  );
  assert.ok(pairs.length < vorbis.size * ogg.size);
});

test("Xiph refresh additions are pure and validated before persistence", () => {
  const source = {
    repository: "xiph/ogg",
    tag: null,
    tag_object_sha: null,
    commit_sha: null,
    archive_url: "https://downloads.xiph.org/releases/ogg/libogg-1.0.tar.gz",
    archive_sha256: "1".repeat(64),
  };
  const lock = {
    schema_version: 1,
    pairs: [
      {
        vorbis_version: "1.0",
        ogg_version: "1.0",
        build_revision: 1,
        sources: {
          ogg: source,
          vorbis: {
            ...source,
            repository: "xiph/vorbis",
            tag: "v1.0.0",
            tag_object_sha: "2".repeat(40),
            commit_sha: "3".repeat(40),
            archive_url: "https://downloads.xiph.org/releases/vorbis/libvorbis-1.0.tar.gz",
          },
        },
        builds: [],
      },
    ],
  };
  const original = structuredClone(lock);
  const planned = withXiphPairAdditions(lock, []);
  assert.deepEqual(lock, original);
  assert.notEqual(planned, lock);
  assert.deepEqual(
    pendingXiphPairs(planned).map((pair) => pair.vorbis_version),
    ["1.0"],
  );
  assert.equal(parseXiphPendingLimit("1", 16), 1);
  assert.throws(() => parseXiphPendingLimit("0", 16), /1 through 32/u);
});
