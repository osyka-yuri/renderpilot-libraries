import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runGenerateManifest } from "../lib/generate-manifest-runner.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "renderpilot-generate-"));

  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("runGenerateManifest writes and checks a single generated manifest output", async () => {
  await withTempDir(async (repoRoot) => {
    const files = {
      manifest: path.join(repoRoot, "reshade_manifest.json"),
    };

    const options = {
      files,
      repoRoot,
      helpText: "help",
      build: ({ generatedAt }) => ({
        manifest: {
          schema_version: 1,
          generated_at: generatedAt,
        },
      }),
      readInputs: ({ generatedAt }) => ({ generatedAt }),
    };

    assert.equal(await runGenerateManifest(options), 0);
    assert.equal(await runGenerateManifest({ ...options, argv: ["--check"] }), 0);
  });
});

test("runGenerateManifest writes and checks manifest plus pending outputs", async () => {
  await withTempDir(async (repoRoot) => {
    const files = {
      manifest: path.join(repoRoot, "tool_manifest.json"),
      pending: path.join(repoRoot, "tool_pending.json"),
      exeCache: path.join(repoRoot, "steam-appid-exe.json"),
    };

    await fs.writeFile(files.exeCache, '{ "10": ["Game.exe"] }\n', "utf8");

    const options = {
      files,
      repoRoot,
      helpText: "help",
      build: ({ generatedAt, exeCache }) => ({
        manifest: {
          schema_version: 1,
          generated_at: generatedAt,
          exes: exeCache["10"],
        },
        pending: [{ id: "needs-match" }],
      }),
      readInputs: ({ exeCache, generatedAt }) => ({ exeCache, generatedAt }),
    };

    assert.equal(await runGenerateManifest(options), 0);
    assert.equal(await runGenerateManifest({ ...options, argv: ["--check"] }), 0);
  });
});
