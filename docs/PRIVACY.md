# Privacy policy

Last updated: 2026-09-01

uBlock MV3 Community is designed to perform content filtering locally in the browser. The extension does not include telemetry, advertising, analytics, an account system, or a project-operated data collection server.

## Data stored locally

The extension stores filtering modes, enabled rulesets, custom filters, imported-list metadata, backup/restore configuration, and compiled filter data in Chrome extension storage. This data remains on the device unless the user exports a backup or enables a browser-provided synchronization feature in a future version.

Incognito browsing history is not recorded. The extension does not build or transmit a browsing-history profile.

## Network access

Bundled filter lists are downloaded during source builds. At runtime, the extension may fetch filter-list URLs selected or entered by the user so it can compile them locally. Requests go directly to the list provider named by the URL. Users should import only trusted lists.

The extension may open GitHub or filter-list support pages when the user explicitly clicks documentation/report links. A report URL can include the site origin shown in the report form; the UI warns before navigation.

## Permissions

- `declarativeNetRequest`: blocks, allows, redirects, or modifies requests using Chrome's declarative engine.
- `scripting`, `activeTab`, and host access: apply cosmetic filtering, packaged scriptlets and user-invoked element tools.
- `storage` and `unlimitedStorage`: persist settings and compiled filter data.
- `alarms`: schedule filter-list maintenance without a permanent background page.
- `offscreen`: compile supported imported/custom filter data outside the service worker when required.
- `userScripts`: register supported user/imported scriptlet filters using packaged code. Chrome may require the user to enable this capability separately.
- Optional `privacy`: only requested after the user clicks **Enable privacy controls**. It can disable hyperlink auditing, network prediction, non-proxied WebRTC UDP and Privacy Sandbox advertising APIs. Disabling a control calls Chrome's `clear()` operation so the setting returns to Chrome/user policy.

## Third parties

This fork inherits filter-list source URLs and external documentation/support links from upstream uBlock Origin/uBO Lite. Those third parties have their own privacy policies. The project does not sell or share personal data.

Questions or reports about this policy should be opened at [the fork issue tracker](https://github.com/kayurachann/uBlock-MV3-Community/issues).
