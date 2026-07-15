import assert from "node:assert/strict";
import test from "node:test";

import { availabilityFromCategory, engineProfileFromGeneric, message } from "../lib/v1.mjs";

test("message requires a registered RenoDX fallback", () => {
  assert.deepEqual(message("renodx.external.nexus"), {
    id: "renodx.external.nexus",
    fallback_text: "Get the add-on from Nexus Mods, then install the downloaded file.",
  });

  assert.throws(
    () => message("renodx.external.unknown"),
    /No RenoDX fallback text registered/,
  );
  assert.throws(
    () =>
      availabilityFromCategory({
        kind: "blacklist",
        reason: "renodx.blocked.unknown",
      }),
    /No RenoDX fallback text registered/,
  );
});

test("engine profiles require a complete source pair", () => {
  const generic = {
    engine: "unity",
    status: "unknown",
    slug: "unityengine",
    label_key: "renodx.generic.unity",
  };

  assert.equal(engineProfileFromGeneric(generic).addon.sources, undefined);
  assert.deepEqual(
    engineProfileFromGeneric({
      ...generic,
      url64: " https://example.com/renodx.addon64 ",
      url32: " https://example.com/renodx.addon32 ",
    }).addon.sources,
    {
      x64: "https://example.com/renodx.addon64",
      x86: "https://example.com/renodx.addon32",
    },
  );

  for (const sources of [
    { url64: "https://example.com/renodx.addon64" },
    { url32: "https://example.com/renodx.addon32" },
  ]) {
    assert.throws(
      () => engineProfileFromGeneric({ ...generic, ...sources }),
      /must provide url64 and url32 together/,
    );
  }

  assert.throws(
    () => engineProfileFromGeneric({ ...generic, url64: "", url32: "" }),
    /url64 must be a non-empty string/,
  );
});
