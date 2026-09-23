/*******************************************************************************

    uBlock Plus+ - dashboard "Updates" section
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import { UPDATE_RELEASES_PAGE, compareVersions, parseVersion } from './update-core.js';
import { browser, i18n, sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';

/******************************************************************************/

const root = qs$('#autoUpdate');
let status = null;
let busy = false;
let restarting = false;
// The failure or note of the last action stays until the next action; a
// refresh of the stored state does not erase it, unless the worker recorded
// a newer failure or started an install since.
let transientError = null;
let transientNote = '';

const t = (key, substitutions) => i18n.getMessage(key, substitutions) || key;

// Numbers and dates follow the language of the extension's own text.
const uiLocale = (( ) => {
    try {
        return Intl.getCanonicalLocales(i18n.getUILanguage())[0];
    } catch {
        return undefined;
    }
})();

const formatNumber = (value, digits = 0) => {
    const options = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    try {
        return new Intl.NumberFormat(uiLocale, options).format(value);
    } catch {
        return value.toFixed(digits);
    }
};

const formatTime = value => {
    if ( Number.isFinite(value) === false || value <= 0 ) { return ''; }
    try {
        return new Date(value).toLocaleString(uiLocale);
    } catch {
        return '';
    }
};

const formatMiB = bytes => formatNumber(bytes / 1048576, 1);

// Error codes from the worker and the native updater. Anything else shows
// the (English) message inside a localized sentence.
const ERROR_KEYS = new Map([
    [ 'network-error', 'autoUpdateErrorNetwork' ],
    [ 'http-error', 'autoUpdateErrorNetwork' ],
    [ 'download-failed', 'autoUpdateErrorNetwork' ],
    [ 'rate-limited', 'autoUpdateErrorRateLimited' ],
    [ 'timeout', 'autoUpdateErrorNetwork' ],
    [ 'response-too-large', 'autoUpdateErrorNetwork' ],
    [ 'updater-missing', 'autoUpdateErrorMissing' ],
    [ 'not-installed', 'autoUpdateErrorMissing' ],
    [ 'updater-forbidden', 'autoUpdateErrorForbidden' ],
    [ 'forbidden-origin', 'autoUpdateErrorForbidden' ],
    [ 'unknown-installation', 'autoUpdateErrorForbidden' ],
    [ 'ambiguous-installation', 'autoUpdateErrorAmbiguous' ],
    [ 'updater-failed', 'autoUpdateErrorFailed' ],
    [ 'updater-error', 'autoUpdateErrorUpdater' ],
    [ 'internal-error', 'autoUpdateErrorUpdater' ],
    [ 'invalid-config', 'autoUpdateErrorUpdater' ],
    [ 'invalid-reply', 'autoUpdateErrorUpdater' ],
    [ 'invalid-request', 'autoUpdateErrorUpdater' ],
    [ 'unsupported-protocol', 'autoUpdateErrorUpdater' ],
    [ 'unsupported-command', 'autoUpdateErrorUpdater' ],
    [ 'checksum-mismatch', 'autoUpdateErrorChecksum' ],
    [ 'checksum-invalid', 'autoUpdateErrorChecksum' ],
    [ 'signature-missing', 'autoUpdateErrorSignature' ],
    [ 'signature-invalid', 'autoUpdateErrorSignature' ],
    [ 'package-invalid', 'autoUpdateErrorPackage' ],
    [ 'identity-mismatch', 'autoUpdateErrorPackage' ],
    [ 'package-too-large', 'autoUpdateErrorPackage' ],
    [ 'not-staged', 'autoUpdateErrorPackage' ],
    [ 'unexpected-files', 'autoUpdateErrorUnexpectedFiles' ],
    [ 'update-busy', 'autoUpdateErrorUpdateBusy' ],
    [ 'filters-busy', 'autoUpdateErrorFiltersBusy' ],
    // Recorded by earlier versions for a running filter-list transaction.
    [ 'busy', 'autoUpdateErrorFiltersBusy' ],
    [ 'no-backup', 'autoUpdateErrorNoBackup' ],
    [ 'rollback-failed', 'autoUpdateErrorRollbackFailed' ],
    [ 'apply-failed', 'autoUpdateErrorApplyFailed' ],
    [ 'backup-failed', 'autoUpdateErrorApplyFailed' ],
    [ 'unsafe-extension-dir', 'autoUpdateErrorUnsafeFolder' ],
    [ 'folder-mismatch', 'autoUpdateErrorFolderMismatch' ],
    [ 'not-offered', 'autoUpdateErrorNotOffered' ],
    [ 'restart-required', 'autoUpdateRestartRequired' ],
    [ 'permission-required', 'autoUpdatePermissionNeeded' ],
    [ 'permission-denied', 'autoUpdatePermissionDenied' ],
    [ 'unsupported-os', 'autoUpdateManualOnly' ],
    [ 'disabled-by-policy', 'autoUpdateErrorPolicy' ],
    [ 'incognito', 'autoUpdateIncognito' ],
    [ 'not-unpacked', 'autoUpdateManagedInstall' ],
    [ 'reload-mismatch', 'autoUpdateErrorReload' ],
    [ 'interrupted', 'autoUpdateErrorInterrupted' ],
    [ 'update-undone', 'autoUpdateErrorUndone' ],
]);

// Their text points to the setup command, which must then be shown.
const SETUP_ERRORS = new Set([
    'updater-missing', 'not-installed', 'updater-forbidden', 'forbidden-origin', 'unknown-installation',
]);

const errorText = error => {
    if ( error === null || typeof error !== 'object' ) { return ''; }
    const key = ERROR_KEYS.get(error.code);
    if ( key !== undefined ) { return t(key); }
    return t('autoUpdateErrorGeneric', [ error.message || error.code || '?' ]);
};

// Live regions announce every change: only assign text which changed.
const setText = (elem, text) => {
    if ( elem.textContent !== text ) { elem.textContent = text; }
};

const setLine = (selector, text) => {
    const elem = qs$(root, selector);
    setText(elem, text);
    elem.hidden = text === '';
    return elem;
};

// The live summary reports phases only; download progress goes to a line
// which is not a live region.
function summaryText(s) {
    if ( s.devBuild ) { return t('autoUpdateDevBuild', [ s.currentVersion ]); }
    if ( s.install ) {
        if ( s.install.phase === 'download' ) {
            return t('autoUpdateDownloadingVersion', [ s.install.version ]);
        }
        if ( s.install.phase === 'apply' ) {
            return t('autoUpdateApplying', [ s.install.version ]);
        }
        return t('autoUpdatePreparing', [ s.install.version ]);
    }
    if ( s.available ) {
        return t('autoUpdateAvailable', [ s.available.version, s.currentVersion ]);
    }
    if ( s.lastSuccess > 0 ) {
        return t('autoUpdateUpToDate', [ s.currentVersion, formatTime(s.lastSuccess) ]);
    }
    return t('autoUpdateNeverChecked', [ s.currentVersion ]);
}

function progressText(s) {
    const progress = s.install?.progress;
    if ( s.install?.phase !== 'download' || (progress?.total > 0) === false ) { return ''; }
    return t('autoUpdateProgress', [ formatMiB(progress.received), formatMiB(progress.total) ]);
}

function updaterText(s) {
    if ( s.devBuild ) { return ''; }
    if ( s.installType !== 'development' ) { return t('autoUpdateManagedInstall'); }
    if ( s.os !== 'win' ) { return t('autoUpdateManualOnly'); }
    if ( s.policy === 'off' ) { return ''; }
    if ( s.restartRequired ) { return t('autoUpdateRestartRequired'); }
    if ( s.permission === false ) { return t('autoUpdatePermissionNeeded'); }
    const updater = s.updater;
    if ( updater?.connected ) {
        return t(s.settings.install === 'auto' ? 'autoUpdateConnectedAuto' : 'autoUpdateConnectedNotify',
            [ updater.version || '?' ]);
    }
    if ( updater?.error ) { return errorText(updater.error); }
    return '';
}

function policyText(s) {
    if ( s.policy === 'off' ) { return t('autoUpdatePolicyOff'); }
    if ( s.policy === 'notify' ) { return t('autoUpdatePolicyNotify'); }
    return '';
}

// The hold matters only while it keeps the offered version from installing
// automatically, and while "Install now" can override it.
function heldText(s, canInstallNow) {
    const held = s.heldVersion;
    const offered = s.available?.version;
    if ( canInstallNow === false || s.settings.install !== 'auto' ) { return ''; }
    if ( parseVersion(held) === null || parseVersion(offered) === null ) { return ''; }
    return compareVersions(offered, held) <= 0 ? t('autoUpdateHeld', [ held ]) : '';
}

function render() {
    if ( root === null || status === null ) { return; }
    const s = status;
    setText(qs$(root, '.autoUpdateSummary'), summaryText(s));
    setLine('.autoUpdateProgress', progressText(s));

    const updated = s.lastUpdate?.to === s.currentVersion
        ? t(s.lastUpdate.rollback ? 'autoUpdateRolledBack' : 'autoUpdateUpdated',
            [ s.lastUpdate.from || '?', s.lastUpdate.to ])
        : '';
    setLine('.autoUpdateLastUpdate', updated);
    setLine('.autoUpdatePolicy', policyText(s));
    setLine('.autoUpdateIncognito', s.incognito ? t('autoUpdateIncognito') : '');

    if ( transientError !== null &&
        (s.lastError?.at > transientError.at || s.install?.startedAt > transientError.at) ) {
        transientError = null;
    }
    const error = transientError ?? (s.install === null ? s.lastError : null);
    const errorLine = setLine('.autoUpdateError', errorText(error));
    // The updater's own (English) message stays available as a detail.
    const detail = typeof error?.message === 'string' && error.message !== error.code
        ? error.message
        : '';
    if ( errorLine.title !== detail ) { errorLine.title = detail; }
    setLine('.autoUpdateNote', transientNote);

    // Controls which act on the shared update state are disabled while an
    // action runs and in an incognito window.
    const locked = busy || s.incognito === true;
    const unpacked = s.installType === 'development' && s.devBuild === false;
    // Automatic installation needs the Windows updater and is off when the
    // administrator turned update checks off.
    const installable = unpacked && s.os === 'win' && s.policy !== 'off';
    const checksOff = s.devBuild || s.policy === 'off';

    const checkBox = qs$(root, '#autoUpdateCheck input');
    checkBox.checked = s.settings.check;
    checkBox.disabled = locked || checksOff;
    const installMode = qs$(root, '#autoUpdateInstallMode');
    installMode.value = s.settings.install;
    installMode.disabled = locked || unpacked === false || s.policy !== '';
    qs$(root, '.autoUpdateInstallModeLabel').hidden = unpacked && s.os !== 'win';
    const channel = qs$(root, '#autoUpdateChannel');
    channel.value = s.settings.channel;
    channel.disabled = locked || checksOff;
    qs$(root, '#autoUpdateCheckNow').disabled = locked || checksOff || s.install !== null;

    const connected = s.permission && s.updater?.connected === true;
    const installNow = qs$(root, '#autoUpdateInstallNow');
    installNow.hidden = !(s.available && connected && installable);
    installNow.disabled = locked || s.installing || s.install !== null;
    setLine('.autoUpdateHeld', heldText(s, installNow.hidden === false));

    const notes = qs$(root, '#autoUpdateReleaseNotes');
    const page = s.available?.version ? `${UPDATE_RELEASES_PAGE}/tag/v${encodeURIComponent(s.available.version)}` : '';
    notes.hidden = page === '';
    if ( page !== '' ) { notes.href = page; }

    // The container stays visible: the managed-install explanation is in it.
    if ( restarting === false ) {
        setText(qs$(root, '.autoUpdateUpdaterStatus'), updaterText(s));
    }
    qs$(root, '.autoUpdatePermissionPrompt').hidden = !(installable && s.permission === false && s.restartRequired !== true);
    qs$(root, '#autoUpdateGrant').disabled = locked;
    const restart = qs$(root, '#autoUpdateRestart');
    restart.hidden = !(installable && s.restartRequired === true);
    restart.disabled = locked;
    const needsSetup = installable && s.restartRequired !== true &&
        (s.permission === false || s.updater?.connected !== true || SETUP_ERRORS.has(error?.code));
    qs$(root, '.autoUpdateSetup').hidden = needsSetup === false;
    setText(qs$(root, '.autoUpdateSetupCommand'),
        `updater\\install-updater.cmd -ExtensionId ${s.extensionId}`);

    const rollback = qs$(root, '#autoUpdateRollback');
    const backup = s.updater?.backupVersion || '';
    rollback.hidden = !(installable && connected && backup !== '' && backup !== s.currentVersion);
    if ( rollback.hidden === false ) {
        setText(qs$(rollback, '.autoUpdateRollbackLabel'), t('autoUpdateRollback', [ backup ]));
    }
    rollback.disabled = locked || s.installing || s.install !== null;
}

async function refresh(probe = false) {
    // The extension is reloading; this page is about to close.
    if ( restarting ) { return; }
    try {
        status = await sendMessage({ what: 'getUpdateStatus', probe });
    } catch (reason) {
        console.error(reason);
    }
    render();
}

async function run(task) {
    if ( busy ) { return; }
    busy = true;
    transientError = null;
    transientNote = '';
    render();
    try {
        await task();
    } catch (reason) {
        transientError = {
            code: reason?.code,
            message: reason?.message || String(reason),
            at: Date.now(),
        };
    } finally {
        busy = false;
        await refresh(false);
    }
}

async function saveSettings(partial) {
    await run(async ( ) => {
        await sendMessage({ what: 'setUpdateSettings', settings: partial });
    });
}

// The extension reloads; the worker reopens this section afterwards.
function showRestarting() {
    restarting = true;
    setText(qs$(root, '.autoUpdateUpdaterStatus'), t('autoUpdateRestarting'));
}

/******************************************************************************/

if ( root !== null ) {
    dom.on('#autoUpdateCheckNow', 'click', ( ) => {
        run(async ( ) => {
            const result = await sendMessage({ what: 'checkForUpdatesNow' });
            if ( result?.throttled !== true || Number.isFinite(result.retryAt) === false ) { return; }
            const seconds = Math.min(60, Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000)));
            transientNote = t('autoUpdateCheckThrottled', [ formatNumber(seconds) ]);
        });
    });

    dom.on('#autoUpdateInstallNow', 'click', ( ) => {
        const version = status?.available?.version;
        if ( typeof version !== 'string' ) { return; }
        run(( ) => sendMessage({ what: 'installUpdateNow', version }));
    });

    dom.on('#autoUpdateRollback', 'click', ( ) => {
        run(async ( ) => {
            const result = await sendMessage({ what: 'rollbackUpdate' });
            if ( result?.reloading ) { showRestarting(); }
        });
    });

    dom.on('#autoUpdateCheck input', 'change', ev => {
        saveSettings({ check: ev.target.checked });
    });

    dom.on('#autoUpdateInstallMode', 'change', ev => {
        saveSettings({ install: ev.target.value });
    });

    dom.on('#autoUpdateChannel', 'change', ev => {
        saveSettings({ channel: ev.target.value });
    });

    // Chrome enables native messaging for the worker only after it restarts;
    // the worker then reopens this section.
    const activate = async ( ) => {
        const result = await sendMessage({ what: 'activateUpdater' });
        if ( result?.reloading ) { showRestarting(); }
    };

    // The permission prompt must come from this user gesture, as for the
    // optional privacy permission.
    dom.on('#autoUpdateGrant', 'click', async ( ) => {
        if ( busy ) { return; }
        transientError = null;
        transientNote = '';
        const granted = await browser.permissions.request({
            permissions: [ 'nativeMessaging' ],
        }).catch(( ) => false);
        if ( granted === false ) {
            transientError = { code: 'permission-denied', message: '', at: Date.now() };
            render();
            return;
        }
        run(activate);
    });

    dom.on('#autoUpdateRestart', 'click', ( ) => {
        run(activate);
    });

    dom.on('#autoUpdateCopyCommand', 'click', async ( ) => {
        const text = qs$(root, '.autoUpdateSetupCommand').textContent;
        try {
            await navigator.clipboard.writeText(text);
            dom.text(qs$(root, '#autoUpdateCopyCommand'), t('autoUpdateCopied'));
        } catch {
        }
    });

    const bc = new self.BroadcastChannel('uBlockPlus');
    bc.addEventListener('message', ev => {
        if ( ev.data?.autoUpdate === true ) { refresh(false); }
    });

    browser.permissions.onAdded.addListener(permissions => {
        if ( permissions.permissions?.includes('nativeMessaging') ) { refresh(true); }
    });
    browser.permissions.onRemoved.addListener(permissions => {
        if ( permissions.permissions?.includes('nativeMessaging') ) { refresh(false); }
    });

    refresh(true);
}
