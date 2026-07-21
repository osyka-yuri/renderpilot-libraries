import assert from "node:assert/strict";
import test from "node:test";

import {
  findBestSteamMatch,
  normalize,
  normalizeBaseTitle,
  scoreTitleMatch,
} from "../lib/steam-search.mjs";

const AUTO_ACCEPT_SCORE = 78;

const TITLE_MATCH_CASES = [
  {
    expected: "Borderlands GOTY Enhanced",
    actual: "Borderlands Game of the Year Enhanced",
    minimumScore: 100,
  },
  {
    expected: "Heaven Burns Red",
    actual: "ヘブンバーンズレッド",
    minimumScore: 100,
  },
  {
    expected: "Bus Simulator 21",
    actual: "Bus Simulator 21 Next Stop",
    minimumScore: 88,
  },
  {
    expected: "Daylight",
    actual: "Daylight",
    minimumScore: 100,
  },
  {
    expected: "Destroy All Humans! – Clone Carnage",
    actual: "Destroy All Humans! - Clone Carnage",
    minimumScore: 100,
  },
  {
    expected: "DRAGON QUEST XI: Echoes of an Elusive Age",
    actual: "DRAGON QUEST® XI S: Echoes of an Elusive Age™ - Definitive Edition",
    minimumScore: 78,
  },
  {
    expected: "ECHO",
    actual: "ECHO",
    minimumScore: 100,
  },
  {
    expected: "Little Nightmares Enhanced Edition",
    actual: "Little Nightmares Enhanced Edition",
    minimumScore: 100,
  },
];

function createSteamItem(id, name, type = "app") {
  return { id, name, type };
}

function assertMinimumMatchScore({ expected, actual, minimumScore }) {
  const result = scoreTitleMatch(expected, actual);

  assert.ok(
    result.score >= minimumScore,
    [
      `Expected "${expected}" to match "${actual}" with score >= ${minimumScore}.`,
      `Received ${result.score} (${result.reason}).`,
    ].join(" "),
  );
}

test("scoreTitleMatch recognizes supported title variants", async (t) => {
  for (const testCase of TITLE_MATCH_CASES) {
    await t.test(`${testCase.expected} -> ${testCase.actual}`, () => {
      assertMinimumMatchScore(testCase);
    });
  }
});

test("normalize preserves edition markers in strict identity", () => {
  assert.notEqual(
    normalize("Little Nightmares"),
    normalize("Little Nightmares Enhanced Edition"),
  );
});

test("normalizeBaseTitle ignores edition markers", () => {
  assert.equal(
    normalizeBaseTitle("Little Nightmares"),
    normalizeBaseTitle("Little Nightmares Enhanced Edition"),
  );
});

test("a requested edition does not resolve to the base game", () => {
  const result = scoreTitleMatch("Little Nightmares Enhanced Edition", "Little Nightmares");

  assert.ok(
    result.score < AUTO_ACCEPT_SCORE,
    `Expected score below ${AUTO_ACCEPT_SCORE}, received ${result.score}.`,
  );

  assert.equal(result.reason, "requested-edition-missing");
});

test("findBestSteamMatch reports equally strong matches as ambiguous", () => {
  const firstResult = createSteamItem(551770, "ECHO");
  const secondResult = createSteamItem(111111, "Echo");

  const resolution = findBestSteamMatch("ECHO", [firstResult, secondResult]);

  assert.deepEqual(resolution.item, firstResult);
  assert.equal(resolution.score, 100);
  assert.equal(resolution.reason, "exact-canonical-title");
  assert.equal(resolution.ambiguous, true);
  assert.equal(resolution.alternatives[0]?.item.id, secondResult.id);
});
