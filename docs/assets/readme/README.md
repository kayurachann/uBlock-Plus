# README image provenance

The September 2026 screenshots below show the actual uBlock Plus+ extension running in **Google Chrome 152.0.7977.76 (Official Build, 64-bit)** on Windows 11. They are direct browser captures, with no compositing, retouching or generated UI.

## Current screenshots

| File | What it shows | Pixel dimensions |
| --- | --- | --- |
| [popup-expanded.png](popup-expanded.png) | Native toolbar popup, light theme, Comfortable density, protection enabled for a local test page; details expanded. The full controls scroll inside Chrome's popup height limit. | 425 × 750 |
| [popup-compact.png](popup-compact.png) | The same native popup in dark theme with details collapsed using **Less**; **More** restores them. This image uses Comfortable density, not the separate Compact density setting. | 425 × 397 |
| [dashboard-settings.png](dashboard-settings.png) | Settings, Balanced protection profile, appearance controls and the three default filtering modes. | 1100 × 980 |
| [filter-lists.png](filter-lists.png) | Packaged filter lists and enabled categories after applying the Balanced profile. Counts describe this captured profile and build. | 1100 × 960 |
| [filter-store-current.png](filter-store-current.png) | Filter Store with the search **Easy**, quota estimates, bundles and two matching community entries. The shown entries have not been enabled. | 1100 × 850 |
| [custom-filters.png](custom-filters.png) | My filters with two saved cosmetic selectors for `example.com`, the text import area and the filter-creation sandbox. Example rules are illustrative, not a recommendation for a real site. | 1100 × 760 |
| [site-rules.png](site-rules.png) | Site rules with an example exact-host **Allow** popup policy and the default Optimal filtering scope. Filter-list rules retain precedence over the popup policy. | 1100 × 1040 |

Captured on **2026-09-06**, using English interface text and isolated test profiles. The popup images were copied byte-for-byte from the release retest captures; the dashboard images were captured for this README. Dark theme in the popup was selected using Chrome's emulated color-scheme preference. The popup captures reflect Windows display scaling; the native Comfortable layout is 340 CSS pixels wide.

All current screenshots use the **1.0.0 Chromium MV3** package validated for commit [`2316c69`](https://github.com/kayurachann/uBlock-Plus/commit/2316c69cddaae3eb190bedb1bba798fe48f730e9). Release ZIP SHA-256:

```text
3093c34afffad538d25de74ec7a027ef3c39a0183f4792a8bf437d87f630a3be
```

The installed Google Chrome executable was used in headed mode. Its supported `Extensions.loadUnpacked` debugging API loaded a copy of the package into a separate profile. Playwright supplied automation flags; the popup retest disabled Chrome's built-in popup blocker to exercise the extension independently. The images document the interface, not a benchmark or a claim that all MV2 features are available under MV3. No personal browsing data appears in them.

Local capture records, retained outside Git under `tmp/google-chrome-retest/`, are:

- Popup images: `run-2026-09-06T12-00-42-012Z` (`popup-light-expanded.png` and `popup-dark-compact.png`).
- My filters: `readme-2026-09-06T12-11-40-429Z/capture.json`.
- Other dashboard images: `readme-2026-09-06T12-13-38-670Z/capture.json`.
- Capture script: `readme-capture.mjs`.

To refresh these images, build and validate the Chromium package, load it in an isolated Google Chrome profile, reproduce the documented settings through the interface and capture the visible view directly. Keep the example domains and record the new browser version, package hash and capture date. Do not substitute a mockup for a product screenshot.

## Earlier assets

`hero.png`, `feature-map.svg` and `install-flow.svg` are earlier illustrative assets. `filter-store.png` and `memory-settings.png` are earlier interface captures. They remain here for older translated documents and should not be used as evidence for the current Chrome retest. The current English and Vietnamese README screenshot set is listed above.

The extension UI and project artwork retain their existing copyright and license notices; see the repository [license](../../../LICENSE.txt) and third-party notices.
