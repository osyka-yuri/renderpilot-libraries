import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import test from "node:test";

import { repoRoot } from "../catalog.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { persistLegalDocument } from "../lib/library-artifact-io.mjs";
import {
  assertVendorSnapshot,
  buildVendorSnapshot,
  legalDocumentObjectKey,
} from "../lib/library-catalog.mjs";
import { buildMicrosoftVendorSource } from "../lib/microsoft-nuget.mjs";
import {
  parsePublicationArgs,
  publishResolvedCatalog,
  resolvePublicationPhases,
} from "../lib/r2-publication.mjs";

const zstdCompressAsync = promisify(zstdCompress);

test("publication modes are mutually exclusive", () => {
  assert.throws(
    () => parsePublicationArgs(["--json-only", "--assets-only"]),
    /mutually exclusive/,
  );
});

test("assets-only plan retains every catalog asset as a remote prerequisite", async () => {
  const plan = await resolvePublicationPhases({ jsonOnly: false, assetsOnly: true });
  assert.ok(plan.requiredAssets.length > 0);
  assert.equal(
    new Set(plan.requiredAssets.map((asset) => asset.key)).size,
    plan.requiredAssets.length,
  );
  assert.ok(plan.assets.length <= plan.requiredAssets.length);
  assert.ok(
    plan.requiredAssets.some((asset) => asset.key.startsWith("libraries/legal/sha256/")),
  );
  assert.deepEqual(plan.jsonBeforeIndex, []);
  assert.deepEqual(plan.vendorSnapshots, []);
  assert.deepEqual(plan.index, []);
});

test("full publication is asset-first and index-last", async () => {
  await withFiles(async ({ binary, otherJson, vendor, index }, contents) => {
    const remote = new Map();
    const puts = [];
    const s3 = fakeS3(remote, puts);
    const required = {
      key: "runtime.dll.zst",
      size: contents.binary.length,
      sha256: sha256Hex(contents.binary),
    };
    await publishResolvedCatalog(
      s3,
      options(),
      phases(binary, otherJson, vendor, index, [required]),
    );
    assert.deepEqual(puts, ["runtime.dll.zst", "other.json", "vendor.json", "index.json"]);
  });
});

test("missing content asset prevents index publication", async () => {
  await withFiles(async ({ otherJson, vendor, index }) => {
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    await assert.rejects(
      publishResolvedCatalog(
        s3,
        options({ jsonOnly: true }),
        phases(null, otherJson, vendor, index, [
          { key: "missing.dll.zst", size: 123, sha256: "a".repeat(64) },
        ]),
      ),
      /remote prerequisite mismatch/,
    );
    assert.deepEqual(puts, ["other.json", "vendor.json"]);
  });
});

test("DLL asset preflight rejects a wrong DLL before the first PUT", async () => {
  await withFiles(async ({ binary, otherJson, vendor, index }) => {
    const wrongDll = Buffer.from("wrong dll");
    await writeFile(binary, await zstdCompressAsync(wrongDll));
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    const binaryObject = {
      key: "runtime.dll.zst",
      abs: binary,
      requiredChecksum: null,
      expectedBinary: {
        storedSize: (await readFile(binary)).length,
        dllSize: wrongDll.length,
        dllSha256: "a".repeat(64),
      },
    };

    await assert.rejects(
      publishResolvedCatalog(s3, options(), {
        assets: [binaryObject],
        jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
        vendorSnapshots: [{ key: "vendor.json", abs: vendor }],
        index: [{ key: "index.json", abs: index }],
        requiredAssets: [],
      }),
      /DLL SHA-256 mismatch/,
    );
    assert.deepEqual(puts, []);
  });
});

test("DLL asset preflight bounds decompressed output before the first PUT", async () => {
  await withFiles(async ({ binary }) => {
    const oversizedDll = Buffer.alloc(1024 * 1024, 1);
    await writeFile(binary, await zstdCompressAsync(oversizedDll));
    const puts = [];
    const s3 = fakeS3(new Map(), puts);

    await assert.rejects(
      publishResolvedCatalog(s3, options({ assetsOnly: true }), {
        assets: [
          {
            key: "runtime.dll.zst",
            abs: binary,
            expectedBinary: {
              storedSize: (await readFile(binary)).length,
              dllSize: 8,
              dllSha256: "a".repeat(64),
            },
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [],
      }),
      /invalid ZST payload/,
    );
    assert.deepEqual(puts, []);
  });
});

test("legal asset preflight binds raw bytes and size before the first PUT", async () => {
  await withFiles(async ({ otherJson }, contents) => {
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    await assert.rejects(
      publishResolvedCatalog(s3, options({ assetsOnly: true }), {
        assets: [
          {
            kind: "legal",
            key: `libraries/legal/sha256/${"a".repeat(64)}.txt`,
            abs: otherJson,
            requiredChecksum: "a".repeat(64),
            expectedSize: contents.otherJson.length,
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [],
      }),
      /local bytes do not match required SHA-256/,
    );
    assert.deepEqual(puts, []);
  });
});

test("legal asset preflight rejects bytes that contradict the declared format", async () => {
  await withFiles(async ({ otherJson }) => {
    const bytes = await readFile(otherJson);
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    await assert.rejects(
      publishResolvedCatalog(s3, options({ assetsOnly: true }), {
        assets: [
          {
            key: `libraries/legal/sha256/${sha256Hex(bytes)}.pdf`,
            abs: otherJson,
            requiredChecksum: sha256Hex(bytes),
            expectedSize: bytes.length,
            expectedLegal: { format: "pdf" },
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [],
      }),
      /canonical PDF header/,
    );
    assert.deepEqual(puts, []);
  });
});

test("legal identity stays bound from lock through source, snapshot, local file, and R2", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "renderpilot-legal-chain-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const [config, lock] = await Promise.all(
    [
      "catalogs/libraries/microsoft-nuget.config.json",
      "catalogs/libraries/microsoft-nuget.lock.json",
    ].map(async (relative) =>
      JSON.parse(await readFile(path.join(repoRoot, relative), "utf8")),
    ),
  );
  const fixtureLock = structuredClone(lock);
  const originalDocument = fixtureLock.releases
    .flatMap((release) => release.legal_documents)
    .at(0);
  assert.ok(originalDocument);

  const bytes = Buffer.from("RenderPilot legal identity integration fixture.\n", "utf8");
  const fixtureSha256 = sha256Hex(bytes);
  const fixtureObjectKey = legalDocumentObjectKey(fixtureSha256, originalDocument.format);
  for (const release of fixtureLock.releases) {
    for (const document of release.legal_documents) {
      if (document.sha256 !== originalDocument.sha256) continue;
      document.sha256 = fixtureSha256;
      document.size_bytes = bytes.length;
      document.object_key = fixtureObjectKey;
    }
  }

  const source = buildMicrosoftVendorSource(fixtureLock, config);
  const snapshot = buildVendorSnapshot(source);
  const locked = fixtureLock.releases
    .flatMap((release) => release.legal_documents)
    .find((document) => document.sha256 === fixtureSha256);
  assert.ok(locked);
  const sourceDocument = source.legal_documents.find(
    (document) => document.content.sha256 === locked.sha256,
  );
  const snapshotDocument = snapshot.legal_documents.find(
    (document) => document.content.sha256 === locked.sha256,
  );
  assert.ok(sourceDocument);
  assert.ok(snapshotDocument);
  assert.equal(sourceDocument.content.size_bytes, locked.size_bytes);
  assert.equal(snapshotDocument.object_key, locked.object_key);

  const persisted = await persistLegalDocument(bytes, locked.format, {
    cdnDirectory: temporary,
  });
  assert.deepEqual(persisted, {
    object_key: locked.object_key,
    sha256: locked.sha256,
    size_bytes: locked.size_bytes,
  });
  const localFile = path.join(temporary, ...persisted.object_key.split("/"));
  const expectedLegal = {
    kind: "legal",
    storedSha256: snapshotDocument.content.sha256,
    format: snapshotDocument.format,
  };
  const required = {
    key: snapshotDocument.object_key,
    size: snapshotDocument.content.size_bytes,
    sha256: snapshotDocument.content.sha256,
  };
  const remote = new Map();
  const puts = [];
  await publishResolvedCatalog(fakeS3(remote, puts), options({ assetsOnly: true }), {
    assets: [
      {
        key: snapshotDocument.object_key,
        abs: localFile,
        requiredChecksum: snapshotDocument.content.sha256,
        expectedSize: snapshotDocument.content.size_bytes,
        expectedLegal,
      },
    ],
    jsonBeforeIndex: [],
    vendorSnapshots: [],
    index: [],
    requiredAssets: [required],
  });
  assert.deepEqual(puts, [snapshotDocument.object_key]);
  assert.equal(remote.get(snapshotDocument.object_key).body.length, locked.size_bytes);
  assert.equal(remote.get(snapshotDocument.object_key).sha256, locked.sha256);

  const badLock = structuredClone(fixtureLock);
  badLock.releases[0].legal_documents[0].sha256 = "a".repeat(64);
  assert.throws(
    () => buildMicrosoftVendorSource(badLock, config),
    /legal document|object key|content identity/u,
  );

  const badSnapshot = structuredClone(snapshot);
  badSnapshot.legal_documents[0].format = "pdf";
  assert.throws(
    () => assertVendorSnapshot(badSnapshot),
    /extension does not match document format|object key/u,
  );

  const badSize = {
    ...required,
    size: required.size + 1,
  };
  await assert.rejects(
    () =>
      publishResolvedCatalog(fakeS3(new Map(), []), options({ assetsOnly: true }), {
        assets: [
          {
            key: required.key,
            abs: localFile,
            requiredChecksum: required.sha256,
            expectedSize: badSize.size,
            expectedLegal,
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [badSize],
      }),
    /local size mismatch/u,
  );

  const wrongKey = legalDocumentObjectKey(required.sha256, "pdf");
  await assert.rejects(
    () =>
      publishResolvedCatalog(fakeS3(new Map(), []), options({ assetsOnly: true }), {
        assets: [
          {
            key: wrongKey,
            abs: localFile,
            requiredChecksum: required.sha256,
            expectedSize: required.size,
            expectedLegal,
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [],
      }),
    /legal object key does not match content identity/u,
  );
});

test("index commit point rejects bytes changed after plan resolution", async () => {
  await withFiles(async ({ index }) => {
    const original = await readFile(index);
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    await writeFile(index, '{"schema_version":2}\n');

    await assert.rejects(
      publishResolvedCatalog(s3, options({ jsonOnly: true }), {
        assets: [],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [
          {
            key: "index.json",
            abs: index,
            requiredChecksum: sha256Hex(original),
            checksumLabel: "resolved JSON publication snapshot",
          },
        ],
        requiredAssets: [],
      }),
      /resolved JSON publication snapshot/,
    );
    assert.deepEqual(puts, []);
  });
});

test("object-store failures retain HTTP diagnostics", async () => {
  await withFiles(async ({ otherJson }) => {
    const s3 = {
      async send() {
        const error = new Error("UnknownError");
        error.$metadata = { httpStatusCode: 400, requestId: "r2-request" };
        throw error;
      },
    };

    await assert.rejects(
      publishResolvedCatalog(s3, options({ jsonOnly: true }), {
        assets: [],
        jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
        vendorSnapshots: [],
        index: [],
        requiredAssets: [],
      }),
      /HEAD failed for other\.json: UnknownError \(HTTP 400, request r2-request\)/,
    );
  });
});

function options(overrides = {}) {
  return {
    jsonOnly: false,
    assetsOnly: false,
    dryRun: false,
    force: false,
    ...overrides,
  };
}

function phases(binary, otherJson, vendor, index, requiredAssets) {
  return {
    assets: binary
      ? [
          {
            key: "runtime.dll.zst",
            abs: binary,
            requiredChecksum: requiredAssets[0].sha256,
          },
        ]
      : [],
    jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
    vendorSnapshots: [{ key: "vendor.json", abs: vendor }],
    index: [{ key: "index.json", abs: index }],
    requiredAssets,
  };
}

function fakeS3(remote, puts) {
  return {
    async send(command) {
      const key = command.input.Key;
      if (command.constructor.name === "HeadObjectCommand") {
        const object = remote.get(key);
        if (!object) {
          const error = new Error("missing");
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return {
          ContentLength: object.body.length,
          Metadata: { sha256: object.sha256 },
          ETag: '"not-an-md5"',
        };
      }
      if (command.constructor.name === "PutObjectCommand") {
        const body = Buffer.from(command.input.Body);
        puts.push(key);
        remote.set(key, { body, sha256: command.input.Metadata.sha256 });
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

async function withFiles(operation) {
  const directory = await mkdtemp(path.join(tmpdir(), "renderpilot-r2-test-"));
  const contents = {
    binary: Buffer.from("binary payload"),
    otherJson: Buffer.from("{}\n"),
    vendor: Buffer.from('{"schema_version":1}\n'),
    index: Buffer.from('{"schema_version":1}\n'),
  };
  const files = Object.fromEntries(
    Object.keys(contents).map((name) => [name, path.join(directory, name)]),
  );
  try {
    await Promise.all(
      Object.entries(files).map(([name, file]) => writeFile(file, contents[name])),
    );
    await operation(files, contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
