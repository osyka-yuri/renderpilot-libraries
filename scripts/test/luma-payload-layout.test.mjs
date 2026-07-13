import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPartialResponse,
  centralDirectoryFromTail,
  collectAssetPayloadIdentities,
  parseContentRange,
  rootAddonFromCentralDirectory,
  rootAddonFromZip,
} from "../lib/luma-payload-layout.mjs";

function zipWithEntries(names) {
  const localEntries = [];
  const centralEntries = [];
  let localOffset = 0;

  for (const name of names) {
    const encoded = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(encoded.length, 26);
    localEntries.push(local, encoded);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralEntries.push(central, encoded);
    localOffset += local.length + encoded.length;
  }

  const centralSize = centralEntries.reduce((size, entry) => size + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localEntries, ...centralEntries, eocd]);
}

test("rootAddonFromZip returns the sole root add-on and ignores nested files", () => {
  const zip = zipWithEntries([
    "Luma-Borderlands 2 and The Pre-Sequel.addon",
    "Luma/Effects/SomeShader.addon",
  ]);

  assert.equal(rootAddonFromZip(zip), "Luma-Borderlands 2 and The Pre-Sequel.addon");
});

test("rootAddonFromZip rejects a missing or ambiguous root identity", () => {
  assert.throws(() => rootAddonFromZip(zipWithEntries(["Luma/Effect.fx"])));
  assert.throws(() =>
    rootAddonFromZip(zipWithEntries(["Luma-One.addon", "Luma-Two.addon"])),
  );
});

test("central-directory metadata can be read from an EOCD tail range", () => {
  const zip = zipWithEntries(["Luma-Exact.addon", "Luma/Effects/Other.addon"]);
  const descriptor = centralDirectoryFromTail(zip, {
    start: 0,
    end: zip.length - 1,
    total: zip.length,
  });

  assert.equal(descriptor.entries, 2);
  assert.equal(
    rootAddonFromCentralDirectory(
      zip.subarray(descriptor.start, descriptor.end + 1),
      descriptor,
    ),
    "Luma-Exact.addon",
  );
});

test("central-directory metadata rejects ZIP64 and truncated layouts", () => {
  const zip64 = zipWithEntries(["Luma-Exact.addon"]);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(
    () =>
      centralDirectoryFromTail(zip64, {
        start: 0,
        end: zip64.length - 1,
        total: zip64.length,
      }),
    /ZIP64/,
  );

  const zip = zipWithEntries(["Luma-Exact.addon"]);
  const descriptor = centralDirectoryFromTail(zip, {
    start: 0,
    end: zip.length - 1,
    total: zip.length,
  });
  assert.throws(
    () => rootAddonFromCentralDirectory(Buffer.alloc(descriptor.size - 1), descriptor),
    /length/,
  );
});

test("Content-Range validation requires an exact bounded partial response", () => {
  assert.deepEqual(parseContentRange("bytes 100-199/1000"), {
    start: 100,
    end: 199,
    total: 1000,
  });
  assert.throws(() => parseContentRange("bytes */1000"), /invalid Content-Range/);

  assert.deepEqual(
    assertPartialResponse({
      status: 206,
      contentRange: "bytes 100-199/1000",
      bytesLength: 100,
      expected: { start: 100, end: 199, total: 1000 },
      maxBytes: 100,
    }),
    { start: 100, end: 199, total: 1000 },
  );
  assert.throws(
    () =>
      assertPartialResponse({
        status: 200,
        contentRange: "bytes 100-199/1000",
        bytesLength: 100,
        expected: { start: 100, end: 199, total: 1000 },
        maxBytes: 100,
      }),
    /did not honor range/,
  );
});

test("collectAssetPayloadIdentities enforces one add-on name per asset", () => {
  assert.deepEqual(
    collectAssetPayloadIdentities({
      titles: [
        { asset: "Luma-Unreal_Engine.zip", addon_file: "Luma-Unreal Engine.addon" },
        { asset: "Luma-Unreal_Engine.zip", addon_file: "Luma-Unreal Engine.addon" },
      ],
    }),
    [{ asset: "Luma-Unreal_Engine.zip", addonFile: "Luma-Unreal Engine.addon" }],
  );
  assert.throws(
    () =>
      collectAssetPayloadIdentities({
        titles: [
          { asset: "Luma-Shared.zip", addon_file: "Luma-One.addon" },
          { asset: "Luma-Shared.zip", addon_file: "Luma-Two.addon" },
        ],
      }),
    /maps to multiple root add-ons/,
  );
});
