/* uBlock Plus+ - actual-native rollback with strict quota and API faults. GPL-3.0-or-later. */
import {
    STOCK_BADFILTER_JOURNAL,
    STOCK_BADFILTER_STATE,
    STOCK_BADFILTER_STATUS,
} from '../platform/mv3/extension/js/stock-badfilter.js';
import assert from 'node:assert/strict';
import { createRulesetNativeState } from '../platform/mv3/extension/js/ruleset-native-state.js';
import { isStrictBlockSessionRule } from '../platform/mv3/extension/js/dnr-namespaces.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clone = value => structuredClone(value);
const regex = (id, expression, action = 'block') => ({ id, priority: 1,
    action: { type: action }, condition: { regexFilter: expression } });
// The strict-block plan owns session IDs 1..999,999, whatever their shape:
// stock regex redirects at 29 and My filters redirects at 1,000,011.
const strict = id => ({ id, priority: 29, action: { type: 'redirect',
    redirect: { extensionPath: '/strictblock.html' } },
condition: { resourceTypes: [ 'main_frame' ], regexFilter: `strict-${id}` } });
const userRedirect = id => ({ id, priority: 1000011, action: { type: 'redirect',
    redirect: { extensionPath: '/strictblock.html' } },
condition: { resourceTypes: [ 'main_frame' ], requestDomains: [ `user-${id}.test` ] } });
// Another owner's rule with the shape of the legacy strict-block allow.
const lookalike = { id: 7000029, priority: 29, action: { type: 'allow' },
    condition: { requestDomains: [ 'excluded.test' ], resourceTypes: [ 'main_frame' ] } };
const regular = id => ({ id, priority: 100, action: { type: 'allow' },
    condition: { urlFilter: `owner-${id}` } });
const sorted = rules => clone(rules).sort((a, b) => a.id - b.id);
const countRegex = rules => rules.filter(rule => rule.condition.regexFilter).length;
const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const start = background.indexOf('async function rollbackRulesetTransaction(');
const rollbackSource = background.slice(start, background.indexOf('\n}\n', start) + 3);
assert.ok(start > 0);
const OUTER = 'rulesets.pendingTransaction';
const INNER = 'compiled.pendingActivation';

function fixture() {
    const events = [];
    const values = new Map([
        [ STOCK_BADFILTER_STATE, { 'stock-a': { digest: 'a', ids: [ 12 ] } } ],
        [ STOCK_BADFILTER_STATUS, { disabledRuleCount: 1 } ],
    ]);
    const state = {
        package: { version: '1.0.0', resources: [
            { id: 'stock-a', path: 'a.json', digest: 'a' },
            { id: 'stock-b', path: 'b.json', digest: 'b' },
        ] },
        dynamic: [ regex(1, 'installed-stock-allow', 'allow'),
            regex(9000001, 'installed-user'), regex(5500000, 'unrelated-dynamic'), regular(8000000) ],
        session: [ strict(1), userRedirect(2), regular(7000000), lookalike,
            regular(8000001), regex(6500000, 'unrelated-session') ],
        enabled: [ 'stock-a' ], disabled: { 'stock-a': [ 12 ], 'stock-b': [ 33 ] },
        generation: 'old-generation', scriptGeneration: 'old-generation', failAPI: '', failScripts: false,
    };
    const api = name => {
        events.push(name);
        if ( state.failAPI === name ) { state.failAPI = ''; throw new Error(`Injected ${name} failure`); }
    };
    const update = (rules, { removeRuleIds = [], addRules = [] }) => {
        const output = rules.filter(rule => !removeRuleIds.includes(rule.id)).concat(clone(addRules));
        assert.equal(new Set(output.map(rule => rule.id)).size, output.length, 'native IDs must remain unique');
        return output;
    };
    const dnr = {
        MAX_NUMBER_OF_REGEX_RULES: 6,
        getEnabledRulesets: async ( ) => state.enabled.slice(),
        getDynamicRules: async ( ) => clone(state.dynamic),
        getSessionRules: async ( ) => clone(state.session),
        getDisabledRuleIds: async ({ rulesetId }) => state.disabled[rulesetId].slice(),
        isRegexSupported: async ( ) => { throw new Error('Old stock regex corpus must never be recompiled during native rollback'); },
        updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
            api('static-selection');
            state.enabled = Array.from(new Set(state.enabled.filter(id => !disableRulesetIds.includes(id)).concat(enableRulesetIds)));
        },
        updateStaticRules: async ({ rulesetId, disableRuleIds, enableRuleIds }) => {
            api('static-ids');
            state.disabled[rulesetId] = Array.from(new Set(state.disabled[rulesetId]
                .filter(id => !enableRuleIds.includes(id)).concat(disableRuleIds)));
        },
        updateDynamicRules: async request => {
            api('dynamic');
            const next = update(state.dynamic, request);
            assert.ok(countRegex(next) + countRegex(state.session) <= 6, 'shared native regex quota');
            state.dynamic = next;
        },
        updateSessionRules: async request => {
            api(request.addRules?.length ? 'session-add' : 'session-remove');
            const next = update(state.session, request);
            assert.ok(countRegex(next) + countRegex(state.dynamic) <= 6, 'shared native regex quota');
            state.session = next;
        },
    };
    const adapter = createRulesetNativeState({
        dnr, read: async key => clone(values.get(key)),
        write: async (key, value) => { values.set(key, clone(value)); },
        remove: async key => { events.push(`remove:${key}`); values.delete(key); },
        getPackageState: async ( ) => clone(state.package),
        ownsSession: isStrictBlockSessionRule,
    });
    const context = vm.createContext({
        Object, Array, Set, Error,
        PENDING_COMPILED_ACTIVATION_KEY: INNER, RULESET_TRANSACTION_KEY: OUTER,
        restoreNativeRulesetState: adapter.restore, finalizeNativeRulesetRecovery: adapter.finalize,
        replaceImportedLists: async ( ) => { events.push('restore-imported'); },
        localRead: async key => clone(values.get(key)),
        localRemove: async key => { events.push(`remove:${key}`); values.delete(key); },
        getActiveCompiledGeneration: async ( ) => state.generation,
        registerUserScripts: async generation => {
            events.push('scripts');
            if ( state.failScripts ) { state.failScripts = false; throw new Error('Injected scripts failure'); }
            state.scriptGeneration = generation;
        },
        commitCompiledGeneration: async generation => { state.generation = generation; },
        rulesetConfig: { enabledRulesets: [ 'stock-b' ] },
        saveRulesetConfig: async ( ) => { events.push('config'); },
        registerContentScripts: async ( ) => { events.push('content'); },
        removeCompiledGeneration: async ( ) => { events.push('cleanup-generation'); },
        enableRulesets: async ( ) => { throw new Error('Unsupported old stock allow regex: recompilation must not run'); },
        updateUserRules: async ( ) => { throw new Error('Compiled rollback must restore native data without rebuilding'); },
        broadcastMessage: ( ) => { events.push('broadcast'); },
        ublockPlusErr: ( ) => {},
        ublockPlusLog: ( ) => {},
    });
    vm.runInContext(rollbackSource, context);
    const mutate = ( ) => {
        state.dynamic = [ regex(2, 'new-stock'), ...state.dynamic.filter(rule => rule.id >= 5000000 && rule.id < 9000000) ];
        state.session = [ strict(3), strict(4), userRedirect(5),
            ...state.session.filter(rule => isStrictBlockSessionRule(rule) === false) ];
        state.enabled = [ 'stock-b' ]; state.disabled = { 'stock-a': [], 'stock-b': [ 44 ] };
        state.generation = 'new-generation'; state.scriptGeneration = 'new-generation';
        values.set(STOCK_BADFILTER_STATE, { 'stock-b': { digest: 'b', ids: [ 44 ] } });
        values.set(STOCK_BADFILTER_STATUS, { disabledRuleCount: 99 });
        values.set(STOCK_BADFILTER_JOURNAL, { pending: true });
        values.set(INNER, { generation: 'new-generation', previousGeneration: 'old-generation' });
    };
    return { state, values, events, dnr, adapter, context, mutate };
}

async function prepared() {
    const f = fixture();
    const before = { dynamic: sorted(f.state.dynamic), session: sorted(f.state.session),
        enabled: f.state.enabled.slice(), disabled: clone(f.state.disabled) };
    const nativeState = await f.adapter.snapshot();
    const transaction = { schemaVersion: 2, nativeState, previousGeneration: 'old-generation',
        previousRulesets: [ 'stock-a' ], previousConfigEnabledRulesets: [ 'stock-a' ], previousImportedLists: [] };
    f.values.set(OUTER, clone(transaction));
    f.mutate();
    return { ...f, before, transaction };
}
const checkRestored = f => {
    assert.deepEqual(sorted(f.state.dynamic), f.before.dynamic);
    assert.deepEqual(sorted(f.state.session), f.before.session);
    assert.deepEqual(f.state.enabled, f.before.enabled);
    assert.deepEqual(f.state.disabled, f.before.disabled);
    assert.equal(f.state.generation, 'old-generation');
    assert.equal(f.state.scriptGeneration, 'old-generation');
    assert.equal(f.values.has(OUTER), false);
    assert.equal(f.values.has(INNER), false);
    assert.equal(f.values.has(STOCK_BADFILTER_JOURNAL), false);
    assert.deepEqual(f.values.get(STOCK_BADFILTER_STATE), f.transaction.nativeState.managed);
    assert.deepEqual(f.values.get(STOCK_BADFILTER_STATUS), f.transaction.nativeState.status);
};
const normal = await prepared();
assert.deepEqual(normal.transaction.nativeState.sessionRules.map(rule => rule.id), [ 1, 2 ],
    'the snapshot owns strict-block IDs only, not the lookalike of another owner');
await normal.context.rollbackRulesetTransaction(normal.transaction);
checkRestored(normal);
assert.ok(normal.state.session.some(rule => rule.id === lookalike.id));
assert.ok(normal.events.indexOf('session-remove') < normal.events.indexOf('dynamic'));
assert.ok(normal.events.indexOf('content') < normal.events.indexOf(`remove:${STOCK_BADFILTER_JOURNAL}`));
assert.ok(normal.events.indexOf(`remove:${INNER}`) < normal.events.indexOf(`remove:${OUTER}`));

for ( const fault of [ 'static-selection', 'session-remove', 'dynamic', 'session-add', 'static-ids', 'scripts' ] ) {
    const f = await prepared();
    if ( fault === 'scripts' ) { f.state.failScripts = true; }
    else { f.state.failAPI = fault; }
    await assert.rejects(f.context.rollbackRulesetTransaction(f.transaction), /Injected/);
    assert.equal(f.values.has(OUTER), true, `${fault}: outer recovery authority must survive`);
    assert.equal(f.values.has(INNER), true, `${fault}: compiled activation journal must survive`);
    assert.equal(f.values.has(STOCK_BADFILTER_JOURNAL), true, `${fault}: stock journal must survive`);
    await f.context.rollbackRulesetTransaction(clone(f.values.get(OUTER)));
    checkRestored(f);
}

// The worker stopped mid-transaction, then an update (for example the
// auto-updater's reload) replaced the package. Old static IDs are never
// replayed, but the package-independent state is rolled back so that every
// later start is not aborted by the same stale journal.
const nativeReplayEvents = [ 'static-selection', 'static-ids', 'dynamic', 'session-add', 'session-remove' ];
const selectionRecorder = (f, error = '') => {
    const selections = [];
    f.context.enableRulesets = async ids => {
        f.events.push('enable-rulesets');
        selections.push(Array.from(ids));
        if ( error ) { return { error }; }
        f.state.enabled = Array.from(ids);
        return {};
    };
    return selections;
};
for ( const mismatch of [ 'version', 'digest' ] ) {
    const f = await prepared();
    if ( mismatch === 'version' ) { f.state.package.version = '2.0.0'; }
    else { f.state.package.resources[0].digest = 'new-main-corpus'; }
    await assert.rejects(f.adapter.restore(f.transaction.nativeState), error =>
        error.code === 'ERR_NATIVE_PACKAGE_MISMATCH' && /different package.*not replayed/.test(error.message));
    assert.deepEqual(f.events, [], 'stale package snapshot must reject before any native mutation');
    const updatedNative = { dynamic: sorted(f.state.dynamic), session: sorted(f.state.session),
        disabled: clone(f.state.disabled) };
    const rebuilt = [];
    f.context.updateUserRules = async generation => {
        f.events.push('user-rules');
        rebuilt.push(generation);
        return { errors: [] };
    };
    const selections = selectionRecorder(f);
    // The config selection, not the old package's native one, is restored.
    f.transaction.previousRulesets = [ 'stock-a', 'stock-b' ];
    await f.context.rollbackRulesetTransaction(f.transaction);
    assert.equal(f.events.some(event => nativeReplayEvents.includes(event)), false,
        `${mismatch}: old static IDs and snapshot rules must not be replayed into a new package`);
    assert.deepEqual({ dynamic: sorted(f.state.dynamic), session: sorted(f.state.session),
        disabled: f.state.disabled }, updatedNative);
    assert.deepEqual(selections, [ [ 'stock-a' ] ],
        `${mismatch}: the restored selection is applied to the new package without startSession()`);
    assert.deepEqual(f.state.enabled, [ 'stock-a' ]);
    assert.deepEqual(rebuilt, [ 'old-generation' ], 'user DNR rules are rebuilt from the previous generation');
    assert.equal(f.state.generation, 'old-generation');
    assert.equal(f.state.scriptGeneration, 'old-generation');
    assert.deepEqual(Array.from(f.context.rulesetConfig.enabledRulesets), [ 'stock-a' ]);
    assert.ok(f.events.indexOf('restore-imported') < f.events.indexOf('enable-rulesets'));
    assert.ok(f.events.indexOf('enable-rulesets') < f.events.indexOf('user-rules'),
        'the stock-badfilter plan is computed against the restored selection');
    assert.ok(f.events.indexOf('user-rules') < f.events.indexOf('config'));
    assert.ok(f.events.includes('content') && f.events.includes('broadcast'));
    assert.equal(f.values.has(OUTER), false, `${mismatch}: stale journal must not abort every later start`);
    assert.equal(f.values.has(INNER), false);
    assert.equal(f.values.has(STOCK_BADFILTER_JOURNAL), false);
    assert.notDeepEqual(f.values.get(STOCK_BADFILTER_STATE), f.transaction.nativeState.managed,
        'old-package badfilter ownership is not restored');
}

// The first post-update start fails the rollback, so startSession() applies
// the in-flight selection. A retry on a later worker wake is not followed by
// startSession() and must apply the restored selection itself.
const staleDNR = await prepared();
staleDNR.state.package.version = '2.0.0';
staleDNR.context.updateUserRules = async ( ) => ({ fatalError: 'Injected DNR rebuild failure' });
const staleSelections = selectionRecorder(staleDNR);
await assert.rejects(staleDNR.context.rollbackRulesetTransaction(staleDNR.transaction), /DNR rollback failed/);
assert.equal(staleDNR.values.has(OUTER), true, 'a failed package-independent rollback keeps its journal for retry');
assert.equal(staleDNR.values.has(INNER), true);
staleDNR.state.enabled = [ 'stock-b' ];
staleDNR.context.updateUserRules = async ( ) => ({ errors: [] });
await staleDNR.context.rollbackRulesetTransaction(clone(staleDNR.values.get(OUTER)));
assert.deepEqual(staleSelections.at(-1), [ 'stock-a' ]);
assert.deepEqual(staleDNR.state.enabled, [ 'stock-a' ], 'native static selection matches the restored config');
assert.deepEqual(Array.from(staleDNR.context.rulesetConfig.enabledRulesets), [ 'stock-a' ]);
assert.equal(staleDNR.values.has(OUTER), false);

// A journal without a config selection falls back to the native one, and a
// failed selection keeps every journal for the next start.
const legacySelection = await prepared();
legacySelection.state.package.version = '2.0.0';
delete legacySelection.transaction.previousConfigEnabledRulesets;
legacySelection.transaction.previousRulesets = [ 'stock-a', 'stock-b' ];
legacySelection.context.updateUserRules = async ( ) => ({ errors: [] });
const fallbackSelections = selectionRecorder(legacySelection);
await legacySelection.context.rollbackRulesetTransaction(legacySelection.transaction);
assert.deepEqual(fallbackSelections, [ [ 'stock-a', 'stock-b' ] ]);
assert.deepEqual(Array.from(legacySelection.context.rulesetConfig.enabledRulesets), [ 'stock-a', 'stock-b' ]);
const staleSelection = await prepared();
staleSelection.state.package.version = '2.0.0';
staleSelection.context.updateUserRules = async ( ) => { throw new Error('User rules must wait for the selection'); };
selectionRecorder(staleSelection, 'Injected selection failure');
await assert.rejects(staleSelection.context.rollbackRulesetTransaction(staleSelection.transaction),
    /Static ruleset rollback failed: Injected selection failure/);
assert.equal(staleSelection.values.has(OUTER), true);
assert.equal(staleSelection.values.has(INNER), true);
assert.equal(staleSelection.values.has(STOCK_BADFILTER_JOURNAL), true);

const foreign = await prepared();
const changedOff = { ...regular(8000001), priority: 200 };
foreign.state.session = foreign.state.session.filter(rule => rule.id !== 8000001 && rule.id !== 6500000);
foreign.state.session.push(changedOff);
foreign.before.session = foreign.before.session.filter(rule => rule.id !== 8000001).concat(changedOff);
foreign.before.session = sorted(foreign.before.session);
await foreign.context.rollbackRulesetTransaction(foreign.transaction);
checkRestored(foreign);

const unrelated = await prepared();
unrelated.state.session = unrelated.state.session.filter(rule => rule.id !== 6500000);
const changedRegex = regex(6500000, 'live-owner-edit');
unrelated.state.session.push(changedRegex);
unrelated.before.session = sorted(unrelated.before.session.filter(rule => rule.id !== 6500000).concat(changedRegex));
await unrelated.context.rollbackRulesetTransaction(unrelated.transaction);
checkRestored(unrelated);

const quota = await prepared();
quota.dnr.MAX_NUMBER_OF_REGEX_RULES = 4;
await assert.rejects(quota.context.rollbackRulesetTransaction(quota.transaction), /unrelated rules were preserved/);
assert.deepEqual(quota.events, [], 'quota preflight cannot remove another owner to force restoration');
assert.equal(quota.values.has(OUTER), true);

console.log('Native ruleset recovery: installed snapshots, shared quota, namespace preservation, API faults, restart retry and stale-package guards passed.');
