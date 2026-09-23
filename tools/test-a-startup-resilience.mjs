/* uBlock Plus+ — service-worker startup resilience regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

// Run the actual startup functions with browser effects replaced by adapters.
const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const extract = (name, prefix = 'async function') => {
    const start = background.indexOf(`${prefix} ${name}(`);
    const end = background.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, `Actual background function ${name} must exist`);
    return background.slice(start, end);
};
const startupCode = [
    extract('recoverFilteringJournals'), extract('start'),
    extract('compiledFilterRetryTime', 'function'), extract('resumeCompiledFilterRetry'),
].join('\n');
const OUTER = 'rulesets.pendingTransaction';
const INNER = 'compiledFilters.pendingActivation';
const STAGING = 'compiledFilters.stagingGeneration';
const DIRTY = 'compiledFilters.dirtySources';
const RECOVERY_ERROR = 'startup.lastRecoveryError';

function fixture({ incognito = false, wakeupRun = false } = {}) {
    const values = new Map();
    const events = [];
    const faults = new Set();
    const note = name => events.push(name);
    const fail = name => {
        if ( faults.has(name) ) { throw new Error(`Injected ${name} failure`); }
    };
    let releaseRetry;
    const retryGate = new Promise(resolve => { releaseRetry = resolve; });
    const context = vm.createContext({
        Object, Promise, Error, Number, Math, Date,
        isIncognitoWorker: incognito,
        process: { wakeupRun, firstRun: false },
        rulesetConfig: { developerMode: false },
        RULESET_TRANSACTION_KEY: OUTER,
        STAGING_COMPILED_GENERATION_KEY: STAGING,
        STARTUP_RECOVERY_ERROR_KEY: RECOVERY_ERROR,
        COMPILED_FILTERS_DIRTY_KEY: DIRTY,
        COMPILED_FILTERS_RETRY_DELAY: 5 * 60 * 1000,
        COMPILED_FILTERS_MAX_RETRY_DELAY: 6 * 60 * 60 * 1000,
        loadRulesetConfig: async ( ) => { note('load-config'); },
        initializeMemoryProfile: async ( ) => ({ retainScriptingMetadata: true }),
        localRead: async key => structuredClone(values.get(key)),
        localWrite: async (key, value) => { values.set(key, structuredClone(value)); },
        localRemove: async key => { values.delete(key); },
        rollbackRulesetTransaction: async ( ) => {
            note('rollback-ruleset');
            fail('rollback-ruleset');
            values.delete(OUTER);
        },
        recoverStockBadfilters: async ( ) => { note('recover-badfilter'); },
        recoverPendingCompiledActivation: async ( ) => {
            note('recover-activation');
            fail('recover-activation');
        },
        closeOffscreenDocument: async ( ) => { note('close-offscreen'); },
        removeCompiledGeneration: async generation => {
            note(`remove-generation:${generation}`);
            fail('remove-generation');
        },
        ensureCompiledFilterRevision: async ( ) => { note('ensure-revision'); },
        startSession: async ( ) => { note('start-session'); },
        releaseScriptingMetadata: ( ) => {},
        runMemoryCleanup: async ( ) => { note('memory-cleanup'); },
        getRegisteredContentScripts: async ( ) => [],
        registerContentScripts: async ( ) => { note('register-content'); },
        popupBlocker: { resume: async ( ) => { note('popup-resume'); } },
        firewall: { initialize: async ( ) => { note('firewall'); } },
        webRequestFirewall: {
            initialize: async ( ) => { note('webrequest-firewall'); },
            fail: ( ) => { note('webrequest-firewall-failed'); },
        },
        toggleDeveloperMode: ( ) => {},
        syncToolbarIconMode: async ( ) => { note('toolbar-icon'); },
        enqueueFilteringMutation: task => { note('enqueue-retry'); return task(); },
        retryDirtyCompiledFilterSourcesNow: async ( ) => {
            note('retry:start');
            await retryGate;
            note('retry:done');
        },
        ublockPlusErr: message => { note(`error:${message}`); },
    });
    vm.runInContext(startupCode, context);
    return { context, values, events, faults, releaseRetry };
}
const essential = [ 'popup-resume', 'firewall', 'webrequest-firewall' ];

// A stale-package or otherwise failing recovery must not skip startSession,
// script registration, popup blocking or the firewall. The journal stays for
// the next start and the failure is recorded for troubleshooting.
for ( const fault of [ 'rollback-ruleset', 'recover-activation', 'remove-generation' ] ) {
    const f = fixture();
    if ( fault === 'rollback-ruleset' ) {
        f.values.set(OUTER, { schemaVersion: 2 });
    }
    f.values.set(STAGING, 'staging-generation');
    f.faults.add(fault);
    await f.context.start();
    for ( const name of [ 'start-session', 'memory-cleanup', 'register-content', ...essential ] ) {
        assert.ok(f.events.includes(name), `${fault}: ${name} must still run`);
    }
    assert.equal(f.events.includes('webrequest-firewall-failed'), false);
    assert.match(f.values.get(RECOVERY_ERROR).message, new RegExp(`Injected ${fault} failure`));
    assert.equal(typeof f.values.get(RECOVERY_ERROR).recordedAt, 'number');
    assert.ok(f.events.some(event => event.startsWith('error:Startup recovery/')));
    if ( fault === 'rollback-ruleset' ) {
        assert.equal(f.values.has(OUTER), true, 'the failed journal is retried on the next start');
    }
    assert.equal(f.events.includes('remove-generation:staging-generation'), true,
        `${fault}: stale staging cleanup is independent of journal recovery`);
    assert.equal(f.events.includes('ensure-revision'), true);
    f.faults.clear();
    await f.context.start();
    assert.equal(f.values.has(RECOVERY_ERROR), false, 'a later clean recovery clears the diagnostic');
}

// A failed compiled-filter update is retried after startup, never inside it.
{
    const f = fixture({ wakeupRun: true });
    f.values.set(DIRTY, { compiled: true, updatedAt: 1 });
    let started = false;
    const starting = f.context.start().then(( ) => { started = true; });
    for ( let i = 0; i < 20 && started === false; i++ ) { await turn(); }
    assert.equal(started, true, 'startup must not wait for list downloads or a full compile');
    assert.equal(f.events.includes('start-session'), false);
    for ( let i = 0; i < 20 && f.events.includes('retry:start') === false; i++ ) { await turn(); }
    assert.equal(f.events.includes('retry:start'), true, 'a due retry is queued behind startup');
    assert.equal(f.events.includes('retry:done'), false);
    f.releaseRetry();
    await starting;
    await turn();
    assert.equal(f.events.includes('retry:done'), true);
}
{
    const f = fixture({ wakeupRun: true });
    f.values.set(DIRTY, { compiled: true, attempts: 3, lastAttemptAt: Date.now() });
    await f.context.start();
    await turn();
    assert.equal(f.events.includes('enqueue-retry'), false, 'a wake inside the backoff window does not compile');
}

// With split incognito, the second worker shares storage.local but not the
// mutation queues. Its cold start must not treat the regular worker's live
// journals, staging generation or retained generations as crash leftovers.
{
    const f = fixture({ incognito: true });
    f.values.set(OUTER, { schemaVersion: 2 });
    f.values.set(INNER, { generation: 'live' });
    f.values.set(STAGING, 'live-staging');
    f.values.set(DIRTY, { compiled: true, updatedAt: 1 });
    await f.context.start();
    await turn();
    for ( const name of [ 'rollback-ruleset', 'recover-badfilter', 'recover-activation',
        'close-offscreen', 'remove-generation:live-staging', 'memory-cleanup', 'ensure-revision',
        'enqueue-retry' ] ) {
        assert.equal(f.events.includes(name), false, `incognito worker must not run ${name}`);
    }
    assert.equal(f.values.has(OUTER), true);
    assert.equal(f.values.has(STAGING), true);
    for ( const name of [ 'start-session', ...essential ] ) {
        assert.ok(f.events.includes(name), `incognito worker still runs ${name}`);
    }
}
{
    const f = fixture();
    f.values.set(OUTER, { schemaVersion: 2 });
    await f.context.start();
    assert.ok(f.events.includes('rollback-ruleset'), 'the regular worker owns recovery');
}

// Permission sync can fail (for example on a nested trusted scope); the rest
// of startSession, including script registration, must still run.
{
    const events = [];
    const context = vm.createContext({
        getCurrentVersion: ( ) => '2.0.0',
        rulesetConfig: { version: '1.0.0', enabledRulesets: [ 'stock-a' ], userScripts: true },
        loadAdminConfig: async ( ) => {},
        patchDefaultRulesets: async ( ) => {},
        enableRulesets: async ( ) => ({ stockUpdated: false, importedUpdated: false }),
        saveRulesetConfig: async ( ) => {},
        updateDynamicAndSessionRules: async ( ) => ({}),
        updateSessionRules: async ( ) => ({}),
        syncWithBrowserPermissions: async ( ) => {
            const error = new Error('Enable filtering on the trusted parent site first');
            error.code = 'ERR_FILTERING_MODE_PARENT_SCOPE';
            throw error;
        },
        supportsUserScripts: ( ) => true,
        isSideloaded: false,
        activateCompiledFilterRules: async ( ) => { events.push('activate'); },
        updateUserRules: async ( ) => { events.push('user-rules'); },
        registerContentScripts: async ( ) => { events.push('register-content'); },
        registerUserScripts: async ( ) => { events.push('register-user'); },
        sessionAccessLevel: ( ) => { events.push('session-access'); },
        canShowBlockedCount: false,
        process: { firstRun: false },
        adminReadEx: async ( ) => [],
        ublockPlusLog: ( ) => {},
        ublockPlusErr: message => { events.push(`error:${message}`); },
    });
    vm.runInContext(extract('startSession'), context);
    await context.startSession();
    assert.deepEqual(events.filter(event => event.startsWith('error:') === false),
        [ 'user-rules', 'register-content', 'session-access' ]);
    assert.ok(events.some(event => /^error:startSession\/permissions\/.*trusted parent/.test(event)));
}

// A managed 'develop' lock turns developer mode off at session start and
// also removes the developer DNR rules installed before the lock.
{
    const events = [];
    const rulesetConfig = { version: '2.0.0', enabledRulesets: [], userScripts: true, developerMode: true };
    const context = vm.createContext({
        getCurrentVersion: ( ) => '2.0.0',
        rulesetConfig,
        loadAdminConfig: async ( ) => {},
        enableRulesets: async ( ) => ({ stockUpdated: false, importedUpdated: false }),
        saveRulesetConfig: async ( ) => {},
        updateSessionRules: async ( ) => ({}),
        syncWithBrowserPermissions: async ( ) => false,
        supportsUserScripts: ( ) => true,
        isSideloaded: false,
        updateUserRules: async ( ) => { events.push('user-rules'); },
        registerContentScripts: async ( ) => {},
        registerUserScripts: async ( ) => {},
        sessionAccessLevel: ( ) => {},
        canShowBlockedCount: false,
        process: { firstRun: false },
        adminReadEx: async key => key === 'disabledFeatures' ? [ 'develop' ] : undefined,
        setDeveloperMode: async state => {
            events.push(`developer-mode:${state}`);
            rulesetConfig.developerMode = state;
        },
        isFullyInitialized: Promise.resolve(),
        enqueueFilteringMutation: task => { events.push('enqueue'); return task(); },
        ublockPlusLog: ( ) => {},
        ublockPlusErr: message => { events.push(`error:${message}`); },
    });
    vm.runInContext(extract('startSession'), context);
    await context.startSession();
    for ( let i = 0; i < 20 && events.includes('user-rules') === false; i++ ) { await turn(); }
    assert.deepEqual(events, [ 'developer-mode:false', 'enqueue', 'user-rules' ]);
}

console.log('Startup resilience: failed recovery, deferred compiled retries, split incognito, permission sync and the develop lock passed.');
