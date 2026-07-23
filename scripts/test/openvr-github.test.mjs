import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "../catalog.mjs";
import {
  assertOpenVrLockBackfillsTimestamps,
  assertOpenVrLockExtendsBaseline,
  assertOpenVrLockSemantics,
  buildOpenVrVendorSource,
  gitBlobSha1,
  listedStableOpenVrReleases,
  parseOpenVrTag,
  parseRemoteTagCommits,
} from "../lib/openvr-github.mjs";

const config = {
  schema_version: 1,
  repository: "ValveSoftware/openvr",
  expected_stable_releases: 1,
  require_signed_release_at_or_after: "2026-07-23T00:00:00.000Z",
  architectures: [
    {
      catalog_architecture: "X64",
      repository_path: "bin/win64/openvr_api.dll",
    },
    {
      catalog_architecture: "X86",
      repository_path: "bin/win32/openvr_api.dll",
    },
  ],
};

test("OpenVR tags preserve exact upstream spelling and reviewed revision labels", () => {
  assert.deepEqual(parseOpenVrTag("0.9.3"), { version: "0.9.3", label: null });
  assert.deepEqual(parseOpenVrTag("v1.1.3b"), {
    version: "1.1.3",
    label: "revision b",
  });
  assert.throws(() => parseOpenVrTag("v3.0.0b"), /unreviewed/);
  assert.throws(() => parseOpenVrTag("v3"), /unsupported/);
  assert.throws(() => parseOpenVrTag("release-3"), /unsupported/);
});

test("stable release discovery follows pagination and keeps exact release identities", async () => {
  const firstUrl =
    "https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100";
  const secondUrl =
    "https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100&page=2";
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    if (url === firstUrl) {
      return Response.json(
        [
          githubRelease(1, "v1.0.0", "2020-01-01T00:00:00.000Z"),
          {
            ...githubRelease(99, "v99.0.0", "2020-01-01T00:00:00.000Z"),
            prerelease: true,
          },
        ],
        { headers: { link: `<${secondUrl}>; rel="next"` } },
      );
    }
    assert.equal(url, secondUrl);
    return Response.json([githubRelease(2, "v1.1.0", "2020-02-01T00:00:00.000Z")]);
  };
  const releases = await listedStableOpenVrReleases(
    { ...config, expected_stable_releases: 2 },
    {
      fetchFn,
      tagCommits: new Map([
        ["v1.0.0", "a".repeat(40)],
        ["v1.1.0", "b".repeat(40)],
      ]),
    },
  );

  assert.deepEqual(requested, [firstUrl, secondUrl]);
  assert.deepEqual(
    releases.map(({ releaseId, tag, commitSha }) => ({ releaseId, tag, commitSha })),
    [
      { releaseId: 1, tag: "v1.0.0", commitSha: "a".repeat(40) },
      { releaseId: 2, tag: "v1.1.0", commitSha: "b".repeat(40) },
    ],
  );
});

test("stable release pagination refuses token-bearing requests to untrusted URLs", async () => {
  const fetchFn = async () =>
    Response.json([githubRelease(1, "v1.0.0", "2020-01-01T00:00:00.000Z")], {
      headers: {
        link: '<https://example.com/steal-token?page=2&per_page=100>; rel="next"',
      },
    });

  await assert.rejects(
    listedStableOpenVrReleases(config, {
      fetchFn,
      tagCommits: new Map([["v1.0.0", "a".repeat(40)]]),
    }),
    /untrusted GitHub releases pagination URL/,
  );
});

test("annotated Git tags resolve to their peeled commit", () => {
  const commits = parseRemoteTagCommits(
    [
      `${"a".repeat(40)}\trefs/tags/v1.0.0`,
      `${"b".repeat(40)}\trefs/tags/v1.0.0^{}`,
      `${"c".repeat(40)}\trefs/tags/v2.0.0`,
      "",
    ].join("\n"),
  );
  assert.equal(commits.get("v1.0.0"), "b".repeat(40));
  assert.equal(commits.get("v2.0.0"), "c".repeat(40));
});

test("Git blob identity includes the canonical header", () => {
  assert.equal(
    gitBlobSha1(Buffer.from("test\n")),
    "9daeafb9864cf43055ae93beb0afd6c7d144bfa4",
  );
});

test("OpenVR source keeps packages but deduplicates physical DLLs", () => {
  const lock = {
    schema_version: 1,
    releases: [release("v1.0.0", "1.0.0"), release("v1.0.1", "1.0.1")],
  };
  lock.releases[1].release_id = 2;
  lock.releases[1].published_at = "2020-01-02T00:00:00.000Z";
  lock.releases[1].commit_sha = "d".repeat(40);
  const source = buildOpenVrVendorSource(lock, config);
  assert.equal(source.artifacts.length, 2);
  assert.equal(source.packages.length, 4);
  assert.equal(source.artifacts[0].file_version, null);
  assert.deepEqual(source, buildOpenVrVendorSource(structuredClone(lock), config));
});

test("OpenVR source projection validates the complete lock first", () => {
  const lock = {
    schema_version: 1,
    releases: [release("v1.0.0", "1.0.0"), release("v1.0.1", "1.0.1")],
  };
  lock.releases[1].release_id = 2;
  lock.releases[1].published_at = "2020-01-02T00:00:00.000Z";
  lock.releases[1].commit_sha = "d".repeat(40);
  lock.releases[1].artifacts[1].r2.object_key = "libraries/blobs/sha256/bad.dll.zst";

  assert.throws(() => buildOpenVrVendorSource(lock, config), /R2 transport/);
});

test("OpenVR lock allows historical unsigned binaries and rejects future ones", () => {
  const historical = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  assert.doesNotThrow(() => assertOpenVrLockSemantics(historical, config));

  const future = structuredClone(historical);
  future.releases[0].published_at = "2026-07-23T00:00:00.000Z";
  assert.throws(
    () => assertOpenVrLockSemantics(future, config),
    /unsigned release violates/,
  );

  const invalid = structuredClone(historical);
  invalid.releases[0].artifacts[0].signature = { status: "invalid" };
  assert.throws(() => assertOpenVrLockSemantics(invalid, config), /status is invalid/);
});

test("OpenVR named exports are strict, sorted, unique, and bounded", () => {
  const malformed = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  malformed.releases[0].artifacts[0].pe_named_exports = ["B", "A"];
  assert.throws(() => assertOpenVrLockSemantics(malformed, config), /sorted and unique/);

  const duplicate = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  duplicate.releases[0].artifacts[0].pe_named_exports = ["A", "A"];
  assert.throws(() => assertOpenVrLockSemantics(duplicate, config), /duplicate/);

  const maximum = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  maximum.releases[0].artifacts[0].pe_named_exports = ["A".repeat(256)];
  assert.doesNotThrow(() => assertOpenVrLockSemantics(maximum, config));

  const tooLong = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  tooLong.releases[0].artifacts[0].pe_named_exports = ["A".repeat(257)];
  assert.throws(() => assertOpenVrLockSemantics(tooLong, config), /ASCII/);
});

test("OpenVR immutable baseline permits transport replacement only", () => {
  const baseline = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  const next = structuredClone(baseline);
  next.releases[0].artifacts[0].r2 = transport("e");
  assert.doesNotThrow(() => assertOpenVrLockExtendsBaseline(next, baseline));
  next.releases[0].artifacts[0].dll_sha256 = "f".repeat(64);
  assert.throws(() => assertOpenVrLockExtendsBaseline(next, baseline), /content changed/);
});

test("OpenVR timestamp backfill permits only null to verified signed_at", () => {
  const baseline = { schema_version: 1, releases: [release("v1.0.0", "1.0.0")] };
  for (const artifactValue of baseline.releases[0].artifacts) {
    artifactValue.signature = {
      status: "signed",
      subject: "CN=Valve Corp.",
      thumbprint: "A".repeat(40),
      signed_at: null,
    };
  }

  const next = structuredClone(baseline);
  next.releases[0].artifacts[0].signature.signed_at = "2020-01-01T00:00:00.000Z";
  assert.equal(assertOpenVrLockBackfillsTimestamps(next, baseline), 1);

  const changedHash = structuredClone(next);
  changedHash.releases[0].artifacts[0].dll_sha256 = "f".repeat(64);
  assert.throws(
    () => assertOpenVrLockBackfillsTimestamps(changedHash, baseline),
    /other than null signed_at/,
  );

  const changedIdentity = structuredClone(baseline);
  changedIdentity.releases[0].artifacts[0].signature.thumbprint = "B".repeat(40);
  assert.throws(
    () => assertOpenVrLockBackfillsTimestamps(changedIdentity, baseline),
    /other than null signed_at/,
  );
});

test("committed OpenVR lock and source retain frozen cardinalities", async () => {
  const [actualConfig, lock] = await Promise.all([
    readFile(
      path.join(repoRoot, "catalogs/libraries/valve-openvr.config.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(path.join(repoRoot, "catalogs/libraries/valve-openvr.lock.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const source = buildOpenVrVendorSource(lock, actualConfig);
  const artifacts = lock.releases.flatMap((releaseValue) => releaseValue.artifacts);
  const signed = artifacts.filter(
    (artifactValue) => artifactValue.signature.status === "signed",
  );
  const unsigned = artifacts.filter(
    (artifactValue) => artifactValue.signature.status === "unsigned",
  );

  assert.equal(lock.releases.length, 61);
  assert.equal(artifacts.length, 122);
  assert.equal(signed.length, 88);
  assert.equal(unsigned.length, 34);
  assert.equal(
    signed.every((artifactValue) => typeof artifactValue.signature.signed_at === "string"),
    true,
  );
  assert.equal(
    new Set(artifacts.map((artifactValue) => artifactValue.dll_sha256)).size,
    118,
  );
  assert.equal(source.artifacts.length, 118);
  assert.equal(source.packages.length, 122);
});

function release(tag, version) {
  return {
    release_id: 1,
    tag,
    version,
    label: null,
    published_at: "2020-01-01T00:00:00.000Z",
    commit_sha: "a".repeat(40),
    artifacts: [
      artifact("X64", "bin/win64/openvr_api.dll", "b"),
      artifact("X86", "bin/win32/openvr_api.dll", "c"),
    ],
  };
}

function artifact(architecture, repositoryPath, hash) {
  return {
    architecture,
    repository_path: repositoryPath,
    git_blob_sha1: hash.repeat(40),
    pe_version: null,
    pe_named_exports: ["VR_InitInternal"],
    dll_sha256: hash.repeat(64),
    dll_size_bytes: 10,
    signature: { status: "unsigned" },
    r2: transport(hash),
  };
}

function transport(hash) {
  return {
    object_key: `libraries/blobs/sha256/${hash.repeat(64)}.dll.zst`,
    zst_sha256: hash.repeat(64),
    zst_size_bytes: 8,
    compression_level: 12,
  };
}

function githubRelease(id, tagName, publishedAt) {
  return {
    id,
    tag_name: tagName,
    published_at: publishedAt,
    draft: false,
    prerelease: false,
  };
}
