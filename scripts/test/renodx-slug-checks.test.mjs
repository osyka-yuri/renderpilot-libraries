import assert from "node:assert/strict";
import test from "node:test";

import {
  ADDON_EXTENSION_BY_ARCH,
  MAX_ISSUES_TO_PRINT,
  OFF_SNAPSHOT_TITLE_KINDS,
  addonBasenameFromUrl,
  addonFile,
  assertGeneric,
  assertManifestShape,
  assertTitle,
  checkExplicitAddonNames,
  checkExplicitGenericAddonNames,
  checkExplicitTitleAddonNames,
  checkGenerics,
  checkTitles,
  expectedGenericAddon,
  expectedTitleAddon,
  genericLabel,
  isOffSnapshotTitle,
  isSnapshotHostedGeneric,
  sameFileName,
  titleLabel,
} from "../lib/renodx-slug-checks.mjs";

test("ADDON_EXTENSION_BY_ARCH maps X64 and X86", () => {
  assert.equal(ADDON_EXTENSION_BY_ARCH.get("X64"), "addon64");
  assert.equal(ADDON_EXTENSION_BY_ARCH.get("X86"), "addon32");
});

test("OFF_SNAPSHOT_TITLE_KINDS covers external, native_hdr, blacklist", () => {
  assert.ok(OFF_SNAPSHOT_TITLE_KINDS.has("external"));
  assert.ok(OFF_SNAPSHOT_TITLE_KINDS.has("native_hdr"));
  assert.ok(OFF_SNAPSHOT_TITLE_KINDS.has("blacklist"));
  assert.ok(!OFF_SNAPSHOT_TITLE_KINDS.has("installable"));
});

test("MAX_ISSUES_TO_PRINT is a positive integer", () => {
  assert.equal(Number.isInteger(MAX_ISSUES_TO_PRINT), true);
  assert.ok(MAX_ISSUES_TO_PRINT > 0);
});

test("addonFile builds renodx-<slug>.addon<arch>", () => {
  assert.equal(addonFile("cp2077", "X64"), "renodx-cp2077.addon64");
  assert.equal(addonFile("ryza", "X86"), "renodx-ryza.addon32");
});

test("addonFile throws on unsupported architecture", () => {
  assert.throws(() => addonFile("cp2077", "ARM"), /Unsupported RenoDX architecture/);
});

test("addonBasenameFromUrl extracts the trailing file name", () => {
  assert.equal(
    addonBasenameFromUrl("https://example.com/path/renodx-cp2077.addon64", "u"),
    "renodx-cp2077.addon64",
  );
});

test("addonBasenameFromUrl strips the query string", () => {
  assert.equal(
    addonBasenameFromUrl("https://example.com/p/renodx-x.addon32?v=2", "u"),
    "renodx-x.addon32",
  );
});

test("addonBasenameFromUrl throws on an invalid URL", () => {
  assert.throws(() => addonBasenameFromUrl("not-a-url", "u"), /must be a valid URL/);
});

test("addonBasenameFromUrl throws on a URL without a file name", () => {
  assert.throws(
    () => addonBasenameFromUrl("https://example.com/", "u"),
    /must end with an add-on file name/,
  );
});

test("addonBasenameFromUrl throws on a non-string", () => {
  assert.throws(() => addonBasenameFromUrl(undefined, "u"), /must be a non-empty string/);
  assert.throws(() => addonBasenameFromUrl("  ", "u"), /must be a non-empty string/);
});

test("sameFileName is case-insensitive", () => {
  assert.equal(sameFileName("Renodx-CP2077.Addon64", "renodx-cp2077.addon64"), true);
  assert.equal(sameFileName("a.addon64", "b.addon64"), false);
});

test("expectedTitleAddon combines slug and arch", () => {
  const title = { id: "cp2077", slug: "cp2077", arch: "X64" };
  assert.equal(expectedTitleAddon(title, 0), "renodx-cp2077.addon64");
});

test("expectedTitleAddon throws when slug is missing", () => {
  assert.throws(() => expectedTitleAddon({ arch: "X64" }, 0), /titles\[0\]\.slug/);
});

test("expectedTitleAddon throws when arch is missing", () => {
  assert.throws(() => expectedTitleAddon({ id: "x", slug: "x" }, 0), /\.arch/);
});

test("expectedTitleAddon uses title id in the label when present", () => {
  assert.throws(() => expectedTitleAddon({ id: "mygame", arch: "X64" }, 0), /mygame\.slug/);
});

test("expectedGenericAddon builds the X64 add-on name", () => {
  assert.equal(
    expectedGenericAddon({ engine: "unity", slug: "unityengine" }, 0),
    "renodx-unityengine.addon64",
  );
});

test("expectedGenericAddon throws when slug is missing", () => {
  assert.throws(() => expectedGenericAddon({ engine: "unity" }, 0), /generic:unity\.slug/);
});

test("titleLabel prefers title.id, falls back to titles[index]", () => {
  assert.equal(titleLabel({ id: "cp2077" }, 3), "cp2077");
  assert.equal(titleLabel({ id: "  " }, 3), "titles[3]");
  assert.equal(titleLabel({}, 3), "titles[3]");
});

test("genericLabel prefers generic.engine, falls back to generics[index]", () => {
  assert.equal(genericLabel({ engine: "unity" }, 3), "generic:unity");
  assert.equal(genericLabel({ engine: "  " }, 3), "generics[3]");
  assert.equal(genericLabel({}, 3), "generics[3]");
});

test("isOffSnapshotTitle is true for download_url", () => {
  assert.equal(isOffSnapshotTitle({ download_url: "https://x/y.addon64" }), true);
});

test("isOffSnapshotTitle is true for off-snapshot categories", () => {
  for (const kind of ["external", "native_hdr", "blacklist"]) {
    assert.equal(isOffSnapshotTitle({ category: { kind } }), true);
  }
});

test("isOffSnapshotTitle is false for a plain installable title", () => {
  assert.equal(isOffSnapshotTitle({ slug: "x", arch: "X64" }), false);
});

test("isSnapshotHostedGeneric is true for slug-only generics", () => {
  assert.equal(isSnapshotHostedGeneric({ slug: "unrealengine" }), true);
});

test("isSnapshotHostedGeneric is false when explicit urls or download_url are present", () => {
  assert.equal(isSnapshotHostedGeneric({ slug: "x", url64: "https://x" }), false);
  assert.equal(isSnapshotHostedGeneric({ slug: "x", url32: "https://x" }), false);
  assert.equal(isSnapshotHostedGeneric({ slug: "x", download_url: "https://x" }), false);
  assert.equal(isSnapshotHostedGeneric({ engine: "unity" }), false);
});

test("assertManifestShape accepts a well-formed manifest", () => {
  assert.doesNotThrow(() =>
    assertManifestShape({ schema_version: 3, titles: [], generics: [] }),
  );
});

test("assertManifestShape rejects non-objects and missing arrays", () => {
  assert.throws(() => assertManifestShape(null), /JSON object/);
  assert.throws(() => assertManifestShape({ titles: [] }), /`generics` array/);
  assert.throws(() => assertManifestShape({ generics: [] }), /`titles` array/);
  assert.throws(() => assertManifestShape({ titles: "x", generics: [] }), /`titles` array/);
});

test("assertTitle and assertGeneric reject non-records", () => {
  assert.throws(() => assertTitle(null, 0), /titles\[0\]/);
  assert.throws(() => assertGeneric("x", 1), /generics\[1\]/);
  assert.doesNotThrow(() => assertTitle({ id: "x" }, 0));
  assert.doesNotThrow(() => assertGeneric({ engine: "x" }, 0));
});

test("checkTitles reports missing snapshot assets and skips off-snapshot titles", () => {
  const titles = [
    { id: "present", slug: "present", arch: "X64" },
    { id: "absent", slug: "absent", arch: "X64" },
    { id: "external", slug: "external", arch: "X64", category: { kind: "external" } },
    { id: "with-url", slug: "withurl", arch: "X64", download_url: "https://x/y.addon64" },
  ];
  const assets = new Set(["renodx-present.addon64"]);

  const result = checkTitles(titles, assets);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.missing, ["absent (renodx-absent.addon64)"]);
});

test("checkGenerics reports missing snapshot generics and skips explicit-hosted ones", () => {
  const generics = [
    { engine: "unreal", slug: "unrealengine" },
    { engine: "unity", slug: "unityengine", url64: "https://x", url32: "https://y" },
    { engine: "missing", slug: "missingengine" },
  ];
  const assets = new Set(["renodx-unrealengine.addon64"]);

  const result = checkGenerics(generics, assets);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.missing, ["generic:missing (renodx-missingengine.addon64)"]);
});

test("checkExplicitTitleAddonNames detects basename mismatches", () => {
  const titles = [
    {
      id: "good",
      slug: "good",
      arch: "X64",
      download_url: "https://x/renodx-good.addon64",
    },
    {
      id: "bad",
      slug: "bad",
      arch: "X64",
      download_url: "https://x/renodx-wrong.addon64",
    },
    { id: "skipped", slug: "skipped", arch: "X64" },
  ];

  const result = checkExplicitTitleAddonNames(titles);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, [
    "bad: renodx-wrong.addon64 should be renodx-bad.addon64",
  ]);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitTitleAddonNames is case-insensitive on the basename", () => {
  const titles = [
    {
      id: "ok",
      slug: "ok",
      arch: "X64",
      download_url: "https://x/RENODX-OK.ADDON64",
    },
  ];

  const result = checkExplicitTitleAddonNames(titles);

  assert.equal(result.checked, 1);
  assert.deepEqual(result.mismatches, []);
});

test("checkExplicitGenericAddonNames reports a structural error when only one url is set", () => {
  const generics = [{ engine: "unity", slug: "unityengine", url64: "https://x" }];

  const result = checkExplicitGenericAddonNames(generics);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.structural, [
    "generic:unity: url64 and url32 must be provided together",
  ]);
  assert.deepEqual(result.mismatches, []);
});

test("checkExplicitGenericAddonNames skips basename check when slug is absent", () => {
  const generics = [
    {
      engine: "unity",
      url64: "https://x/renodx-unityengine.addon64",
      url32: "https://x/renodx-unityengine.addon32",
    },
  ];

  const result = checkExplicitGenericAddonNames(generics);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitGenericAddonNames skips snapshot-hosted generics without urls", () => {
  const generics = [{ engine: "unreal", slug: "unrealengine" }];

  const result = checkExplicitGenericAddonNames(generics);

  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitGenericAddonNames detects basename mismatches for both arches", () => {
  const generics = [
    {
      engine: "unity",
      slug: "unityengine",
      url64: "https://x/renodx-wrong.addon64",
      url32: "https://x/renodx-wrong.addon32",
    },
  ];

  const result = checkExplicitGenericAddonNames(generics);

  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.mismatches, [
    "generic:unity.url64: renodx-wrong.addon64 should be renodx-unityengine.addon64",
    "generic:unity.url32: renodx-wrong.addon32 should be renodx-unityengine.addon32",
  ]);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitGenericAddonNames accepts matching urls case-insensitively", () => {
  const generics = [
    {
      engine: "unity",
      slug: "unityengine",
      url64: "https://x/RENODX-UNITYENGINE.ADDON64",
      url32: "https://x/renodx-unityengine.addon32",
    },
  ];

  const result = checkExplicitGenericAddonNames(generics);

  assert.equal(result.checked, 2);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitAddonNames aggregates titles and generics", () => {
  const manifest = {
    titles: [
      {
        id: "t-bad",
        slug: "tbad",
        arch: "X64",
        download_url: "https://x/renodx-wrong.addon64",
      },
    ],
    generics: [
      {
        engine: "unity",
        slug: "unityengine",
        url64: "https://x/renodx-wrong.addon64",
        url32: "https://x/renodx-wrong.addon32",
      },
    ],
  };

  const result = checkExplicitAddonNames(manifest);

  assert.equal(result.checked, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.mismatches.length, 3);
  assert.deepEqual(result.structural, []);
});

test("checkExplicitAddonNames separates structural errors from mismatches", () => {
  const manifest = {
    titles: [],
    generics: [{ engine: "unity", slug: "x", url64: "https://x" }],
  };

  const result = checkExplicitAddonNames(manifest);

  assert.equal(result.structural.length, 1);
  assert.equal(result.mismatches.length, 0);
});
