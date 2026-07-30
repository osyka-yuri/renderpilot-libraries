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

`release.version` is the canonical NuGet/SemVer 2 package version used for display, ordering, candidate selection, and update-all behavior. It contains at least a three-segment numeric core and preserves a normalized prerelease suffix such as `1.721.2-preview`. One shared parser supplies canonical identity, ordering, numeric core, and the derived stable/preview channel to every provider. Build metadata may be accepted from upstream but is never persisted as part of catalogue identity. `release.label` is an optional supplemental annotation displayed after the version. It must not repeat the package name or a leading segment of the version.

Package versions and binary versions are deliberately separate. Exact numeric PE `FileVersion` metadata remains on the artifact and is used for runtime compatibility; it is never made prerelease-aware. During adoption of the canonical package-version contract, curated NVIDIA package IDs and generated AMD identities were migrated together with their normalized release versions. This one-time identity migration prevents an old receipt from colliding with a canonical active package while leaving DLL hashes, PE versions, and upstream provenance unchanged.

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

Microsoft imports bind the full normalized NuGet package version (including prerelease suffix), release channel, catalogue identity, and package SHA-512. The exact package ID and version are also verified against the archive's single root `.nuspec`. Stable and preview releases share the Microsoft v1 snapshot but always have distinct package/revision identities. GitHub imports bind the official repository, release, tag reference, exact commit, Git blob SHA-1, and downloaded content SHA-256.

For an already known release, any unexpected change in tag, commit, package layout, or payload fails closed. Unknown tags or layouts also require an explicit profile decision instead of automatic normalization. NuGet prereleases never mutate into stable releases; each exact package version is an independent immutable identity.

## Binary Inspection

The Windows inspector reads PE architecture, nullable file version, bounded named exports, and Authenticode data in one inspection flow.

| Provider  | Signature policy | PE version policy                     | Additional projection         |
| --------- | ---------------- | ------------------------------------- | ----------------------------- |
| Microsoft | Required         | Numeric version required              | Product-specific NuGet layout |
| AMD       | Required         | Numeric when used as release identity | FidelityFX package projection |
| Intel     | Required         | Numeric when used as release identity | XeSS package projection       |
| Valve     | Cutoff policy    | Nullable                              | Sorted OpenVR named exports   |
| NVIDIA    | Curated metadata | Curated                               | Explicit reviewed packages    |

Signed files must have an embedded Authenticode signature with Windows status `Valid` and a signer allowed by the provider profile. Catalog signatures are a different trust source and are rejected rather than being mixed with embedded CMS metadata. RFC 3161 timestamps are verified with `CryptVerifyTimeStampSignature`; legacy PKCS#9 countersignatures are verified with `CryptMsgVerifyCountersignatureEncodedEx` against the original signer digest. In both cases, the timestamp signer must match the trusted `TimeStamperCertificate` selected by Windows WinTrust for that embedded signature.

Malformed CMS, signer or timestamp-trust mismatch, invalid cryptography, conflicting verified times, and unsupported timestamp structures always fail. `signed_at` is `null` only when neither embedded timestamp attributes nor a Windows-trusted timestamp are present.

OpenVR's policy can report historical unsigned DLLs only before the configured inclusive signature cutoff. A release at or after that cutoff must be validly signed. OpenVR also publishes sorted named exports for RenderPilot's export-surface compatibility guard and preserves every official release package even when releases share the same DLL.

## Generation Invariants

The generator:

- reads only validated curated sources and provider locks;
- produces deterministic vendor snapshots and index bytes;
- preserves canonical stable/preview package IDs and ordered members after the documented identity migration;
- deduplicates physical assets by content;
- keeps distinct release identities where required;
- projects provider-neutral public contracts;
- prepares every vendor snapshot and the index as one immutable generation plan;
- orders vendor outputs lexicographically and keeps the index last as the publication commit point;
- writes the exact prepared UTF-8 bytes from that plan;
- stages every output before replacement and rolls back earlier replacements if the batch fails;
- never edits the frozen root `manifest.json`.

`scripts/catalog.mjs` is the repository and publication registry. Generators, validators, synchronizers, and remote checks obtain their explicit source paths, schemas, output paths, and R2 keys from that registry.

Before production pruning, the R2 guard verifies the exact index bytes and validates
every referenced vendor snapshot against the same catalog validators. A malformed or
identity-mismatched snapshot therefore stops pruning before the global transport
reference graph is evaluated.
