# Installed Google Chrome regression test — 2026-09-06

The release package was tested in the installed Google Chrome 152.0.7977.76 (Official Build, 64-bit) on Windows, in a visible browser window with an isolated profile. This extends the earlier Chromium 145 fixture run; the two browser versions are separate test environments.

## Native popup defect

The original release reproduced a 26px-wide native action popup. The narrow-screen CSS rule set the body to `100vw`, tying the popup's desired size to Chrome's transient initial viewport. Removing that override alone did not consistently stabilize intrinsic sizing. The fix anchors both the root and body to one explicit width: 340px for comfortable density and 320px for compact density.

In visible Chrome, both densities retained their width through opening, scrolling, collapsing and expanding. Expanded height stayed at 600px; collapsed height was 318px in the measured configuration. Mouse-wheel scrolling reached the footer without scrolling the document root. The browser suite now checks native viewport dimensions after allowing layout to settle, alongside body/root widths and overflow.

## Isolated profile setup

An initial profile nested under the long repository path produced `Internal error while updating dynamic rules` even for a minimal dynamic-rule add/remove probe. Equivalent session-rule updates succeeded. Retesting with a short disposable profile path made all dynamic and session probes pass without changing filtering code. This points to the Chrome/Windows profile persistence environment, rather than rule syntax or the popup matcher. Use a short profile path when reproducing on Windows; personal profiles were not used or changed.

Unpacked loading used Chrome's supported [`Extensions.loadUnpacked`](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked) debugging API through a pipe. The executable, full version, launch arguments, profile, extension path and package hashes are recorded with the local test evidence.

## Release validation

The workflow's Node 22.22.0 and npm 11.19.1 were used for `npm ci`, `npm test`, `npm run lint`, `./tools/make-mv3.ps1 -Platform chromium -Version 1.0.0`, and `node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release`. All passed, including the 31 source test programs. The packaged popup-authority regression also passed against the generated stock corpus.

The validator checked 55 rulesets, 70,163 DNR rules and 301 JSON files. Every one of the 976 ZIP entries matched the unpacked build by path, size and SHA-256. Loaded copies were compared with the build, excluding browser-generated metadata.

- Package: `uBlock-Plus_1.0.0.chromium.zip`
- Size: 10,073,745 bytes
- SHA-256: `3093c34afffad538d25de74ec7a027ef3c39a0183f4792a8bf437d87f630a3be`

## Visible Chrome functionality suite

All 28 scenarios passed with zero uncaught errors and zero unexpected extension console errors. Coverage includes native popup dimensions and wheel/keyboard interaction, actual network blocking with protection On/Off, filtering-level restoration, restricted pages, dashboard shortcuts and profiles, IPv4/IPv6, appearance settings, custom filters, picker/zapper/unpicker, trusted parent/child scopes, worker `importScripts`, strict-block continuation, popup policies and compiled stock rules, HTTPS imported-list lifecycle/reset, backup/restore, and service-worker stop/wake persistence.

This fixture mode disables Chrome's built-in popup blocker so the extension's own observer can be measured independently. Tool tests wait for overlay initialization and popup dismissal before sending trusted mouse input. The launcher's second debugging connection leaves dialogs for the test connection to handle. These harness corrections do not change extension behavior.

The native optional-permission dismissal case remains untested: the unpacked manifest already grants `<all_urls>`, so no permission prompt appears for the tested mode transition. The final local report is `tmp/google-chrome-retest/run-2026-09-06T12-00-42-012Z/REPORT.md`, with JSON states, screenshots and runtime asset hashes alongside it.

## Chrome with its normal protective settings

A separate visible Chrome run used only isolated-profile, debugging, automation and startup/window arguments. It retained the sandbox, built-in popup blocker and normal browser feature defaults. All seven scenarios passed with zero uncaught errors: launch-argument verification, native popup layout, keyboard-controlled network protection Off/On, intentional clicked popups, native no-gesture popup blocking, compiled stock-popup enforcement, and public-site packaged DNR behavior.

The local server received exactly one protected fixture request, while protection was Off. The no-gesture probe recorded no user activation and `window.open` returned null; a real clicked link stayed open. The stock popup rule closed its matching target through the observer even with the native popup blocker enabled.

On `https://example.com/`, the known `adsbygoogle.js` URL was redirected to the packaged surrogate with a 200 response, as specified by uBlock's higher-priority redirect rule. A separate script preload under the same EasyList-blocked ad domain produced `ERR_BLOCKED_BY_CLIENT` while protection was On and after it was restored. While Off, the extension allowed the request through and Chrome applied its own opaque-response protection (`ERR_BLOCKED_BY_ORB`). Downloaded advertising scripts were not executed by these preload probes.

## Behavior preserved

The product change is limited to popup sizing. Missing popup context, unsupported exceptions and evaluation-budget exhaustion retain the documented fail-open behavior. No DNR condition, filtering quota, trusted-site policy or observer decision was relaxed to make the tests pass.

Local commands, failure evidence, screenshots and structured results are stored under `tmp/google-chrome-retest/`; these generated files and disposable profiles are not part of the source commit. Browser coverage is a defined regression set, not certification of every production website or complete Manifest V2 parity.
