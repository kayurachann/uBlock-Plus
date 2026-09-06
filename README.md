<div align="center">

<img src="src/img/icon_128.png" width="80" height="80" alt="uBlock Plus+ extension icon">

# uBlock Plus+

**A community content blocker for Chromium Manifest V3**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml) [![Latest preview](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release)](https://github.com/kayurachann/uBlock-Plus/releases) [![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start) [![License](https://img.shields.io/badge/license-GPL--3.0--or--later-22863a)](LICENSE.txt)

[**English**](README.md) · [Deutsch](docs/README.de.md) · [Español](docs/README.es.md) · [Français](docs/README.fr.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md) · [Русский](docs/README.ru.md) · [Tiếng Việt](docs/README.vi.md) · [简体中文](docs/README.zh_CN.md) · [繁體中文](docs/README.zh_TW.md)

[Releases](https://github.com/kayurachann/uBlock-Plus/releases) · [Installation](#quick-start) · [User guide](#using-the-popup) · [Documentation](docs/README.md) · [Report a problem](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)

</div>

uBlock Plus+ blocks unwanted network requests and page elements using Chromium's declarative filtering engine, cosmetic filters and packaged scriptlets. It builds on the filtering and MV3 components of [uBlock Origin](https://github.com/gorhill/uBlock), with a familiar site power button, custom filters, a community Filter Store and local backup/restore.

> [!IMPORTANT]
> This is an independent community fork, not an official uBlock Origin or [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) release, and it is not endorsed by Raymond Hill. Distribution is currently a **manually installed pre-release**. MV3 imposes browser limits; this project does not claim complete MV2 parity. The published preview and the latest source can differ—see [which build to install](#which-build-to-install).

## Contents

- [Features and screenshots](#features-and-screenshots)
- [Quick start, updates and removal](#quick-start)
- [Using the popup](#using-the-popup)
- [Filter lists and personal filters](#filter-lists-and-personal-filters)
- [Settings and backups](#settings-and-backups)
- [Permissions and privacy](#permissions-and-privacy)
- [What MV3 can and cannot do](#what-mv3-can-and-cannot-do)
- [Build and validate](#build-and-validate)
- [Troubleshooting](#troubleshooting)
- [Documentation and contributions](#documentation-and-contributions)
- [Credits and license](#credits-and-license)

## Features and screenshots

| Area | Available in this fork |
| --- | --- |
| Network filtering | Packaged static DNR lists, supported imported/custom rules, exceptions and packaged redirect resources. |
| Page filtering | Site-specific and generic cosmetic filtering, supported procedural filters and packaged scriptlets. |
| Site controls | Power Off/On with remembered filtering level, Basic/Optimal/Complete modes and hostname-scoped popup policies. |
| Element tools | Picker for persistent cosmetic filters, zapper for temporary removal and unpicker for saved matching filters. |
| Filter management | Built-in lists, HTTPS imports, Filter Store bundles and compatible community catalogs. |
| Settings | Protection presets, themes, density, memory profiles, optional browser privacy controls and backup/restore. |
| Diagnostics | Local, bounded diagnostics with MV3-specific limits; no claim of a complete live request logger. |

The screenshots below show the **actual unpacked extension in Google Chrome 152.0.7977.76 on Windows**, captured on 6 September 2026. They use isolated profiles and demonstration pages; they are not concept mockups. UI language in the screenshots is English. [Image provenance](docs/assets/readme/README.md).

<p align="center">
<img src="docs/assets/readme/popup-expanded.png" width="340" alt="Actual Chrome popup with site power, filtering capabilities, mode selector and popup policy">
<br><strong>Site controls</strong><br>Power, filtering level and tools in one popup. Scroll to reach the footer when expanded.
</p>

<details>
<summary><strong>View the dark theme with fewer details</strong></summary>

<p align="center">
<img src="docs/assets/readme/popup-compact.png" width="340" alt="Actual Chrome popup in a dark theme with details collapsed">
<br><strong>Fewer details</strong><br>Dark theme with details collapsed. More/Less changes the amount of information; density is a separate appearance setting.
</p>

</details>

## Quick start

### Which build to install

The manifest declares **Chromium 130 or newer**. The latest documented native-browser test is on Google Chrome 152; that result is not certification of every Chromium derivative or version. This repository's release pipeline targets Chromium MV3, not a Firefox or Safari package.

As checked on **6 September 2026**, [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases) provides the **v1.0.0 pre-release published on 1 September**. That ZIP predates the popup fixes and Chrome testing described in this README. For those changes, **build the current source or use an artifact from a successful Actions run** until a newer release is published. The CI badge reports the current workflow status; a source commit being pushed does not by itself mean an artifact was produced.

For a CI build, open [MV3 Chromium Actions](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml), select a successful run for the desired commit, and download its `uBlock-Plus-chromium-<commit>` artifact. GitHub may require sign-in. Extract that outer artifact archive first to find the extension ZIP and matching checksum. CI artifacts are preview build outputs with limited retention; they do not update the public Release automatically.

### Install an unpacked build

1. Obtain `uBlock-Plus_*.chromium.zip` and its matching `.sha256` file from this repository's Releases, a successful CI artifact, or a [source build](#build-and-validate).
2. Verify the checksum, then extract the ZIP into a permanent folder. On Windows, a short path such as `C:\Extensions\uBlock-Plus` helps avoid long-path problems.
3. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
4. Turn on **Developer mode**, select **Load unpacked**, and choose the folder that directly contains `manifest.json`. Do not select the ZIP or its parent folder.
5. Pin the extension from the browser's Extensions menu and open an ordinary HTTP/HTTPS page to try the popup.
6. For supported imported/user-script filters, enable the browser's user-script capability when required. On Chrome 138+, this is **Details → Allow User Scripts**. Chrome 130–137 uses **Developer mode**. After changing the switch, reload the extension so its worker sees the new API state. See the official [Chrome userScripts instructions](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

<details>
<summary><strong>Check the SHA-256 on Windows</strong></summary>

Run these commands in the download folder, adjusting the version if necessary:

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

The hexadecimal values must match; letter case does not matter. Compare against the checksum supplied with the **same build**.

</details>

### Update or remove

An unpacked installation **does not auto-update** through the Chrome Web Store. Export a backup from **Dashboard → Settings**, close affected tabs if needed, verify and extract the replacement build, then replace the contents of the same extension folder. Preserve the folder path and click **Reload** on its extension card. Reload websites to refresh already-injected scripts and cosmetic filters. Do not place the new build one folder deeper inside the old one.

To uninstall, optionally export a backup first, then select **Remove** on the browser's extensions page. Deleting the source folder alone is not an uninstall. Reinstalling from a different folder can create a different unpacked extension identity; use your backup when migrating.

## Using the popup

### Power and filtering modes

Click the large power button to turn protection Off for the current site's supported hostname scope. Click it again to restore the previous positive filtering level. The remembered level survives closing the popup and restarting the service worker.

| Mode | Behavior |
| --- | --- |
| Off / None | Disable filtering for that site scope. Reload to remove effects already applied to the page. |
| Basic | Network filtering; stock extended cosmetic/scriptlet registrations are not enabled at this level. |
| Optimal | Network filtering plus site-specific cosmetic filtering and packaged scriptlets. |
| Complete | Optimal filtering plus generic cosmetic filtering. |

These levels select filtering behavior; choosing Basic does **not** revoke the manifest's existing `<all_urls>` permission. Global defaults are configured in the dashboard, while site exceptions take precedence where supported. A child-site override that cannot safely be represented returns an error instead of silently changing its parent or siblings.

Use **Reload** after changing protection. **More/Less** expands or collapses popup details; it does not change filtering. The popup supports keyboard Tab/Enter, and focus returns to the initiating control after a successful asynchronous change. Browser settings, extension pages and other restricted pages show unavailable tools.

### Popup policies

The popup policy applies to the **exact hostname**. It controls the contextual popup policy alongside filter-list rules and trusted-site settings.

| Policy | Meaning |
| --- | --- |
| Default (Smart) | Follow the configured default contextual policy. |
| Allow | Allow through the contextual policy. **Matching compiled filter-list rules can still block.** |
| Smart | Consider opener, destination, trusted interaction and popup bursts. Missing information is handled conservatively. |
| Strict | Require a trusted user action and a directly related hostname. A legitimate cross-site sign-in or payment window may need a different policy. |

Site protection Off takes precedence. Recent popup counts refer to successful closures for the displayed site, not all browser requests. MV3 observation is asynchronous, so a target may begin opening before an eligible rule closes it. [Popup behavior and guarantees](docs/MV3-POPUP-PARITY.md).

### Picker, zapper and unpicker

- **Picker:** select an element and create a persistent cosmetic filter; review the selection before saving.
- **Zapper:** remove an element from the current page temporarily. Reloading restores it.
- **Unpicker:** remove a saved custom filter matching a selected element; it is available when matching personal filters exist.
- **My filters / Site rules:** open the relevant dashboard pane directly, including when the dashboard is already open.

## Filter lists and personal filters

### Built-in lists and HTTPS imports

Open **Dashboard → Filter lists** to review enabled lists and add supported HTTPS subscriptions. The build packages upstream filter data into static rulesets. Imported lists are fetched and compiled locally into the supported MV3 subset; enabling more lists consumes browser rule budgets and can introduce overlapping rules or site breakage.

Start with the default selection and enable additional regional or specialized lists for a concrete need. Use a direct HTTPS list URL: redirects, invalid schemas and oversized or unsupported input can be rejected. A list's availability does not guarantee every MV2 filter in it can be implemented. If a replacement cannot be activated safely, the existing active rules are retained where the operation supports recovery.

<img src="docs/assets/readme/filter-lists.png" width="960" alt="Actual Chrome dashboard showing packaged filter lists and their enabled state">

### Filter Store

The **Filter Store** is a catalog of filter lists, not an extension or executable-code store. It contains packaged community entries and bundles, and accepts up to eight compatible HTTPS JSON catalogs. A catalog URL is different from a raw filter-list URL.

Inspect each entry's purpose, source, license and trust label before enabling it. `community` is not a project endorsement; a digest proves a specific data snapshot, not the quality of its filters. Custom catalogs remain community entries. See [catalog format and review rules](docs/FILTER-STORE.md).

<img src="docs/assets/readme/filter-store-current.png" width="960" alt="Actual Chrome Filter Store with community entries, bundles and quota information">

### My filters

The cosmetic filter section organizes saved selectors by hostname and supports text import/export. For example, a site-specific selector can hide a repeated sponsored card:

```text
example.com##.sponsored-card
```

This is an illustrative rule, not a list recommendation. Use the picker to choose a real element on the target page. The separate user-filter editor accepts supported filter syntax and requires the appropriate browser capability for user-script filters. It does not make arbitrary MV2 syntax or remote JavaScript executable under MV3.

<img src="docs/assets/readme/custom-filters.png" width="960" alt="Actual Chrome My filters pane with demonstration hostname-scoped cosmetic filters">

## Settings and backups

**Protection presets** and **memory profiles** are different settings:

| Setting | Options | Purpose |
| --- | --- | --- |
| Protection preset | Baseline, Balanced, Maximum, Low memory | Apply a group of filtering and runtime preferences. Review the selected settings after switching. |
| Filtering level | Basic, Optimal, Complete; Off for exceptions | Choose what filtering applies globally or to a site. |
| Memory profile | Auto, Balanced, Low-memory | Control compilation concurrency, cache budgets and cleanup. |
| Appearance | Theme, accent, density, popup details | Adjust presentation without changing the matching rules. |

> [!NOTE]
> Storage diagnostics measure extension storage/cache usage, **not live RAM or process memory**. Low-memory mode uses bounded caches and sequential compilation; no claim of a measured percentage reduction or a low-end-device benchmark is made.

Use **Dashboard → Settings** to export a backup before changing builds or resetting the extension. Restore validates supported configuration and includes filtering settings, remembered site levels, popup policies, personal filters and list/catalog configuration. Keep backup files private: they can reveal site names, custom rules and subscription URLs.

Restore is sequential rather than one global transaction. Invalid input fails validation, but a late browser or storage failure may leave earlier settings restored. Check the displayed result and your enabled lists afterward. **Reset** returns settings to defaults and clears imported-list state; it is not a substitute for making a backup.

<img src="docs/assets/readme/dashboard-settings.png" width="960" alt="Actual Chrome Settings pane showing protection presets and appearance controls">

## Permissions and privacy

Filtering and diagnostic storage are local. The extension includes no project analytics, advertising SDK or browsing-history upload service. It does make network requests to filter/catalog providers for selected sources; those providers have their own privacy policies. Opening a support/report link can also contact an external site.

| Permission or capability | Why it is used |
| --- | --- |
| `<all_urls>`, `scripting`, `activeTab` | Apply site filtering, packaged scripts and user-invoked element tools on supported pages. |
| `declarativeNetRequest` | Ask Chrome to block, allow, redirect or modify requests using declared rules. |
| `declarativeNetRequestFeedback` | Provide limited matched-rule diagnostics in supported unpacked/debug contexts. |
| `storage`, `unlimitedStorage` | Save settings and compiled filter data locally. |
| `alarms`, `offscreen` | Schedule maintenance and perform temporary background compilation. |
| `userScripts` | Register supported user/imported filters using packaged code, subject to Chrome's separate switch. |
| `webNavigation` | Correlate navigation and popup context. |
| Optional `privacy` | Change selected Chrome privacy settings after the user enables those controls; disabling a control clears the extension's override. |

Current unpacked builds, including versioned packages, declare `declarativeNetRequestFeedback`. Matched-rule diagnostics also require the extension's own **Developer mode** and browser support; this is separate from Chrome's Developer mode used for installation. Versioned builds omit detailed debug mapping assets, so diagnostic detail can differ from a development build. An unavailable matched-rules control is not evidence that filtering is off. Popup diagnostics remain bounded and redact detailed URLs. See [privacy and retention](docs/PRIVACY.md) and the [threat model](docs/THREAT-MODEL.md).

## What MV3 can and cannot do

| Capability | Current boundary |
| --- | --- |
| Network blocking and exceptions | Available through DNR, within Chrome's supported conditions and quotas. |
| Cosmetic filters and scriptlets | Supported subset; scriptlet code and redirect resources must be packaged with the extension. |
| Popup/popunder filters | The supported stock `$popup` corpus and imported `$popup`/`$popunder` subset run through the contextual observer. Stock `$popunder` is explicitly omitted where export loses its original kind. |
| Dynamic firewall and request logger | Do not reproduce the full synchronous MV2 firewall or unrestricted live logger. |
| Response-body rewriting, DNS/CNAME inspection, exact response-size blocking | No equivalent implementation through this build's normal public MV3 APIs. |
| Managed/native capabilities | Research and roadmap items; no native companion is shipped or silently installed. |

**Fail-open is deliberate.** If a popup decision requires context that is missing, an exception cannot be represented safely, or the matching work budget is exhausted, the relevant decision defers instead of approximating a block. Deferred allow conditions can force deferral; they cannot manufacture an approximate allow/block decision. Unsupported restrictive rules are not broadened by stripping their conditions. This reduces false positives and also means some unwanted popups can pass.

Sideloading does not remove DNR quotas, restore a permanent MV2 background page or bypass browser security. Chromium, other installed blockers and the target site can also affect the result. See the [feature matrix](docs/FEATURE-MATRIX.md), [architecture](docs/ARCHITECTURE.md) and [Power Runtime](docs/POWER-RUNTIME.md) for exact boundaries.

## Build and validate

Use Git with submodules, Node.js and npm, with network access for build-time filter data. The Windows release workflow pins **Node 22.22.0 and npm 11.19.1**. The package declares Node 22+ and npm 11+; use the pinned versions to reproduce CI.

### Windows / PowerShell

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
git submodule update --init --recursive

npm ci
npm test
npm run lint
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
.\tools\make-mv3.ps1 -Platform chromium -Version $version
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

Load `dist/build/uBlockPlus.chromium` from the browser's extensions page. The versioned command also creates `dist/build/uBlock-Plus_<version>.chromium.zip` and its `.sha256` sidecar. The folder contains `manifest.json`; the source repository root does not contain the installable build.

<details>
<summary><strong>Linux / macOS build entry points</strong></summary>

Use a shell environment with the prerequisites expected by the [MV3 build scripts](platform/mv3/README.md), including Bash, make, jq and ZIP/checksum utilities. The release pipeline and native Chrome evidence cited here were run on Windows.

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
npm ci
npm test
npm run lint
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

`make mv3-chromium` is the alternative unpacked-build target. Supplying a version to the script produces the versioned ZIP and checksum.

</details>

### What has been tested

The [6 September 2026 local release validation](docs/MV3-CHROME-RETEST-2026-09-06.md) recorded:

- **31 source test programs**, lint, the versioned build and artifact validation passing.
- **28 visible Google Chrome scenarios**, covering popup controls, actual On/Off requests, IPv4/IPv6, element tools, site scopes, imports, backup/reset and worker restart.
- **7 additional Chrome scenarios** with sandbox and built-in popup blocking enabled, including real public-site block/redirect behavior.
- **976 ZIP entries** matching the unpacked build; 55 rulesets and 70,163 DNR rules in that specific artifact.

These are dated local results for the recorded build, not a claim that the older published ZIP or every future commit passed those checks. The native optional-permission dismissal case was not exercised because the test installation already had `<all_urls>`. Fixtures and one public-site probe are not a guarantee for every website, browser or assistive technology. Consult the live [Actions runs](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml) separately for CI status.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Chrome cannot load the extension | Extract the ZIP, select the folder containing `manifest.json`, check browser version and read the extension card's error. |
| A website breaks | Turn protection Off for that site and reload. If it recovers, inspect custom filters and recently enabled lists, then report a reproducible case. |
| A sign-in/payment popup closes | Review the exact hostname's policy and compiled filter rules. Allow changes the contextual policy only; temporarily turning site protection Off is a separate diagnostic step. |
| Picker or cosmetic changes seem inactive | Use a normal web page, check filtering mode and user-script capability, then reload the page. Restricted browser pages cannot be injected. |
| An imported list fails | Check its direct HTTPS URL, format, size, browser capability and available DNR budget. Read the error before retrying. |
| A child-site setting is rejected | Inspect the parent scope in Site rules; the extension refuses unsupported overrides instead of broadening them. |
| `Internal error while updating dynamic rules` in Windows testing | Retry in an isolated profile with a short path. This setup issue was reproduced during native Chrome validation; do not delete your personal profile to troubleshoot it. |
| Matched-rules diagnostics are unavailable | Check the extension's own Developer mode and the browser's debug API support. These controls are separate from Chrome's installation switch; filtering can still be active. |
| Old popup layout after updating | Confirm the loaded folder and version, reload the extension, then close and reopen the popup. Do not assume a previously published ZIP contains newer source fixes. |

For a bug report, include the extension build/commit, browser and OS versions, relevant URL and reproduction steps, filtering level, enabled custom lists, expected/actual result and a redacted screenshot if useful. Test with other blockers disabled in a separate profile to isolate interference. Do not publish private URLs, account data or an unreviewed backup.

## Documentation and contributions

The current detailed guides are maintained in [English](README.md) and [Vietnamese](docs/README.vi.md). Eight earlier README translations remain available in the language bar; their notices link to the current guide while they await a full refresh. The extension UI has complete Power strings in ten maintained locales, with English build fallbacks for the remaining packaged locales. UI translation coverage and README freshness are separate.

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | User, developer and community documentation. |
| [Feature matrix](docs/FEATURE-MATRIX.md) / [Popup controls](docs/MV3-POPUP-PARITY.md) | Supported behavior and compatibility limits. |
| [Filter Store](docs/FILTER-STORE.md) | Catalog format, trust tiers and submission process. |
| [Architecture](docs/ARCHITECTURE.md) / [Power Runtime](docs/POWER-RUNTIME.md) | Compilation, rule budgets, runtime and durable state. |
| [Privacy](docs/PRIVACY.md) / [Threat model](docs/THREAT-MODEL.md) | Data, permissions and trust boundaries. |
| [Upstream comparison](docs/MV3-RETEST-2026-09-05.md) / [Community research](docs/COMMUNITY-RESEARCH.md) | Dated source evidence and regression comparisons. |
| [Roadmap](docs/ROADMAP.md) / [Governance](docs/COMMUNITY-GOVERNANCE.md) | Planned work, review process and responsibilities. |

Use this fork's [issue forms](https://github.com/kayurachann/uBlock-Plus/issues/new/choose) for bugs and feature requests, or [submit a Filter Store entry](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml). Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing code, filters or translations. Do not assume a fork-specific defect belongs in an upstream project's issue tracker.

Report security vulnerabilities through the repository's [private advisory form](https://github.com/kayurachann/uBlock-Plus/security/advisories/new), following [SECURITY.md](SECURITY.md). Roadmap items, including managed/native research, are not shipped-feature or release-date promises.

## Credits and license

Based on [uBlock Origin](https://github.com/gorhill/uBlock) by Raymond Hill and its contributors, including inherited upstream MV3 work. Thanks to the authors and maintainers of [uAssets](https://github.com/uBlockOrigin/uAssets), the [uBlock Origin Lite project](https://github.com/uBlockOrigin/uBOL-home), filter lists, translations and bundled third-party libraries. Project names and links identify their respective projects; they do not imply endorsement of this fork.

Upstream history, copyright headers and third-party notices are preserved. See [NOTICE.md](NOTICE.md) for attribution. uBlock Plus+ is distributed under the [GNU General Public License, version 3 or later](LICENSE.txt).
