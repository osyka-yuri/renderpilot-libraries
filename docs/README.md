# RenderPilot Libraries documentation

This directory is the documentation hub for the RenderPilot catalog producer. Start with development setup for a new checkout. Read the catalog model before changing a public schema or generated document, and read the operations guide before importing upstream data or touching Cloudflare R2.

## Developer guide

- [Development setup](setup.md) covers the pinned Node.js and pnpm versions, installation, local gates, Windows-only checks, and environment variables.
- [Architecture](architecture.md) describes authoring inputs, provider adapters, validation, deterministic generation, immutable storage, and the RenderPilot consumer boundary.
- [Library catalog](library-catalog.md) documents public topology, release and artifact identity, provenance, signatures, legal documents, Xiph source builds, and generation invariants.
- [Add-on catalogs](addon-catalogs.md) documents RenoDX, Luma, and ReShade contracts, reviewed guidance, matching rules, and Wiki synchronization.
- [Operations and publishing](operations.md) covers generation, provider refresh, withdrawal, pruning, scheduled automation, and the R2 commit protocol.

Provider-specific authoring notes live beside the data they govern:

- [RenoDX curation](../catalogs/addons/renodx/PUBLISHING.md)
- [Luma curation](../catalogs/addons/luma/PUBLISHING.md)
- [ReShade source catalogs](../catalogs/addons/reshade/PUBLISHING.md)

Public JSON Schemas remain authoritative for document shape. These guides explain maintained boundaries and contributor workflows; they do not replace schema validation or duplicate private implementation line by line.

## Sources of truth

- [Tooling package manifest](../package.json)
- [Catalog and publication registry](../scripts/catalog.mjs)
- [Publish workflow](../.github/workflows/publish.yml)
- [RenderPilot consumer repository](https://github.com/osyka-yuri/renderpilot)
