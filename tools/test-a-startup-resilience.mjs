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
        initializeMemoryProfile: async ( ) => ({
            effective: incognito ? 'low-memory' : 'balanced',
            retainScriptingMetadata: true,
        }),
        followStrictBlockMemoryProfile: profile => {
            note(`strictblock-memory:${profile.effective}`);
            return false;
        },
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
        reconcileStrictBlockSessionRules: async ( ) => {
            note('strictblock-reconcile');
            fail('strictblock-reconcile');
            return faults.has('strictblock-reconcile-error')
                ? { error: 'Injected session update failure' }
                : { rebuilt: false };
        },
        syncStrictBlockTracker: async ( ) => { note('strictblock-sync'); },
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

// Strict blocking: every start, also a wake, reconciles the session plan
// with the host access its redirects need, then points the tracker at the
// installed plan. On a first run the plan was just rebuilt by startSession.
for ( const options of [ { wakeupRun: false }, { wakeupRun: true },
    { wakeupRun: false, incognito: true }, { wakeupRun: true, incognito: true } ] ) {
    const f = fixture(options);
    await f.context.start();
    const at = name => f.events.indexOf(name);
    assert.ok(at('strictblock-reconcile') !== -1,
        `${JSON.stringify(options)}: start() reconciles the strict-block session plan`);
    assert.ok(at('strictblock-reconcile') < at('strictblock-sync'),
        'the tracker follows the reconciled plan');
    // The low-memory profile decides the URL source, which the reconcile
    // compares with the installed plan.
    const memory = `strictblock-memory:${options.incognito ? 'low-memory' : 'balanced'}`;
    assert.ok(at(memory) !== -1 && at(memory) < at('strictblock-reconcile'),
        'the tracker follows the memory profile before the reconcile');
    if ( options.wakeupRun === false ) {
        assert.ok(at('start-session') < at('strictblock-reconcile'));
    } else {
        assert.equal(at('start-session'), -1);
    }
    assert.ok(at('strictblock-sync') < at('popup-resume'));
}
// A failed reconcile is reported and never skips the rest of startup.
for ( const fault of [ 'strictblock-reconcile', 'strictblock-reconcile-error' ] ) {
    const f = fixture({ wakeupRun: true });
    f.faults.add(fault);
    await f.context.start();
    for ( const name of [ 'strictblock-sync', 'register-content', ...essential ] ) {
        assert.ok(f.events.includes(name), `${fault}: ${name} must still run`);
    }
    assert.ok(f.events.some(event => /^error:Strict-block reconcile\/.*Injected/.test(event)),
        `${fault}: the failure is logged`);
}

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

// A permission change rebuilds the strict-block session plan: without broad
// host access a redirect shadows the block below it and the page loads, and
// the optional webRequest permission changes the address source. The rebuild
// waits for startup and for the tracker's new source, never for the
// filtering queue.
{
    const permissionCode = extract('onStrictBlockPermissionsChanged', 'function');
    const run = async (permissions, { sessionError, trackerError } = {}) => {
        const events = [];
        let releaseSource;
        let releaseStartup;
        const context = vm.createContext({
            Promise, Array,
            isFullyInitialized: new Promise(resolve => { releaseStartup = resolve; }),
            strictBlockTracker: {
                permissionsChanged: ( ) => {
                    events.push('tracker-source');
                    return new Promise((resolve, reject) => {
                        releaseSource = ( ) => trackerError
                            ? reject(new Error('Injected tracker failure'))
                            : resolve('webrequest');
                    });
                },
            },
            updateSessionRules: async ( ) => {
                events.push('session-rebuild');
                return sessionError ? { error: 'Injected session update failure' } : {};
            },
            ublockPlusErr: message => { events.push(`error:${message}`); },
        });
        vm.runInContext(permissionCode, context);
        const done = context.onStrictBlockPermissionsChanged(permissions);
        for ( let i = 0; i < 10; i++ ) { await turn(); }
        const early = events.slice();
        releaseStartup();
        for ( let i = 0; i < 10; i++ ) { await turn(); }
        const afterStartup = events.slice();
        releaseSource();
        await done;
        for ( let i = 0; i < 10; i++ ) { await turn(); }
        return { early, afterStartup, events };
    };
    for ( const permissions of [
        { origins: [ '<all_urls>' ], permissions: [] },
        { origins: [ 'https://*.example.com/*' ] },
        { permissions: [ 'webRequest' ], origins: [] },
    ] ) {
        const r = await run(permissions);
        assert.deepEqual(r.early, [ 'tracker-source' ],
            'the tracker re-checks its address source at once');
        assert.deepEqual(r.afterStartup, [ 'tracker-source' ],
            'the rebuild waits for the new address source');
        assert.deepEqual(r.events, [ 'tracker-source', 'session-rebuild' ],
            `${JSON.stringify(permissions)} rebuilds the session plan`);
    }
    for ( const permissions of [ { permissions: [ 'nativeMessaging' ], origins: [] }, undefined ] ) {
        const r = await run(permissions);
        assert.deepEqual(r.events, [ 'tracker-source' ],
            `${JSON.stringify(permissions)} does not concern strict blocking`);
    }
    const failed = await run({ origins: [ '<all_urls>' ] }, { sessionError: true });
    assert.ok(failed.events.includes('error:strictBlockPermissions/Injected session update failure'));
    const noSource = await run({ origins: [ '<all_urls>' ] }, { trackerError: true });
    assert.ok(noSource.events.includes('error:strictBlockPermissions/Error: Injected tracker failure'));
    assert.ok(noSource.events.includes('session-rebuild'),
        'a failed source check still rebuilds, with the source the tracker kept');
}

// The tracker follows the plan in storage.session after a worker restart,
// unless a newer plan was installed while it was read.
{
    const planStart = background.indexOf('let strictBlockPlanRevision = 0;');
    assert.ok(planStart >= 0, 'the plan revision counter must exist');
    const planCode = [
        'let strictBlockPlanRevision = 0;',
        extract('onStrictBlockPlan', 'function'),
        extract('syncStrictBlockTracker'),
    ].join('\n');
    const plans = [];
    const reads = [];
    const context = vm.createContext({
        Promise,
        STRICTBLOCK_PLAN_KEY: 'strictBlock.plan',
        strictBlockTracker: { setPlan: plan => { plans.push(plan); } },
        sessionRead: key => new Promise(resolve => { reads.push({ key, resolve }); }),
    });
    vm.runInContext(planCode, context);
    const stored = { redirectCount: 3, owners: [ [ 1, 3, 'stock:x', 'redirect' ] ] };
    const first = context.syncStrictBlockTracker();
    assert.equal(reads[0].key, 'strictBlock.plan');
    reads[0].resolve(stored);
    await first;
    assert.deepEqual(plans, [ stored ]);
    const second = context.syncStrictBlockTracker();
    const installed = { redirectCount: 0, owners: [] };
    context.onStrictBlockPlan(installed);
    reads[1].resolve(stored);
    await second;
    assert.deepEqual(plans, [ stored, installed ],
        'a stale read must not bring back the replaced plan');
    const missing = context.syncStrictBlockTracker();
    reads[2].resolve(undefined);
    await missing;
    assert.equal(plans.length, 3);
    assert.equal(plans[2], undefined, 'no stored plan: the tracker goes inactive');
}

console.log('Startup resilience: failed recovery, deferred compiled retries, split incognito, permission sync, the develop lock and strict-block reconcile passed.');
