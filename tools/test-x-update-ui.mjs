/*******************************************************************************

    uBlock Plus+ - dashboard "Updates" section rendering
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    Loads the production update-ui.js against stub elements and a scripted
    worker, and checks what each update state shows: explanations that must
    stay visible, controls that must be disabled or hidden, localized error
    text that survives a refresh, and live regions that are not rewritten
    while nothing changed.

*/

import {
    FakeDocument,
    FakeElement,
    createExtension,
    settle,
    stageModules,
} from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = new FakeDocument();
const root = document.register('#autoUpdate', new FakeElement('div'));
const el = {};
// Counts text assignments, which a screen reader announces in live regions.
const counted = element => {
    let text = '';
    element.writes = 0;
    Object.defineProperty(element, 'textContent', {
        get() { return text; },
        set(value) { text = value; element.writes += 1; },
    });
    return element;
};
for ( const [ name, selector, tag, hidden ] of [
    [ 'summary', '.autoUpdateSummary', 'p', false ],
    [ 'progress', '.autoUpdateProgress', 'p', true ],
    [ 'lastUpdate', '.autoUpdateLastUpdate', 'p', true ],
    [ 'policy', '.autoUpdatePolicy', 'p', true ],
    [ 'incognito', '.autoUpdateIncognito', 'p', true ],
    [ 'held', '.autoUpdateHeld', 'p', true ],
    [ 'error', '.autoUpdateError', 'p', true ],
    [ 'note', '.autoUpdateNote', 'p', true ],
    [ 'checkBox', '#autoUpdateCheck input', 'input', false ],
    [ 'installMode', '#autoUpdateInstallMode', 'select', false ],
    [ 'installModeLabel', '.autoUpdateInstallModeLabel', 'label', false ],
    [ 'channel', '#autoUpdateChannel', 'select', false ],
    [ 'checkNow', '#autoUpdateCheckNow', 'button', false ],
    [ 'installNow', '#autoUpdateInstallNow', 'button', true ],
    [ 'notes', '#autoUpdateReleaseNotes', 'a', true ],
    [ 'updater', '.autoUpdateUpdater', 'div', false ],
    [ 'updaterStatus', '.autoUpdateUpdaterStatus', 'p', false ],
    [ 'permissionPrompt', '.autoUpdatePermissionPrompt', 'p', true ],
    [ 'grant', '#autoUpdateGrant', 'button', false ],
    [ 'restart', '#autoUpdateRestart', 'button', true ],
    [ 'setup', '.autoUpdateSetup', 'div', true ],
    [ 'setupCommand', '.autoUpdateSetupCommand', 'code', false ],
    [ 'rollback', '#autoUpdateRollback', 'button', true ],
] ) {
    el[name] = root.register(selector, counted(new FakeElement(tag, { hidden, title: '' })));
}
el.rollbackLabel = el.rollback.register('.autoUpdateRollbackLabel', new FakeElement('span'));

const baseStatus = (extra = {}) => ({
    currentVersion: '1.1.2', edition: 'standard', devBuild: false,
    installType: 'development', os: 'win', policy: '', incognito: false,
    permission: true, restartRequired: false,
    settings: { schemaVersion: 1, check: true, install: 'auto', channel: 'preview' },
    available: null, heldVersion: null, lastCheck: 0, lastSuccess: 0, nextCheckAfter: 0,
    lastError: null, install: null, lastUpdate: null,
    updater: { connected: true, version: '1.0.0', backupVersion: '' },
    installBlockedBy: '', installing: false, extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    ...extra,
});
let current = baseStatus();
const handlers = {};
const extension = createExtension({
    dispatch: request => {
        if ( request.what === 'getUpdateStatus' ) { return structuredClone(current); }
        return handlers[request.what]?.(request);
    },
});
// Numbers follow the extension's UI language, not the default locale.
extension.browser.i18n.getUILanguage = ( ) => 'de';

const staged = await stageModules({ modules: [ 'update-ui.js', 'update-core.js' ], document, extension });
const channelListeners = [];
globalThis.BroadcastChannel = class {
    addEventListener(type, listener) { channelListeners.push(listener); }
};
const refresh = async status => {
    current = status;
    for ( const listener of channelListeners ) { listener({ data: { autoUpdate: true } }); }
    await settle(5);
};
const click = async selector => {
    await document.trigger(selector, 'click');
    await settle(5);
};

try {
    await staged.load('update-ui.js');
    await settle(5);
    assert.equal(el.summary.textContent, '[autoUpdateNeverChecked:1.1.2]');
    assert.equal(el.updaterStatus.textContent, '[autoUpdateConnectedAuto:1.0.0]');

    // Packaged or policy installs: the explanation stays visible.
    await refresh(baseStatus({
        installType: 'normal', permission: false, updater: null,
        available: { version: '1.2.0' }, installBlockedBy: 'not-unpacked',
    }));
    assert.equal(el.updaterStatus.textContent, '[autoUpdateManagedInstall]');
    assert.notEqual(el.updater.hidden, true, 'The managed-install explanation is not hidden');
    assert.equal(el.installNow.hidden, true);
    assert.equal(el.installMode.disabled, true);
    assert.equal(el.permissionPrompt.hidden, true);

    // Downloads: the live summary announces phases, the numbers go to a line
    // which is not a live region, and unchanged text is not assigned again.
    const MiB = 1048576;
    const downloading = received => baseStatus({ install: {
        version: '1.3.0', phase: 'download', progress: { received, total: 25.3 * MiB },
    }, installing: true });
    await refresh(downloading(4.5 * MiB));
    assert.equal(el.summary.textContent, '[autoUpdateDownloadingVersion:1.3.0]');
    assert.equal(el.progress.textContent, '[autoUpdateProgress:4,5|25,3]', 'MiB use the UI language');
    assert.equal(el.progress.hidden, false);
    const summaryWrites = el.summary.writes;
    await refresh(downloading(10 * MiB));
    assert.equal(el.progress.textContent, '[autoUpdateProgress:10,0|25,3]');
    assert.equal(el.summary.writes, summaryWrites, 'Progress does not rewrite the live summary');
    await refresh(baseStatus({ lastError: { code: 'signature-invalid', message: 'The package signature does not match.' } }));
    assert.equal(el.progress.hidden, true);
    assert.equal(el.error.textContent, '[autoUpdateErrorSignature]');
    assert.equal(el.error.title, 'The package signature does not match.', 'The updater message stays as a detail');
    const errorWrites = el.error.writes;
    await refresh(baseStatus({ lastError: { code: 'signature-invalid', message: 'The package signature does not match.' } }));
    assert.equal(el.error.writes, errorWrites, 'An unchanged alert is not announced again');

    // Error codes map to localized text.
    for ( const [ code, key ] of [
        [ 'network-error', 'autoUpdateErrorNetwork' ],
        [ 'download-failed', 'autoUpdateErrorNetwork' ],
        [ 'checksum-invalid', 'autoUpdateErrorChecksum' ],
        [ 'package-too-large', 'autoUpdateErrorPackage' ],
        [ 'not-staged', 'autoUpdateErrorPackage' ],
        [ 'unexpected-files', 'autoUpdateErrorUnexpectedFiles' ],
        [ 'filters-busy', 'autoUpdateErrorFiltersBusy' ],
        [ 'update-busy', 'autoUpdateErrorUpdateBusy' ],
        [ 'no-backup', 'autoUpdateErrorNoBackup' ],
        [ 'rollback-failed', 'autoUpdateErrorRollbackFailed' ],
        [ 'backup-failed', 'autoUpdateErrorApplyFailed' ],
        [ 'unsafe-extension-dir', 'autoUpdateErrorUnsafeFolder' ],
        [ 'folder-mismatch', 'autoUpdateErrorFolderMismatch' ],
        [ 'not-offered', 'autoUpdateErrorNotOffered' ],
        [ 'disabled-by-policy', 'autoUpdateErrorPolicy' ],
        [ 'unsupported-os', 'autoUpdateManualOnly' ],
        [ 'timeout', 'autoUpdateErrorNetwork' ],
        [ 'response-too-large', 'autoUpdateErrorNetwork' ],
        [ 'forbidden-origin', 'autoUpdateErrorForbidden' ],
        [ 'unknown-installation', 'autoUpdateErrorForbidden' ],
        [ 'ambiguous-installation', 'autoUpdateErrorAmbiguous' ],
        [ 'invalid-config', 'autoUpdateErrorUpdater' ],
        [ 'internal-error', 'autoUpdateErrorUpdater' ],
        [ 'updater-error', 'autoUpdateErrorUpdater' ],
        [ 'invalid-reply', 'autoUpdateErrorUpdater' ],
        [ 'invalid-request', 'autoUpdateErrorUpdater' ],
        [ 'unsupported-protocol', 'autoUpdateErrorUpdater' ],
        [ 'unsupported-command', 'autoUpdateErrorUpdater' ],
    ] ) {
        await refresh(baseStatus({ lastError: { code, message: 'English detail' } }));
        assert.equal(el.error.textContent, `[${key}]`, code);
    }
    await refresh(baseStatus({ lastError: { code: 'something-new', message: 'English detail' } }));
    assert.equal(el.error.textContent, '[autoUpdateErrorGeneric:English detail]');
    // Registration errors point to the setup command: it is shown even while
    // the last probe still said "connected".
    assert.equal(el.setup.hidden, true);
    await refresh(baseStatus({ lastError: { code: 'forbidden-origin', message: 'Extension x is not registered with this updater.' } }));
    assert.equal(el.setup.hidden, false);
    assert.equal(el.setupCommand.textContent, 'updater\\install-updater.cmd -ExtensionId abcdefghijklmnopabcdefghijklmnop');

    // A failure which the worker does not store survives the next refresh,
    // until the next action.
    await refresh(baseStatus({ updater: { connected: true, version: '1.0.0', backupVersion: '1.1.0' } }));
    assert.equal(el.rollback.hidden, false);
    assert.equal(el.rollbackLabel.textContent, '[autoUpdateRollback:1.1.0]');
    handlers.rollbackUpdate = ( ) => {
        throw Object.assign(new Error('Another update operation is running.'), { code: 'update-busy' });
    };
    await click('#autoUpdateRollback');
    assert.equal(el.error.textContent, '[autoUpdateErrorUpdateBusy]');
    assert.equal(el.error.hidden, false);
    await refresh(current);
    assert.equal(el.error.textContent, '[autoUpdateErrorUpdateBusy]', 'A refresh does not erase it');
    assert.equal(el.error.hidden, false);
    // A failure the worker recorded later (for example by an automatic
    // install) is more important than the refused action.
    const withBackup = { updater: { connected: true, version: '1.0.0', backupVersion: '1.1.0' } };
    await refresh(baseStatus({ ...withBackup, lastError: { code: 'no-backup', message: 'older', at: Date.now() - 60000 } }));
    assert.equal(el.error.textContent, '[autoUpdateErrorUpdateBusy]', 'An older stored failure does not replace it');
    await refresh(baseStatus({ ...withBackup, lastError: { code: 'signature-invalid', message: 'newer', at: Date.now() + 1000 } }));
    assert.equal(el.error.textContent, '[autoUpdateErrorSignature]', 'A newer stored failure replaces it');
    await refresh(baseStatus(withBackup));
    assert.equal(el.error.hidden, true, 'The stale refusal does not come back');
    await click('#autoUpdateRollback');
    assert.equal(el.error.textContent, '[autoUpdateErrorUpdateBusy]');
    await refresh(baseStatus({ ...withBackup, install: { version: '1.2.0', phase: 'prepare', startedAt: Date.now() + 1000 } }));
    await refresh(baseStatus(withBackup));
    assert.equal(el.error.hidden, true, 'An install started after the refusal supersedes it');

    // Check now inside the one-minute throttle explains itself; the next
    // action clears the previous failure.
    handlers.checkForUpdatesNow = ( ) => ({ ...structuredClone(current), throttled: true, retryAt: Date.now() + 41500 });
    await click('#autoUpdateCheckNow');
    assert.equal(el.error.hidden, true);
    assert.equal(el.note.textContent, '[autoUpdateCheckThrottled:42]');
    assert.equal(el.note.hidden, false);

    // Settings cannot be changed while an action runs.
    let releaseCheck;
    handlers.checkForUpdatesNow = ( ) => new Promise(resolve => { releaseCheck = resolve; });
    await click('#autoUpdateCheckNow');
    assert.equal(el.note.hidden, true);
    for ( const name of [ 'checkBox', 'installMode', 'channel', 'checkNow', 'grant' ] ) {
        assert.equal(el[name].disabled, true, `${name} is disabled while busy`);
    }
    releaseCheck(structuredClone(current));
    await settle(5);
    for ( const name of [ 'checkBox', 'installMode', 'channel', 'checkNow' ] ) {
        assert.equal(el[name].disabled, false, `${name} is enabled again`);
    }

    // Incognito windows: explained, and every control disabled.
    await refresh(baseStatus({
        incognito: true, installBlockedBy: 'incognito', available: { version: '1.2.0' },
        updater: { connected: true, version: '1.0.0', backupVersion: '1.1.0' },
    }));
    assert.equal(el.incognito.textContent, '[autoUpdateIncognito]');
    assert.equal(el.incognito.hidden, false);
    for ( const name of [ 'checkBox', 'installMode', 'channel', 'checkNow', 'installNow', 'rollback', 'grant', 'restart' ] ) {
        assert.equal(el[name].disabled, true, `incognito: ${name}`);
    }

    // macOS and Linux: no Windows updater prompt or setup.
    await refresh(baseStatus({ os: 'linux', permission: false, updater: null, installBlockedBy: 'unsupported-os' }));
    assert.equal(el.incognito.hidden, true);
    assert.equal(el.updaterStatus.textContent, '[autoUpdateManualOnly]');
    for ( const name of [ 'permissionPrompt', 'restart', 'setup', 'rollback', 'installModeLabel' ] ) {
        assert.equal(el[name].hidden, true, `non-Windows: ${name} is hidden`);
    }
    await refresh(baseStatus({ os: 'mac', restartRequired: true, permission: false }));
    assert.equal(el.restart.hidden, true);

    // Administrator policy.
    await refresh(baseStatus({ policy: 'notify', settings: { schemaVersion: 1, check: true, install: 'notify', channel: 'preview' } }));
    assert.equal(el.policy.textContent, '[autoUpdatePolicyNotify]');
    assert.equal(el.installMode.disabled, true);
    assert.equal(el.checkNow.disabled, false);
    await refresh(baseStatus({
        policy: 'off', installBlockedBy: 'disabled-by-policy', permission: false,
        settings: { schemaVersion: 1, check: false, install: 'notify', channel: 'preview' },
    }));
    assert.equal(el.policy.textContent, '[autoUpdatePolicyOff]');
    for ( const name of [ 'checkBox', 'checkNow', 'channel', 'installMode' ] ) {
        assert.equal(el[name].disabled, true, `policy off: ${name}`);
    }
    assert.equal(el.permissionPrompt.hidden, true, 'No updater prompt when updates are off');

    // A rollback hold is explained.
    await refresh(baseStatus({ heldVersion: '1.3.0', available: { version: '1.3.0' } }));
    assert.equal(el.policy.hidden, true);
    assert.equal(el.held.textContent, '[autoUpdateHeld:1.3.0]');
    assert.equal(el.held.hidden, false);
    assert.equal(el.installNow.hidden, false, 'Install now still installs a held version');
    // The note says to select "Install now": only while that button is
    // there and the hold actually keeps an automatic install from running.
    for ( const [ label, extra ] of [
        [ 'nothing offered yet', { available: null } ],
        [ 'notify mode', { settings: { schemaVersion: 1, check: true, install: 'notify', channel: 'preview' } } ],
        [ 'updater not connected', { updater: { connected: false } } ],
        [ 'a newer release offered', { available: { version: '1.3.1' } } ],
    ] ) {
        await refresh(baseStatus({ heldVersion: '1.3.0', available: { version: '1.3.0' }, ...extra }));
        assert.equal(el.held.hidden, true, label);
    }

    // Development builds: no checks to run or configure.
    await refresh(baseStatus({ devBuild: true, currentVersion: '2026.923.1530', installBlockedBy: 'development-build' }));
    assert.equal(el.held.hidden, true);
    assert.equal(el.summary.textContent, '[autoUpdateDevBuild:2026.923.1530]');
    assert.equal(el.updaterStatus.textContent, '');
    for ( const name of [ 'checkBox', 'checkNow', 'channel' ] ) {
        assert.equal(el[name].disabled, true, `development build: ${name}`);
    }

    // A restore reloads the extension; the page says it comes back.
    await refresh(baseStatus({ updater: { connected: true, version: '1.0.0', backupVersion: '1.1.0' } }));
    handlers.rollbackUpdate = ( ) => ({ reloading: true, version: '1.1.0' });
    await click('#autoUpdateRollback');
    assert.equal(el.error.hidden, true);
    assert.equal(el.updaterStatus.textContent, '[autoUpdateRestarting]');
} finally {
    await staged.cleanup();
}

// Markup: progress is outside every live region.
{
    const html = await readFile(new URL('../platform/mv3/extension/dashboard.html', import.meta.url), 'utf8');
    assert.match(html, /<p class="autoUpdateSummary" role="status" aria-live="polite"><\/p>/);
    assert.match(html, /<p class="autoUpdateProgress" hidden><\/p>/);
}

console.log('Updates section: managed, incognito, non-Windows, policy, hold, busy, throttle, error and live-region states passed.');
