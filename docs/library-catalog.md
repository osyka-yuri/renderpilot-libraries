# Library Catalogue

The versioned library catalogue describes installable graphics-runtime packages, their exact upstream provenance, binary identity, compatibility metadata, legal documents, and compressed transport.

## Public Topology

| Object                                     | Purpose                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `libraries/v1/index.json`                  | Current vendor snapshot references and the catalogue commit point |
| `libraries/v1/vendors/<vendor>.json`       | Local generated projection of one vendor                          |
| `libraries/v1/vendors/<vendor>/<sha>.json` | Immutable R2 vendor snapshot addressed by its exact bytes         |
| `libraries/blobs/sha256/<sha>.dll.zst`     | Immutable compressed DLL transport                                |
| `libraries/legal/sha256/<sha>.<format>`    | Immutable raw licence or notice document                          |

The index binds every vendor snapshot by object key, SHA-256, and size. Publication verifies all referenced assets before making a new index visible.

## Sources

| Provider  | Source model                  | Reviewed input                                                                   |
| --------- | ----------------------------- | -------------------------------------------------------------------------------- |
| NVIDIA    | Curated                       | `catalogs/libraries/nvidia.json`                                                 |
| Microsoft | NuGet                         | `catalogs/libraries/microsoft-nuget.config.json` and `microsoft-nuget.lock.json` |
| AMD       | GitHub release tree + overlay | `amd-fidelityfx.{config,lock}.json` and `amd.overlays.json`                      |
| Intel     | GitHub release tree + overlay | `intel-xess.{config,lock}.json` and `intel.overlays.json`                        |
| Valve     | GitHub release tree           | `valve-openvr.{config,lock}.json`                                                |

The shared GitHub release-tree importer handles AMD, Intel, and Valve. Provider profiles define tag syntax, exact paths within a commit tree, package projection, and signature policy. Historical AMD and Intel overlays cover reviewed packages without a verified official GitHub-release identity; an overlay cannot replace or impersonate an official import.

## Identity Model

The catalogue keeps presentation, package revision, raw content, and transport identity separate.

### Release identity

`release.version` is the canonical package version used for display, ordering, candidate selection, and update-all behavior. `release.label` is an optional supplemental annotation displayed after the version. It must not repeat the package name or a leading segment of the version.

### Package revision

A versioned package revision binds install-relevant semantics:

- package ID;
- technology and variant;
- release version and channel;
- runtime target;
- provenance;
- ordered package members.

Presentation-only fields such as `display_name`, `release.label`, legal-document references, and extensions do not change the package revision.

### Content and transport

The raw DLL SHA-256 identifies the binary. Its Zstandard object has an independent transport SHA-256 and size. Recompressing an unchanged DLL creates a new transport identity rather than changing the DLL identity.

Transport generation is pinned to the reviewed Zstandard 1.5.7 runtime. `materialize-locked` may only reproduce the exact transport recorded in a lock. An intentional encoder change requires the explicit `migrate-transport` mode and a reviewed lock update.

### Legal documents

Each vendor snapshot contains a deduplicated `legal_documents` table. Packages reference applicable entries through sorted `legal_document_ids`.

- `license` is the package's primary licence text.
- `notice` carries attribution or additional third-party terms.
- An ID is exactly `<kind>.<content-sha256>`.
- The object extension must agree with the declared format.
- Raw content is limited to 16 MiB.
- Text must be valid UTF-8 without NUL bytes.
- PDF content must have a canonical PDF version header.

Legal documents are independently content-addressed and do not change an otherwise identical package revision.

## Upstream Provenance

Microsoft imports bind NuGet package and catalogue identities, including the package SHA-512. GitHub imports bind the official repository, release, tag reference, exact commit, Git blob SHA-1, and downloaded content SHA-256.

For an already known release, any unexpected change in tag, commit, package layout, or payload fails closed. Unknown stable tags or layouts also require an explicit profile decision instead of automatic normalization.

## Binary Inspection

The Windows inspector reads PE architecture, nullable file version, bounded named exports, and Authenticode data in one inspection flow.

| Provider  | Signature policy | PE version policy                     | Additional projection         |
| --------- | ---------------- | ------------------------------------- | ----------------------------- |
| Microsoft | Required         | Numeric version required              | Product-specific NuGet layout |
| AMD       | Required         | Numeric when used as release identity | FidelityFX package projection |
| Intel     | Required         | Numeric when used as release identity | XeSS package projection       |
| Valve     | Cutoff policy    | Nullable                              | Sorted OpenVR named exports   |
| NVIDIA    | Curated metadata | Curated                               | Explicit reviewed packages    |

Signed files must have Windows status `Valid` and a signer allowed by the provider profile. RFC 3161 timestamps are verified with `CryptVerifyTimeStampSignature`; legacy PKCS#9 countersignatures are verified with `CryptMsgVerifyCountersignatureEncodedEx` against the original signer digest.

Malformed CMS, signer mismatch, invalid cryptography, conflicting verified times, and unsupported timestamp structures always fail. `signed_at` is `null` only when no timestamp attribute exists.

OpenVR's policy can report historical unsigned DLLs only before the configured inclusive signature cutoff. A release at or after that cutoff must be validly signed. OpenVR also publishes sorted named exports for RenderPilot's export-surface compatibility guard and preserves every official release package even when releases share the same DLL.

## Generation Invariants

The generator:

- reads only validated curated sources and provider locks;
- produces deterministic vendor snapshots and index bytes;
- preserves stable package IDs and ordered members;
- deduplicates physical assets by content;
- keeps distinct release identities where required;
- projects provider-neutral public contracts;
- never edits the frozen root `manifest.json`.

`scripts/catalog.mjs` is the repository and publication registry. Generators, validators, synchronizers, and remote checks obtain their explicit source paths, schemas, output paths, and R2 keys from that registry.
