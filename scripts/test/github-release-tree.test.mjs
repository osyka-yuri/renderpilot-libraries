import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertGitHubReleaseTreeLock,
  assertGitHubReleaseTreeLockExtendsBaseline,
  assertLockedReleaseIdentities,
  buildGitHubReleaseTreeVendorSource,
  fetchCommitTree,
  gitBlobSha1,
  listStableGitHubReleases,
  parseRemoteTagIdentities,
} from "../lib/github-release-tree.mjs";
import { githubReleaseTreeProfile } from "../lib/github-release-tree-profiles.mjs";

test("profiles accept reviewed stable tags and fail closed on unknown syntax", () => {
  assert.deepEqual(githubReleaseTreeProfile("amd_fidelityfx").parseTag("v2.3.0"), {
    version: "2.3.0",
    label: null,
  });
  assert.deepEqual(githubReleaseTreeProfile("amd_fidelityfx").parseTag("fsr3-v3.0.4"), {
    version: "3.0.4",
    label: null,
  });
  assert.deepEqual(githubReleaseTreeProfile("intel_xess").parseTag("v3.0.1"), {
    version: "3.0.1",
    label: null,
  });
  assert.deepEqual(githubReleaseTreeProfile("openvr").parseTag("v1.1.3b"), {
    version: "1.1.3",
    label: "revision b",
  });
  assert.throws(() => githubReleaseTreeProfile("openvr").parseTag("v9.9.9b"), /unreviewed/);
  assert.throws(
    () => githubReleaseTreeProfile("intel_xess").parseTag("release-latest"),
    /unsupported stable/,
  );
});

test("stable discovery is paginated, repository-bound, and records tag refs", async () => {
  const config = openVrConfig();
  config.expected_stable_releases = 2;
  const tagIdentities = new Map([
    ["v1.0.0", { tagRefSha: "1".repeat(40), commitSha: "2".repeat(40) }],
    ["v1.0.1", { tagRefSha: "3".repeat(40), commitSha: "3".repeat(40) }],
  ]);
  const pages = new Map([
    [
      "https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100",
      {
        body: [githubRelease(10, "v1.0.0", "2020-01-01T00:00:00Z")],
        link: '<https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100&page=2>; rel="next"',
      },
    ],
    [
      "https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100&page=2",
      {
        body: [githubRelease(11, "v1.0.1", "2020-02-01T00:00:00Z")],
        link: null,
      },
    ],
  ]);
  const releases = await listStableGitHubReleases(config, {
    tagIdentities,
    fetchFn: async (url) => {
      const page = pages.get(url);
      assert.ok(page, url);
      return {
        ok: true,
        headers: new Headers(page.link ? { link: page.link } : {}),
        async json() {
          return page.body;
        },
      };
    },
  });
  assert.deepEqual(
    releases.map(({ tag, tagRefSha, commitSha }) => ({
      tag,
      tagRefSha,
      commitSha,
    })),
    [
      { tag: "v1.0.0", tagRefSha: "1".repeat(40), commitSha: "2".repeat(40) },
      { tag: "v1.0.1", tagRefSha: "3".repeat(40), commitSha: "3".repeat(40) },
    ],
  );
});

test("stable discovery rejects pagination ports and duplicate control parameters", async () => {
  const config = openVrConfig();
  const tagIdentities = new Map([
    ["v1.0.0", { tagRefSha: "1".repeat(40), commitSha: "2".repeat(40) }],
  ]);
  for (const link of [
    '<https://api.github.com:444/repos/ValveSoftware/openvr/releases?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/ValveSoftware/openvr/releases?per_page=100&per_page=100&page=2>; rel="next"',
  ]) {
    await assert.rejects(
      listStableGitHubReleases(config, {
        tagIdentities,
        fetchFn: async () => ({
          ok: true,
          headers: new Headers({ link }),
          async json() {
            return [githubRelease(10, "v1.0.0", "2020-01-01T00:00:00Z")];
          },
        }),
      }),
      /untrusted GitHub releases pagination URL/,
    );
  }
});

test("annotated and lightweight Git tags preserve both ref and commit identity", () => {
  const identities = parseRemoteTagIdentities(
    [
      `${"a".repeat(40)}\trefs/tags/v1.0.0`,
      `${"b".repeat(40)}\trefs/tags/v1.0.0^{}`,
      `${"c".repeat(40)}\trefs/tags/v1.0.1`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(identities.get("v1.0.0"), {
    tagRefSha: "a".repeat(40),
    commitSha: "b".repeat(40),
  });
  assert.deepEqual(identities.get("v1.0.1"), {
    tagRefSha: "c".repeat(40),
    commitSha: "c".repeat(40),
  });
});

test("Git blob identity includes the canonical object header", () => {
  assert.equal(
    gitBlobSha1(Buffer.from("test\n")),
    "9daeafb9864cf43055ae93beb0afd6c7d144bfa4",
  );
});

test("commit-tree discovery fails closed on truncated or duplicate trees", async () => {
  const config = openVrConfig();
  await assert.rejects(
    fetchCommitTree(config, "a".repeat(40), {
      fetchFn: async () => ({
        ok: true,
        async json() {
          return { truncated: true, tree: [] };
        },
      }),
    }),
    /truncated commit tree/,
  );
  await assert.rejects(
    fetchCommitTree(config, "a".repeat(40), {
      fetchFn: async () => ({
        ok: true,
        async json() {
          return {
            truncated: false,
            tree: [
              { type: "blob", path: "LICENSE", sha: "1".repeat(40) },
              { type: "blob", path: "LICENSE", sha: "2".repeat(40) },
            ],
          };
        },
      }),
    }),
    /invalid or duplicate Git tree blob/,
  );
});

test("OpenVR keeps release packages while deduplicating repeated physical DLLs", () => {
  const config = openVrConfig();
  const first = openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z");
  const second = openVrRelease("v1.0.1", "1.0.1", 2, "2020-02-01T00:00:00.000Z");
  second.artifacts = structuredClone(first.artifacts);
  second.legal_documents = structuredClone(first.legal_documents);
  const lock = { schema_version: 1, profile: "openvr", releases: [first, second] };
  const source = buildGitHubReleaseTreeVendorSource(lock, config);
  assert.equal(source.artifacts.length, 2);
  assert.equal(source.packages.length, 4);
  assert.equal(source.legal_documents.length, 1);
  assert.equal(
    source.packages.every((value) => value.legal_document_ids.length === 1),
    true,
  );
});

test("signature policy checks signer allowlists and the inclusive unsigned cutoff", () => {
  const config = openVrConfig();
  const historical = openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z");
  for (const artifact of historical.artifacts) artifact.signature = { status: "unsigned" };
  assert.doesNotThrow(() =>
    assertGitHubReleaseTreeLock(
      { schema_version: 1, profile: "openvr", releases: [historical] },
      config,
    ),
  );

  const cutoff = structuredClone(historical);
  cutoff.published_at = config.require_valid_signature_at_or_after;
  assert.throws(
    () =>
      assertGitHubReleaseTreeLock(
        { schema_version: 1, profile: "openvr", releases: [cutoff] },
        config,
      ),
    /signature policy/,
  );

  const untrusted = openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z");
  untrusted.artifacts[0].signature.subject = "CN=Untrusted";
  assert.throws(
    () =>
      assertGitHubReleaseTreeLock(
        { schema_version: 1, profile: "openvr", releases: [untrusted] },
        config,
      ),
    /signed Authenticode metadata is invalid/,
  );
});

test("profile identity pins the reviewed upstream repository", () => {
  const config = openVrConfig();
  config.repository = "example/openvr";
  assert.throws(
    () =>
      assertGitHubReleaseTreeLock(
        {
          schema_version: 1,
          profile: "openvr",
          releases: [],
        },
        config,
      ),
    /config is invalid/,
  );
});

test("one immutable object key cannot describe inconsistent asset metadata", () => {
  const release = openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z");
  release.artifacts[1].r2 = structuredClone(release.artifacts[0].r2);
  assert.throws(
    () =>
      assertGitHubReleaseTreeLock(
        { schema_version: 1, profile: "openvr", releases: [release] },
        openVrConfig(),
      ),
    /shared asset object has inconsistent metadata/,
  );
});

test("immutable baseline permits transport-only changes and detects retagging", () => {
  const baseline = {
    schema_version: 1,
    profile: "openvr",
    releases: [openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z")],
  };
  const recompressed = structuredClone(baseline);
  recompressed.releases[0].artifacts[0].r2 = r2("f");
  assert.doesNotThrow(() =>
    assertGitHubReleaseTreeLockExtendsBaseline(recompressed, baseline),
  );

  const changed = structuredClone(baseline);
  changed.releases[0].artifacts[0].dll_sha256 = "f".repeat(64);
  assert.throws(
    () => assertGitHubReleaseTreeLockExtendsBaseline(changed, baseline),
    /immutable GitHub release content changed/,
  );

  const upstream = [
    {
      releaseId: 1,
      tag: "v1.0.0",
      version: "1.0.0",
      label: null,
      publishedAt: "2020-01-01T00:00:00.000Z",
      tagRefSha: "9".repeat(40),
      commitSha: "b".repeat(40),
    },
  ];
  assert.throws(
    () => assertLockedReleaseIdentities(baseline, upstream),
    /immutable GitHub release identity changed/,
  );
});

test("append-only comparison rejects a baseline from another lock contract", () => {
  const current = { schema_version: 1, profile: "openvr", releases: [] };
  const predecessor = structuredClone(current);
  delete predecessor.profile;
  assert.throws(
    () => assertGitHubReleaseTreeLockExtendsBaseline(current, predecessor),
    /different contract/,
  );
});

test("signature backfill permits only null to verified timestamp enrichment", () => {
  const baseline = {
    schema_version: 1,
    profile: "openvr",
    releases: [openVrRelease("v1.0.0", "1.0.0", 1, "2020-01-01T00:00:00.000Z")],
  };
  baseline.releases[0].artifacts[0].signature.signed_at = null;
  const enriched = structuredClone(baseline);
  enriched.releases[0].artifacts[0].signature.signed_at = "2019-12-01T00:00:00.000Z";
  assert.doesNotThrow(() =>
    assertGitHubReleaseTreeLockExtendsBaseline(enriched, baseline, {
      allowSignatureTimestampBackfill: true,
    }),
  );
  assert.throws(
    () => assertGitHubReleaseTreeLockExtendsBaseline(enriched, baseline),
    /immutable GitHub release content changed/,
  );

  const changed = structuredClone(enriched);
  changed.releases[0].artifacts[1].signature.signed_at = "2019-12-02T00:00:00.000Z";
  assert.throws(
    () =>
      assertGitHubReleaseTreeLockExtendsBaseline(changed, baseline, {
        allowSignatureTimestampBackfill: true,
      }),
    /immutable GitHub release content changed/,
  );
});

test("committed GitHub locks preserve audited release and projection cardinalities", async () => {
  const expectations = [
    {
      prefix: "amd-fidelityfx",
      overlay: "amd.overlays.json",
      releases: 13,
      imported: 10,
      excluded: 3,
      artifacts: 34,
      packages: 38,
      newestDuplicateProvenance: true,
      contentAddressedPackageIds: true,
    },
    {
      prefix: "intel-xess",
      overlay: "intel.overlays.json",
      releases: 11,
      imported: 11,
      excluded: 0,
      artifacts: 33,
      packages: 33,
      newestDuplicateProvenance: true,
      contentAddressedPackageIds: true,
    },
    {
      prefix: "valve-openvr",
      overlay: null,
      releases: 61,
      imported: 61,
      excluded: 0,
      artifacts: 118,
      packages: 122,
      newestDuplicateProvenance: false,
      contentAddressedPackageIds: false,
    },
  ];
  for (const expected of expectations) {
    const [config, lock, overlay] = await Promise.all([
      repositoryJson(`catalogs/libraries/${expected.prefix}.config.json`),
      repositoryJson(`catalogs/libraries/${expected.prefix}.lock.json`),
      expected.overlay
        ? repositoryJson(`catalogs/libraries/${expected.overlay}`)
        : Promise.resolve(null),
    ]);
    assertGitHubReleaseTreeLock(lock, config);
    const source = buildGitHubReleaseTreeVendorSource(lock, config, overlay);
    assert.equal(lock.releases.length, expected.releases);
    assert.equal(
      lock.releases.filter((release) => release.disposition === "imported").length,
      expected.imported,
    );
    assert.equal(
      lock.releases.filter((release) => release.disposition === "excluded").length,
      expected.excluded,
    );
    assert.equal(source.artifacts.length, expected.artifacts);
    assert.equal(source.packages.length, expected.packages);
    if (expected.newestDuplicateProvenance) {
      assertNewestDuplicateProvenance(source, lock);
    }
    if (expected.contentAddressedPackageIds) {
      assertContentAddressedPackageIds(source);
    }
  }
});

test("scheduled GitHub refresh produces one registry-wide catalog update and PR", async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(
      new URL("../../.github/workflows/github-release-tree-refresh.yml", import.meta.url),
      "utf8",
    ),
    repositoryJson("package.json"),
  ]);
  assert.doesNotMatch(workflow, /\bmatrix:/u);
  assert.match(workflow, /pnpm run refresh:github:check/u);
  assert.match(workflow, /pnpm run refresh:github:write/u);
  assert.doesNotMatch(workflow, /refresh-github-release-tree\.mjs/u);
  assert.equal(
    packageJson.scripts["refresh:github:check"],
    "node scripts/libraries.mjs refresh github --check",
  );
  assert.equal(
    packageJson.scripts["refresh:github:write"],
    "node scripts/libraries.mjs refresh github --write",
  );
  assert.equal(
    packageJson.scripts["materialize:github"],
    "node scripts/libraries.mjs refresh github --materialize-locked",
  );
  assert.equal(
    packageJson.scripts["backfill:github-signatures"],
    "node scripts/libraries.mjs refresh github --backfill-signatures",
  );
  assert.equal((workflow.match(/peter-evans\/create-pull-request/gu) ?? []).length, 1);
});

function assertContentAddressedPackageIds(source) {
  const artifactByKey = new Map(
    source.artifacts.map((artifact) => [artifact.artifact_key, artifact]),
  );
  for (const packageValue of source.packages) {
    if (packageValue.provenance?.kind !== "github_release") continue;
    const contentIdentity = packageValue.members
      .map((member) => {
        const artifact = artifactByKey.get(member.artifact_key);
        assert.ok(artifact, packageValue.package_id);
        return `${member.install_as.toLowerCase()}\0${artifact.dll.sha256}`;
      })
      .sort()
      .join("\n");
    const digest = createHash("sha256").update(contentIdentity, "utf8").digest("hex");
    assert.ok(
      packageValue.package_id.endsWith(`.${digest}`),
      `${packageValue.package_id} must bind the complete install-unit content`,
    );
  }
}

function assertNewestDuplicateProvenance(source, lock) {
  const artifactByKey = new Map(
    source.artifacts.map((artifact) => [artifact.artifact_key, artifact]),
  );
  for (const packageValue of source.packages) {
    if (
      packageValue.provenance?.kind !== "github_release" ||
      packageValue.members.length !== 1
    ) {
      continue;
    }
    const artifact = artifactByKey.get(packageValue.members[0].artifact_key);
    assert.ok(artifact, packageValue.package_id);
    const matchingReleases = lock.releases.filter((release) =>
      (release.artifacts ?? []).some(
        (locked) =>
          locked.component === artifact.library_id &&
          locked.dll_sha256 === artifact.dll.sha256,
      ),
    );
    assert.ok(matchingReleases.length > 0, packageValue.package_id);
    assert.equal(
      packageValue.provenance.tag,
      matchingReleases.at(-1).tag,
      `${packageValue.package_id} should keep newest identical-payload provenance`,
    );
  }
}

function openVrConfig() {
  return {
    schema_version: 1,
    profile: "openvr",
    repository: "ValveSoftware/openvr",
    expected_stable_releases: 1,
    trusted_signer_subjects: ["CN=Valve"],
    require_valid_signature_at_or_after: "2025-01-01T00:00:00.000Z",
  };
}

function openVrRelease(tag, version, releaseId, publishedAt) {
  return {
    release_id: releaseId,
    tag,
    version,
    label: null,
    published_at: publishedAt,
    tag_ref_sha: "a".repeat(40),
    commit_sha: "b".repeat(40),
    disposition: "imported",
    artifacts: [
      openVrArtifact("X86", "bin/win32/openvr_api.dll", "e", "f"),
      openVrArtifact("X64", "bin/win64/openvr_api.dll", "c", "d"),
    ],
    legal_documents: [
      {
        kind: "license",
        title: "OpenVR SDK License",
        format: "text",
        file_name: "LICENSE.txt",
        repository_path: "LICENSE",
        git_blob_sha1: "1".repeat(40),
        sha256: "2".repeat(64),
        size_bytes: 100,
        object_key: `libraries/legal/sha256/${"2".repeat(64)}.txt`,
      },
    ],
  };
}

function openVrArtifact(architecture, repositoryPath, dllSeed, transportSeed) {
  return {
    component: "openvr_api",
    architecture,
    repository_path: repositoryPath,
    git_blob_sha1: dllSeed.repeat(40),
    pe_version: "1.1.1",
    pe_named_exports: ["VR_GetGenericInterface", "VR_InitInternal"],
    dll_sha256: dllSeed.repeat(64),
    dll_size_bytes: 100,
    signature: {
      status: "signed",
      subject: "CN=Valve",
      thumbprint: "A".repeat(40),
      signed_at: "2020-01-01T00:00:00.000Z",
    },
    r2: r2(transportSeed),
  };
}

function r2(seed) {
  return {
    object_key: `libraries/blobs/sha256/${seed.repeat(64)}.dll.zst`,
    zst_sha256: seed.repeat(64),
    zst_size_bytes: 50,
    compression_level: 12,
  };
}

function githubRelease(id, tag_name, published_at) {
  return { id, tag_name, published_at, draft: false, prerelease: false };
}

async function repositoryJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  );
}
