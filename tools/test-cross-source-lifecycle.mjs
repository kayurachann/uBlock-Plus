/* uBlock Plus+ — actual background cross-source transaction regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const extract = name => {
    const start = background.indexOf(`async function ${name}(`);
    const end = background.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, `Actual background function ${name} must exist`);
    return background.slice(start, end);
};
const transactionCode = [
    'snapshotRulesetTransaction', 'activateCompiledFilterRulesNow',
    'recoverPendingCompiledActivation', 'rollbackRulesetTransaction', 'applyRulesetsNow',
].map(extract).join('\n');
const clone = value => structuredClone(value);
const OUTER = 'test.ruleset.transaction';
const ACTIVATION = 'test.compiled.pending';
const STAGING = 'test.compiled.staging';
const IMPORTED = 'https://filters.example/list.txt';

function fixture() {
    const values = new Map();
    const events = [];
    const state = {
        enabled: [ 'stock-a' ],
        imported: [ { id: IMPORTED, enabled: false, checksum: 'old-source' } ],
        generation: 'old-generation',
        userGeneration: 'old-generation',
        dnrGeneration: 'old-generation',
        compileCount: 0,
        failNewDNR: false,
        failRollbackStatic: false,
        failMetadata: false,
        failPendingCleanup: false,
        rejectOldRegexCorpus: false,
    };
    const note = (type, details = {}) => events.push({
        type, ...clone(details), enabled: state.enabled.slice(), generation: state.generation,
    });
    const context = vm.createContext({
        Object, Array, Error, Promise, structuredClone,
        PENDING_COMPILED_ACTIVATION_KEY: ACTIVATION,
        STAGING_COMPILED_GENERATION_KEY: STAGING,
        RULESET_TRANSACTION_KEY: OUTER,
        rulesetConfig: { enabledRulesets: [ 'stock-a' ] },
        getEnabledRulesets: async ( ) => state.enabled.slice(),
        getImportedLists: async ( ) => clone(state.imported),
        getActiveCompiledGeneration: async ( ) => state.generation,
        snapshotNativeRulesetState: async ( ) => ({ enabled: state.enabled.slice(), dnrGeneration: state.dnrGeneration }),
        restoreNativeRulesetState: async snapshot => {
            note('restore-native-snapshot');
            if ( state.failRollbackStatic ) { throw new Error('native restoration temporarily unavailable'); }
            state.enabled = snapshot.enabled.slice();
            state.dnrGeneration = snapshot.dnrGeneration;
        },
        finalizeNativeRulesetRecovery: async ( ) => { note('finalize-native-recovery'); },
        localWrite: async (key, value) => { note(`write:${key}`); values.set(key, clone(value)); },
        localRead: async key => values.has(key) ? clone(values.get(key)) : undefined,
        localRemove: async key => {
            note(`remove:${key}`);
            if ( key === ACTIVATION && state.failPendingCleanup ) {
                state.failPendingCleanup = false;
                throw new Error('journal cleanup temporarily unavailable');
            }
            values.delete(key);
        },
        replaceImportedLists: async lists => { note('restore-imported'); state.imported = clone(lists); },
        enableRulesets: async requested => {
            note('enable', { requested });
            if ( state.rejectOldRegexCorpus && requested.includes('stock-a') ) {
                return { error: 'old stock allow regex now exceeds native memory limit' };
            }
            if ( state.failRollbackStatic && requested.length === 1 && requested[0] === 'stock-a' ) {
                return { error: 'old static set temporarily unavailable' };
            }
            const beforeStock = state.enabled.filter(id => !id.startsWith('https:'));
            const afterStock = requested.filter(id => !id.startsWith('https:'));
            const beforeImported = state.enabled.filter(id => id.startsWith('https:'));
            const afterImported = requested.filter(id => id.startsWith('https:'));
            const stockUpdated = JSON.stringify(beforeStock) !== JSON.stringify(afterStock);
            const importedUpdated = JSON.stringify(beforeImported) !== JSON.stringify(afterImported);
            state.enabled = Array.from(requested);
            state.imported[0].enabled = state.enabled.includes(IMPORTED);
            return { stockUpdated, importedUpdated, enabledRulesets: state.enabled.slice() };
        },
        saveRulesetConfig: async ( ) => { note('save-config'); },
        updateCompiledFilters: async ( ) => {
            note('compile-shared-sources');
            state.compileCount += 1;
            const generation = `new-generation-${state.compileCount}`;
            values.set(STAGING, generation);
            return { generation, importedListUpdates: [ { id: IMPORTED, checksum: 'new-source' } ] };
        },
        registerUserScripts: async generation => {
            note('register-shared-scriptlets', { target: generation });
            const previousGeneration = state.userGeneration;
            state.userGeneration = generation;
            return { previousGeneration };
        },
        restoreUserScripts: async registration => {
            note('restore-scriptlets');
            if ( registration ) { state.userGeneration = registration.previousGeneration; }
        },
        updateUserRules: async generation => {
            note('activate-source-cancellation', { target: generation });
            if ( generation.startsWith('new-') && state.failNewDNR ) {
                return { fatalError: 'native source cancellation rejected' };
            }
            state.dnrGeneration = generation;
            return { errors: [] };
        },
        commitCompiledGeneration: async generation => {
            note('commit-generation', { target: generation });
            state.generation = generation;
        },
        removeCompiledGeneration: async generation => { note('remove-generation', { target: generation }); },
        commitImportedListUpdates: async updates => {
            note('commit-source-metadata', { updates });
            if ( state.failMetadata ) { throw new Error('source metadata write failed'); }
            state.imported[0].checksum = 'new-source';
        },
        cleanupCommittedImportedListUpdates: async ( ) => { note('cleanup-source-metadata'); },
        recordCompiledFilterWarnings: async ( ) => { note('record-warnings'); },
        registerContentScripts: async ( ) => {
            note('register-content');
            // The real content-script manager refreshes shared userscripts too.
            state.userGeneration = state.generation;
        },
        broadcastMessage: data => { note('broadcast', data); },
        ublockPlusErr: message => { note('diagnostic', { message }); },
    });
    vm.runInContext(transactionCode, context);
    return { state, values, events, context };
}

const stock = fixture();
const result = await stock.context.applyRulesetsNow([ 'stock-b' ]);
assert.equal(result.stockUpdated, true);
assert.equal(result.importedUpdated, false);
assert.equal(stock.state.compileCount, 1,
    'changing only packaged lists must recompile shared $badfilter and scriptlet exception sources');
for ( const event of stock.events.filter(event => [
    'compile-shared-sources', 'register-shared-scriptlets', 'activate-source-cancellation',
].includes(event.type)) ) {
    assert.deepEqual(event.enabled, [ 'stock-b' ], 'shared activation must see the newly selected stock source');
}
assert.equal(stock.state.userGeneration, 'new-generation-1');
assert.equal(stock.state.dnrGeneration, 'new-generation-1');
assert.equal(stock.state.generation, 'new-generation-1');
const indexOf = (f, type) => f.events.findIndex(event => event.type === type);
assert.ok(indexOf(stock, `write:${OUTER}`) < indexOf(stock, 'enable'));
assert.ok(indexOf(stock, 'commit-source-metadata') < indexOf(stock, `remove:${OUTER}`));
assert.ok(indexOf(stock, `remove:${OUTER}`) < indexOf(stock, `remove:${ACTIVATION}`));
assert.equal(stock.values.has(OUTER), false);
assert.equal(stock.values.has(ACTIVATION), false);

const unchanged = fixture();
await unchanged.context.applyRulesetsNow([ 'stock-a' ]);
assert.equal(unchanged.state.compileCount, 0, 'a no-op selection must not activate a new compiled generation');
assert.equal(unchanged.events.some(event => event.type === 'register-content'), false);
await unchanged.context.applyRulesetsNow([ 'stock-a' ], { forceCompiledActivation: true });
assert.equal(unchanged.state.compileCount, 1, 'explicit restore/repair can force shared activation');

const imported = fixture();
await imported.context.applyRulesetsNow([ 'stock-a', IMPORTED ]);
assert.equal(imported.state.compileCount, 1, 'import-only changes continue to activate shared filters');

const rejected = fixture();
rejected.state.failNewDNR = true;
await assert.rejects(rejected.context.applyRulesetsNow([ 'stock-b' ]), /native source cancellation rejected/);
assert.deepEqual(rejected.state.enabled, [ 'stock-a' ]);
assert.deepEqual(Array.from(rejected.context.rulesetConfig.enabledRulesets), [ 'stock-a' ]);
assert.equal(rejected.state.userGeneration, 'old-generation');
assert.equal(rejected.state.dnrGeneration, 'old-generation');
assert.equal(rejected.state.generation, 'old-generation');
assert.equal(rejected.state.imported[0].checksum, 'old-source');
assert.equal(rejected.events.some(event => event.type === 'commit-source-metadata'), false);
const rejectedCommit = rejected.events.find(event => event.type === `remove:${OUTER}`);
assert.deepEqual(rejectedCommit.enabled, [ 'stock-a' ], 'failed selection journal is cleared only after the old static set is restored');
assert.equal(rejectedCommit.generation, 'old-generation');
assert.equal(rejected.values.has(OUTER), false);
const unsupportedOld = fixture();
unsupportedOld.state.failNewDNR = true;
unsupportedOld.state.rejectOldRegexCorpus = true;
await assert.rejects(unsupportedOld.context.applyRulesetsNow([ 'stock-b' ]), /native source cancellation rejected/);
assert.deepEqual(unsupportedOld.state.enabled, [ 'stock-a' ]);
assert.equal(unsupportedOld.state.dnrGeneration, 'old-generation');
assert.equal(unsupportedOld.values.has(OUTER), false,
    'v2 rollback restores the installed native snapshot even when compiling the old stock corpus now fails');
assert.equal(unsupportedOld.events.some(event => event.type === 'enable' && event.requested.includes('stock-a')), false);

const legacy = fixture();
legacy.state.enabled = [ 'stock-b' ];
await legacy.context.rollbackRulesetTransaction({ schemaVersion: 1, previousRulesets: [ 'stock-a' ],
    previousConfigEnabledRulesets: [ 'stock-a' ], previousImportedLists: clone(legacy.state.imported),
    previousGeneration: 'old-generation' });
assert.deepEqual(legacy.state.enabled, [ 'stock-a' ], 'v1 journals retain the guarded legacy restoration path');

const afterApply = fixture();
await assert.rejects(afterApply.context.applyRulesetsNow([ 'stock-b' ], {
    afterApply: async ( ) => { throw new Error('post-selection source removal failed'); },
}), /post-selection source removal failed/);
assert.deepEqual(afterApply.state.enabled, [ 'stock-a' ]);
assert.equal(afterApply.state.generation, 'old-generation');
assert.equal(afterApply.state.userGeneration, 'old-generation');
assert.equal(afterApply.state.dnrGeneration, 'old-generation');
assert.equal(afterApply.events.some(event => event.type === 'commit-source-metadata'), false);

const metadata = fixture();
metadata.state.failMetadata = true;
await assert.rejects(metadata.context.applyRulesetsNow([ 'stock-b' ]), /source metadata write failed/);
assert.deepEqual(metadata.state.enabled, [ 'stock-a' ]);
assert.equal(metadata.state.generation, 'old-generation');
assert.equal(metadata.state.userGeneration, 'old-generation');
assert.equal(metadata.values.has(OUTER), false);
assert.equal(metadata.values.has(ACTIVATION), false);

const recovery = fixture();
recovery.state.failNewDNR = true;
recovery.state.failRollbackStatic = true;
await assert.rejects(recovery.context.applyRulesetsNow([ 'stock-b' ]), /ruleset rollback failed/);
assert.equal(recovery.values.has(OUTER), true, 'incomplete rollback retains the durable original selection');
assert.deepEqual(recovery.values.get(OUTER).previousRulesets, [ 'stock-a' ]);
recovery.state.failRollbackStatic = false;
await recovery.context.rollbackRulesetTransaction(clone(recovery.values.get(OUTER)));
assert.deepEqual(recovery.state.enabled, [ 'stock-a' ]);
assert.equal(recovery.values.has(OUTER), false, 'retry clears the journal only after restoring the old selection');

const committed = fixture();
committed.state.failPendingCleanup = true;
await committed.context.applyRulesetsNow([ 'stock-b' ]);
assert.deepEqual(committed.state.enabled, [ 'stock-b' ]);
assert.equal(committed.values.has(OUTER), false);
assert.equal(committed.values.has(ACTIVATION), true,
    'post-commit cleanup failure keeps the activation journal without reverting the committed selection');
await committed.context.recoverPendingCompiledActivation();
assert.equal(committed.state.generation, 'new-generation-1');
assert.equal(committed.values.has(ACTIVATION), false);

function startupFixture() {
    const order = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = { generation: 'old-generation', rejectActivation: false };
    const context = vm.createContext({
        getCurrentVersion: ( ) => '1.0.0',
        rulesetConfig: { version: '1.0.0', enabledRulesets: [ 'stock-a' ], userScripts: true },
        loadAdminConfig: async ( ) => {},
        enableRulesets: async ( ) => ({ stockUpdated: true, importedUpdated: false, enabledRulesets: [ 'stock-b' ] }),
        saveRulesetConfig: async ( ) => {},
        syncWithBrowserPermissions: async ( ) => false,
        supportsUserScripts: ( ) => true,
        isSideloaded: false,
        activateCompiledFilterRules: async ( ) => {
            order.push('activate:start');
            await gate;
            if ( state.rejectActivation ) { throw new Error('startup activation failed'); }
            state.generation = 'new-generation';
            order.push('activate:committed');
        },
        registerContentScripts: async ( ) => { order.push(`content:${state.generation}`); },
        registerUserScripts: async ( ) => { order.push(`user:${state.generation}`); },
        updateUserRules: async ( ) => { order.push('dnr-refresh'); },
        sessionAccessLevel: ( ) => {},
        canShowBlockedCount: false,
        process: { firstRun: false },
        adminReadEx: async ( ) => [],
    });
    vm.runInContext(extract('startSession'), context);
    return { context, state, order, release };
}
const startup = startupFixture();
const starting = startup.context.startSession();
await turn();
assert.deepEqual(startup.order, [ 'activate:start' ],
    'startup must not snapshot native registration while shared generation activation is pending');
startup.release();
await starting;
assert.deepEqual(startup.order, [ 'activate:start', 'activate:committed', 'content:new-generation' ],
    'stock-only startup changes commit shared exceptions before full content registration');
const failedStartup = startupFixture();
failedStartup.state.rejectActivation = true;
const startingFailure = assert.rejects(failedStartup.context.startSession(), /startup activation failed/);
await turn();
failedStartup.release();
await startingFailure;
assert.deepEqual(failedStartup.order, [ 'activate:start' ],
    'a rejected activation must not race a stale full native replacement');

const adminSource = (await readFile(new URL(
    '../platform/mv3/extension/js/admin.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const adminStart = adminSource.indexOf('async function applyAdminConfig(');
const adminEnd = adminSource.indexOf('export async function getAdminRulesets(', adminStart);
assert.ok(adminStart >= 0 && adminEnd > adminStart);
const adminCode = adminSource.slice(adminStart, adminEnd).replace('export function ', 'function ');
const queueStart = background.indexOf('function enqueueFilteringMutation(');
const queueEnd = background.indexOf('\n}\n', queueStart) + 3;
const schedulerStart = background.indexOf('setAdminMutationScheduler(task =>');
const schedulerEnd = background.indexOf(';\n', schedulerStart) + 2;
assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, 'Managed mutations must use the worker scheduler');
const adminTimers = [];
const adminEvents = [];
let initialized;
let releasePolicy;
let releasePopup;
let failAdminRulesets = false;
const initialization = new Promise(resolve => { initialized = resolve; });
const policyGate = new Promise(resolve => { releasePolicy = resolve; });
const popupGate = new Promise(resolve => { releasePopup = resolve; });
const adminContext = vm.createContext({
    pendingFilteringMutation: Promise.resolve(),
    isFullyInitialized: initialization,
    rulesetConfig: { enabledRulesets: [ 'stock-a' ], popupBlockMode: true, strictBlockMode: true, showBlockedCount: true },
    self: { setTimeout: fn => { adminTimers.push(fn); return adminTimers.length; } },
    registerContentScripts: async ( ) => { throw new Error('Direct script registry bypassed shared scheduler adapter'); },
    enableRulesets: async ( ) => { throw new Error('Direct ruleset mutation bypassed shared transaction adapter'); },
    applyRulesetsNow: async ( ) => {
        adminEvents.push('rulesets:start');
        if ( failAdminRulesets ) { throw new Error('managed selection rejected'); }
        await policyGate;
        adminEvents.push('rulesets:done');
    },
    refreshFilteringScripts: async ( ) => { adminEvents.push('shared-script-refresh'); },
    saveRulesetConfig: async ( ) => { adminEvents.push('save-config'); },
    setPopupBlockMode: async value => {
        adminEvents.push(`popup:start:${value}`);
        await popupGate;
        adminEvents.push(`popup:done:${value}`);
    },
    setStrictBlockMode: async value => { adminEvents.push(`strict:${value}`); },
    getAdminRulesets: async ( ) => [],
    getEnabledRulesets: async ( ) => [ 'stock-a' ],
    readFilteringModeDetails: async ( ) => { adminEvents.push('read-modes'); return {}; },
    getDefaultFilteringMode: async ( ) => 2,
    broadcastMessage: ( ) => { adminEvents.push('broadcast'); },
    ublockPlusLog: message => { adminEvents.push(`log:${message}`); },
    dnr: { setExtensionActionOptions: async ( ) => { adminEvents.push('action-options'); } },
});
vm.runInContext(adminCode + '\n' + background.slice(queueStart, queueEnd) + '\n' +
    background.slice(schedulerStart, schedulerEnd) + '\n globalThis.testAdminSettings = adminSettings;', adminContext);
const policies = adminContext.testAdminSettings;
const runAdminTimer = async ( ) => {
    assert.ok(adminTimers.length > 0, 'Managed changes must schedule a batch');
    adminTimers.shift()();
    await turn();
};
policies.change('rulesets', [ '+stock-b' ]);
policies.change('popupBlockMode', false);
await runAdminTimer();
assert.deepEqual(adminEvents, [], 'managed mutation must wait for service-worker initialization before entering the filtering queue');
initialized();
await turn();
assert.equal(adminEvents.includes('rulesets:start'), true);
assert.equal(adminEvents.includes('save-config'), false, 'policy side effects wait for the pending shared selection');
policies.change('popupBlockMode', true);
await runAdminTimer();
releasePolicy();
await turn();
assert.equal(adminEvents.includes('popup:start:false'), true);
assert.equal(adminEvents.includes('popup:start:true'), false,
    'a later batch must wait for the first native policy API, not only its storage write');
releasePopup();
await turn();
assert.ok(adminEvents.indexOf('popup:done:false') < adminEvents.indexOf('popup:start:true'));
assert.equal(adminContext.rulesetConfig.popupBlockMode, true,
    'a changed value arriving during the prior batch must not be erased with its snapshot');
assert.equal(adminEvents.filter(event => event === 'shared-script-refresh').length, 2);
policies.change('defaultFiltering', 'optimal');
policies.change('noFiltering', [ 'off.example' ]);
await runAdminTimer();
assert.equal(adminEvents.filter(event => event === 'read-modes').length, 2);
assert.equal(adminEvents.filter(event => event === 'shared-script-refresh').length, 4,
    'managed mode changes use the complete content/firewall refresh adapter');
failAdminRulesets = true;
policies.change('rulesets', [ '+bad-stock' ]);
await runAdminTimer();
assert.equal(adminEvents.some(event => event.includes('Managed filtering update failed')), true,
    'timer-triggered mutation errors are handled rather than becoming unhandled rejections');
failAdminRulesets = false;
policies.change('strictBlockMode', false);
await runAdminTimer();
assert.equal(adminEvents.includes('strict:false'), true, 'one rejected batch cannot poison later managed changes');

// Execute the real message case bodies and worker queue together. A global
// popup toggle used to re-register the old active generation while a new
// generation was waiting for native DNR activation to finish.
const settingCases = [ 'setStrictBlockMode', 'setPopupBlockMode', 'excludeFromStrictBlock' ]
    .map(name => {
        const start = background.indexOf(`    case '${name}':`);
        const end = background.indexOf('\n    case ', start + 1);
        assert.ok(start >= 0 && end > start);
        return background.slice(start, end);
    }).join('\n');
const settingEvents = [];
let releaseActivation;
let releaseStrict;
let rejectStrict = false;
const activationGate = new Promise(resolve => { releaseActivation = resolve; });
const strictGate = new Promise(resolve => { releaseStrict = resolve; });
const settingState = { active: 'old', registered: 'old', strict: true, excluded: [] };
const settings = vm.createContext({
    pendingFilteringMutation: Promise.resolve(),
    rulesetConfig: { popupBlockMode: true, strictBlockMode: true },
    setPopupBlockMode: async ( ) => { settingEvents.push('popup-state'); },
    registerContentScripts: async ( ) => {
        settingState.registered = settingState.active;
        settingEvents.push(`content:${settingState.active}`);
    },
    setStrictBlockMode: async value => {
        settingEvents.push('strict:start');
        await strictGate;
        if ( rejectStrict ) { throw new Error('native strict update failed'); }
        settingState.strict = value;
        settingEvents.push('strict:done');
    },
    excludeFromStrictBlock: async (hostname, permanent) => {
        settingState.excluded.push({ hostname, permanent });
        settingEvents.push('exclude');
    },
    broadcastMessage: ( ) => { settingEvents.push('broadcast'); },
});
vm.runInContext(background.slice(queueStart, queueEnd) +
    `\nasync function dispatchSetting(request) { switch (request.what) { ${settingCases} } }`, settings);
const activating = settings.enqueueFilteringMutation(async ( ) => {
    settingState.registered = 'new';
    settingEvents.push('new-registration');
    await activationGate;
    settingState.active = 'new';
    // Also model the last rollback write to native strict rules. A waiting
    // user's newer setting must run after this transaction, never before it.
    settingState.strict = true;
    settingEvents.push('activation-settled');
});
await turn();
const popupSetting = settings.dispatchSetting({ what: 'setPopupBlockMode', state: false });
const strictSetting = settings.dispatchSetting({ what: 'setStrictBlockMode', state: false });
const exclusion = settings.dispatchSetting({ what: 'excludeFromStrictBlock', hostname: 'keep.example', permanent: true });
await turn();
assert.deepEqual(settingEvents, [ 'new-registration' ],
    'all three settings must wait for the whole filtering transaction, including native activation and pointer commit');
releaseActivation();
await activating;
await popupSetting;
await turn();
assert.equal(settingState.registered, 'new', 'popup re-registration must use the committed new generation');
assert.equal(settingEvents.includes('strict:start'), true);
assert.equal(settingEvents.includes('exclude'), false, 'strict exception mutation must wait for the native strict update');
releaseStrict();
await Promise.all([ strictSetting, exclusion ]);
assert.equal(settingState.strict, false, 'the later setting must survive an earlier transaction rollback');
assert.deepEqual(settingState.excluded, [ { hostname: 'keep.example', permanent: true } ]);
assert.ok(settingEvents.indexOf('strict:done') < settingEvents.indexOf('exclude'));
rejectStrict = true;
await assert.rejects(settings.dispatchSetting({ what: 'setStrictBlockMode', state: true }), /native strict update failed/);
await settings.dispatchSetting({ what: 'excludeFromStrictBlock', hostname: 'after-error.example', permanent: false });
assert.equal(settingState.excluded.at(-1).hostname, 'after-error.example',
    'rejected native settings cannot poison later queued changes');

console.log('Cross-source background lifecycle: stock-only activation, transactions, rollback/recovery, startup ordering, managed policies and settings serialization passed.');
