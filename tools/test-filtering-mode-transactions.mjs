/*******************************************************************************

    uBlock Plus+ - filtering-mode transaction and site-power regression tests
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';

const MODE_KEY = 'filteringModeDetails';
const RESTORE_KEY = 'filteringModeRestoreLevels';
const TRANSACTION_KEY = 'filteringModeTransaction';
const defaults = { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] };
const broadcasts = [];

function makeStorageArea(initial = {}) {
    const values = new Map(Object.entries(initial));
    const failures = new Map();
    const writes = [];
    return {
        values, failures, writes,
        async get(keys) {
            if ( failures.get('get') ) {
                failures.set('get', failures.get('get') - 1);
                throw new Error('mock storage read rejection');
            }
            return Object.fromEntries((Array.isArray(keys) ? keys : [ keys ])
                .filter(key => values.has(key))
                .map(key => [ key, structuredClone(values.get(key)) ]));
        },
        async set(entries) {
            for ( const key of Object.keys(entries) ) {
                if ( failures.get(key) ) {
                    failures.set(key, failures.get(key) - 1);
                    throw new Error(`mock storage write rejection: ${key}`);
                }
            }
            for ( const [ key, value ] of Object.entries(entries) ) {
                writes.push(key);
                values.set(key, structuredClone(value));
            }
        },
        async remove(keys) {
            for ( const key of Array.isArray(keys) ? keys : [ keys ] ) {
                if ( failures.get(`remove:${key}`) ) {
                    failures.set(`remove:${key}`, failures.get(`remove:${key}`) - 1);
                    throw new Error(`mock storage remove rejection: ${key}`);
                }
                values.delete(key);
            }
        },
    };
}

const local = makeStorageArea({ [MODE_KEY]: defaults });
const session = makeStorageArea();
let dynamicRules = [];
let sessionRules = [];
let dynamicFailures = 0;
let sessionFailures = 0;
let dynamicGate;
let dynamicUpdates = 0;
const filtered = (rules, options) => structuredClone(options?.ruleIds
    ? rules.filter(rule => options.ruleIds.includes(rule.id))
    : rules);
const replaced = (rules, details) => rules
    .filter(rule => (details.removeRuleIds || []).includes(rule.id) === false)
    .concat(structuredClone(details.addRules || []));

globalThis.self = globalThis;
globalThis.BroadcastChannel = class {
    postMessage(value) { broadcasts.push(structuredClone(value)); }
};
globalThis.chrome = {
    declarativeNetRequest: {
        async getDynamicRules(options) { return filtered(dynamicRules, options); },
        async getSessionRules(options) { return filtered(sessionRules, options); },
        async updateDynamicRules(details) {
            dynamicUpdates += 1;
            if ( dynamicGate !== undefined ) {
                const gate = dynamicGate;
                dynamicGate = undefined;
                gate.entered();
                await gate.wait;
            }
            if ( dynamicFailures > 0 ) {
                dynamicFailures -= 1;
                throw new Error('mock dynamic DNR rejection');
            }
            dynamicRules = replaced(dynamicRules, details);
        },
        async updateSessionRules(details) {
            if ( sessionFailures > 0 ) {
                sessionFailures -= 1;
                throw new Error('mock session DNR rejection');
            }
            sessionRules = replaced(sessionRules, details);
        },
    },
    i18n: { getMessage() { return ''; } },
    permissions: { async getAll() { return { origins: [ '<all_urls>' ] }; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: { local, session, managed: makeStorageArea() },
    tabs: { TAB_ID_NONE: -1 },
};

let generation = 0;
async function restart() {
    generation += 1;
    return import(`../platform/mv3/extension/js/mode-manager.js?test=${generation}`);
}

let modes = await restart();
assert.equal(await modes.getFilteringMode('site.example'), 2);

// Power preserves the exact supported level through worker restarts.
await modes.setFilteringMode('site.example', 3);
await modes.setFilteringMode('site.example', 0);
assert.equal(await modes.getFilteringModeRestoreLevel('site.example'), 3);
modes = await restart();
assert.equal(await modes.getFilteringMode('site.example'), 0);
assert.equal(await modes.getFilteringModeRestoreLevel('site.example'), 3);
local.failures.set(MODE_KEY, 1);
await assert.rejects(modes.setFilteringMode('site.example', 3), /storage/);
assert.equal(await modes.getFilteringMode('site.example'), 0);
assert.equal(local.values.get(RESTORE_KEY)['site.example'], 3);
await modes.setFilteringMode('unrelated.example', 1);
await modes.setFilteringMode(
    'site.example', await modes.getFilteringModeRestoreLevel('site.example')
);
assert.equal(await modes.getFilteringMode('site.example'), 3);
assert.equal(await modes.getFilteringMode('unrelated.example'), 1);
assert.equal(Object.hasOwn(local.values.get(RESTORE_KEY), 'site.example'), false);
assert.equal(await modes.getFilteringModeRestoreLevel('unknown.example'), 2);
await modes.setFilteringMode('site.example', 1);
assert.equal(await modes.getFilteringModeRestoreLevel('site.example'), 1);
await modes.setFilteringMode('site.example', 0);
assert.equal(await modes.getFilteringModeRestoreLevel('site.example'), 1);

// A child power switch must not erase an inherited parent level or affect
// siblings. A positive exception inside a trusted parent is unsupported.
await modes.setFilteringModeDetails({ ...defaults, complete: [ 'example.com' ] });
await modes.setFilteringMode('a.example.com', 0);
assert.equal(await modes.getFilteringMode('a.example.com'), 0);
assert.equal(await modes.getFilteringMode('b.example.com'), 3);
assert.deepEqual(local.values.get(MODE_KEY).complete, [ 'example.com' ]);
await modes.setFilteringMode('a.example.com', 3);
assert.equal(await modes.getFilteringMode('b.example.com'), 3);
await modes.setFilteringModeDetails({ ...defaults, none: [ 'example.com' ] });
const parentTrusted = structuredClone(local.values.get(MODE_KEY));
await assert.rejects(modes.setFilteringMode('a.example.com', 2), /trusted parent/);
assert.deepEqual(local.values.get(MODE_KEY), parentTrusted);
assert.equal(await modes.getFilteringMode('b.example.com'), 0);

// A parent Off/On cycle preserves independently trusted descendants. Their
// redundant-looking None entries carry user intent after the parent is on.
await modes.setFilteringModeDetails(defaults);
await modes.setFilteringMode('parent.example', 3);
await modes.setFilteringMode('trusted.parent.example', 0);
await modes.setFilteringMode('parent.example', 0);
assert.equal(await modes.getFilteringMode('trusted.parent.example'), 0);
assert.equal(await modes.getFilteringMode('sibling.parent.example'), 0);
assert.equal(await modes.getFilteringMode('unrelated.example'), 2);
modes = await restart();
await modes.setFilteringMode('parent.example',
    await modes.getFilteringModeRestoreLevel('parent.example'));
assert.equal(await modes.getFilteringMode('parent.example'), 3);
assert.equal(await modes.getFilteringMode('sibling.parent.example'), 3);
assert.equal(await modes.getFilteringMode('trusted.parent.example'), 0);
assert.equal(await modes.getFilteringMode('unrelated.example'), 2);
assert.deepEqual(local.values.get(MODE_KEY).none, [ 'trusted.parent.example' ]);
assert.equal(Object.hasOwn(local.values.get(RESTORE_KEY), 'parent.example'), false);
assert.equal(local.values.get(RESTORE_KEY)['trusted.parent.example'], 3);
assert.equal(dynamicRules.some(rule =>
    rule.condition.requestDomains?.includes('trusted.parent.example')
), true);

// Every differing positive child level is rejected without changing inherited
// parent settings, browser rules, or siblings. Returning to an explicit parent
// level and ordinary overrides of the global default remain supported.
const modeNames = [ 'none', 'basic', 'optimal', 'complete' ];
for ( const parentLevel of [ 1, 2, 3 ] ) {
    const details = {
        none: [], basic: [], optimal: [], complete: [],
        [modeNames[parentLevel === 1 ? 2 : 1]]: [ 'all-urls' ],
        [modeNames[parentLevel]]: [ 'parent.example' ],
    };
    await modes.setFilteringModeDetails(details);
    for ( const childLevel of [ 1, 2, 3 ] ) {
        if ( childLevel === parentLevel ) { continue; }
        const beforeDNR = structuredClone([ dynamicRules, sessionRules ]);
        const beforeWrites = local.writes.length;
        await assert.rejects(modes.setFilteringMode('child.parent.example', childLevel), {
            code: 'ERR_FILTERING_MODE_PARENT_SCOPE',
        });
        assert.deepEqual(local.values.get(MODE_KEY), details);
        assert.deepEqual([ dynamicRules, sessionRules ], beforeDNR);
        assert.equal(local.writes.length, beforeWrites);
        assert.equal(await modes.getFilteringMode('sibling.parent.example'), parentLevel);
    }
    await modes.setFilteringMode('child.parent.example', 0);
    await modes.setFilteringMode('child.parent.example', parentLevel);
    assert.equal(await modes.getFilteringMode('child.parent.example'), parentLevel);
    assert.equal(await modes.getFilteringMode('sibling.parent.example'), parentLevel);
}
await modes.setFilteringModeDetails({
    ...defaults, basic: [ 'child.parent.example' ], complete: [ 'parent.example' ],
});
await modes.setFilteringMode('child.parent.example', 3);
assert.equal(await modes.getFilteringMode('child.parent.example'), 3);
assert.equal(await modes.getFilteringMode('sibling.parent.example'), 3);
assert.deepEqual(local.values.get(MODE_KEY).complete, [ 'parent.example' ]);
assert.deepEqual(local.values.get(MODE_KEY).basic, []);

// With global filtering Off, Chromium's existing reverse trusted-site rule
// cannot exempt one child of an explicitly protected parent from that scope.
const globalOff = {
    none: [ 'all-urls' ], basic: [], optimal: [], complete: [ 'parent.example' ],
};
await modes.setFilteringModeDetails(globalOff);
const globalOffDNR = structuredClone([ dynamicRules, sessionRules ]);
await assert.rejects(modes.setFilteringMode('child.parent.example', 0), {
    code: 'ERR_FILTERING_MODE_PARENT_SCOPE',
});
assert.deepEqual(local.values.get(MODE_KEY), globalOff);
assert.deepEqual([ dynamicRules, sessionRules ], globalOffDNR);
assert.equal(await modes.getFilteringMode('child.parent.example'), 3);
assert.equal(await modes.getFilteringMode('sibling.parent.example'), 3);
await modes.setFilteringMode('parent.example', 0);
assert.equal(await modes.getFilteringMode('child.parent.example'), 0);

await modes.setFilteringModeDetails(defaults);
async function assertCommittedDefault() {
    assert.deepEqual(local.values.get(MODE_KEY), defaults);
    assert.deepEqual(session.values.get(MODE_KEY), defaults);
    assert.deepEqual(await modes.getFilteringModeDetails(true), defaults);
    assert.deepEqual(dynamicRules, []);
    assert.deepEqual(sessionRules, []);
    assert.equal(local.values.has(TRANSACTION_KEY), false);
}

// Single-site and bulk changes never save a mode rejected by Chrome.
for ( const half of [ 'dynamic', 'session' ] ) {
    if ( half === 'dynamic' ) { dynamicFailures = 1; }
    else { sessionFailures = 1; }
    await assert.rejects(
        modes.setFilteringModeDetails({ ...defaults, none: [ 'rejected.example' ] }),
        /DNR rejection/
    );
    await assertCommittedDefault();
}
dynamicFailures = 1;
await assert.rejects(modes.setFilteringMode('rejected.example', 0), /DNR rejection/);
await assertCommittedDefault();

// Failure to create the journal prevents all DNR changes and remains retryable.
const updatesBeforeJournalFailure = dynamicUpdates;
local.failures.set(TRANSACTION_KEY, 1);
await assert.rejects(modes.setFilteringMode('journal.example', 0), /storage/);
assert.equal(dynamicUpdates, updatesBeforeJournalFailure);
await assertCommittedDefault();

// Failures in each durable/cache write roll back, never publish success,
// and leave no accidentally remembered power level.
for ( const [ area, key ] of [
    [ local, MODE_KEY ],
    [ local, RESTORE_KEY ],
    [ session, MODE_KEY ],
    [ local, `remove:${TRANSACTION_KEY}` ],
] ) {
    const previousLevels = structuredClone(local.values.get(RESTORE_KEY));
    const broadcastsBefore = broadcasts.length;
    area.failures.set(key, 1);
    await assert.rejects(modes.setFilteringMode('failed.example', 0), /storage/);
    await assertCommittedDefault();
    assert.deepEqual(local.values.get(RESTORE_KEY), previousLevels);
    assert.equal(broadcasts.length, broadcastsBefore);
}

// If rollback itself fails, retain its journal, propagate both errors, and
// recover the previous committed state after restarting the worker.
local.failures.set(MODE_KEY, 2);
await assert.rejects(
    modes.setFilteringMode('rollback.example', 0), /rollback failed/
);
assert.equal(local.values.has(TRANSACTION_KEY), true);
modes = await restart();
await modes.getFilteringModeDetails();
await assertCommittedDefault();

// Simulate termination after the new DNR/storage/cache state was applied but
// before the commit point. Even a populated session cache cannot hide it.
const previousLevels = structuredClone(local.values.get(RESTORE_KEY));
await modes.setFilteringMode('interrupted.example', 0);
local.values.set(TRANSACTION_KEY, {
    version: 1,
    previousModes: defaults,
    previousRestoreLevels: previousLevels,
});
modes = await restart();
await modes.getFilteringModeDetails();
await assertCommittedDefault();
assert.deepEqual(local.values.get(RESTORE_KEY), previousLevels);

// A failed durable read must not treat an existing trusted site as default
// protected; DNR remains untouched until authoritative settings are readable.
await modes.setFilteringMode('read-failure.example', 0);
const readsBeforeFailure = dynamicUpdates;
local.failures.set('get', 1);
modes = await restart();
await assert.rejects(modes.getFilteringModeDetails(), /storage read/);
assert.equal(dynamicUpdates, readsBeforeFailure);
assert.equal(await modes.getFilteringMode('read-failure.example'), 0);

// Serialize read/modify/write as well as DNR writes: two switches preserve
// each other's updates, and readers see committed state during a pending save.
await modes.setFilteringModeDetails(defaults);
let markEntered;
let release;
const entered = new Promise(resolve => { markEntered = resolve; });
dynamicGate = {
    entered: markEntered,
    wait: new Promise(resolve => { release = resolve; }),
};
const first = modes.setFilteringMode('first.example', 0);
await entered;
const second = modes.setFilteringMode('second.example', 0);
assert.equal(await modes.getFilteringMode('first.example'), 2);
release();
await Promise.all([ first, second ]);
assert.equal(await modes.getFilteringMode('first.example'), 0);
assert.equal(await modes.getFilteringMode('second.example'), 0);
assert.deepEqual(local.values.get(MODE_KEY).none.sort(), [
    'first.example', 'second.example',
]);
assert.equal(local.values.has(TRANSACTION_KEY), false);

await modes.setDefaultFilteringMode(0);
assert.equal(await modes.getFilteringModeRestoreLevel('unknown.example'), 1);
await assert.rejects(modes.setFilteringMode('site.example', 4), /Invalid/);

console.log('Filtering-mode transaction and site-power tests passed.');
