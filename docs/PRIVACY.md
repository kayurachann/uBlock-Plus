# Privacy policy

Last updated: 2026-09-24

uBlock Plus+ is designed to perform content filtering locally in the browser. The extension does not transmit project telemetry and includes no advertising, analytics, account system, or project-operated data collection server. Its storage-size diagnostics are calculated and retained locally.

## Data stored locally

The extension stores filtering modes, enabled rulesets, custom filters, imported-list and Filter Store metadata, the selected memory profile, a coarse browser-reported device-memory hint, local storage-size counters, backup/restore configuration, and compiled filter data in Chrome extension storage. This data remains on the device unless the user explicitly exports it. Storage-size counters are not live RAM measurements.

Permanent firewall rules are stored locally and included in backups. Temporary firewall rules and up to 128 registrable domains used for party classification are kept in session storage and end with the browser session. The packaged Public Suffix List is consulted locally; no DNS/DoH classification service is called.

Logger capture is off by default. After the user selects a tab and starts capture, a bounded in-memory buffer can contain full request URLs and filtering diagnostics for that tab, including an incognito tab when explicitly captured in that separate extension context. Up to 512 records are shared by four logger windows; closing the last logger clears them. Pause stops observation. The project does not build or transmit a browsing-history profile.

Export is explicit and strips URL credentials, queries, fragments and diagnostic free text. URL paths can still contain personal identifiers, so review exported JSON before sharing. No export is uploaded automatically.

## Network access

Bundled filter lists are downloaded during source builds. The packaged Filter Store catalog is updated only through a reviewed uBlock Plus+ release. Users may add custom HTTPS catalog URLs; those catalogs and filter sources are fetched directly from the provider when the Filter Store is opened or an entry is enabled. Users should import only trusted lists and should treat `community` entries as unendorsed.

The extension may open GitHub or filter-list support pages when the user explicitly clicks documentation/report links. A new report contains only the site origin shown in the report form, plus the troubleshooting information shown on the same page, in which every URL, including imported-list subscriptions, is reduced to its origin; paths, queries, fragments and credentials are not included. The UI asks for confirmation before it opens the prefilled GitHub form, and nothing is published until the user submits that form. Searching for similar reports sends the site hostname to GitHub.

### Update checks and the Windows updater

The project operates no update server of its own and collects no telemetry. Every update request goes to GitHub. Technical details are in [AUTO-UPDATE.md](AUTO-UPDATE.md).

**Update checks by the extension.** To find new releases, the extension requests `https://api.github.com/repos/kayurachann/uBlock-Plus/releases?per_page=30`:

- about every six hours, and never sooner than 30 minutes after the previous successful check;
- after a failed check, again each time its backoff delay ends: 15 minutes, doubling after each further failure up to one day, or later when GitHub reports a rate limit;
- when you select **Check now** (at most once a minute, except right after a check that failed for a reason other than a rate limit, or after a change of release channel).

The request carries no cookies, referrer, identifiers, settings or browsing data. When a previous answer exists, it also carries that answer's ETag (`If-None-Match`). As with any web request, GitHub receives the device's IP address and the browser's user agent. Development builds (first version number 2000 or higher) and the incognito worker make no scheduled request. Installations whose administrator set the managed `autoUpdate` policy to `off` make no request at all.

To stop scheduled checks, clear **Check for new versions automatically** in **Dashboard → Settings → Updates**. **Check now** still works when you select it. Nothing else changes. **Release notes** opens the release page on `github.com` only when you select it. The popup's **Update x.y.z** button only reads the result of the last check; the popup makes no request.

The extension keeps its update settings and state in local extension storage. They are not included in backups and are not sent anywhere. The state holds:

- the compact release list (tags, names, dates and asset file names) and its ETag;
- check times and the failure count;
- the version that is available, or held after a restore;
- a running install with its download progress, and the version expected after the reload;
- the last update;
- the versions that the updater reports;
- the last error. An error reported by the updater can include the extension folder path.

**The Windows updater.** The optional updater is installed separately by the user. It runs only when Chrome starts it for the extension or when the user runs it; nothing stays in the background. Chrome passes it the extension's origin. The extension sends it the following, and nothing else:

- the protocol version (`1`);
- a command (`hello`, `stage`, `apply` or `rollback`);
- a request ID made of the command name and a timestamp;
- for `stage` and `apply`, a release version number.

The updater and its installer build every URL themselves; the extension never passes a URL:

| Endpoint | When | What is sent |
| --- | --- | --- |
| `https://github.com/kayurachann/uBlock-Plus/releases/download/…`, which redirects to GitHub's download servers such as `objects.githubusercontent.com` | Downloading a release: the `.sha256` checksum, the package and, once release signing keys are pinned, the `.sig` signature | Requests for those public files, with the user agent `uBlock-Plus-Updater/<updater version>` |
| `https://api.github.com` release list | Only from the command line: `-Update` or `-Install` without `-Version`, the installer's first download into an empty folder, and `install-updater.ps1 -StableOnly`, which checks that a stable release exists | The same public request as the extension's check |
| `https://raw.githubusercontent.com` | Only the one-step installer: you download `install-updater.ps1` from there. When no updater lies next to that script, it fetches `ublock-plus-updater.ps1`, `ublock-plus-updater.cmd` and `release-signing-keys.json` from the `main` branch | Requests for those public files |

The updater and the installer send no browsing data, settings or identifiers. GitHub sees the IP address and the user agent of the updater or of PowerShell.

The updater keeps its files in `%LOCALAPPDATA%\uBlockPlus\Updater`, or in the folder passed to the installer's `-InstallRoot`. `<key>` below is a short hash of the extension folder's path:

- `config.json`: the repository, its download and API addresses, the pre-release preference, and every registered extension folder with its edition and extension IDs;
- the updater scripts and the Chrome host manifest `io.github.kayurachann.ublock_plus.updater.json`;
- `release-signing-keys.json`: the pinned public release signing keys;
- `staging\<key>\`: at most one downloaded package per extension folder, kept until it is installed or replaced;
- `backup\<key>\`: one full copy of the previous version per extension folder, used by **Restore version x**;
- `state-<key>.json`: the last update, and a marker while an update is being applied;
- `updater.log` and `updater.log.1`: a local log of times, folder paths, versions and errors. It is rotated at 256 KiB, so it holds at most about 512 KiB;
- `updater.lock`: an empty file that keeps two updates from running at once.

The installer also writes the registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.kayurachann.ublock_plus.updater`, and the same key for Microsoft Edge, Chromium and Brave when their settings exist under `HKCU\Software`. The documented one-step installer command saves `install-updater.ps1` in `%TEMP%`, and that script leaves its downloads in a `ubp-updater-*` folder there; you can delete both.

To remove the updater's data for one extension folder, run `updater\install-updater.cmd -Uninstall` from that folder. It stops updating the folder and deletes the folder's staged download, backup and state. When no other folder remains registered, it also deletes the registry keys and the whole `%LOCALAPPDATA%\uBlockPlus\Updater` folder. It refuses while an update is running; try again a minute later. The extension folder and your settings are not changed. The `nativeMessaging` permission stays granted after `-Uninstall`, but with no updater registered it reaches nothing. Removing the extension from Chrome removes the permission; neither deletes the updater's files.

## Permissions

- `declarativeNetRequest`: blocks, allows, redirects, or modifies requests using Chrome's declarative engine.
- `declarativeNetRequestFeedback`: native matched-rule diagnostics when Chrome and the installation type support it. Matches are observed only while the opt-in logger captures a tab, within its 512-record lifecycle; Developer mode keeps no separate matched-rule buffer. Nothing is transmitted by the project.
- Optional `webRequest` in the standard edition: requested only when the user clicks **Start capture** in the logger. It observes requests for explicitly captured tabs; it does not grant synchronous request blocking. Refusing permission leaves the other available diagnostic sources usable. Observers are removed when capture stops.
- Required `webRequest` and `webRequestBlocking` in the separate [Experimental WebRequest edition](EXPERIMENTAL-WEBREQUEST.md): evaluate saved firewall block rules synchronously when Chrome grants access. The supplementary listener keeps bounded tab context in memory, respects Off and skips uncertain contexts. Request logging remains opt-in. The launcher uses a separate local Chrome profile and does not edit enterprise policy, registry entries or the existing personal profile. It installs no native service and sends no telemetry. The stable manifest public key identifies the variant; it is not a signing secret.
- `scripting`, `activeTab`, and host access: apply cosmetic filtering, packaged scriptlets and user-invoked element tools.
- `storage` and `unlimitedStorage`: persist settings and compiled filter data.
- `alarms`: schedule filter-list maintenance and update checks without a permanent background page.
- `offscreen`: compile supported imported/custom filter data outside the service worker when required.
- `userScripts`: register packaged stock and supported user/imported scriptlets with shared exception data. Chrome requires the user to enable this capability separately. Filter sources remain data; no remotely hosted executable code is used.
- `webNavigation`: correlate newly created navigation targets and enumerate opener frames for the Smart Popup Blocker. Candidate URLs and trusted-gesture targets exist in memory for at most 30 seconds and 5 seconds respectively; service-worker recovery checkpoints retain only origin-level URLs, while the bounded session diagnostic log retains at most 100 hostname-only decisions. Paths, queries, fragments and credentials are not persisted.
- Optional `nativeMessaging`: only requested after the user clicks **Allow the updater** in **Settings → Updates**. It lets the extension ask the separately installed Windows updater to download, verify and install a newer release, or to restore the previous one. Only the protocol version, a command, a request ID and, for downloads and installs, a version number are sent (see [Update checks and the Windows updater](#update-checks-and-the-windows-updater)). Revoking it stops automatic installation; update checks continue unless turned off.
- Optional `privacy`: only requested after the user clicks **Enable privacy controls…**. It can disable hyperlink auditing, network prediction, non-proxied WebRTC UDP and Privacy Sandbox advertising APIs. Disabling a control calls Chrome's `clear()` operation so the setting returns to Chrome/user policy.

## Managed settings and future capability layers

The standard package reads supported settings from Chrome managed storage when an administrator supplies them. The UI distinguishes managed values from user settings. Those settings do not activate another engine. The `autoUpdate` setting can turn update checks off (`off`), allow notifications only (`notify`), or leave the choice to the user (`auto`). The experimental package separately implements a supplementary blocking firewall, gated on an actual browser permission grant; the complete managed uBO static network engine remains unimplemented. Enterprise diagnostics remain local unless an administrator separately configures an organizational system.

The Windows updater is the first native companion. It is installed separately with explicit consent, and its IPC schema, log retention, network behavior, uninstall path and update verification are documented in [AUTO-UPDATE.md](AUTO-UPDATE.md). Any further native capability, such as DNS or proxy diagnostics, requires its own reviewed documentation before release. The browser extension never silently installs or activates native software.

## Third parties

This fork inherits filter-list source URLs and external documentation/support links from upstream uBlock Origin projects. Update checks, updater downloads and reports go to GitHub. These third parties have their own privacy policies. The project does not sell or share personal data.

Questions or reports about this policy should be opened at [the uBlock Plus+ issue tracker](https://github.com/kayurachann/uBlock-Plus/issues). Unpatched vulnerabilities should use the repository's private Security Advisory form rather than a public issue.
