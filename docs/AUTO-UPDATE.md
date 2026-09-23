# Automatic updates

uBlock Plus+ is installed with **Load unpacked**, so the Chrome Web Store cannot update it. This document explains how the extension finds new releases and how the optional Windows updater installs them. It also records the design and trust model. That part is the RFC for the native companion that [THREAT-MODEL.md](THREAT-MODEL.md) requires.

Status: shipped in 1.2.0 for Chromium browsers on Windows (updater version 1.0.0). On macOS and Linux the extension reports new releases, and you update it by hand. Releases before 1.2.0 do not contain the updater.

Contents:

* [For users](#for-users): what happens, setup, settings, troubleshooting, moving and uninstalling
* [Command line](#command-line): the updater and the installer
* [For administrators](#for-administrators): the managed `autoUpdate` policy
* [Design and trust model](#design-and-trust-model): components, protocol, verification, folder safety, risks
* [For maintainers: publishing a release](#for-maintainers-publishing-a-release): release workflow and signing keys

## For users

### What happens automatically

| Installation | Finds new releases | Installs them |
| --- | --- | --- |
| Unpacked on Windows, updater installed and allowed | Yes | Yes: automatically, or with **Install now** in **Only notify me** mode |
| Unpacked on Windows, updater not installed or not allowed | Yes | No. **Settings → Updates** shows the setup steps. |
| Unpacked on macOS or Linux | Yes | No. The section says that automatic installation works only on Windows. [Update by hand](#updating-by-hand). |
| Development build: a local build whose first version number is 2000 or more | No | No |
| Installed as a package (by policy or from a `.crx`) | Yes | No. The browser or your administrator manages updates. |
| Administrator policy `autoUpdate` set to `off` | No | No |

When a newer version exists, the dashboard says so and the popup shows an **Update x.y.z** button.

A check reads the public release list of this repository from `api.github.com`, about every six hours. It sends no browsing data, no settings and no identifier. GitHub sees your IP address and browser user agent, as with any request. All network requests are listed under [Network requests](#network-requests).

When an update installs:

1. The updater downloads the release, verifies it and backs up the extension folder.
2. It replaces the files in the folder, and the extension reloads into the new version.
3. Open extension pages close. After **Install now** or **Restore version …**, the dashboard reopens at **Settings → Updates**; after an automatic install it does not.
4. Websites keep their current filtering until you reload them. Reload them to refresh already-injected scripts and cosmetic filters.

Your settings, filters and lists are kept, because the folder and the extension ID do not change.

### One-time setup on Windows

The updater only changes a folder that no other user of the PC can change (see [folder rules](#folder-rules)). Use a **new, empty folder in your user profile**. The recommended folder is `%LOCALAPPDATA%\uBlockPlus\Extension`.

1. Download `uBlock-Plus_<version>.chromium.zip` (1.2.0 or later) and its `.sha256` file from [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases), and verify the checksum: see **Check the SHA-256 on Windows** under [Install an unpacked build](../README.md#install-an-unpacked-build) in the README.
2. Extract the ZIP into the new folder. In File Explorer, type `%LOCALAPPDATA%` in the address bar, create `uBlockPlus\Extension` there and extract the ZIP into `Extension`. Or in PowerShell (replace `<version>`):

   ```powershell
   $folder = Join-Path $env:LOCALAPPDATA 'uBlockPlus\Extension'
   New-Item -ItemType Directory -Path $folder
   Expand-Archive -LiteralPath "$HOME\Downloads\uBlock-Plus_<version>.chromium.zip" -DestinationPath $folder
   ```

   `manifest.json` must be directly in that folder. Keep nothing else in it: no ZIP, notes or backups.
3. Open `chrome://extensions` (`edge://extensions` in Edge), turn on **Developer mode**, select **Load unpacked** and choose the folder. In the folder picker you can type `%LOCALAPPDATA%\uBlockPlus\Extension` into the address bar.
4. In that folder, double-click `updater\install-updater.cmd`. It needs no administrator rights. It checks the folder, copies the updater to `%LOCALAPPDATA%\uBlockPlus\Updater` and registers it for Chrome, and for Edge, Chromium and Brave when they are installed. It then prints the folder, the edition, the signing state (`Signed releases  : not configured (checksum only)` until release signing is set up), the extension ID(s) and the browsers.
5. Open **Dashboard → Settings → Updates** and select **Allow the updater**. Chrome asks for permission to "communicate with cooperating native applications". Allow it.
6. The section shows "Restarting… this page reopens automatically." uBlock Plus+ restarts once, because Chrome enables native messaging only after a restart, and reopens the Updates section. It then shows "Updater 1.0.0 connected. New versions install automatically and the extension reloads by itself." If it shows **Restart now** instead, select it.

Keep **Developer mode** on. Chrome disables unpacked extensions when it is off, and the updater only serves an unpacked copy.

**Already using uBlock Plus+?** If your folder passes the [folder rules](#folder-rules), [update it by hand](#updating-by-hand) to 1.2.0 or later, then run steps 4 to 6 there. Otherwise [move the installation](#moving-an-existing-installation).

### One-step installer

This PowerShell command does steps 1, 2 and 4 in one go. It needs no administrator rights. `-ExecutionPolicy Bypass` applies only to that PowerShell process.

```powershell
$installer = Join-Path $env:TEMP 'install-updater.ps1'
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/kayurachann/uBlock-Plus/main/platform/mv3/updater/install-updater.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer
```

The installer:

* downloads the updater scripts and the release signing keys from the `main` branch on `raw.githubusercontent.com`;
* creates `%LOCALAPPDATA%\uBlockPlus\Extension` if it is missing, and checks it against the folder rules;
* installs and registers the updater;
* downloads the newest release of the standard edition, pre-releases included, verifies it and extracts it into the folder.

The folder must be missing or empty. If it already contains uBlock Plus+, only the updater is installed. If it contains other files, the download fails and the installer says "The first download failed; the updater registration was kept. Run this script again." To use another folder, add `-ExtensionDirectory <folder>` to the last line. Do not add `-StableOnly` while every published release is a pre-release: the first download would then find nothing.

Then continue with steps 3, 5 and 6 above.

### Settings

All controls are in **Dashboard → Settings → Updates**.

| Control | Default | Effect |
| --- | --- | --- |
| **Check for new versions automatically** | On | Scheduled checks about every six hours. When off, the extension makes no scheduled requests; **Check now** still works. |
| **When a new version is found:** **Install it automatically** or **Only notify me** | **Install it automatically** | Automatic mode installs through the updater as soon as a check finds a newer version. **Only notify me** reports it, and you select **Install now**. Hidden on macOS and Linux. |
| **Release channel:** **Preview (includes pre-releases)** or **Stable releases only** | **Preview (includes pre-releases)** | **Stable releases only** ignores GitHub pre-releases. At the time of writing every release is a pre-release. Switching to stable withdraws a pre-release that was already found. The command line has its own option (`-IncludePrerelease`). |
| **Check now** | | Checks at once. It works at most once a minute ("The last check was less than a minute ago. Try again in N seconds."), except after a failed check (other than a rate limit) and once after a channel change. In automatic mode, a version it finds installs right away. |
| **Install now** | | Shown when a newer version is known and the updater is connected. Installs it now, in either mode. |
| **Release notes** | | Opens the release page on GitHub. |
| **Restore version x** | | Shown when the updater kept a backup of a version other than the running one. Puts that version back, reloads and reopens this section. |
| **Allow the updater**, **Restart now** | | Setup, see above. |
| **Copy** | | Copies the command `updater\install-updater.cmd -ExtensionId <id>` shown with the setup steps. Run it in the extension folder when the updater refuses this extension's ID. |

**Hold after a restore.** After **Restore version x**, automatic installs skip the version you restored from, and older ones. The section then says "Version x is not installed automatically because you restored an earlier version. Select “Install now” to install it anyway." The hold ends when a newer release appears, when you select **Install now**, or when the running version reaches the held one (for example after an update from the command line).

**Filter-list work.** **Install now**, automatic installs, **Restore version x** and the restart after **Allow the updater** wait up to 60 seconds for startup and for running or queued filtering changes (filter list updates, compiling, filtering-mode and rule changes). An install waits once before the download and once more before it replaces files. If the work is still running, the action stops with "A filter list update is running. Try again when it finishes." An automatic install tries again five minutes later, without a new request to GitHub; a finished download is reused. A manual action is not retried; select it again.

**Incognito.** In an incognito window the section says "Manage updates from a regular window, not from an incognito window." and its controls are disabled.

**Administrator.** When an administrator set the [`autoUpdate` policy](#for-administrators), the section says "Your administrator has turned off update checks." or "Your administrator allows update notifications only; new versions are not installed automatically." Controls that the policy decides are disabled.

The update settings stay in the browser profile. They are not part of the settings backup (**Back up…**), because the updater belongs to the PC, not to the profile.

#### Status lines

| The section shows | When |
| --- | --- |
| Installed version: x. No update check has run yet. | No check has succeeded yet. |
| Version x is up to date. Last checked: … | The last successful check found nothing newer. |
| Version x is available (installed: y). | A newer version was found on the selected channel. |
| Preparing to install x…, Downloading x… (with "a of b MiB"), Installing x… | An install is running. |
| Updated from x to y. / Restored version y (was x). | After an install or a restore, once the extension reloaded. |
| Development build x: automatic updates are turned off. | A local build with a date-based version. |
| Updater x connected. New versions install automatically and the extension reloads by itself. | The updater answers, automatic mode. |
| Updater x connected. Select “Install now” when a new version is available. | The updater answers, **Only notify me** mode, or policy `notify`. |

### What the popup shows

When the last check found a newer version, the popup shows an **Update x.y.z** button. Its tooltip says "Version x.y.z is available. Open the update settings." It opens **Dashboard → Settings → Updates**. The popup never contacts the network; it only reads the result of the last check. The button is hidden when an administrator disabled the dashboard.

### Updating by hand

This works everywhere, and it is the only way on macOS and Linux.

1. Optionally export a backup: **Dashboard → Settings → Backup → Back up…**.
2. Download the new ZIP and verify its checksum.
3. Delete the files in the extension folder, but keep the folder. Extract the new ZIP into it. Do not extract over the old files: files left over from the old version make the Windows updater refuse later updates ([unexpected files](#unexpected-files)).
4. On `chrome://extensions`, click **Reload** on the uBlock Plus+ card. **Details** must show the new version. If it does not, Chrome is loading another folder.

### Troubleshooting

Start with the message in **Settings → Updates**. If it follows an action (a check, an install or a restore), hover over it to see the updater's own (English) message. Messages about the updater connection, such as "The Windows updater is not installed yet." or a failed repair of an [interrupted update](#interrupted-updates), have no hover text; read the log or run `-Status`. The updater writes a log to `%LOCALAPPDATA%\uBlockPlus\Updater\updater.log` (older lines are in `updater.log.1`). The [command line](#command-line) `-Status` shows the updater's state. Error codes appear in the log and on the command line.

#### Setup and permission

| Message | Code | Cause and fix |
| --- | --- | --- |
| Automatic installation needs the Windows updater and your permission. | `permission-required` | The permission is not granted yet. Run the installer, then select **Allow the updater**. |
| Permission was not granted. | `permission-denied` | You declined Chrome's prompt. Select **Allow the updater** again and allow it. |
| Permission granted. uBlock Plus+ restarts once to connect to the updater. | `restart-required` | Chrome enables native messaging only after the extension restarts, and the restart has not happened, for example because filter-list work was running. Select **Restart now**. |
| The Windows updater is not installed yet. | `updater-missing`, `not-installed` | Chrome finds no registered updater, or its configuration is missing. Run `updater\install-updater.cmd` in the folder you loaded. If the message stays after the installer succeeded, restart the browser. An organization can block per-user native messaging hosts (Chrome policies `NativeMessagingUserLevelHosts`, `NativeMessagingBlocklist`). |
| The updater is registered for a different extension folder or ID. Run the command below. | `updater-forbidden`, `forbidden-origin`, `unknown-installation` | Chrome derives an unpacked extension's ID from its folder path. The ID Chrome uses is not among the IDs the installer registered, for example after moving the folder, loading another copy, or using a mapped drive or `subst`, or after `-Uninstall` in this folder while other folders stay registered. Open a Command Prompt in the folder you loaded and run the command shown (`updater\install-updater.cmd -ExtensionId <id>`, with **Copy**). It registers the exact ID. |
| The updater is registered for several folders with this extension ID. Run updater\install-updater.cmd -Replace from the folder you loaded with “Load unpacked”. | `ambiguous-installation` | Experimental builds have a fixed ID, and two folders are registered for it. Run the command from the folder the browser loads. |
| The updater manages a folder that holds a different version than this extension. Run the setup command from the folder you loaded with “Load unpacked”. | `folder-mismatch` | The registered folder holds an older or unknown version. Either the files changed without a reload (for example after `-Rollback` on the command line), or the ID is registered for another folder. Click **Reload** on the extension card. If the message stays, run the installer from the folder you loaded. |
| The updater does not change this extension folder: it is a drive root or a system or profile folder, it contains links, or other users of this PC can change it. Move uBlock Plus+ into your user profile, for example %LOCALAPPDATA%\uBlockPlus\Extension, load it from there, then run the setup again. | `unsafe-extension-dir` | See [folder rules](#folder-rules). |
| Automatic installation works only on Windows. To update, replace the files in the extension folder with those of the new release, then reload uBlock Plus+ on the extensions page. | `unsupported-os` | Not an error: macOS and Linux have no updater. Checks still report new versions. [Update by hand](#updating-by-hand). |
| This copy was installed as a package; your browser or administrator manages its updates. | `not-unpacked` | Not an error: the copy was not loaded with **Load unpacked**. |
| Manage updates from a regular window, not from an incognito window. | `incognito` | Open the dashboard from a regular window. |
| Development build x: automatic updates are turned off. | | A local build with a date-based version. Install a release to get updates. |
| Your administrator does not allow this. | `disabled-by-policy` | The [`autoUpdate` policy](#for-administrators) does not allow this action. Ask your administrator. |

#### Checks

| Message | Code | Cause and fix |
| --- | --- | --- |
| GitHub is limiting requests; the next check will wait. | `rate-limited` | GitHub allows about 60 anonymous API requests per hour per IP address, shared by everything behind that address (VPN, office network). The next check waits until GitHub's reset time, at most one day. Nothing to do. |
| Could not reach GitHub. The next check will try again. | `network-error`, `http-error`, `timeout`, `response-too-large`, `download-failed` | No connection, a proxy or firewall that blocks `api.github.com` or the release downloads, an HTTP error, or a timeout (15 seconds for the release list, 20 minutes for the whole download). A failed check is retried after 15 minutes, then at growing intervals up to one day. A failed download is tried again at the next check in automatic mode, or with **Install now**. **Check now** retries a failed check at once. |
| The last check was less than a minute ago. Try again in N seconds. | | **Check now** works at most once a minute. |
| This version is not offered on the selected release channel. | `not-offered` | You selected **Install now** for a pre-release after switching to **Stable releases only**. Select **Check now**, or switch the channel back. |

#### Download and verification

In all these cases nothing in the extension folder was changed.

| Message | Code | Cause and fix |
| --- | --- | --- |
| The downloaded package did not match its published checksum and was discarded. | `checksum-mismatch`, `checksum-invalid` | The download was damaged, or the `.sha256` file is malformed or names another file. The next check tries again. If it persists, report it: the release files may have been changed. |
| The package is not signed with a trusted uBlock Plus+ release key, so it was not installed. | `signature-missing`, `signature-invalid` | Your updater trusts release signing keys, and the release has no `.sig` file or no signature from one of those keys. Do not work around this; report it. If it started after the maintainers rotated keys, download the latest release, [update by hand](#updating-by-hand) and run `updater\install-updater.cmd` again: the installer takes the newer key set. |
| The downloaded package is not a valid uBlock Plus+ release for this copy, so it was not installed. | `package-invalid`, `identity-mismatch`, `package-too-large`, `not-staged` | The ZIP is corrupt, has unsafe paths or is too large; or it is another edition, another version, or would change the extension ID; or the download was not verified yet (for example it was made before signing keys were trusted). **Install now** downloads it again. If it persists, report it. |

#### Installing and restoring

| Message | Code | Cause and fix |
| --- | --- | --- |
| A filter list update is running. Try again when it finishes. | `filters-busy` | Filtering changes ran for more than 60 seconds. An automatic install retries after five minutes. Otherwise, select the action again later. |
| Another update is already running. Try again in a moment. | `update-busy` | Another install or restore is running: from this browser, another browser, the command line or the installer. Wait until it finishes. |
| The extension folder contains files that are not part of uBlock Plus+. Move them out of the folder, then try again. Nothing was changed. | `unexpected-files` | See [unexpected files](#unexpected-files). |
| The new version could not be installed. Details are in %LOCALAPPDATA%\uBlockPlus\Updater\updater.log. | `apply-failed`, `backup-failed` | `backup-failed`: the backup could not be made, often because the disk is full; nothing was changed. `apply-failed`: copying failed or the folder did not verify, and the updater put the backup back. The updater's message says whether that worked. Close programs that may hold files in the folder open, free disk space, then select **Install now** again. If the message says the previous version was NOT fully restored, run `-Rollback` on the [command line](#command-line). |
| There is no earlier version to restore. | `no-backup` | The updater keeps a backup only after it installed an update, and `-Uninstall` deletes it. |
| The earlier version could not be restored. Details are in %LOCALAPPDATA%\uBlockPlus\Updater\updater.log. | `rollback-failed` | The backup could not be copied back or did not verify, or an interrupted update could not be undone. See [interrupted updates](#interrupted-updates). |
| The previous update was interrupted before it finished. | `interrupted` | The browser closed or the extension restarted during an install. The next check, or **Install now**, tries again. If files were being replaced, the updater first restores the backup. |
| An interrupted update was undone and the previous version was restored. Nothing else was changed. | `update-undone` | See [interrupted updates](#interrupted-updates). The next check offers the update again. |
| The extension reloaded but its version did not change. Check the updater log. | `reload-mismatch` | Chrome reloaded the extension from files of another version. Usually Chrome loads a different folder than the one the updater manages. Compare the folder that `chrome://extensions` shows with the one the installer printed, and run `-Status`. |
| Version x is not installed automatically because you restored an earlier version. Select “Install now” to install it anyway. | | Not an error: the [hold after a restore](#settings). |

#### Updater errors

| Message | Code | Cause and fix |
| --- | --- | --- |
| The updater stopped unexpectedly. Details are in %LOCALAPPDATA%\uBlockPlus\Updater\updater.log. | `updater-failed` | Chrome could not start the updater, or it exited without an answer. Security software or an organization policy may block PowerShell, or the updater files are missing. Read the log, run `-Status` on the command line to see the error, and run the installer again. |
| The updater reported an error. Details are in %LOCALAPPDATA%\uBlockPlus\Updater\updater.log. | `updater-error`, `internal-error`, `invalid-config`, `invalid-reply`, `invalid-request`, `unsupported-protocol`, `unsupported-command` | An unexpected error, a damaged `config.json` or key file, or an updater that does not match the extension. Read the log, then run `updater\install-updater.cmd` again from the folder you loaded. |
| Update problem: … | any other code | The text after the colon is the updater's or the extension's own message, for example for `not-newer` or `invalid-version`. Read the log. |

#### Folder rules

The updater replaces files only in a folder that it can protect. It refuses the folder (`unsafe-extension-dir`) in these cases. The installer runs the same check, with the updater's own code, before it registers anything, and stops with "The updater cannot manage this folder." followed by the reason.

| The folder … | Examples |
| --- | --- |
| is a drive root or on a network (UNC) path | `C:\`, `D:\`, `\\server\share\uBlock` |
| is itself a system or profile folder | `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, `C:\Users`, your profile folder, `%LOCALAPPDATA%`, `%APPDATA%`, `%TEMP%`, `%LOCALAPPDATA%\uBlockPlus`, Desktop, Documents, Downloads. A new folder inside your own profile folders passes, for example `%LOCALAPPDATA%\uBlockPlus\Extension`. Do not use a folder under `C:\Windows`, `C:\Program Files` or `C:\ProgramData`: the updater runs without administrator rights. Do not use one under `%TEMP%` either: Windows may clean it up. |
| is, contains or is inside the updater's folder | `%LOCALAPPDATA%\uBlockPlus\Updater` |
| has a junction or symbolic link in its path or anywhere inside it | A folder reached through `mklink /J`. Only junctions and symbolic links are refused; other reparse points, such as OneDrive placeholders, are allowed, but an extension folder synced by OneDrive has not been tested. |
| can be changed by other users of the PC | Groups that every account belongs to (Everyone, Users, Authenticated Users, Interactive, Guests, Domain Users and similar) may write to it or to a folder in it, add or delete entries, change permissions or take ownership. A folder created directly under `C:\` is the usual case: Windows gives Authenticated Users the Modify right there. |
| has a parent that other users can rename or replace | Those groups hold Delete, delete-children, change-permissions, take-ownership or full control on a parent folder. |
| has permissions that cannot be read | |

Why: the updater mirrors a package into the folder with `robocopy /MIR`, which writes and deletes through links. It checks for links at fixed moments. If another account could swap a folder for a link in between, an update could overwrite or delete files elsewhere on the PC, or that account could change the extension's code.

Fix, in order of preference:

1. [Move the installation](#moving-an-existing-installation) to `%LOCALAPPDATA%\uBlockPlus\Extension`.
2. Keep a folder under a drive root, and remove the shared permissions from the top folder you created there (here `C:\Extensions`). Run this once in Command Prompt, not PowerShell, then run `updater\install-updater.cmd` again. Afterwards only your account, SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`) have access to that folder and everything in it.

   ```bat
   icacls C:\Extensions /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F
   ```

#### Unexpected files

An update deletes a file from the extension folder only when the installed release listed it in `updater\package-files.json`. If the folder holds any other file that the new release does not contain, the update stops before anything changes: "The extension folder contains files that are not part of uBlock Plus+. Move them out of the folder, then try again. Nothing was changed." The updater's message names up to ten of the files. It is in the log and on the command line. In the dashboard, hover over the error after an install or a restore; when the repair of an [interrupted update](#interrupted-updates) stopped, the section has no hover text. **Restore version x** does the same for files that are in neither the backup nor the installed list.

Chrome's `_metadata` folder and the `Thumbs.db`, `desktop.ini` and `.DS_Store` files are left alone, but only inside folders that the new release (or the backup) also has. In a folder that the release drops, they count like any other file.

Common causes: the ZIP, notes or a settings backup saved in the extension folder, or a release extracted over an older one. Move the files out, or [update by hand](#updating-by-hand) into the emptied folder, then try again.

#### Interrupted updates

A sign-out, crash or power cut while files are being replaced leaves the folder with files of two versions. The updater prepares for that:

* It backs up the folder and records the update as in progress (an `applying` marker) before it copies anything.
* It copies `manifest.json` last, so the folder declares the old version until every other file is in place.
* The next time the updater runs while no other update runs, it puts the backup back first. That happens when you open **Settings → Updates**, start an install or a restore, or run `-Status`, `-Update`, `-Install` or `-Rollback`. It deletes only files that the old release or the folder's current list names, or that the pending download contains. Any other file stops the repair with `unexpected-files`, and the repair is tried again at the next run.

When opening **Settings → Updates** triggered the repair, the section says "An interrupted update was undone and the previous version was restored. Nothing else was changed." If the restored version differs from the one running, uBlock Plus+ reloads into it. When an install triggered the repair, the install simply continues. On the command line, `-Status` reports `recovered` and `-Update` prints "restored x after the interrupted update to y".

If no backup is left (for example it was deleted to free space) or it cannot be restored, the dashboard shows "The earlier version could not be restored. …" and the log says "The update to y was interrupted and no backup of version x is left. Run the updater with -Rollback." The section also shows the setup steps, because the updater does not connect. Ignore them: rerunning the installer does not fix this. Instead:

1. Run `-Rollback` on the [command line](#command-line). With no backup, it keeps the folder as it is, provided it is uBlock Plus+ of the right edition and declares either version. It clears the interrupted state and prints "Cleared the interrupted update to y. …".
2. Run `-Update`, or [update by hand](#updating-by-hand) into the emptied folder.

The dashboard cannot do this: without a backup it shows no **Restore version x** button, and the updater's `rollback` command answers `no-backup`. `-Status` keeps working and reports `interrupted` with the error.

#### Installer messages

After any error, `install-updater.cmd` also prints "The updater was not installed. See the message above." The line above it gives the reason. After "The first download failed", the updater registration was kept anyway.

| Message | Cause and fix |
| --- | --- |
| The updater cannot manage this folder. … | See [folder rules](#folder-rules). A folder that the installer created for the check is removed again. |
| … does not contain a uBlock Plus+ extension. | The folder holds another extension. Run the installer from the uBlock Plus+ folder, or pass `-ExtensionDirectory`. |
| … is already registered for extension ID …. Pass -Replace to update this folder instead, or uninstall the other one first. | Another registered folder uses the same ID. Experimental builds share one ID, and an `-ExtensionId` you passed can also belong to another folder. Run the installer in the folder that **Details → Loaded from** on `chrome://extensions` shows. Pass `-Replace` only from that folder: it moves the registration to the folder you run it in. |
| An update is running; try again in a minute. | `-Replace` or `-Uninstall` does not interrupt a running update. Try again when it finishes. |
| The first download failed; the updater registration was kept. Run this script again. | The folder was not empty, or the download or verification failed; the lines above say why. Empty the folder, check the connection and run the installer again. |
| Kept the installed updater x, which is newer than y in this folder. Pass -Force to replace it. | Information: the installed updater is newer than the one in this folder. |
| Kept the trusted release signing keys: this folder ships an older key set, or one without all of them. Pass -ResetKeys to replace them. | Information: this folder's keys would weaken the trusted set. Use `-ResetKeys` only for deliberate recovery. |
| No stable release is published yet, so the updater finds no update until one is. Run this script with -IncludePrerelease to follow pre-releases. | Warning after `-StableOnly`. |
| Pass either -StableOnly or -IncludePrerelease, not both. | Choose one. |
| Invalid extension ID: … | An ID is 32 letters from `a` to `p`. Copy it from the dashboard or from **Details** on `chrome://extensions`. |
| The uBlock Plus+ updater supports Windows only. | The installer ran on another system. |

#### Other problems

| Problem | Fix |
| --- | --- |
| uBlock Plus+ is disabled or missing after a restart | Keep **Developer mode** on at `chrome://extensions`. Chrome disables unpacked extensions without it, independently of updates. |
| Websites still behave as before the update | Reload them. Already-injected scripts and cosmetic filters stay until then. |
| **Stable releases only** never finds a version | At the time of writing, every release is a pre-release. |
| `-Update` installs a pre-release although the dashboard uses **Stable releases only** | The command line does not use the dashboard setting. Pass `-IncludePrerelease no`, or run the installer with `-StableOnly`. |

### Moving an existing installation

Chrome derives an unpacked extension's ID from its folder. Moving the folder therefore creates a new extension: settings do not carry over, and you grant the updater permission again.

1. In the old copy, export your settings: **Dashboard → Settings → Backup → Back up…**.
2. If the updater manages the old folder, run `updater\install-updater.cmd -Uninstall` in it.
3. On `chrome://extensions`, select **Remove** on the old copy.
4. Install into `%LOCALAPPDATA%\uBlockPlus\Extension`: [setup](#one-time-setup-on-windows) steps 1 to 3, or the [one-step installer](#one-step-installer) followed by setup step 3 (**Load unpacked**).
5. In the new copy, restore your settings: **Dashboard → Settings → Backup → Restore…**.
6. Run `updater\install-updater.cmd` in the new folder (the one-step installer already did), then select **Allow the updater**.
7. Delete the old folder.

### Uninstalling

To remove only the updater, run `updater\install-updater.cmd -Uninstall` in the extension folder, or add `-ExtensionDirectory <folder>`. It:

* stops with "An update is running; try again in a minute." while an update runs;
* removes the registration of this folder, and deletes the updater's download, backup and state for it;
* when no other folder remains registered, removes the registry entries for all browsers and deletes `%LOCALAPPDATA%\uBlockPlus\Updater`, including the log, configuration and trusted keys, and prints "The uBlock Plus+ updater was removed. The extension folder was not changed.";
* otherwise keeps the updater and its registration for the other folders, and prints "Stopped updating <folder>. Other installations remain registered."

The extension folder and your settings are not changed. uBlock Plus+ still checks for new versions, and it keeps the native messaging permission. **Settings → Updates** therefore shows "The Windows updater is not installed yet." and the setup steps, in either mode. If other folders are still registered, it shows "The updater is registered for a different extension folder or ID. Run the command below." instead. In **Install it automatically** mode, each new version also fails with that message; select **Only notify me** to stop these attempts. The message itself stays.

To remove uBlock Plus+ entirely, remove the updater as above, select **Remove** on `chrome://extensions`, then delete the extension folder. Export a backup first if you may reinstall later. If you used the one-step installer, you can also delete `%TEMP%\install-updater.ps1` and the `%TEMP%\ubp-updater-*` folders.

## Command line

### Updater

Use the installed copy in `%LOCALAPPDATA%\uBlockPlus\Updater`. It reads `config.json` next to it, so the copy inside the extension folder does not work. `ublock-plus-updater.cmd` is only Chrome's launcher for the native host.

```powershell
$updater = "$env:LOCALAPPDATA\uBlockPlus\Updater\ublock-plus-updater.ps1"
powershell -ExecutionPolicy Bypass -File $updater -Status
powershell -ExecutionPolicy Bypass -File $updater -Update
powershell -ExecutionPolicy Bypass -File $updater -Rollback
```

| Switch | Effect |
| --- | --- |
| `-Status` | The default. Prints the registered folder as JSON: `extensionDir`, `edition`, `installedVersion`, `stagedVersion`, `backupVersion`, `lastApplied`. First undoes an interrupted update when no other update runs, and then adds `recovered`. If that fails, it adds `interrupted` (`from`, `to` and the error) instead of failing. |
| `-Update` | Reads the release list, then downloads, verifies and installs the newest release. Prints "uBlock Plus+ x is up to date." when there is nothing newer. |
| `-Update -Version <version>` | Uses that release instead of the newest. There are no downgrades: an older or equal version only prints "up to date". |
| `-Install` | Like `-Update`, and also fills an empty or missing registered folder. The installer uses it for the first download. Accepts `-Version` too. |
| `-Rollback` | Restores the backup made before the last update. With no backup left after an interrupted update, keeps the folder and clears the interrupted state (see [interrupted updates](#interrupted-updates)). |
| `-IncludePrerelease yes`, `no` or `config` | With `-Update` and `-Install`: whether pre-releases count. `config` (the default) uses the installer's `-StableOnly` or `-IncludePrerelease`; without them, pre-releases count. The dashboard's **Release channel** does not apply here. |
| `-ExtensionDirectory <folder>` | Selects a registered folder (with `-Status`, `-Update`, `-Install` and `-Rollback`). Required when several folders are registered; an unknown folder is `unknown-installation`. |
| `-NativeHost`, `-CallerOrigin <origin>` | Used by Chrome through `ublock-plus-updater.cmd`. Not for manual use. |

The command line does not wait for filter-list work and does not reload the extension. After `-Update` or `-Rollback`, click **Reload** on the extension card at `chrome://extensions`, or restart the browser.

A command-line rollback does not [hold](#settings) the version you left. In **Install it automatically** mode, the next check installs it again. To stay on the earlier version, use **Restore version x** in the dashboard, or select **Only notify me** first.

On failure the updater prints `uBlock Plus+ updater error (<code>): <message>` and exits with code 1.

### Installer

`install-updater.cmd` runs `install-updater.ps1` with `-ExecutionPolicy Bypass` for that process only, passes all arguments on and waits for a key at the end. Run it from the extension folder, for example `updater\install-updater.cmd -StableOnly`.

| Switch | Effect |
| --- | --- |
| `-ExtensionDirectory <folder>` | The folder that contains `manifest.json`. Default: the folder above `updater` when it contains `manifest.json`, otherwise `%LOCALAPPDATA%\uBlockPlus\Extension`. A missing folder is created; an empty one is filled with the newest release. |
| `-ExtensionId <id>` | Also trust this extension ID. The dashboard shows the exact command when Chrome reports an ID that the installer could not derive from the path. IDs registered earlier for the same folder are kept. |
| `-StableOnly` | The command line ignores pre-releases. Warns when no stable release exists. |
| `-IncludePrerelease` | The command line considers pre-releases again (the default). Cannot be combined with `-StableOnly`. |
| `-Replace` | Moves the registration to this folder when another registered folder has the same extension ID (experimental builds, or an `-ExtensionId` that belongs to the other folder). Run it only from the folder the browser loads. Deletes the updater's download, backup and state for the other folder, not the folder itself. |
| `-ResetKeys` | Replaces the trusted release signing keys with the set this folder ships, even an older one. Only for deliberate recovery. |
| `-Force` | Installs the updater from this folder even when the installed one is newer. |
| `-Uninstall` | See [uninstalling](#uninstalling). |
| `-Repository <owner/name>` | Repository for downloads and the command line's release list; default `kayurachann/uBlock-Plus`. Also resets the download address to that repository's. For forks and tests: the extension itself always checks `kayurachann/uBlock-Plus`. |
| `-ReleaseBaseUrl <url>`, `-ApiBaseUrl <url>` | Download and API addresses, for tests. The updater accepts HTTPS only, and plain HTTP only on `localhost` or `127.0.0.1`. |
| `-InstallRoot <folder>` | Where the updater is installed; default `%LOCALAPPDATA%\uBlockPlus\Updater`. |
| `-NoRegistry` | Writes no registry entries. For tests. |

Options passed on the command line replace the stored ones; options not passed keep their stored values. Rerunning the installer is safe. It never replaces a newer installed updater (unless `-Force`), and never replaces the trusted keys with a key set of a lower generation, with an empty set, or with a set of the same generation that lacks a trusted key (unless `-ResetKeys`).

## For administrators

The managed storage setting `autoUpdate` caps what users can choose. Set it like any managed extension setting, through Chrome's `3rdparty` extension policy for the extension's ID. For example, on Windows, create the string value `autoUpdate` under `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<extension ID>\policy`. For an unpacked copy, the ID depends on its folder path.

| Value | Checks | Installs | Restore |
| --- | --- | --- | --- |
| `auto`, or not set | As the user chooses | As the user chooses | Allowed |
| `notify` | As the user chooses | Never automatically; **Install now** still works | Allowed |
| `off` | None: no alarms, no requests, and a version found earlier is forgotten | None | Not allowed |

Use exactly `off`, `notify` or `auto`. The extension's policy schema (`managed_storage.json`) allows only these values. Chrome ignores another value and reports it on `chrome://policy`, and the extension then behaves as if the policy were not set. (If another value reached the extension, it would count as `notify`.) When `disabledFeatures` contains `dashboard`, the Updates section is hidden, so the extension also behaves as with `notify`. The Updates section tells users that the administrator manages these settings, and changing them fails with "Your administrator does not allow this."

The policy applies to the extension. The Windows updater has no policy of its own, and its command line ignores the extension's policy. To prevent the extension from starting it, block the native messaging host `io.github.kayurachann.ublock_plus.updater` with Chrome's `NativeMessagingBlocklist` policy, or disallow per-user hosts with `NativeMessagingUserLevelHosts`.

## Design and trust model

This section is the RFC for the first native companion. It covers the threat model, the IPC schema, install and uninstall, verification, log retention and the resource budget. The updater changes no proxy or DNS settings; any such capability needs its own RFC.

### Components

```text
Chrome
  service worker: update-manager.js, update-core.js
    |-- GET release list (JSON only) -----------------------> api.github.com
    |-- native messaging: hello, stage, apply, rollback (version strings only)
    v
Windows, current user: %LOCALAPPDATA%\uBlockPlus\Updater
  ublock-plus-updater.cmd -> ublock-plus-updater.ps1
    reads config.json (folders, extension IDs, repository) and release-signing-keys.json
    |-- HTTPS: <asset>.sha256, <asset>, <asset>.sig --------> github.com/<repo>/releases/download/v<version>/
    |-- staging\<key>\package   verified, extracted package
    |-- backup\<key>            copy of the folder before the update
    v
  unpacked extension folder  <-- robocopy /MIR from staging, manifest.json last
Chrome reloads the extension from that folder (runtime.reload)
```

* **Extension.** `js/update-core.js` holds pure functions: version parsing, release selection, backoff, policy, reply validation. `js/update-manager.js` runs in the service worker: checks, alarms, install and restore, state. `js/update-ui.js` renders **Settings → Updates** (`#autoUpdate` in `dashboard.html`), and `js/popup.js` the **Update x.y.z** button (`#updateAvailable`). `js/background.js` wires them up: sender checks, the filter-list busy guard and the managed policy. The extension decides whether a release is newer, for its edition and channel, and asks the updater for a **version string**. It never downloads or runs a package, and never passes a URL or a path to the updater.
* **Updater** (`platform/mv3/updater`). `ublock-plus-updater.ps1` runs under Windows PowerShell 5.1 as the native messaging host and as a command-line tool. Chrome starts it per request through `ublock-plus-updater.cmd`, and it exits after answering. `install-updater.ps1` (and its `.cmd` launcher) installs and registers it. There is no service, scheduled task, startup entry, browser policy or elevated process. The updater manages only the folders recorded in its `config.json`.
* **Release pipeline.** `.github/workflows/release.yml` builds and publishes. `tools/make-mv3.ps1` packages the updater into every build and has `tools/package-files.mjs` write `updater/package-files.json`. `tools/validate-mv3.mjs` requires both. `tools/release-signing.mjs` manages signing keys.

### Files and state

In `%LOCALAPPDATA%\uBlockPlus\Updater`. `<key>` is the first 16 hexadecimal digits of the SHA-256 of the lower-cased full folder path.

| File | Content |
| --- | --- |
| `ublock-plus-updater.ps1`, `ublock-plus-updater.cmd` | The updater and Chrome's launcher |
| `config.json` | Written by the installer: `schemaVersion` 1, `repository`, `releaseBaseUrl`, `apiBaseUrl`, `includePrerelease`, and `installations` (`extensionDir`, `edition`, `extensionIds`) |
| `io.github.kayurachann.ublock_plus.updater.json` | Native messaging host manifest: the launcher's path and `allowed_origins` for every registered ID |
| `release-signing-keys.json` | Trusted release signing keys |
| `staging\<key>\` | `staged.json` and `package\`, the verified and extracted release |
| `backup\<key>\` | The folder as it was before the last update |
| `state-<key>.json` | `lastApplied`, and `applying` while files are replaced |
| `updater.log`, `updater.log.1` | Log. Rotated at 256 KiB, so at most about 512 KiB. It holds times, versions, folder paths and error messages, no browsing data. |
| `updater.lock` | Held while an update or restore runs |

Registry: the default value of `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.kayurachann.ublock_plus.updater` points to the host manifest. The installer always writes this key, and writes the same key under `Microsoft\Edge`, `Chromium` and `BraveSoftware\Brave-Browser` when that browser's key exists.

Extension: the settings (`schemaVersion`, `check`, `install`, `channel`) are in `storage.local` under `autoUpdate.settings`. The state is under `autoUpdate.state`: last check and success, ETag, a compact release list, the offered version, failures and next retry, last error, the running install, pending reload, last update, updater status and held version. Content scripts can read and write `storage.local`, so both are validated on every read. Neither is part of settings backups.

### Extension behaviour

**Checks**

* The alarm `autoUpdateCheck` repeats every 360 minutes. Its first run comes 2 minutes to 6 hours after start, depending on the last check.
* Scheduled checks run at least 30 minutes apart.
* After a failure, the next check waits 15 minutes, then 30 minutes, 1 hour and so on, up to 24 hours. A one-shot alarm, `autoUpdateRetry`, runs it when the wait ends, and is scheduled again after a browser restart. For HTTP 403 and 429 (`rate-limited`), `Retry-After` or `X-RateLimit-Reset` wins when later, up to 24 hours.
* **Check now** runs at most once per 60 seconds, except after a failed check other than a rate limit, and once after a channel change.
* There are no scheduled checks and no alarms when checks are off, in development builds (first version number 2000 or more), under the policy `off`, and in the incognito worker.
* The request is `GET https://api.github.com/repos/kayurachann/uBlock-Plus/releases?per_page=30`. It sends `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` and, with a cached list, `If-None-Match`; a 304 reuses the cached list. It uses `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'` and `cache: 'no-store'`, a 15-second timeout and a 2 MiB response limit.
* Only a compact list is stored: tag, draft and pre-release flags, name (plain text, at most 120 characters), date and asset names. Release names are rendered with `textContent`, and release links are built locally.

**Selection.** A release is offered when all of these hold:

* its tag is `v` followed by a Chromium version (one to four numbers up to 65535, without leading zeros);
* it is not a draft, and not a pre-release on the stable channel;
* it lists `uBlock-Plus_<version>.chromium.zip` (standard) or `uBlock-Plus_<version>.experimental.chromium.zip` (experimental) and the matching `.sha256`;
* it is strictly newer than the running version.

The newest such release is offered.

**Eligibility to install.** In this order, the first failing condition is reported: the worker is not the incognito worker (`incognito`); not a development build (`development-build`); `management.getSelf().installType` is `development` (`not-unpacked`); the OS is Windows (`unsupported-os`); the policy is not `off` (`disabled-by-policy`); the optional `nativeMessaging` permission is granted (`permission-required`); the worker has the native messaging API, which Chrome adds only after a restart (`restart-required`). An automatic install is not started when any of these fails, and records nothing; nor does it record `notify-only` and `held`. The next check tries again.

**Install flow**

1. Check eligibility and that the version is strictly newer than the running one (`not-newer`).
2. Wait up to 60 seconds for startup and queued filtering transactions, otherwise stop with `filters-busy`. In split incognito mode, also wait within the same bound for the incognito worker's transaction journals to clear; journals that outlive the bound were left by a failed recovery and do not block.
3. For an automatic install, read the settings, the policy and the hold again (`notify-only`, `held`).
4. `hello` (`sendNativeMessage`). The updater must answer, manage the same edition, and report the running version on disk. If the folder already holds a newer version (for example after `-Update` on the command line), skip to step 9. An older or unknown version is `folder-mismatch`.
5. Check that the selected channel offers the version (`not-offered`).
6. `stage` through `connectNative`. The port carries progress events and keeps the worker alive. Limit: 20 minutes (`timeout`).
7. Wait for filtering transactions again. If busy, stop; the staged download is kept and reused.
8. `apply` (`sendNativeMessage`). The reply must name the requested version.
9. Record `pendingReload` and call `runtime.reload()` after 250 ms. A manual install also ends the hold and asks the next worker to reopen **Settings → Updates**.
10. At the next start, the worker compares the running version with the expected one and records `lastUpdate`, or `reload-mismatch`. An install marker that a fresh worker finds is recorded as `interrupted`.

An automatic install refused with `filters-busy` schedules `autoUpdateRetry` five minutes later. That retry installs the known version without asking GitHub again.

**Restore flow.** Eligibility, the busy guard, then `rollback`. On success, record the pending reload, reload and reopen **Settings → Updates**. At the next start, the version restored from becomes `heldVersion`. Automatic installs skip it and older versions until a newer release is found, **Install now** is used, or the running version reaches it.

**Reporting an undone update.** When `hello` returns `recovered`, the worker records `update-undone`. If the restored version differs from the running one, it reloads the extension. Only the status request (`hello` from the dashboard) reports this. An install that finds an interrupted update lets the updater undo it and continues.

**Boundaries**

* Install and restore run one at a time in the worker (`update-busy`).
* The update messages (`activateUpdater`, `getUpdateStatus`, `setUpdateSettings`, `checkForUpdatesNow`, `installUpdateNow`, `rollbackUpdate`) are accepted only from extension pages: same extension ID, a sender URL under the extension's origin and, when present, a matching origin. Content scripts and web pages cannot send them.
* These messages work even when the rest of the extension failed to start, because a newer release is the usual fix for a broken one.
* In split incognito mode, only the regular worker writes the update state and owns the alarms.

### Native messaging protocol v1

**Registration.** The host `io.github.kayurachann.ublock_plus.updater` is registered per user (see [files and state](#files-and-state)). Its manifest lists `allowed_origins` for every registered installation, so Chrome starts it only for those extension IDs. The installer derives the IDs:

* Standard build: from the folder path, as Chromium does for unpacked extensions: SHA-256 of the UTF-16LE absolute path with the drive letter upper-cased, the first 128 bits mapped to the letters `a`–`p`. It registers the ID of the path with the case as stored on disk and of the path as given, plus any `-ExtensionId`, plus the IDs already registered for that folder.
* Experimental build: from the manifest `key`, which is fixed.

Chrome passes the caller's origin as the first argument. The host checks it against `config.json` again (`forbidden-origin`) and resolves the installation from it. It refuses to guess when an ID is registered for several folders (`ambiguous-installation`).

**Framing.** Chrome's native messaging format: a 32-bit length, then UTF-8 JSON. A request is at most 64 KiB. Each process handles one request and exits.

```json
{ "v": 1, "id": "stage-1790000000000", "cmd": "stage", "version": "1.2.1" }
```

`version` is required for `stage` and `apply`: one to four numbers, as in a Chromium version (`invalid-version`). The host truncates `id` to 64 characters and echoes it.

| Command | Lock | Effect | Reply fields besides `v`, `id`, `ok`, `cmd` |
| --- | --- | --- | --- |
| `hello` | Only to undo an interrupted update, and only when free | Reports state | `updaterVersion`, `protocol`, `repository`, `signatureRequired`, `extensionDir`, `edition`, `installedVersion`, `stagedVersion`, `backupVersion`, `lastApplied` |
| `stage` | Yes | Undoes an interrupted update, then downloads, verifies and extracts into `staging\<key>\package`. Reuses a staged package of the same version (only a signed one while keys are trusted). Sends progress events. | `version`, `sha256`, `signedBy`, `reused` |
| `apply` | Yes | Undoes an interrupted update, checks, backs up, replaces and verifies the folder, restores on failure. Then adopts keys and updates itself from a signed package. | `applied`: `from`, `to`, `at` |
| `rollback` | Yes | Puts the backup back, including after an interrupted update. Without a backup: `no-backup`. | `applied`: `from`, `to`, `at`, `rollback: true` |

Any successful reply can carry `recovered`: `restored` and `interrupted` versions, when an interrupted update was undone.

Progress events use the request's `id`: `{ "v": 1, "id": "…", "event": "progress", "phase": "…", "received": …, "total": … }`. The phases are `checksum`, `download`, `verify`, `signature` and `extract`.

Errors are `{ "v": 1, "id": "…", "ok": false, "error": { "code": "…", "message": "…" } }`. The codes are stable:

| Group | Codes |
| --- | --- |
| Request | `invalid-request` (empty, over 64 KiB or truncated), `unsupported-protocol`, `unsupported-command`, `invalid-version` |
| Registration | `not-installed`, `invalid-config`, `forbidden-origin`, `ambiguous-installation`, `unknown-installation` (command line) |
| Versions | `not-newer`, `not-staged`, `no-release` and `check-failed` (command line) |
| Download | `download-failed`, `package-too-large` |
| Verification | `checksum-invalid`, `checksum-mismatch`, `signature-missing`, `signature-invalid`, `package-invalid`, `identity-mismatch` |
| Folder | `unsafe-extension-dir`, `unexpected-files`, `backup-failed`, `apply-failed`, `no-backup`, `rollback-failed` |
| Concurrency | `update-busy` |
| Other | `internal-error` |

The extension validates every reply before use: protocol version, the error code's form, field types and lengths, and version strings. It maps Chrome's own errors to `updater-missing` (host not found), `updater-forbidden` (origin not allowed), `updater-failed` (host exited or failed to start) and `updater-error`. The dashboard shows a localized message per code; see [troubleshooting](#troubleshooting).

### Verification chain

A release reaches the extension folder only if every step passes.

1. **Source.** URLs are built from `config.json` (`releaseBaseUrl`, default `https://github.com/kayurachann/uBlock-Plus/releases/download`), `v<version>` and the fixed asset name. Only HTTPS is used, except plain HTTP on `localhost` and `127.0.0.1` for tests, and a redirect must stay on HTTPS. Size limits: 4 KiB for the checksum file, 8 KiB for the signature file, 256 MiB for the package. The download is streamed and counted.
2. **Integrity.** The `.sha256` file must be one line, `<64 hex digits>  <asset name>`, and the name must be exactly the requested asset. A bare hash, or another name, is `checksum-invalid`. The package's SHA-256 must match (`checksum-mismatch`).
3. **Authenticity**, when keys are trusted. `<asset>.sig` must exist (HTTP 404 is `signature-missing`; other download errors stay `download-failed`). It holds one base64 signature per line, at most 8 lines. One line must be a valid RSA PKCS#1 v1.5 signature over the package's SHA-256 digest from a trusted key (`signature-invalid`). See [release signing keys](#release-signing-keys).
4. **Archive safety.** At most 20,000 entries and 768 MiB expanded. Both the declared sizes and the bytes actually written are counted, so an entry cannot expand beyond its declared size. Entry names must be relative, without backslashes, colons, `.` or `..` segments, and must resolve inside the staging folder. Duplicate entries are refused. A corrupt ZIP is `package-invalid`, and the staging folder is removed.
5. **Identity.** `manifest_version` 3, `short_name` "uBlock Plus+", the installation's edition (an `experimental-webrequest.json` file marks the experimental edition, which must also be named "uBlock Plus+ Experimental"), the requested version, and the same manifest `key` as the installed copy, so the extension ID cannot change (`identity-mismatch`).
6. **Newer.** The version must be strictly newer than the installed one, checked at stage and again at apply (`not-newer`). An update never downgrades, and an old release cannot be replayed.
7. **Target folder.** It must hold uBlock Plus+ of the same edition, or be empty or missing for `-Install`. It must pass the [folder rules](#folder-rules) and contain no [unexpected files](#unexpected-files).

### Release signing keys

`release-signing-keys.json` has the form `{ "schemaVersion": 1, "generation": N, "keys": [ { "id", "kty": "RSA", "n", "e" } ] }`. A missing `generation` counts as 0. The updater accepts RSA keys of at least 2048 bits; `tools/release-signing.mjs` generates 3072-bit keys. Today no key is published (`"keys": []`), so releases are verified by checksum only, and the installer prints `Signed releases  : not configured (checksum only)`.

* **Pinning.** The installer copies the key set that ships next to it (in the one-step installer, from the `main` branch) when no key is trusted yet, when the shipped set is not empty and has a higher generation, when it has the same generation and contains every trusted key, or with `-ResetKeys`. Otherwise it keeps the trusted set.
* **No trust on first use.** An updater without keys never takes keys from a download. After the first key is published, an existing installation starts requiring signatures only when its user runs `updater\install-updater.cmd` again from a release that ships the key.
* **Adoption from signed releases.** After it applied a release whose signature verified, the updater adopts the key set in that release, unless it is empty or of a lower generation. It reads the verified staging copy, never the extension folder, and writes exactly the bytes it checked.
* **Self-update.** Under the same condition, the updater replaces its own `.ps1` and `.cmd` with the copies in the release. The new script must parse without errors and declare a higher `$script:UpdaterVersion`, and the launcher must start it as the native host. A damaged release therefore cannot disable future updates. The `.cmd` launcher is one command line ending in `& exit /b`, so replacing it while it runs is safe. Without signing, the updater never replaces its keys or itself; rerunning the installer from a newer release does.
* **Rotation.** Releases are signed with the old and the new key for a long overlap. Updaters that install one of them verify with the old key and adopt the new key set. Then the old key is retired, which raises the generation. Updaters never go back to a lower generation, so a retired key does not come back. The release workflow fails a release that the previous release's keys would not verify. An updater that missed the whole overlap refuses later releases, and its user reruns the installer from the latest release. See [maintainers](#release-signing-keys-for-maintainers).

### Replacing files

* **Lock.** Stage, apply and restore hold `updater.lock`, opened exclusively. A second operation fails at once with `update-busy`. Windows releases the lock when the process ends, so a crash leaves no stale lock. `hello` and `-Status` take the lock only to undo an interrupted update, and skip that when the lock is held, so a status request never makes a starting update fail. The installer takes the same lock for `-Replace` and `-Uninstall`.
* **Unexpected files.** Before anything is copied, every file in the folder must be in the new package, be listed in the installed release's `updater/package-files.json`, or be one of the [ignored files](#unexpected-files). Otherwise the update stops with `unexpected-files` and names up to ten files. Files are compared with the new package's actual contents, not its list, so a wrong list in a new release cannot cause user files to be deleted. Restore compares with the backup's contents and the installed list.
* **Backup.** The folder is copied into an emptied `backup\<key>` and verified by its manifest version. If that fails, nothing is changed (`backup-failed`).
* **Marker.** The folder is checked for links again, then `state-<key>.json` records `applying` (`from`, `to`, time).
* **Copy.** The staged files got one fresh timestamp when they were extracted. `robocopy "<staging>" "<folder>" /MIR /IS /IT /XJ /XD _metadata /XF "<staging>\manifest.json" Thumbs.db desktop.ini .DS_Store /R:5 /W:1 /NP /NFL /NDL /NJH /NJS` makes the folder a copy of the verified package. After that, `manifest.json` is copied on its own.
  * `/IS /IT` copy files even when size and time match, so versions cannot mix.
  * `/XJ` skips links in the source only; links in the target are refused beforehand.
  * Chrome keeps indexed rulesets in `_metadata` and rebuilds them on reload, so that folder is neither copied nor purged.
  * robocopy's output goes to the log, never to the native messaging channel.
* **Verification.** The folder's manifest must declare the new version. Otherwise the backup is restored, and the error says whether that worked. The marker is cleared only once the folder verifies, or once the backup is back.
* **Afterwards.** `lastApplied` is recorded. Keys and the updater are refreshed from a signed release, and the staging folder is removed. The backup stays for **Restore version x**.
* **Interrupted apply.** If the process stops between marker and verification, the next run that gets the lock restores the backup first. It checks that the folder contains only files that the old release or the folder's current `package-files.json` names, or that the staged download contains. The staged download stays until an apply succeeds. See [interrupted updates](#interrupted-updates).
* **Not atomic.** Files are replaced one by one. Between the copy and `runtime.reload()`, about a second, the running extension may read new files. The busy guard keeps ruleset transactions out of that window.

### Network requests

| Who | Address | When |
| --- | --- | --- |
| Extension | `api.github.com/repos/kayurachann/uBlock-Plus/releases?per_page=30` | Scheduled checks and **Check now** |
| Updater | `github.com/<repo>/releases/download/v<version>/…`: the `.sha256`, the ZIP and the `.sig`. GitHub redirects the download to one of its `githubusercontent.com` hosts. | When it stages a release |
| Updater, command line | `api.github.com` release list | `-Update` and `-Install` without `-Version`, including the installer's first download |
| Installer | `api.github.com` release list | Only with `-StableOnly` |
| Installer, one-step copy | `raw.githubusercontent.com/kayurachann/uBlock-Plus/main/platform/mv3/updater/`: `ublock-plus-updater.ps1`, `ublock-plus-updater.cmd`, `release-signing-keys.json` | When no updater files are next to it |
| You, one-step command | `raw.githubusercontent.com/…/install-updater.ps1` | Once |
| You, **Release notes** | `github.com/kayurachann/uBlock-Plus/releases/tag/v<version>` | When you select it. The page opens in a new tab, without a referrer, like any page you visit. |

No request carries browsing data, settings or an identifier. The extension sends no cookies or referrer. The updater identifies itself as `uBlock-Plus-Updater/<updater version>`. GitHub sees the IP address and the user agent. The updater only receives a version number from the extension, and sends nothing else anywhere. See [PRIVACY.md](PRIVACY.md).

### Resource use

No process stays resident: PowerShell starts per request and exits after answering. Downloads are streamed through a 256 KiB buffer. On disk, the updater keeps, per registered folder, at most one staged release (download limit 256 MiB, 768 MiB expanded; real packages are far smaller) and one backup copy, plus about 512 KiB of log.

### What the updater never does

* It never accepts a URL, path or command from the extension: only a version string.
* It never installs an older or equal version. Restore uses only the local backup.
* It never changes the extension ID or edition.
* It never deletes a file that no uBlock Plus+ package involved in the operation listed or contained, and never writes through a junction or symbolic link.
* It never changes a folder that is not in `config.json`, nor a folder that other users can change.
* It never takes keys or a new copy of itself from an unsigned release, and never goes back to an older key set.
* It never runs in the background, starts with Windows, needs administrator rights or changes browser policies.
* It never reloads the extension; the extension reloads itself.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| A web page or content script starts an install or restore | Update messages are accepted only from extension pages. Only a version string reaches the updater. |
| Another extension talks to the host | Chrome enforces `allowed_origins`, and the host checks the origin against `config.json` again. |
| A tampered or truncated download | Checksum bound to the asset name, signatures once keys are published, archive limits counted on written bytes, identity and version checks. The folder is backed up and restored on failure. |
| A compromised release (account or CI) | Release signatures with pinned keys, once published. The signing secret and the OIDC token exist only in the publish job, which installs no npm code. The previous release's keys must verify each new release. Build-provenance attestations let people check a package. Strictly newer versions only. |
| A downgrade or replay of an old, vulnerable release | Strictly newer version at stage and apply. Restore is explicit and only to the local backup. Key sets never go back to a lower generation. |
| Path tricks: zip slip, junctions, the wrong folder | Entry name checks, links refused in and above the folder, folders changeable by other users refused, system and profile folders refused, identity check before `/MIR`. |
| Deleting the user's own files | Only files listed in `package-files.json` or contained in the release are replaced or removed; anything else stops the update. |
| Concurrent or interrupted operations | Updater lock, one operation at a time in the worker, uninstall and `-Replace` refused during an update, `manifest.json` last, backup and automatic repair. |
| Abuse of the updater's self-update | Only from a signed release, from the verified staging copy, only to a higher version that parses. |
| Privacy | One public API request about every six hours, with an opt-out and no identifiers. |
| Resource use | No resident process. Bounded downloads, archive and log. |

### Residual risks

* **No signing key is published yet.** The `.sha256` file sits next to the package in the same release. It protects against damaged or truncated downloads, not against someone who can publish releases (a compromised GitHub account, repository or workflow). Such a release would reach every installation in automatic mode within about six hours, as extension code with the extension's permissions. It would not replace the updater, because self-update requires a signature. Provenance attestations help people check a package, but the updater does not check them.
* **With signing:** a leaked private key. Installed updaters trust a key until they adopt a later key set (see [the maintainer steps](#release-signing-keys-for-maintainers)). The build job still produces the ZIPs, and it runs npm development dependencies (with read-only permissions and no secrets). A compromised dependency could alter a package before it is signed. The job split protects the key and the OIDC token, not the package contents.
* **One-step installer.** It trusts whatever the `main` branch holds at that moment (scripts and keys), fetched over HTTPS without a signature.
* **Local attackers.** The updater is an unsigned PowerShell script in the user's profile, started with `-ExecutionPolicy Bypass`. Software running as the same user can change it, and its staged download, as it can change the extension folder anyway.
* **Folder checks** use a list of groups shared by all accounts. An entry that grants one specific other account write access is not detected, and Deny entries are not considered. The checks run at fixed moments and rely on these permissions between them.
* **Availability.** Updates depend on GitHub. A rate limit or outage delays them; there is no mirror.
* **Older releases.** Releases before 1.2.0 have no updater and no provenance attestation.

### Non-goals

* No store publishing and no CRX `update_url`. Chrome on Windows blocks installing CRX files from outside the store unless enterprise policy allows it.
* No remote code in the extension. A whole, verified release replacing the unpacked folder is an update channel, as in a browser's own updater. It is not runtime code loading.
* No silent first installation. The user runs the installer and grants the permission.

## For maintainers: publishing a release

### Release workflow

1. Update `version` in `package.json`, add a `CHANGELOG.md` entry and merge to `main`.
2. Tag and push: `git tag v<version>`, then `git push origin v<version>`. The tag must be `v` followed by the `package.json` version, or the workflow stops.

The **Release** workflow (`.github/workflows/release.yml`) has two jobs:

| Job | Permissions | Steps |
| --- | --- | --- |
| **Build and verify** | `contents: read`, no secrets | Checks out the tag with submodules. Runs `npm ci --ignore-scripts`, `npm test` and `npm run lint`. Builds both packages with `tools/make-mv3.ps1 -Version <version>` and validates them with `tools/validate-mv3.mjs --release`. Uploads the two ZIPs and their `.sha256` files as an artifact kept for 7 days. |
| **Sign and publish** | `contents: write`, `id-token: write`, `attestations: write` | Fresh checkout; installs no npm package. Checks that the artifact holds exactly those four files, that each `.sha256` line names its ZIP and matches, that each manifest declares the version, and that each ZIP ships `updater/ublock-plus-updater.ps1` and `updater/package-files.json`. Signs when keys are published (secret `UBP_RELEASE_SIGNING_KEY`). Checks that the previous release's keys verify the new packages. Attests build provenance for both ZIPs, then publishes. |

Published assets:

* `uBlock-Plus_<version>.chromium.zip`, `.sha256` and, when signing is enabled, `.sig`;
* `uBlock-Plus_<version>.experimental.chromium.zip`, `.sha256` and, when signing is enabled, `.sig`.

A new release is created with the title "uBlock Plus+ <version>", install notes and generated notes. `gh` keeps it a draft until every asset is uploaded. A tag push always publishes a **pre-release**. To make it a stable release, clear **Set as a pre-release** on the published release on GitHub, or run `gh release edit v<version> --prerelease=false`. This changes no asset. The workflow never changes the pre-release flag of a release that already exists. **Run workflow** (**Actions → Release**) with **Mark the GitHub release as a pre-release** cleared therefore creates a stable release only when no release exists for the tag yet, for example when you cancelled the tag-triggered run before its publish job started.

Rules:

* **Do not upload or replace assets by hand.** Updaters and users rely on each `.sha256` and `.sig` belonging to the ZIP next to it.
* **Existing releases.** The workflow never replaces an asset. Every asset that already exists must be byte-identical to this run's build, or the run fails with "Release v… already has a … that differs from this build. Delete that asset (or the release) and run this workflow again." Missing checksums and signatures are uploaded first, then the missing ZIPs.
* **Re-runs.** To finish a partly published release, use **Re-run failed jobs** within the 7 days the artifact is kept, so that the publish job uses the same build artifact. A full re-run builds new ZIPs, which are not byte-identical to the uploaded ones (file times differ), so it fails until the old assets are deleted.
* **Provenance.** `gh attestation verify <zip> --repo kayurachann/uBlock-Plus` checks a package. Releases before 1.2.0 were published by hand before this workflow existed; they have no attestation.
* `tools/test-release-workflow.mjs` runs three of the workflow's PowerShell steps (package verification, the previous-release key check and publishing) with a stub `gh`. The tag checks and the signing step are not run by it.

### Release signing keys for maintainers

`tools/release-signing.mjs` manages the keys. Every command accepts `--keys <file>` to use another key file.

| Command | Effect |
| --- | --- |
| `node tools/release-signing.mjs generate --out <private-key.pem> [--id <key-id>]` | Creates an RSA-3072 key pair. Writes the private key, refusing a path inside the repository or an existing file. Adds the public key to `platform/mv3/updater/release-signing-keys.json` and raises the generation. The default ID is `release-<date>`; an ID that is already published is refused. |
| `node tools/release-signing.mjs sign <zip>...` | Reads one or more PEM private keys from `UBP_RELEASE_SIGNING_KEY` (at most 8) and writes `<zip>.sig`, one line per key. Checks each signature against the published keys first, and refuses when no key is published. |
| `node tools/release-signing.mjs verify <zip>...` | Checks that `<zip>.sig` verifies with a published key. |
| `node tools/release-signing.mjs retire --id <key-id>` | Removes a key and raises the generation. Refuses the last key. |

**Enable signing (once).**

1. `node tools/release-signing.mjs generate --out <folder outside the repository>\ublock-plus-release.pem`
2. Commit the updated `platform/mv3/updater/release-signing-keys.json`.
3. Store the private key as a secret. In PowerShell: `Get-Content -Raw <private-key.pem> | gh secret set UBP_RELEASE_SIGNING_KEY`. The commands that `generate` and `retire` print are for bash: PowerShell does not accept `<`. Keep an offline copy.

From then on the publish job signs both ZIPs, and it fails when a key is published but the secret is missing. Existing installations do not adopt the first key from a release (no trust on first use). They stay on checksum-only verification until their users run `updater\install-updater.cmd` again from a release that ships the key. Say so in the release notes.

**Rotate keys.**

1. Generate the new key: it is added next to the old one. Commit the key file.
2. Set the secret to both private keys. In PowerShell: `Get-Content -Raw <current-key.pem>, <new-key.pem> | gh secret set UBP_RELEASE_SIGNING_KEY`.
3. Publish releases signed with both keys for a long overlap, so that updaters that skip releases still install one of them and adopt the new key set.
4. Retire the old key with `node tools/release-signing.mjs retire --id <old-key-id>`, commit, and set the secret to the new key alone: `Get-Content -Raw <new-key.pem> | gh secret set UBP_RELEASE_SIGNING_KEY`.

The workflow refuses a release that the previous release's keys do not verify. This catches a retirement before any release shipped the new key. It does not catch a short overlap: once one release signed with both keys is published, a release signed with the new key alone passes. Keep the overlap long yourself. Users whose updater missed the overlap see the signature error. They download the latest release, update by hand and run `updater\install-updater.cmd` again; the installer adopts the later key set.

**If a private key leaks.** Installed updaters keep trusting that key until they adopt a later key set, and they adopt one only from a package that a key they already trust signed. `sign` refuses a key that is no longer in the key file. Replace the key with a short rotation:

1. Generate a new key and commit the key file. Set the secret to the leaked key and the new key, and publish a release at once. Updaters that install it adopt the new key set, which still contains the leaked key.
2. Right after that, retire the leaked key, commit, set the secret to the new key alone and publish the next release. Updaters that install it stop trusting the leaked key.
3. In the release notes, ask users to [update by hand](#updating-by-hand) to the latest release and run `updater\install-updater.cmd` again; the installer replaces their key set with the later one. Updaters that missed the first release still trust only the leaked key and refuse releases signed with the new key alone. Updaters that missed the second release trust the leaked key until their next install.

Also follow the [incident response](THREAT-MODEL.md#incident-response) in THREAT-MODEL.md.
