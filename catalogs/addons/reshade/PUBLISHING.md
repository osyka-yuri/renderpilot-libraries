# ReShade source catalogues

`addons/v1/reshade.json` is the only current ReShade source catalogue. Current
Luma and RenoDX v1 documents contain tool data only and do not embed these URLs.
The v1 schema requires `channels.nightly` and permits `channels.stable` to be
absent; the current generator intentionally continues to publish both.

`reshade_manifest.json` and the `reshade` block in `renodx_manifest.json` are
generated compatibility projections for already released clients. Keep both
root documents, their schemas, and their R2 publication entries until a
separately announced end of life; do not edit them by hand.

RenderPilot also ships a release-pinned copy of `addons/v1/reshade.json` as a
last-resort offline fallback. That snapshot is refreshed when the application
is released or when source-schema/security policy changes. It is not expected
to follow every CDN refresh between application releases.
