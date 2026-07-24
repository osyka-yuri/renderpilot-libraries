# Operations and Publishing

This guide covers local validation, upstream refresh, locked-asset recovery, and Cloudflare R2 publication.

## Requirements

- Node.js 24.18.0, pinned in `.node-version`
- pnpm 11
- PowerShell 7 and Windows for PE and Authenticode inspection
- Reviewed Zstandard 1.5.7 runtime for DLL transport generation
- R2 credentials only for explicit publication commands

Install dependencies once:

```powershell
pnpm install
```

## Quality Gates

| Command                          | Purpose                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm run check`                 | Complete validation, deterministic generation, tests, Wiki checks, and add-on checks |
| `pnpm run check:offline`         | Network-free formatting, schema, generation, provider-lock, and unit-test subset     |
| `pnpm run test:authenticode`     | Windows signature, timestamp, PE parser, RVA, and export-table tests                 |
| `pnpm run libraries:check`       | Confirm that generated library snapshots and index are current                       |
| `pnpm run check:published-json`  | Compare every served JSON file with local bytes by SHA-256                           |
| `pnpm run check:upstream-health` | Probe committed upstream pins; intended for scheduled automation                     |
| `pnpm run check:wiki-drift`      | Check RenoDX and Luma Wiki drift without writing                                     |

`pnpm run check` is the required local gate before committing catalogue changes. Signature-inspector, PE-parser, or timestamp-verifier changes also require `pnpm run test:authenticode` on Windows.

## Generating Catalogues

Refresh commands update provider locks and local content-addressed assets. They do not implicitly regenerate the public library catalogue.

```powershell
pnpm run libraries:generate
pnpm run generate:reshade
pnpm run generate:renodx
pnpm run generate:luma
```

Keeping refresh and generation separate makes lock changes reviewable before they affect public snapshots or the index.

## Refreshing Library Providers

The unified CLI has explicit provider and operation arguments:

```text
libraries refresh <microsoft|github|amd|intel|openvr> <mode>
```

| Mode                    | Contract                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `--check`               | Discover upstream drift without changing files                                                 |
| `--write`               | Import reviewed new releases and update locks                                                  |
| `--materialize-locked`  | Recover missing local assets while reproducing the exact locked identities                     |
| `--migrate-transport`   | Explicitly replace compressed transport identity after an intentional encoder-policy change    |
| `--backfill-signatures` | Explicit metadata migration from a missing timestamp to a cryptographically verified timestamp |

### Microsoft

```powershell
pnpm run refresh:microsoft:check
pnpm run refresh:microsoft:write
pnpm run materialize:microsoft
pnpm run migrate:microsoft-transport
pnpm run backfill:microsoft-signatures
```

Microsoft discovery reads NuGet V3 Registration and Catalog Details and accepts listed stable releases only. Import verifies NuGet SHA-512, exact package layout, legal documents, PE metadata, and Authenticode. DXC x86 is optional per upstream package, but any published architecture must contain a complete `dxcompiler.dll` and `dxil.dll` pair.

### AMD, Intel, and Valve

```powershell
pnpm run refresh:github:check
pnpm run refresh:github:write
pnpm run materialize:github
pnpm run migrate:github-transport
pnpm run backfill:github-signatures

pnpm run refresh:amd:check
pnpm run refresh:amd:write
pnpm run materialize:amd

pnpm run refresh:intel:check
pnpm run refresh:intel:write
pnpm run materialize:intel

pnpm run refresh:openvr:check
pnpm run refresh:openvr:write
pnpm run materialize:openvr
pnpm run backfill:openvr-signatures
```

The provider-neutral GitHub engine discovers every stable, non-draft, non-prerelease release with pagination. It retains the exact tag-ref and commit identities, imports only reviewed paths, and verifies Git blob SHA-1 plus content SHA-256 before atomic persistence.

The scheduled GitHub workflow processes every registered release-tree source as one catalogue update. It completes all providers before writing locks, generates the shared index once, uploads immutable assets, and opens one pull request. This prevents providers from racing to update the same index commit point.

## Refreshing Add-ons

```powershell
pnpm run refresh:reshade:check
pnpm run refresh:reshade:write

pnpm run sync:renodx-wiki:check
pnpm run sync:renodx-wiki
pnpm run match-pending:renodx

pnpm run sync:luma-wiki:check
pnpm run sync:luma-wiki
pnpm run match-pending:luma
```

Wiki write commands regenerate their corresponding manifests. `match-pending` creates local review output only; it never silently publishes an installable match.

## Publication

Publication follows a strict order:

1. validate local compressed DLLs and legal-document identities;
2. upload immutable content-addressed assets;
3. upload immutable vendor snapshots;
4. verify every referenced asset remotely by size and SHA-256 metadata;
5. publish `libraries/v1/index.json` last as the commit point.

| Command                         | Behavior                                                     |
| ------------------------------- | ------------------------------------------------------------ |
| `pnpm run publish`              | Validate and publish assets, snapshots, and index            |
| `pnpm run publish:assets`       | Upload locally available immutable DLL and legal assets only |
| `pnpm run publish:json:dry-run` | Preview JSON publication without writes                      |
| `pnpm run publish:json`         | Publish snapshots and index after remote asset verification  |
| `pnpm run check:published-json` | Fetch all served JSON and confirm byte-for-byte identity     |

Before the first v1 index publication, `publish:assets` must run from a workspace containing the complete migrated asset set. Later refresh jobs upload only newly materialized assets.

### Safety properties

- Published content-addressed objects are never overwritten with different bytes.
- Recompression creates a new transport object and requires an explicit lock migration.
- `publish:json` fails before the index if any remote prerequisite is absent or has unexpected metadata.
- Publication never mutates or deletes the frozen root `manifest.json` or legacy R2 objects.
- Current tooling does not delete obsolete root keys; remove them only after confirming that no client still fetches them.

## Automation

| Workflow                          | Responsibility                                                            |
| --------------------------------- | ------------------------------------------------------------------------- |
| `publish.yml`                     | Validate every change to `main`, then publish current JSON                |
| `microsoft-nuget-refresh.yml`     | Discover and import Microsoft runtime releases on Windows                 |
| `github-release-tree-refresh.yml` | Refresh AMD, Intel, and Valve through the shared GitHub importer          |
| `upstream-refresh.yml`            | Refresh ReShade stable data and open a pull request                       |
| `upstream-health.yml`             | Probe committed upstream assets                                           |
| `wiki-drift.yml`                  | Detect explicit RenoDX or Luma catalogue drift and manage tracking issues |

Scheduled refresh workflows open pull requests rather than pushing catalogue changes directly to `main`.

### Bot pull requests

Pull requests opened with the default `GITHUB_TOKEN` do not trigger another `pull_request` workflow run. The ReShade workflow therefore runs the offline validation gate before opening its pull request, while merging to `main` still runs the full publication workflow.

If normal pull-request checks are required for bot-created pull requests, configure a fine-grained `BOT_GITHUB_TOKEN` with contents and pull-request permissions. The workflow already prefers that secret and falls back to `GITHUB_TOKEN`.
