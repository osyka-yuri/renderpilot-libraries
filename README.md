<div align="center">
  <img src="https://raw.githubusercontent.com/osyka-yuri/renderpilot/main/apps/desktop/public/icon.svg" alt="RenderPilot logo" width="112" height="112">
  <h1>RenderPilot Libraries</h1>
  <p><strong>Reviewed, reproducible library and add-on catalogs for RenderPilot.</strong></p>
  <p>RenderPilot Libraries tracks exact upstream releases, verifies installable artifacts, generates deterministic public contracts, and publishes immutable assets for the RenderPilot application.</p>
  <p>
    <a href="https://github.com/osyka-yuri/renderpilot-libraries/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/osyka-yuri/renderpilot-libraries/publish.yml?branch=main&style=flat-square&label=Catalog" alt="Catalog workflow status"></a>
    <img src="https://img.shields.io/badge/Node.js-24.19.0_LTS-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.19.0 LTS">
    <img src="https://img.shields.io/badge/Schema-v1-4a9eff?style=flat-square" alt="Catalog schema v1">
  </p>
  <p>Application code lives in the <a href="https://github.com/osyka-yuri/renderpilot">main RenderPilot repository</a>.</p>
</div>

## What RenderPilot Libraries does

This repository is the catalog producer for RenderPilot. It keeps reviewed source data, immutable provider locks, public schemas, generated manifests, and the tooling that connects them.

- **Tracks exact upstream identities.** Provider records bind releases to reviewed package, tag, commit, archive, and source-tree evidence instead of mutable download pages alone.
- **Verifies installable artifacts.** Validation covers hashes, PE metadata, architecture, exports, Authenticode policy, legal documents, and provider-specific layout rules.
- **Generates deterministic catalogs.** Library vendor snapshots, the shared index, and add-on manifests are rebuilt from declared authoring sources and checked into the repository for review.
- **Publishes in dependency order.** Content-addressed assets and immutable vendor snapshots are uploaded and verified before `libraries/v1/index.json` becomes the new catalog commit point.
- **Separates discovery from publication.** Refresh, materialization, generation, review, and R2 publication remain explicit operations with different authority and failure modes.

The root `manifest.json` is frozen for legacy clients. Current RenderPilot builds consume the versioned `libraries/v1` and `addons/v1` contracts.

## Published ecosystem

| Group     | Cataloged components                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| NVIDIA    | DLSS Super Resolution, Frame Generation, Ray Reconstruction, and related runtime packages |
| AMD       | FidelityFX packages imported from reviewed GitHub release trees and historical overlays   |
| Intel     | XeSS packages imported from reviewed GitHub release trees and historical overlays         |
| Microsoft | DirectStorage, DXC, and D3D12 Agility SDK packages imported from NuGet                    |
| Valve     | OpenVR runtime packages with export-surface metadata                                      |
| Xiph      | Reproducible Windows builds of reviewed Ogg and Vorbis source pairs                       |
| Add-ons   | RenoDX, Luma Framework, and ReShade source manifests                                      |
| Settings  | NVIDIA DLSS preset and settings contracts                                                 |

Every installable file and legal document is content-addressed. A published vendor snapshot is immutable; the index references it by object key, SHA-256, and size. RenderPilot therefore observes either the previous complete library catalog or the next complete catalog, never a partially published generation.

## Get started

The repository pins the latest Node.js LTS release in [`.node-version`](.node-version) and pnpm in [`package.json`](package.json). Install the pinned pnpm version explicitly on a fresh machine. PowerShell 7 and Windows are additionally required for PE inspection, Authenticode verification, and reproducible Xiph builds.

```powershell
npm install --global pnpm@11.23.0
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` is the complete repository gate. It validates formatting and documentation, schemas, provider locks, generated output, unit tests, upstream Wiki synchronization, slugs, and add-on payload layouts. Use `pnpm run check:offline` for the deterministic network-free subset.

Refresh and publication commands can write reviewed catalog state or remote objects. Read the [operations and publishing guide](docs/operations.md) before running them.

## Repository map

| Path                  | Responsibility                                                                  |
| --------------------- | ------------------------------------------------------------------------------- |
| `catalogs/libraries/` | Reviewed provider configuration, immutable locks, curated sources, and overlays |
| `catalogs/addons/`    | RenoDX, Luma, and ReShade authoring data, generators, schemas, and tests        |
| `libraries/v1/`       | Generated library index and local vendor snapshot projections                   |
| `addons/v1/`          | Generated add-on manifests consumed by RenderPilot                              |
| `cdn/`                | Local content-addressed DLL transports and legal documents                      |
| Root JSON files       | Frozen legacy data plus current DLSS preset and settings contracts              |
| `schemas/`            | Public and authoring JSON Schemas                                               |
| `scripts/`            | Validation, generation, import, inspection, refresh, and publication tooling    |
| `.github/workflows/`  | Validation, scheduled refresh, withdrawal, and R2 publication automation        |

## Documentation and project

- [Documentation hub](docs/README.md) — setup, architecture, catalog contracts, curation, and production operations.
- [Contributing](CONTRIBUTING.md) — the shortest path from a local checkout to a reviewable change.
- [Library catalog model](docs/library-catalog.md) — identities, provenance, signatures, legal documents, transport, and generation invariants.
- [Add-on catalogs](docs/addon-catalogs.md) — published contracts, authoring boundaries, curation, and Wiki synchronization.
- [Operations and publishing](docs/operations.md) — quality gates, refresh modes, automation, withdrawal, pruning, and R2 safety.
- [RenderPilot](https://github.com/osyka-yuri/renderpilot) — the desktop application and source-only CLI that consume these contracts.
- [Public library index](https://pub-48612a35034d40f88f42b4181547925a.r2.dev/libraries/v1/index.json) — the current production commit point.

Catalog data does not transfer ownership of third-party components. Upstream projects retain their own licenses, support policies, compatibility requirements, and distribution terms.
