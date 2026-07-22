import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import test from "node:test";

import { sha256Hex } from "../lib/hash.mjs";
import {
  parsePublicationArgs,
  publishResolvedCatalog,
  resolvePublicationPhases,
} from "../lib/r2-publication.mjs";

const zstdCompressAsync = promisify(zstdCompress);

test("publication modes are mutually exclusive", () => {
  assert.throws(
    () => parsePublicationArgs(["--json-only", "--binary-only"]),
    /mutually exclusive/,
  );
});

test("binary-only plan retains every catalog blob as a remote prerequisite", async () => {
  const plan = await resolvePublicationPhases({ jsonOnly: false, binaryOnly: true });
  assert.ok(plan.requiredBlobs.length > 0);
  assert.equal(
    new Set(plan.requiredBlobs.map((blob) => blob.key)).size,
    plan.requiredBlobs.length,
  );
  assert.ok(plan.blobs.length <= plan.requiredBlobs.length);
  assert.deepEqual(plan.jsonBeforeIndex, []);
  assert.deepEqual(plan.vendorSnapshots, []);
  assert.deepEqual(plan.index, []);
});

test("full publication is blob-first and index-last", async () => {
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

test("missing content blob prevents index publication", async () => {
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

test("binary preflight rejects a wrong DLL before the first PUT", async () => {
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
        compressedSize: (await readFile(binary)).length,
        dllSize: wrongDll.length,
        dllSha256: "a".repeat(64),
      },
    };

    await assert.rejects(
      publishResolvedCatalog(s3, options(), {
        blobs: [binaryObject],
        jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
        vendorSnapshots: [{ key: "vendor.json", abs: vendor }],
        index: [{ key: "index.json", abs: index }],
        requiredBlobs: [],
      }),
      /DLL SHA-256 mismatch/,
    );
    assert.deepEqual(puts, []);
  });
});

test("binary preflight bounds decompressed output before the first PUT", async () => {
  await withFiles(async ({ binary }) => {
    const oversizedDll = Buffer.alloc(1024 * 1024, 1);
    await writeFile(binary, await zstdCompressAsync(oversizedDll));
    const puts = [];
    const s3 = fakeS3(new Map(), puts);

    await assert.rejects(
      publishResolvedCatalog(s3, options({ binaryOnly: true }), {
        blobs: [
          {
            key: "runtime.dll.zst",
            abs: binary,
            expectedBinary: {
              compressedSize: (await readFile(binary)).length,
              dllSize: 8,
              dllSha256: "a".repeat(64),
            },
          },
        ],
        jsonBeforeIndex: [],
        vendorSnapshots: [],
        index: [],
        requiredBlobs: [],
      }),
      /invalid ZST payload/,
    );
    assert.deepEqual(puts, []);
  });
});

test("index commit point rejects bytes changed after plan resolution", async () => {
  await withFiles(async ({ index }) => {
    const original = await readFile(index);
    const puts = [];
    const s3 = fakeS3(new Map(), puts);
    await writeFile(index, '{"schema_version":2}\n');

    await assert.rejects(
      publishResolvedCatalog(s3, options({ jsonOnly: true }), {
        blobs: [],
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
        requiredBlobs: [],
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
        blobs: [],
        jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
        vendorSnapshots: [],
        index: [],
        requiredBlobs: [],
      }),
      /HEAD failed for other\.json: UnknownError \(HTTP 400, request r2-request\)/,
    );
  });
});

function options(overrides = {}) {
  return {
    jsonOnly: false,
    binaryOnly: false,
    dryRun: false,
    force: false,
    ...overrides,
  };
}

function phases(binary, otherJson, vendor, index, requiredBlobs) {
  return {
    blobs: binary
      ? [
          {
            key: "runtime.dll.zst",
            abs: binary,
            requiredChecksum: requiredBlobs[0].sha256,
          },
        ]
      : [],
    jsonBeforeIndex: [{ key: "other.json", abs: otherJson }],
    vendorSnapshots: [{ key: "vendor.json", abs: vendor }],
    index: [{ key: "index.json", abs: index }],
    requiredBlobs,
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
