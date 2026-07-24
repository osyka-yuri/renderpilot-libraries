import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFilesBatchWithRollback } from "../lib/json.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "renderpilot-json-batch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [path.join(directory, "one.json"), path.join(directory, "two.json")];
  await Promise.all([
    writeFile(files[0], '{ "old": 1 }\n'),
    writeFile(files[1], '{ "old": 2 }\n'),
  ]);
  return { directory, files };
}

test("batch JSON write stages and replaces every target", async (t) => {
  const { directory, files } = await fixture(t);
  await writeJsonFilesBatchWithRollback([
    { file: files[0], value: { next: 1 } },
    { file: files[1], value: { next: 2 } },
  ]);
  assert.equal(await readFile(files[0], "utf8"), '{\n  "next": 1\n}\n');
  assert.equal(await readFile(files[1], "utf8"), '{\n  "next": 2\n}\n');
  assert.deepEqual((await readdir(directory)).sort(), ["one.json", "two.json"]);
});

test("batch JSON validation failure occurs before staging or replacement", async (t) => {
  const { directory, files } = await fixture(t);
  await assert.rejects(
    () =>
      writeJsonFilesBatchWithRollback(
        [
          { file: files[0], value: { next: 1 } },
          { file: files[1], value: { invalid: true } },
        ],
        {
          validate(value) {
            if (value.invalid) throw new Error("fixture validation failed");
          },
        },
      ),
    /fixture validation failed/u,
  );
  assert.equal(await readFile(files[0], "utf8"), '{ "old": 1 }\n');
  assert.equal(await readFile(files[1], "utf8"), '{ "old": 2 }\n');
  assert.deepEqual((await readdir(directory)).sort(), ["one.json", "two.json"]);
});

test("batch JSON staging waits for sibling writes before cleaning up", async (t) => {
  const { directory, files } = await fixture(t);
  let delayedWriteCompleted = false;
  const operations = {
    readFile,
    rename,
    rm,
    async writeFile(file, data, encoding) {
      if (!file.includes("stage.tmp")) return writeFile(file, data, encoding);
      if (file.includes(".two.json.")) throw new Error("second staging write failed");
      await new Promise((resolve) => setTimeout(resolve, 40));
      delayedWriteCompleted = true;
      return writeFile(file, data, encoding);
    },
  };

  await assert.rejects(
    () =>
      writeJsonFilesBatchWithRollback(
        [
          { file: files[0], value: { next: 1 } },
          { file: files[1], value: { next: 2 } },
        ],
        { operations },
      ),
    /batch JSON staging failed.*second staging write failed/u,
  );
  assert.equal(delayedWriteCompleted, true);
  assert.equal(await readFile(files[0], "utf8"), '{ "old": 1 }\n');
  assert.equal(await readFile(files[1], "utf8"), '{ "old": 2 }\n');
  assert.deepEqual((await readdir(directory)).sort(), ["one.json", "two.json"]);
});

function failingOperations({ rollbackFails = false, cleanupFails = false } = {}) {
  let replacement = 0;
  return {
    readFile,
    writeFile,
    async rm(file, options) {
      if (cleanupFails && file.endsWith(".tmp")) {
        throw new Error("temporary cleanup failed");
      }
      return rm(file, options);
    },
    async rename(source, target) {
      replacement += 1;
      if (replacement === 2) throw new Error("second replacement failed");
      if (rollbackFails && replacement === 3) {
        throw new Error("restoration rename failed");
      }
      return rename(source, target);
    },
  };
}

test("batch JSON write restores the first target when the second replacement fails", async (t) => {
  const { files } = await fixture(t);
  await assert.rejects(
    () =>
      writeJsonFilesBatchWithRollback(
        [
          { file: files[0], value: { next: 1 } },
          { file: files[1], value: { next: 2 } },
        ],
        { operations: failingOperations() },
      ),
    /rolled back.*second replacement failed/u,
  );
  assert.equal(await readFile(files[0], "utf8"), '{ "old": 1 }\n');
  assert.equal(await readFile(files[1], "utf8"), '{ "old": 2 }\n');
});

test("batch JSON write reports replacement and rollback failures together", async (t) => {
  const { files } = await fixture(t);
  await assert.rejects(
    () =>
      writeJsonFilesBatchWithRollback(
        [
          { file: files[0], value: { next: 1 } },
          { file: files[1], value: { next: 2 } },
        ],
        { operations: failingOperations({ rollbackFails: true }) },
      ),
    (error) => {
      assert.match(error.message, /second replacement failed/u);
      assert.match(error.message, /rollback also failed/u);
      assert.match(error.message, /restoration rename failed/u);
      return true;
    },
  );
});

test("batch JSON write keeps the replacement error when cleanup also fails", async (t) => {
  const { files } = await fixture(t);
  await assert.rejects(
    () =>
      writeJsonFilesBatchWithRollback(
        [
          { file: files[0], value: { next: 1 } },
          { file: files[1], value: { next: 2 } },
        ],
        { operations: failingOperations({ cleanupFails: true }) },
      ),
    (error) => {
      assert.match(error.message, /second replacement failed/u);
      assert.match(error.message, /was rolled back/u);
      assert.match(error.message, /temporary cleanup also failed/u);
      assert.match(error.message, /temporary cleanup failed/u);
      return true;
    },
  );
});
