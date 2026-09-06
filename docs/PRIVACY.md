# Privacy policy

Last updated: 2026-09-06

uBlock Plus+ is designed to perform content filtering locally in the browser. The extension does not transmit project telemetry and includes no advertising, analytics, account system, or project-operated data collection server. Its storage-size diagnostics are calculated and retained locally.

## Data stored locally

The extension stores filtering modes, enabled rulesets, custom filters, imported-list and Filter Store metadata, the selected memory profile, a coarse browser-reported device-memory hint, local storage-size counters, backup/restore configuration, and compiled filter data in Chrome extension storage. This data remains on the device unless the user explicitly exports it. Storage-size counters are not live RAM measurements.

Permanent firewall rules are stored locally and included in backups. Temporary firewall rules and up to 128 registrable domains used for party classification are kept in session storage and end with the browser session. The packaged Public Suffix List is consulted locally; no DNS/DoH classification service is called.

Logger capture is off by default. After the user selects a tab and starts capture, a bounded in-memory buffer can contain full request URLs and filtering diagnostics for that tab, including an incognito tab when explicitly captured in that separate extension context. Up to 512 records are shared by four logger windows; closing the last logger clears them. Pause stops observation. The project does not build or transmit a browsing-history profile.

Export is explicit and strips URL credentials, queries, fragments and diagnostic free text. URL paths can still contain personal identifiers, so review exported JSON before sharing. No export is uploaded automatically.

## Network access

Bundled filter lists are downloaded during source builds. The packaged Filter Store catalog is updated only through a reviewed uBlock Plus+ release. Users may add custom HTTPS catalog URLs; those catalogs and filter sources are fetched directly from the provider when the Filter Store is opened or an entry is enabled. Users should import only trusted lists and should treat `community` entries as unendorsed.

The extension may open GitHub or filter-list support pages when the user explicitly clicks documentation/report links. A report URL can include the site origin shown in the report form; the UI warns before navigation. Sideloading does not create a project-operated update or telemetry connection.

## Permissions

- `declarativeNetRequest`: blocks, allows, redirects, or modifies requests using Chrome's declarative engine.
- `declarativeNetRequestFeedback`: native matched-rule diagnostics when Chrome and the installation type support it. The legacy developer buffer is limited to 256 events while Developer mode is enabled; the separate opt-in logger has its own 512-record capture lifecycle. Neither is transmitted by the project.
- Optional `webRequest`: requested only when the user clicks **Start capture** in the logger. It observes requests for explicitly captured tabs; it does not grant synchronous request blocking. Refusing permission leaves the other available diagnostic sources usable. Observers are removed when capture stops.
- `scripting`, `activeTab`, and host access: apply cosmetic filtering, packaged scriptlets and user-invoked element tools.
- `storage` and `unlimitedStorage`: persist settings and compiled filter data.
- `alarms`: schedule filter-list maintenance without a permanent background page.
- `offscreen`: compile supported imported/custom filter data outside the service worker when required.
- `userScripts`: register packaged stock and supported user/imported scriptlets with shared exception data. Chrome requires the user to enable this capability separately. Filter sources remain data; no remotely hosted executable code is used.
- `webNavigation`: correlate newly created navigation targets and enumerate opener frames for the Smart Popup Blocker. Candidate URLs and trusted-gesture targets exist in memory for at most 30 seconds and 5 seconds respectively; service-worker recovery checkpoints retain only origin-level URLs, while the bounded session diagnostic log retains at most 100 hostname-only decisions. Paths, queries, fragments and credentials are not persisted.
- Optional `privacy`: only requested after the user clicks **Enable privacy controls**. It can disable hyperlink auditing, network prediction, non-proxied WebRTC UDP and Privacy Sandbox advertising APIs. Disabling a control calls Chrome's `clear()` operation so the setting returns to Chrome/user policy.

## Managed settings and future capability layers

The current package reads supported settings from Chrome managed storage when an administrator supplies them. The UI distinguishes managed values from user settings. This configuration does not activate a separate blocking engine; filtering still uses DNR. A managed blocking adapter is a future capability requiring its own implementation and review. Enterprise diagnostics remain local unless an administrator separately configures an organizational system.

A future native companion would be installed separately and require explicit user/admin consent. Its privacy policy, IPC schema, log retention, network behavior, uninstall path and update verification must be documented and reviewed before release. The browser extension must not silently install or activate it.

## Third parties

This fork inherits filter-list source URLs and external documentation/support links from upstream uBlock Origin projects. Those third parties have their own privacy policies. The project does not sell or share personal data.

Questions or reports about this policy should be opened at [the uBlock Plus+ issue tracker](https://github.com/kayurachann/uBlock-Plus/issues). Unpatched vulnerabilities should use the repository's private Security Advisory form rather than a public issue.
