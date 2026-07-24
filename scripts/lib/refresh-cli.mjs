import { UsageError } from "./common.mjs";
import { parseCliArgs } from "./cli-args.mjs";

const REFRESH_MODES = Object.freeze([
  "check",
  "write",
  "materialize-locked",
  "backfill-signatures",
]);

const MODE_OPTIONS = Object.freeze(
  Object.fromEntries(REFRESH_MODES.map((name) => [name, { type: "boolean" }])),
);

function optionOccurrences(tokens, name) {
  return tokens.filter((token) => token.kind === "option" && token.name === name).length;
}

function assertSingleOccurrence(tokens, name) {
  if (optionOccurrences(tokens, name) > 1) {
    throw new UsageError(`--${name} can be specified only once`);
  }
}

export function parseRefreshArgs(
  argv,
  { allowBackfillSignatures = true, allowProduct = false, target = "none" } = {},
) {
  if (!new Set(["none", "vendor-or-all"]).has(target)) {
    throw new Error(`unsupported refresh target contract ${target}`);
  }

  const options = {
    ...MODE_OPTIONS,
    product: { type: "string" },
    ...(target === "vendor-or-all"
      ? {
          vendor: { type: "string" },
          all: { type: "boolean" },
        }
      : {}),
  };
  const { values, tokens } = parseCliArgs(argv, options, { tokens: true });

  for (const name of [
    ...REFRESH_MODES,
    "product",
    ...(target === "vendor-or-all" ? ["vendor", "all"] : []),
  ]) {
    assertSingleOccurrence(tokens, name);
  }

  const explicitModes = REFRESH_MODES.filter((name) => values[name] === true);
  if (explicitModes.length > 1) {
    throw new UsageError(
      "refresh modes --check, --write, --materialize-locked, and --backfill-signatures are mutually exclusive",
    );
  }
  const mode = explicitModes[0] ?? "check";
  if (mode === "backfill-signatures" && !allowBackfillSignatures) {
    throw new UsageError("--backfill-signatures is not valid for this provider");
  }

  const result = { mode };
  if (!allowProduct && values.product !== undefined) {
    throw new UsageError("--product is only valid for Microsoft");
  }
  if (values.product !== undefined) {
    if (values.product.trim() === "") {
      throw new UsageError("--product requires a non-empty product id");
    }
    result.product = values.product;
  }

  if (target === "vendor-or-all") {
    const vendorId = values.vendor;
    const all = values.all === true;
    if ((typeof vendorId === "string") === all) {
      throw new UsageError("specify exactly one of --vendor or --all");
    }
    if (typeof vendorId === "string" && vendorId.trim() === "") {
      throw new UsageError("--vendor requires a non-empty vendor id");
    }
    if (typeof vendorId === "string") result.vendorId = vendorId;
    result.all = all;
  }

  return result;
}
