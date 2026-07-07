import test from "node:test";
import assert from "node:assert/strict";

import { validateOverlay, collectMatchedAppids } from "../lib/overlay.mjs";

test("validateOverlay warns on unknown fields and orphan entries but does not throw", () => {
  const warnings = [];
  validateOverlay(
    { "some-game": { appid: "100", typo_field: true } },
    new Set(),
    (message) => warnings.push(message),
  );

  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((message) => /unknown field "typo_field"/.test(message)));
  assert.ok(
    warnings.some((message) =>
      /no matching curated_games\.json entry \(orphan\)/.test(message),
    ),
  );
});

test("validateOverlay rejects a non-boolean ignore flag", () => {
  assert.throws(
    () => validateOverlay({ game: { ignore: "yes" } }, new Set(["game"])),
    /ignore must be a boolean/,
  );
});

test("collectMatchedAppids gathers appid/appids across every curated game", () => {
  const appids = collectMatchedAppids([{ id: "one" }, { id: "two" }, { id: "three" }], {
    one: { appid: "100" },
    two: { appids: ["200", "201"] },
  });

  assert.deepEqual([...appids].sort(), ["100", "200", "201"]);
});
