# Development setup

RenderPilot Libraries is a Node.js and PowerShell tooling repository. Most validation runs on any platform supported by the pinned Node.js toolchain. PE inspection, Authenticode verification, and reproducible Xiph builds require Windows.

## Requirements

- Git
- Node.js 24.20.0 LTS, pinned in [`.node-version`](../.node-version)
- pnpm 12.3.4, pinned by the `packageManager` field in [`package.json`](../package.json)
- PowerShell 7 for Windows tooling
- A supported Windows toolchain when maintaining PE, signature, or Xiph source-build paths

The shared GitHub Actions setup action reads the same version pins used by a local checkout. The `packageManager` field is the authoritative pnpm version source, but it does not provision pnpm locally, so the documented bootstrap remains independent of Corepack availability.

## Install dependencies

From the repository root:

```powershell
npm install --global pnpm@12.3.4
pnpm install --frozen-lockfile
```

The first command is required once per pnpm version on a fresh machine. When `packageManager` changes, install that exact version before running repository commands.

Do not mix npm or Yarn lockfiles into the repository. Update `pnpm-lock.yaml` only through pnpm when a declared dependency changes.

## Local quality gates

Use the smallest gate that fully covers the change while iterating:

```powershell
pnpm run docs:check
pnpm run check:offline
pnpm run test:windows
pnpm run check
```

- `docs:check` lints maintained Markdown and verifies local links and heading anchors.
- `check:offline` runs the deterministic formatting, documentation, schema, generated-output, provider-lock, and unit-test subset without live upstream synchronization.
- `test:windows` exercises Authenticode, timestamp, PE inspection, and Xiph source-verification helpers on Windows.
- `check` is the complete gate and includes live RenoDX and Luma Wiki checks.

The publish workflow runs the complete gate on pull requests and on `main`. Pull requests also receive the Windows-specific test job.

## Generated documents

Authoring sources and generated outputs have different ownership:

- edit provider configuration, locks, curated sources, or add-on authoring records;
- run the declared generator;
- review both the source change and generated diff;
- never hand-edit a generated vendor snapshot, shared index, or add-on manifest to bypass its producer.

`scripts/catalog.mjs` declares repository document paths, schemas, publication keys, and generator ownership. A generated-output check reports the command required to refresh stale files.

## Network and credentials

Ordinary validation needs no Cloudflare credentials. `GITHUB_TOKEN` is optional for authenticated GitHub discovery and health checks. Wiki checks use public upstream data unless notification mode is explicitly requested.

R2 writes require `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. `R2_BUCKET`, `R2_ENDPOINT`, and `R2_PUBLIC_HOST` override the registered defaults for tests or an alternate environment. Keep credentials out of commands, logs, fixtures, and committed files.

Do not run publication, withdrawal, prune, or write-mode refresh commands as exploratory checks. Their authority and ordering are documented in [Operations and publishing](operations.md).

## Sources of truth

- [Node.js version](../.node-version)
- [Package scripts and pnpm version](../package.json)
- [Shared CI toolchain setup](../.github/actions/setup-library-tools/action.yml)
- [Publish validation workflow](../.github/workflows/publish.yml)
