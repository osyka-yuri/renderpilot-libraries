import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE_MODULE = new URL("../lib/steam-search.mjs", import.meta.url);

async function importSteamSearchInTempRepo(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "steam-search-test-"));
  const tempLibDir = path.join(repoRoot, "scripts", "lib");
  const tempModulePath = path.join(tempLibDir, "steam-search.mjs");

  await fs.mkdir(tempLibDir, { recursive: true });
  await fs.copyFile(SOURCE_MODULE, tempModulePath);

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const moduleUrl = pathToFileURL(tempModulePath);
  moduleUrl.searchParams.set("t", `${Date.now()}-${Math.random()}`);

  return {
    module: await import(moduleUrl.href),
    cacheFile: path.join(repoRoot, "scripts", ".cache", "steam-search.json"),
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("normalize() handles Steam title noise predictably", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  assert.equal(
    module.normalize("FINAL FANTASY VII REMAKE INTERGRADE"),
    "finalfantasy7remakeintergrade",
  );
  assert.equal(module.normalize("Tomb Raider™ (2013)"), "tombraider");
  assert.equal(
    module.normalize("Deus Ex: Human Revolution - Director's Cut"),
    "deusexhumanrevolution",
  );
  assert.equal(
    module.normalize("Dungeons & Dragons: Dark Alliance"),
    "dungeonsanddragonsdarkalliance",
  );
  assert.equal(module.normalize("Pokémon® Legends: Arceus"), "pokemonlegendsarceus");
});

test("normalize() rejects non-string input", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  assert.throws(() => module.normalize(null), {
    name: "TypeError",
    message: "Expected game name to be a string.",
  });
});

test("searchSteamStore() returns [] for empty search terms without calling fetch", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("fetch should not be called for an empty search term");
  });

  assert.deepEqual(await module.searchSteamStore("  \n\t  "), []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("searchSteamStore() trims whitespace, fetches Steam, sanitizes items, and writes cache", async (t) => {
  const { module, cacheFile } = await importSteamSearchInTempRepo(t);

  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.origin, "https://store.steampowered.com");
    assert.equal(url.pathname, "/api/storesearch/");
    assert.equal(url.searchParams.get("term"), "Half Life");
    assert.equal(url.searchParams.get("l"), "english");
    assert.equal(url.searchParams.get("cc"), "US");
    assert.equal(init.headers.accept, "application/json");
    assert.ok(init.signal instanceof AbortSignal);

    return jsonResponse({
      items: [
        { id: 70, name: "Half-Life", type: "app" },
        { id: "220", name: "Half-Life 2", type: "app", ignored: true },
        { id: "not-a-number", name: "Broken", type: "app" },
        { id: 123, name: null, type: "app" },
      ],
    });
  });

  assert.deepEqual(await module.searchSteamStore("  Half   Life  "), [
    { id: 70, name: "Half-Life", type: "app" },
    { id: 220, name: "Half-Life 2", type: "app" },
  ]);

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(await readJsonFile(cacheFile), {
    "Half Life": [
      { id: 70, name: "Half-Life", type: "app" },
      { id: 220, name: "Half-Life 2", type: "app" },
    ],
  });
});

test("searchSteamStore() serves repeated successful searches from cache", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ items: [{ id: 400, name: "Portal", type: "app" }] }),
  );

  assert.deepEqual(await module.searchSteamStore("Portal"), [
    { id: 400, name: "Portal", type: "app" },
  ]);
  assert.deepEqual(await module.searchSteamStore("Portal"), [
    { id: 400, name: "Portal", type: "app" },
  ]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("searchSteamStore() reads and sanitizes an existing cache file", async (t) => {
  const { module, cacheFile } = await importSteamSearchInTempRepo(t);

  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(
    cacheFile,
    JSON.stringify({
      Portal: [
        { id: "400", name: "Portal", type: "app", extra: "discarded" },
        { id: 401, name: 123, type: "app" },
      ],
    }),
    "utf8",
  );

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("fetch should not be called for a cache hit");
  });

  assert.deepEqual(await module.searchSteamStore("Portal"), [
    { id: 400, name: "Portal", type: "app" },
  ]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("searchSteamStore() ignores an unreadable cache and refreshes it", async (t) => {
  const { module, cacheFile } = await importSteamSearchInTempRepo(t);

  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, "{not valid json", "utf8");

  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ items: [{ id: 10, name: "Doom", type: "app" }] }),
  );

  assert.deepEqual(await module.searchSteamStore("Doom"), [
    { id: 10, name: "Doom", type: "app" },
  ]);
  assert.deepEqual(await readJsonFile(cacheFile), {
    Doom: [{ id: 10, name: "Doom", type: "app" }],
  });
});

test("searchSteamStore() de-duplicates concurrent identical requests", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ items: [{ id: 620, name: "Portal 2", type: "app" }] }),
  );

  const [first, second] = await Promise.all([
    module.searchSteamStore("Portal 2"),
    module.searchSteamStore("Portal 2"),
  ]);

  assert.deepEqual(first, [{ id: 620, name: "Portal 2", type: "app" }]);
  assert.deepEqual(second, first);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("searchSteamStore() retries a rate-limited response that provides Retry-After", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  t.mock.method(console, "warn", () => {});

  const responses = [
    new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    jsonResponse({ items: [{ id: 730, name: "Counter-Strike 2", type: "app" }] }),
  ];

  const fetchMock = t.mock.method(globalThis, "fetch", async () => responses.shift());

  assert.deepEqual(await module.searchSteamStore("Counter-Strike 2"), [
    { id: 730, name: "Counter-Strike 2", type: "app" },
  ]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("searchSteamStore() returns null on non-retriable HTTP errors", async (t) => {
  const { module } = await importSteamSearchInTempRepo(t);

  t.mock.method(console, "error", () => {});

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 }),
  );

  assert.equal(await module.searchSteamStore("Definitely Missing"), null);
  assert.equal(fetchMock.mock.callCount(), 1);
});
