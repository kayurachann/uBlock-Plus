# uBlock MV3 Community

[Tiếng Việt](docs/README.vi.md) · [Feature compatibility](docs/FEATURE-MATRIX.md) · [Architecture](docs/ARCHITECTURE.md) · [Privacy](docs/PRIVACY.md)

An independent, GPL-3.0-or-later community fork of the current uBlock Origin codebase, focused on a transparent and maintainable Manifest V3 build for Chromium.

> [!IMPORTANT]
> This project is not an official uBlock Origin or uBO Lite release and is not endorsed by Raymond Hill. Chrome MV3 does not expose the blocking APIs needed for exact uBlock Origin MV2 parity. This fork aims for the closest reliable behavior the public MV3 platform permits and documents the gaps instead of claiming 1:1 compatibility.

## What is included

- Declarative network blocking through bundled static rulesets and runtime dynamic/session rules.
- Cosmetic filtering, packaged scriptlets, per-site filtering modes, strict blocking, popup blocking, element picker/zapper, custom filters, imported lists, backup/restore, and matched-rule diagnostics.
- A thin event-driven service worker with persisted state; request filtering stays in Chrome's DNR engine.
- Optional Chrome privacy controls for hyperlink auditing, network prediction, WebRTC non-proxied UDP, and Privacy Sandbox advertising APIs. The `privacy` permission is optional and requested only from the settings page.
- Automatic language-appropriate regional lists, including ABPVN when the browser language is Vietnamese.
- Reproducible source builds on Linux and a native PowerShell build path on Windows.

The implementation is based on upstream's actively maintained `platform/mv3` architecture rather than a manifest-only conversion of the old MV2 release bundle.

## Build

Prerequisites: Git with submodules, Node.js 22 or newer, and network access for downloading filter-list data.

### Windows (PowerShell)

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-MV3-Community.git
cd uBlock-MV3-Community
.\tools\make-mv3.ps1 -Platform chromium
```

### Linux/macOS

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-MV3-Community.git
cd uBlock-MV3-Community
make mv3-chromium
```

The unpacked Chromium extension is generated at `dist/build/uBOLite.chromium`. Load it from `chrome://extensions` by enabling Developer mode and choosing **Load unpacked**.

Filter lists are live external inputs and the build creates a local cache/secret, so separate builds are functionally equivalent but are not expected to be byte-for-byte identical.

## Development

```bash
npm ci
npm run lint
npm test
```

Run the MV3 validator against an assembled extension:

```bash
node tools/validate-mv3.mjs dist/build/uBOLite.chromium
```

The CI workflow builds the extension, validates its manifest and DNR resources, and uploads the unpacked artifact. Do not use the upstream store-publishing targets: this fork has no access to official uBlock Origin store identities or signing keys.

## Upstream and attribution

This repository preserves the full upstream Git history and keeps [`gorhill/uBlock`](https://github.com/gorhill/uBlock) configured as `upstream`. See [NOTICE.md](NOTICE.md) for attribution and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change.

Licensed under the [GNU General Public License v3.0 or later](LICENSE.txt).
