# Contributing to RenderPilot Libraries

Thank you for improving the RenderPilot catalogs. Keep changes focused, preserve exact upstream evidence, and do not weaken the boundary between reviewed authoring data and generated public output.

## Before changing data or tooling

1. Read the [development setup](docs/setup.md) and use the pinned Node.js and pnpm versions.
2. Review the [architecture](docs/architecture.md) before changing a schema, provider adapter, identity rule, generated document, or publication boundary.
3. Read the [library catalog](docs/library-catalog.md), [add-on catalogs](docs/addon-catalogs.md), or provider-local publishing notes for the surface you are changing.
4. Read [Operations and publishing](docs/operations.md) before running any write-mode refresh, withdrawal, prune, or R2 command.

Do not add unreviewed third-party binaries, credentials, private API data, or ambiguous source identities. New provider behavior should fail closed when upstream identity or layout cannot be established.

## Quality gates

Run focused checks while iterating and the complete applicable gate before opening a pull request:

```powershell
pnpm run check:offline
pnpm run test:windows
pnpm run check
```

`test:windows` is required for changes to PE inspection, Authenticode, timestamps, or Xiph source-build verification. `check` includes live upstream checks and is the expected final repository gate.

When a generator-owned document changes, update its declared source, run the generator, and include both source and generated output in the review. Add focused tests for changed schemas, adapters, validators, failure modes, and command behavior.

## Pull requests

Describe the upstream or contract change, the evidence used, generated outputs, publication implications, and verification performed. Keep unrelated provider refreshes separate. Automated refresh pull requests must satisfy the same source, validation, and generated-output contracts as manual contributions.

## Sources of truth

- [Documentation hub](docs/README.md)
- [Package scripts](package.json)
- [Catalog registry](scripts/catalog.mjs)
- [Publish workflow](.github/workflows/publish.yml)
