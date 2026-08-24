# Operations and publishing

This guide covers local validation, upstream refresh, locked-asset recovery, and Cloudflare R2 publication.

## Requirements

- Node.js 24.19.0 LTS, pinned in `.node-version`
- pnpm 11.23.0, pinned in `package.json`
- PowerShell 7 and Windows for PE and Authenticode inspection
- Reviewed Zstandard 1.5.7 runtime for DLL transport generation
- R2 credentials only for explicit publication commands

Install dependencies once:

```powershell
pnpm install --frozen-lockfile
```

## Quality gates

| Command                          | Purpose                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm run check`                 | Complete validation, deterministic generation, tests, Wiki checks, and add-on checks |
| `pnpm run check:offline`         | Network-free formatting, schema, generation, provider-lock, and unit-test subset     |
| `pnpm run docs:check`            | Markdown lint plus local link, anchor, and image-alt validation                      |
| `pnpm run test:authenticode`     | Windows signature, timestamp, PE parser, RVA, and export-table tests                 |
| `pnpm run libraries:check`       | Confirm that generated library snapshots and index are current                       |
| `pnpm run check:published-json`  | Compare every served JSON file with local bytes by SHA-256                           |
| `pnpm run check:upstream-health` | Probe committed upstream pins; intended for scheduled automation                     |
| `pnpm run check:wiki-drift`      | Check RenoDX and Luma Wiki drift without writing                                     |

`pnpm run check` is the required local gate before committing catalog changes. Signature-inspector, PE-parser, timestamp-verifier, or Xiph source-verification changes also require `pnpm run test:windows` on Windows.

## Generating catalogs

Refresh commands update provider locks and local content-addressed assets. They do not implicitly regenerate the public library catalog.

```powershell
pnpm run libraries:generate
pnpm run generate:reshade
pnpm run generate:renodx
pnpm run generate:luma
```

Keeping refresh and generation separate makes lock changes reviewable before they affect public snapshots or the index.

## Refreshing library providers

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
pnpm run withdraw:microsoft -- --package-id=Microsoft.Direct3D.DXC --version=1.0.0-preview
pnpm run prune:microsoft -- --package-id=Microsoft.Direct3D.DXC --version=1.0.0-preview
```

Microsoft discovery reads every NuGet V3 Registration page and imports every `listed` stable and preview release into one v1 vendor snapshot. Import verifies NuGet SHA-512, the exact package ID and version from the single root `.nuspec`, package layout, legal documents, PE metadata, and Authenticode. Architectures and runtime members are explicit capabilities: DXC x86 and `dxil.dll` may be absent when upstream does not ship them, while `dxcompiler.dll` remains required.

The Microsoft implementation keeps network discovery, archive validation, lock/tombstone policy, and public projection in separate modules behind the stable `microsoft-nuget.mjs` facade. Withdrawal and prune share one CLI identity parser and one catalog-state loader, so direct and unified commands apply the same validation.

Reviewed total-release and preview-release floors make an incomplete Registration response fail closed. These are coverage safeguards, not retention caps: every additional listed release is still imported, and a confirmed withdrawal continues to satisfy historical coverage through its tombstone.

Refresh is append-only. An active release becoming `unlisted`, or disappearing together with a 404 from its exact flat-container endpoint, stops refresh and requires the audited `withdraw microsoft` command. The command defaults to a verified dry-run; `--write` moves the active record to an immutable tombstone and replaces the lock, all vendor snapshots, and the v1 index as one rollback-protected batch. Security/legal withdrawals additionally require trimmed printable `--reason` and `--evidence`; the evidence is persisted in the tombstone and repeated in the reviewed PR.

`prune microsoft` also defaults to dry-run. `--execute` first proves that R2 contains the exact local index commit point and that its Microsoft snapshot no longer references the release. It then deletes only DLL transport keys named by that tombstone and unused by every active release. Shared blobs and legal documents are retained, and repeating the operation is safe.

For production, use the **Microsoft NuGet withdrawal** workflow: `withdraw`
creates the reviewed tombstone/catalog PR, while `prune` is run only after that
PR has merged and the normal publish workflow has switched the v1 index. Refresh,
publish, withdrawal, and prune share the `libraries-production-r2` concurrency
group; prune additionally verifies the exact remote index and immutable Microsoft
snapshot before deleting any unreferenced transport object.

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

The scheduled GitHub workflow processes every registered release-tree source as one catalog update. It completes all providers before writing locks, generates the shared index once, uploads immutable assets, and opens one pull request. This prevents providers from racing to update the same index commit point.

### Xiph Ogg and Vorbis

```powershell
pnpm run refresh:xiph:check
pnpm run refresh:xiph:write
pnpm run build:xiph
pnpm run finalize:xiph
pnpm run validate:xiph
```

The Xiph path builds executable upstream source and is intentionally Windows- and toolchain-specific. `refresh:xiph:check` discovers reviewed stable source history without writing. Write mode records a bounded pending set; build and finalization then produce the matrix and bind its exact source, recipe, policy, toolchain, artifact, and transport evidence.

The scheduled Xiph workflow is the normal publication path. It builds each source pair twice, verifies reproducibility and the full binary policy, exports bounded CI bundles, and revalidates those bundles without executing them in the asset-publication and pull-request jobs. Immutable assets are uploaded before the catalog pull request opens. Use exceptional rebuild mode only when a reviewed source tuple must receive a new explicit build revision.

## Refreshing add-ons

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
- Publication commands do not delete obsolete root keys. The separately authorized Microsoft prune operation deletes only tombstone-scoped, globally unreferenced transport objects after proving the production commit point.

## Automation

| Workflow                          | Responsibility                                                            |
| --------------------------------- | ------------------------------------------------------------------------- |
| `publish.yml`                     | Validate every change to `main`, then publish current JSON                |
| `microsoft-nuget-refresh.yml`     | Discover and import Microsoft runtime releases on Windows                 |
| `github-release-tree-refresh.yml` | Refresh AMD, Intel, and Valve through the shared GitHub importer          |
| `xiph-source-refresh.yml`         | Build and verify reviewed Xiph source pairs, upload assets, and open a PR |
| `microsoft-nuget-withdrawal.yml`  | Create reviewed Microsoft tombstones or prune after production switches   |
| `upstream-refresh.yml`            | Refresh ReShade stable data and open a pull request                       |
| `upstream-health.yml`             | Probe committed upstream assets                                           |
| `wiki-drift.yml`                  | Detect explicit RenoDX or Luma catalog drift and manage tracking issues   |

Scheduled refresh workflows open pull requests rather than pushing catalog changes directly to `main`.

### Bot pull requests

Pull requests opened with the default `GITHUB_TOKEN` do not trigger another `pull_request` workflow run. The ReShade workflow therefore runs the offline validation gate before opening its pull request, while merging to `main` still runs the full publication workflow.

If normal pull-request checks are required for bot-created pull requests, configure a fine-grained `BOT_GITHUB_TOKEN` with contents and pull-request permissions. The workflow already prefers that secret and falls back to `GITHUB_TOKEN`.

## Sources of truth

- [Package commands](../package.json)
- [Unified catalog CLI](../scripts/libraries.mjs)
- [Catalog and R2 registry](../scripts/catalog.mjs)
- [Publish workflow](../.github/workflows/publish.yml)
- [Microsoft withdrawal workflow](../.github/workflows/microsoft-nuget-withdrawal.yml)
- [Xiph source refresh workflow](../.github/workflows/xiph-source-refresh.yml)
