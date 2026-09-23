/* uBlock Plus+ — durable settings and retry regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';

function storage(initial = {}) {
    let values = structuredClone(initial);
    return {
        failRead: false, failWrite: false, writes: [],
        async get() {
            if ( this.failRead ) { throw new Error('read failed'); }
            return structuredClone(values);
        },
        async set(entries) {
            if ( this.failWrite ) { throw new Error('write failed'); }
            this.writes.push(structuredClone(entries));
            Object.assign(values, structuredClone(entries));
        },
        async remove(key) { delete values[key]; },
    };
}
const local = storage();
const session = storage();
globalThis.self = globalThis;
globalThis.chrome = {
    runtime: { getURL: () => 'chrome-extension://test/' },
    storage: { local, session },
};
let generation = 0;
const restart = () => import(
    `../platform/mv3/extension/js/config.js?settings-test=${++generation}`
);
let config = await restart();
await config.loadRulesetConfig();
config.rulesetConfig.autoReload = false;
local.failWrite = true;
await assert.rejects(config.saveRulesetConfig(), /write failed/);
local.failWrite = false;
config.rulesetConfig.showBlockedCount = false;
await config.saveRulesetConfig();
assert.equal((await local.get()).rulesetConfig.showBlockedCount, false,
    'A rejected save must not poison later saves');

// Each queued save owns a snapshot, including array values.
local.writes.length = 0;
config.rulesetConfig.enabledRulesets = [ 'first' ];
const first = config.saveRulesetConfig();
config.rulesetConfig.enabledRulesets.push('second');
const second = config.saveRulesetConfig();
await Promise.all([ first, second ]);
assert.deepEqual(local.writes.map(entry => entry.rulesetConfig.enabledRulesets),
    [ [ 'first' ], [ 'first', 'second' ] ]);

// Session is a cache. A failed cache update cannot turn a committed local save
// into an unhandled rejection, or resurrect stale settings after worker wakeup.
session.failWrite = true;
config.rulesetConfig.autoReload = true;
await config.saveRulesetConfig();
config = await restart();
await config.loadRulesetConfig();
assert.equal(config.rulesetConfig.autoReload, true);
assert.deepEqual(config.rulesetConfig.enabledRulesets, [ 'first', 'second' ]);
session.failWrite = false;

// A failed authoritative read is not a fresh install and must never overwrite
// existing settings with defaults. It must also remain retryable.
local.failRead = true;
const writeCount = local.writes.length;
config = await restart();
await assert.rejects(config.loadRulesetConfig(), /read failed/);
assert.equal(local.writes.length, writeCount);
assert.equal(config.process.firstRun, false);
local.failRead = false;
await config.loadRulesetConfig();
assert.deepEqual(config.rulesetConfig.enabledRulesets, [ 'first', 'second' ]);

// Dashboard Settings pane. Strict backup validation, late restore steps and
// rejected mutations must reach the user, never only the console.
{
    const {
        FakeDocument, FakeElement, createExtension, settle, stageModules,
    } = await import('./dashboard-test-harness.mjs');
    const document = new FakeDocument();
    const status = document.register('#operationStatus');
    const radios = new Map([ 1, 2, 3 ].map(level => {
        const radio = new FakeElement('input', { value: `${level}` });
        document.register(`.filteringModeCard input[type="radio"][value="${level}"]`, radio);
        document.register('.filteringModeCard input[type="radio"]', radio);
        return [ level, radio ];
    }));
    for ( const id of [ 'autoReload', 'showBlockedCount', 'strictBlockMode', 'popupBlockMode', 'developerMode' ] ) {
        document.register(`#${id} input[type="checkbox"]`, new FakeElement('input'));
    }
    document.register('#memoryProfile');
    const memorySelect = document.register('#memoryProfile select', new FakeElement('select'));
    document.register('#memoryProfile .memoryProfileStatus');
    document.register('#memoryProfile .memoryProfileMetrics');
    const fileInput = document.register(
        'section[data-pane="settings"] input[type="file"]',
        new FakeElement('input')
    );
    let memorySelected = 'auto';
    let setDefaultError;
    const extension = createExtension({
        dispatch(request) {
            switch ( request.what ) {
            case 'getOptionsPageData':
                return {
                    defaultFilteringMode: 2, autoReload: true, showBlockedCount: true,
                    canShowBlockedCount: true, strictBlockMode: true, popupBlockMode: true,
                    hasOmnipotence: true, developerMode: false,
                    disabledFeatures: [ 'develop' ],
                };
            case 'getMemoryProfile':
                return { selected: memorySelected, effective: memorySelected };
            case 'getMemoryTelemetry':
                return { storage: {} };
            case 'setDefaultFilteringMode':
                if ( setDefaultError ) { throw setDefaultError; }
                return request.level;
            }
        },
    });
    const backupAPI = {
        backup: async ( ) => ({}),
        restore: async ( ) => ({}),
    };
    globalThis.settingsTestBackupAPI = backupAPI;
    globalThis.FileReader = class {
        readAsText(file) {
            setTimeout(( ) => {
                this.result = file.text;
                this.onload();
            });
        }
    };
    let confirmed = true;
    globalThis.confirm = ( ) => confirmed;
    // A remembered pane which a managed policy forbids.
    document.body.dataset.pane = 'develop';
    const staged = await stageModules({
        modules: [ 'settings.js', 'dashboard.js' ],
        stubs: {
            'filter-lists.js': 'export const renderFilterLists = ( ) => {};',
            'backup-restore.js': `
                export const backupToObject = config => globalThis.settingsTestBackupAPI.backup(config);
                export const restoreFromObject = data => globalThis.settingsTestBackupAPI.restore(data);
            `,
        },
        document,
        extension,
    });
    const buttonSelector = key =>
        `section[data-pane="settings"] button:has([data-i18n="${key}"])`;
    // Expected failures are also logged; keep them out of the test output.
    const { error: consoleError, warn: consoleWarn } = console;
    console.error = console.warn = ( ) => {};
    const pickBackup = async text => {
        await document.trigger(buttonSelector('restoreButton'), 'click');
        assert.equal(typeof fileInput.onchange, 'function', 'Restore opens the file picker');
        fileInput.onchange({ target: { files: [ { name: 'backup.json', size: text.length, text } ] } });
        await settle(20);
    };
    try {
        await staged.load('settings.js');
        await settle(20);
        assert.equal(document.body.dataset.forbid, 'develop');
        assert.equal(document.body.dataset.pane, 'settings',
            'A pane locked by disabledFeatures must not stay selected');

        await pickBackup('{');
        assert.equal(status.textContent, '[restoreFailed:Backup file is not valid JSON]');
        assert.equal(status.dataset.level, 'error');
        assert.equal(document.body.classes.has('busy'), false);

        backupAPI.restore = async ( ) => { throw new TypeError('Invalid filtering-mode hostname'); };
        await pickBackup('{"filteringModes":{}}');
        assert.equal(status.textContent, '[restoreFailed:Invalid filtering-mode hostname]',
            'A rejected restore must be reported to the user');
        assert.equal(status.dataset.level, 'error');

        backupAPI.restore = async ( ) => ({
            firewallRulesSkipped: true,
            importedListsDisabled: [ 'https://filters.example/list.txt' ],
            importedListsSkipped: [],
        });
        await pickBackup('{}');
        assert.equal(status.textContent,
            '[restoreSucceeded] [restoreFirewallUnsupported] [restoreImportedListsDisabled:1]',
            'Backup parts which could not be applied as saved must be reported');
        assert.equal(status.dataset.level, 'error');

        backupAPI.restore = async ( ) => ({
            firewallRulesSkipped: false, importedListsDisabled: [], importedListsSkipped: [],
        });
        await pickBackup('{}');
        assert.equal(status.textContent, '[restoreSucceeded]');
        assert.equal(status.dataset.level, 'info');

        // Parts which an administrator lock kept unchanged are reported for
        // restore and reset alike.
        const lockedSummary = {
            developerSkipped: true, filteringModesSkipped: true,
            firewallRulesSkipped: false, importedListsDisabled: [], importedListsSkipped: [],
        };
        backupAPI.restore = async ( ) => lockedSummary;
        await pickBackup('{}');
        assert.equal(status.textContent,
            '[restoreSucceeded] [restoreFilteringModesLocked] [restoreDeveloperLocked]');
        assert.equal(status.dataset.level, 'error');
        await document.trigger(buttonSelector('resetToDefaultButton'), 'click');
        await settle(20);
        assert.equal(status.textContent,
            '[resetSucceeded] [restoreFilteringModesLocked] [restoreDeveloperLocked]',
            'A reset must report the parts an administrator lock kept');
        assert.equal(status.dataset.level, 'error');

        status.textContent = '';
        await document.trigger(buttonSelector('restoreButton'), 'click');
        fileInput.oncancel();
        await settle(20);
        assert.equal(status.textContent, '', 'Cancelling the file picker reports nothing');

        backupAPI.backup = async ( ) => { throw new Error('Popup policy state is unavailable'); };
        await document.trigger(buttonSelector('backupButton'), 'click');
        await settle(20);
        assert.equal(status.textContent, '[backupFailed:Popup policy state is unavailable]');

        backupAPI.restore = async ( ) => { throw new Error('Unable to restore DNR rules'); };
        await document.trigger(buttonSelector('resetToDefaultButton'), 'click');
        await settle(20);
        assert.equal(status.textContent, '[resetFailed:Unable to restore DNR rules]');
        backupAPI.restore = async ( ) => ({});
        await document.trigger(buttonSelector('resetToDefaultButton'), 'click');
        await settle(20);
        assert.equal(status.textContent, '[resetSucceeded]');
        assert.equal(status.dataset.level, 'info');
        status.textContent = '';
        confirmed = false;
        await document.trigger(buttonSelector('resetToDefaultButton'), 'click');
        await settle(20);
        assert.equal(status.textContent, '', 'A declined reset reports nothing');

        // A rejected default-mode change must show the level still in effect.
        setDefaultError = new Error('Filtering-mode transaction recovery is required');
        radios.get(2).checked = false;
        radios.get(3).checked = true;
        await document.trigger('#defaultFilteringMode', 'change',
            { target: radios.get(3) }, '.filteringModeCard input[type="radio"]');
        await settle(20);
        assert.equal(radios.get(2).checked, true, 'The effective level is displayed again');
        assert.equal(status.textContent,
            '[defaultFilteringModeFailed:Filtering-mode transaction recovery is required]');

        // A protection profile applied from another pane changes the stored
        // memory profile without a broadcast.
        memorySelected = 'low-memory';
        extension.emitStorageChange({ memoryProfile: { newValue: 'low-memory' } });
        await settle(20);
        assert.equal(memorySelect.value, 'low-memory');
    } finally {
        Object.assign(console, { error: consoleError, warn: consoleWarn });
        (await staged.load('dashboard.js')).setOperationStatus('');
        await staged.cleanup();
        delete globalThis.settingsTestBackupAPI;
    }
}
console.log('Durable settings lifecycle tests passed');
