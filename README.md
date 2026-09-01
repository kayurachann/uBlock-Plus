# uBlock Plus+

[Tiếng Việt](docs/README.vi.md) · [Compatibility](docs/FEATURE-MATRIX.md) · [Architecture](docs/ARCHITECTURE.md) · [Privacy](docs/PRIVACY.md)

uBlock Plus+ is an independent, sideload-first, GPL-3.0-or-later content-blocking platform for Chromium Manifest V3. It keeps the proven upstream filtering/compiler foundation while building a user-sovereign product around community filter repositories, explicit power-user modes and low-memory operation. Chrome Web Store submission is not a project goal.

> [!IMPORTANT]
> This is not an official uBlock Origin or uBO Lite release and is not endorsed by Raymond Hill. Public Chrome MV3 does not expose every blocking primitive available to the original MV2 extension. uBlock Plus+ documents those API gaps and uses separate, opt-in distribution modes where Chrome officially provides stronger capabilities; it does not bypass browser security controls or misrepresent feature parity.

## User sovereignty

- Core settings, subscriptions, repositories and custom filters can be exported and restored by the user.
- Any compatible HTTPS filter repository may be added; the built-in catalog is a convenience, not a lock-in mechanism.
- Core filtering permissions are documented; the separate `privacy` permission is optional, requested at the point of use and reversible.
- Remote filter lists are treated as data. Executable extension code remains packaged and reviewable.
- No network telemetry, advertising, analytics account or project-operated browsing-history service. Storage-size diagnostics remain local.

## Power distribution modes

| Mode | Installation | Purpose |
| --- | --- | --- |
| Power | Source build / Load unpacked | Default distribution with custom repositories, advanced user lists/scripts, DNR feedback diagnostics and portable core configuration. |
| Enterprise | Organization policy | May use policy-only Chrome capabilities such as `webRequestBlocking` where administrators explicitly deploy them. |
| Native companion | Optional separate open-source install | Future DNS/CNAME and local diagnostic capabilities unavailable to the public extension API; never required for core blocking. |

All modes share the same auditable filtering core. Sideloading removes Chrome Web Store policy constraints, but it does not remove Chrome's MV3 runtime quotas or security boundaries.

## Current foundation

- Static, dynamic and session Declarative Net Request rules.
- Cosmetic filtering and packaged scriptlets.
- Per-site filtering modes, strict blocking and popup blocking.
- Element picker, zapper and unpicker.
- Custom filters, imported lists, matched-rule diagnostics and backup/restore.
- Unpacked-only `declarativeNetRequestFeedback` access for richer matched-rule diagnostics.
- Automatic regional lists, including ABPVN for Vietnamese browser profiles.
- Optional privacy controls for hyperlink auditing, network prediction, non-proxied WebRTC UDP and Privacy Sandbox advertising APIs.
- Event-driven service worker with persistent state and no permanent MV2 background page.
- Native PowerShell and Linux build paths, release validation and pinned GitHub Actions dependencies.

The current MVP adds a packaged curated Filter Store, up to eight user-supplied HTTPS catalogs, source-integrity/provenance checks, quota-cost visibility, selectable Low-memory Mode and community feature governance. Custom repositories are not publisher-signed in this release and are always labeled Community. See the architecture and roadmap documents for measured status rather than relying on marketing claims.

## Build and sideload

Prerequisites: Chrome/Chromium or Edge 130+, Git with submodules, Node.js 22 or newer and network access for downloading filter-list data.

### Windows

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
.\tools\make-mv3.ps1 -Platform chromium -Version 1.0.0
```

### Linux/macOS

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
make mv3-chromium
```

Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, choose **Load unpacked**, and select `dist/build/uBOLite.chromium`. Then open the extension's **Details** page and, whenever the browser shows it, enable **Allow User Scripts** so cosmetic and packaged-scriptlet filters from imported lists can run. Release ZIP files and their SHA-256 checksum files are created under `dist/build/` with the `uBlock-Plus_` prefix.

## Development checks

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBOLite.chromium --release
```

The repository preserves upstream Git history and keeps [`gorhill/uBlock`](https://github.com/gorhill/uBlock) configured as a fetch-only `upstream` remote. See [NOTICE.md](NOTICE.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Licensed under the [GNU General Public License v3.0 or later](LICENSE.txt).
