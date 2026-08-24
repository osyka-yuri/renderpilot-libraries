# Architecture

RenderPilot Libraries is a producer repository. It converts reviewed upstream evidence and curated metadata into versioned JSON contracts plus immutable downloadable objects. The main RenderPilot repository is the consumer and does not own catalog generation.

## Responsibility layers

| Layer                | Owned state                               | Primary responsibility                                                                  |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Authoring            | `catalogs/libraries/`, `catalogs/addons/` | Reviewed sources, provider policy, immutable locks, overlays, and curation              |
| Contract             | `schemas/`, add-on-local schemas          | Public and authoring document shape                                                     |
| Tooling              | `scripts/`                                | Discovery, import, inspection, validation, generation, synchronization, and publication |
| Generated projection | `libraries/v1/`, `addons/v1/`             | Reviewable documents derived from declared sources                                      |
| Immutable content    | `cdn/`, content-addressed R2 keys         | DLL transports, legal documents, and immutable vendor snapshots                         |
| Commit point         | `libraries/v1/index.json`                 | The current complete library generation visible to consumers                            |

`scripts/catalog.mjs` is the central registry for document paths, schemas, generated outputs, R2 keys, provider kinds, and the public host. Validation and publication import this registry instead of maintaining parallel path lists.

## Library catalog flow

1. A provider adapter discovers or reads an exact upstream release identity.
2. Import validates the reviewed layout and captures immutable provenance.
3. Windows inspection records PE architecture, file version, exports, imports, and signature evidence where the provider contract requires them.
4. Raw binaries and legal documents receive independent content identities; compressed DLL transport receives its own identity.
5. Deterministic generation projects provider-neutral vendor snapshots and the shared index.
6. Publication uploads and verifies content-addressed prerequisites, then immutable vendor snapshots, then publishes the index last.

NVIDIA and Xiph use curated source models. Microsoft uses NuGet Registration plus exact package validation. AMD, Intel, and Valve share the GitHub release-tree importer with provider-specific profiles and optional reviewed overlays.

## Add-on catalog flow

RenoDX and Luma separate upstream Wiki snapshots from explicit RenderPilot curation. Match overlays and curated profiles decide which records can become installable. Unresolved identities remain pending review rather than entering a public manifest.

ReShade source channels are generated from the reviewed source module. Stable refresh may update that module and its generated manifest through a pull request; nightly remains a rolling source by contract.

Generated add-on manifests expose only reviewed structured guidance. Raw Wiki notes and local unmatched-review output are not public contracts.

## Identity and mutability boundaries

- Upstream URLs are discovery inputs; locks preserve the exact package, tag, commit, archive, tree, or content evidence accepted by review.
- Raw DLL identity and compressed transport identity are separate. Recompression cannot silently masquerade as the same transport object.
- Vendor snapshots published under content-addressed keys are immutable.
- `libraries/v1/index.json` is mutable only as the final commit point for a complete generation.
- The root `manifest.json` is a frozen legacy document and is not regenerated or published by current tooling.
- Generated repository files are review surfaces, not alternative authoring sources.

## Failure boundaries

Unexpected upstream identity, layout, signature, version, hash, legal-document, or generation drift fails before publication. Publication verifies remote prerequisites before switching the index. Microsoft withdrawal separates the reviewed catalog tombstone from later transport pruning, and pruning proves that the production index no longer references the release before deleting an object.

Scheduled refresh workflows open pull requests for catalog state. They do not bypass review by pushing source changes directly to `main`.

## Consumer boundary

RenderPilot pins an immutable revision of this producer repository for contract validation. Application behavior, fallback snapshots, and runtime mutation safety remain owned by the main repository. This repository owns only the data and producer guarantees described here; a catalog entry is not permission to modify a game or a replacement for upstream compatibility guidance.

## Sources of truth

- [Catalog and publication registry](../scripts/catalog.mjs)
- [Library generation](../scripts/generate-library-catalog.mjs)
- [Library publication phases](../scripts/lib/r2-publication.mjs)
- [Publish workflow](../.github/workflows/publish.yml)
- [RenderPilot quality workflow](https://github.com/osyka-yuri/renderpilot/blob/main/.github/workflows/quality.yml)
