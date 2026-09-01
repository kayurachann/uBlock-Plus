/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function makeStorageArea(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        async get(keys) {
            const selected = {};
            const names = keys === null || keys === undefined
                ? Array.from(values.keys())
                : Array.isArray(keys) ? keys : [ keys ];
            for ( const key of names ) {
                if ( values.has(key) === false ) { continue; }
                selected[key] = structuredClone(values.get(key));
            }
            return selected;
        },
        async set(entries) {
            for ( const [ key, value ] of Object.entries(entries) ) {
                values.set(key, structuredClone(value));
            }
        },
        async remove(keys) {
            for ( const key of Array.isArray(keys) ? keys : [ keys ] ) {
                values.delete(key);
            }
        },
        async getKeys() {
            return Array.from(values.keys());
        },
        async setAccessLevel() {
        },
    };
}

const root = path.resolve(import.meta.dirname, '..');
const extensionJS = path.join(root, 'platform', 'mv3', 'extension', 'js');
const local = makeStorageArea();
const session = makeStorageArea();
const alarmOperations = [];
let currentDynamicRules = [];
let dynamicRulesReads = 0;
let rejectDynamicUpdate = false;
let rejectDynamicReadOnce = false;
let currentSessionRules = [];
let sessionRulesReads = 0;
let rejectSessionUpdate = false;
let enabledStaticRulesets = [];
const sessionRuleUpdates = [];
let dynamicUpdateGate;

const dnr = {
    DYNAMIC_RULESET_ID: '_dynamic',
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    RuleConditionKeys: { TOP_DOMAINS: true },
    async getDynamicRules() {
        dynamicRulesReads += 1;
        if ( rejectDynamicReadOnce ) {
            rejectDynamicReadOnce = false;
            throw new Error('mock dynamic read rejection');
        }
        return structuredClone(currentDynamicRules);
    },
    async getSessionRules() {
        sessionRulesReads += 1;
        return structuredClone(currentSessionRules);
    },
    async getEnabledRulesets() {
        return enabledStaticRulesets.slice();
    },
    async isRegexSupported() {
        return { isSupported: true };
    },
    async updateDynamicRules(details) {
        if ( dynamicUpdateGate !== undefined ) {
            const gate = dynamicUpdateGate;
            dynamicUpdateGate = undefined;
            gate.entered();
            await gate.wait;
        }
        if ( rejectDynamicUpdate ) { throw new Error('mock DNR rejection'); }
        const removed = new Set(details.removeRuleIds || []);
        const replacement = currentDynamicRules
            .filter(rule => removed.has(rule.id) === false)
            .concat(structuredClone(details.addRules || []));
        const sharedRegexCount = replacement.filter(rule =>
            Boolean(rule.condition?.regexFilter)
        ).length + currentSessionRules.filter(rule =>
            Boolean(rule.condition?.regexFilter)
        ).length;
        if ( sharedRegexCount > dnr.MAX_NUMBER_OF_REGEX_RULES ) {
            throw new Error('mock shared regex quota exceeded');
        }
        currentDynamicRules = replacement;
    },
    async updateSessionRules(details) {
        sessionRuleUpdates.push(structuredClone(details));
        if ( rejectSessionUpdate ) {
            throw new Error('mock session DNR rejection');
        }
        const removed = new Set(details.removeRuleIds || []);
        const replacement = currentSessionRules
            .filter(rule => removed.has(rule.id) === false)
            .concat(structuredClone(details.addRules || []));
        const sharedRegexCount = currentDynamicRules.filter(rule =>
            Boolean(rule.condition?.regexFilter)
        ).length + replacement.filter(rule =>
            Boolean(rule.condition?.regexFilter)
        ).length;
        if ( sharedRegexCount > dnr.MAX_NUMBER_OF_REGEX_RULES ) {
            throw new Error('mock shared regex quota exceeded');
        }
        currentSessionRules = replacement;
    },
    async updateEnabledRulesets() {
    },
};

globalThis.self = globalThis;
globalThis.chrome = {
    alarms: {
        async clear(name) {
            alarmOperations.push({ op: 'clear', name });
        },
        async create(name, details) {
            alarmOperations.push({ op: 'create', name, ...details });
        },
    },
    declarativeNetRequest: dnr,
    i18n: {
        getMessage() {
            return '';
        },
    },
    permissions: {
        async getAll() {
            return { origins: [ '<all_urls>' ] };
        },
    },
    runtime: {
        getManifest() {
            return { permissions: [ 'declarativeNetRequestFeedback' ] };
        },
        getURL(value = '') {
            return `chrome-extension://test/${value.replace(/^\//, '')}`;
        },
        async sendMessage() {
        },
    },
    storage: {
        local,
        managed: makeStorageArea(),
        session,
    },
    tabs: { TAB_ID_NONE: -1 },
};

const alarmsModule = await import(pathToFileURL(
    path.join(extensionJS, 'alarms.js')
));

const { processDueJobs, registerJob, removeJob } = alarmsModule;
const now = Date.now();
await registerJob('leased', now - 1);
let releaseLeasedJob;
const leasedRun = processDueJobs(( ) => new Promise(resolve => {
    releaseLeasedJob = resolve;
}));

while ( local.values.get('deferredJobs')?.[0]?.runToken === undefined ) {
    await new Promise(resolve => setTimeout(resolve, 0));
}
const leased = local.values.get('deferredJobs')[0];
assert.equal(leased.name, 'leased');
assert.equal(typeof leased.runToken, 'string');
assert.ok(leased.time >= now + 5 * 60 * 1000);
assert.equal(
    alarmOperations.some(entry =>
        entry.op === 'create' && entry.name === 'deferredJobs'
    ),
    true
);

const replacementTime = Date.now() + 20 * 60 * 1000;
const concurrentTime = Date.now() + 25 * 60 * 1000;
await registerJob('leased', replacementTime);
await registerJob('concurrent', concurrentTime);
releaseLeasedJob();
await leasedRun;
assert.deepEqual(local.values.get('deferredJobs'), [
    { name: 'leased', time: replacementTime },
    { name: 'concurrent', time: concurrentTime },
]);

await removeJob('leased');
await removeJob('concurrent');
await registerJob('completed', Date.now() - 1);
const futureTime = Date.now() + 30 * 60 * 1000;
await registerJob('future', futureTime);
await processDueJobs(async request => {
    assert.equal(request.what, 'completed');
});
assert.deepEqual(local.values.get('deferredJobs'), [ {
    name: 'future',
    time: futureTime,
} ]);
await removeJob('future');

await registerJob('retry', Date.now() - 1);
await assert.rejects(
    processDueJobs(async ( ) => {
        throw new Error('handler failed');
    }),
    /handler failed/
);
const retry = local.values.get('deferredJobs')[0];
assert.equal(retry.name, 'retry');
assert.equal(typeof retry.runToken, 'string');
assert.ok(retry.time > Date.now());
await removeJob('retry');

const importedListsModule = await import(pathToFileURL(
    path.join(extensionJS, 'imported-lists.js')
));
const manualListURL = 'https://filters.example/manual.txt';
await importedListsModule.addImportedLists([ { url: manualListURL } ]);
const manualList = local.values.get('rulesets.imported')
    .find(list => list.id === manualListURL);
assert.equal(manualList.maxSourceBytes, 5 * 1024 * 1024);
assert.equal(manualList.maxSourceFetches, 32);
assert.equal(manualList.requireHTTPSSource, true);

const rulesetManager = await import(pathToFileURL(
    path.join(extensionJS, 'ruleset-manager.js')
));

const makeRule = id => ({
    id,
    action: { type: 'block' },
    condition: { urlFilter: `||example${id}.test^` },
});
const makeRegexRule = (id, regexFilter) => ({
    id,
    action: { type: 'block' },
    condition: { regexFilter },
});

currentDynamicRules = [
    makeRule(42),
    makeRule(9000000),
    makeRule(9000001),
];
local.values.set(
    'compiledFilters.g.success.sandboxFilters.dnrRules',
    [ makeRule(1), makeRule(2), makeRule(3) ]
);
dynamicRulesReads = 0;
const success = await rulesetManager.updateUserRules('success');
assert.equal(success.fatalError, '');
assert.equal(success.added, 3);
assert.equal(dynamicRulesReads, 1);
assert.equal(local.values.get('userDnrRuleCount'), 3);

local.values.set(
    'compiledFilters.g.failure.sandboxFilters.dnrRules',
    [ makeRule(4) ]
);
dynamicRulesReads = 0;
rejectDynamicUpdate = true;
const failure = await rulesetManager.updateUserRules('failure');
assert.match(failure.fatalError, /mock DNR rejection/);
assert.equal(dynamicRulesReads, 1);
assert.equal(local.values.get('userDnrRuleCount'), 3);

// Chromium uses one regex pool for dynamic + session rules. Imported/user
// regex growth must make room before the atomic dynamic update, then report
// any lower-priority session rules that no longer fit.
const configModule = await import(pathToFileURL(
    path.join(extensionJS, 'config.js')
));
const previousStrictBlockMode = configModule.rulesetConfig.strictBlockMode;
configModule.rulesetConfig.strictBlockMode = false;
dnr.MAX_NUMBER_OF_REGEX_RULES = 3;
rejectDynamicUpdate = false;
currentDynamicRules = [
    makeRegexRule(1, 'retained-stock'),
    makeRegexRule(9000000, 'old-user'),
];
currentSessionRules = [ makeRegexRule(88, 'session-low-priority') ];
local.values.set(
    'compiledFilters.g.regex-success.sandboxFilters.dnrRules',
    [
        makeRegexRule(1, 'new-user-a'),
        makeRegexRule(2, 'new-user-b'),
    ]
);
sessionRuleUpdates.length = 0;
const regexSuccess = await rulesetManager.updateUserRules('regex-success');
assert.equal(regexSuccess.fatalError, '');
assert.equal(regexSuccess.added, 2);
assert.match(regexSuccess.errors.join('\n'), /shared 3-rule pool/);
assert.deepEqual(sessionRuleUpdates[0], { removeRuleIds: [ 88 ] });
assert.equal(currentSessionRules.length, 0);
assert.equal(
    currentDynamicRules.filter(rule => rule.condition.regexFilter).length,
    3
);

// If Chrome rejects the dynamic transaction after session capacity was
// displaced, restore the exact session snapshot and keep dynamic rules intact.
currentDynamicRules = [
    makeRegexRule(1, 'retained-stock'),
    makeRegexRule(9000000, 'old-user'),
];
currentSessionRules = [ makeRegexRule(89, 'session-restore') ];
local.values.set(
    'compiledFilters.g.regex-failure.sandboxFilters.dnrRules',
    [
        makeRegexRule(1, 'replacement-a'),
        makeRegexRule(2, 'replacement-b'),
    ]
);
sessionRuleUpdates.length = 0;
rejectDynamicUpdate = true;
const regexFailure = await rulesetManager.updateUserRules('regex-failure');
rejectDynamicUpdate = false;
assert.match(regexFailure.fatalError, /mock DNR rejection/);
assert.deepEqual(
    currentSessionRules.map(rule => rule.condition.regexFilter),
    [ 'session-restore' ]
);
assert.deepEqual(sessionRuleUpdates, [
    { removeRuleIds: [ 89 ] },
    { addRules: [ makeRegexRule(89, 'session-restore') ] },
]);
assert.deepEqual(
    currentDynamicRules.map(rule => rule.condition.regexFilter),
    [ 'retained-stock', 'old-user' ]
);
dnr.MAX_NUMBER_OF_REGEX_RULES = 1000;
configModule.rulesetConfig.strictBlockMode = previousStrictBlockMode;

// Stock-regex replacement must project retained imported/user regexes without
// clearing unrelated non-regex session rules merely because the regex count
// grew.
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => ({
    async json() {
        if ( url === '/rulesets/ruleset-details.json' ) {
            return [ {
                id: 'stock-regex',
                rules: { regex: 2 },
            } ];
        }
        if ( url === '/rulesets/regex/stock-regex.json' ) {
            return [ 101, 102 ].map(id => ({
                id,
                action: { type: 'block' },
                condition: { regexFilter: `stock${id}` },
            }));
        }
        throw new Error(`Unexpected test fetch: ${url}`);
    },
});
rejectDynamicUpdate = false;
enabledStaticRulesets = [ 'stock-regex' ];
currentDynamicRules = [
    {
        id: 1,
        action: { type: 'block' },
        condition: { regexFilter: 'old-stock' },
    },
    {
        id: 8000000,
        action: { type: 'block' },
        condition: { regexFilter: 'retained-imported' },
    },
    {
        id: 9000000,
        action: { type: 'block' },
        condition: { regexFilter: 'retained-user' },
    },
];
currentSessionRules = [ makeRule(77) ];
sessionRuleUpdates.length = 0;
const stockUpdate = await rulesetManager.updateDynamicAndSessionRules();
assert.equal(stockUpdate.error, undefined);
assert.deepEqual(sessionRuleUpdates, []);
assert.deepEqual(currentSessionRules.map(rule => rule.id), [ 77 ]);
assert.equal(
    currentDynamicRules.filter(rule => rule.condition.regexFilter).length,
    4
);
assert.deepEqual(
    currentDynamicRules
        .filter(rule => rule.id >= 8000000)
        .map(rule => rule.condition.regexFilter)
        .sort(),
    [ 'retained-imported', 'retained-user' ]
);

// A failed stock transaction restores any session regex snapshot displaced
// to make room in Chromium's shared pool.
dnr.MAX_NUMBER_OF_REGEX_RULES = 4;
currentDynamicRules = [
    makeRegexRule(1, 'old-stock'),
    makeRegexRule(8000000, 'retained-imported'),
    makeRegexRule(9000000, 'retained-user'),
];
currentSessionRules = [ makeRegexRule(78, 'stock-session-restore') ];
sessionRuleUpdates.length = 0;
rejectDynamicUpdate = true;
const stockFailure = await rulesetManager.updateDynamicAndSessionRules();
rejectDynamicUpdate = false;
dnr.MAX_NUMBER_OF_REGEX_RULES = 1000;
globalThis.fetch = originalFetch;
assert.match(stockFailure.error, /mock DNR rejection/);
assert.deepEqual(sessionRuleUpdates, [
    { removeRuleIds: [ 78 ] },
    { addRules: [ makeRegexRule(78, 'stock-session-restore') ] },
]);
assert.deepEqual(
    currentDynamicRules.map(rule => rule.condition.regexFilter),
    [ 'old-stock', 'retained-imported', 'retained-user' ]
);

// A cold-start dynamic read failure is reported as data, not leaked as a
// rejection which aborts background initialization. Session reconstruction is
// still attempted against the dynamic snapshot available on the retry.
const sessionReadsBeforeColdFailure = sessionRulesReads;
rejectDynamicReadOnce = true;
const coldReadFailure = await rulesetManager.updateDynamicAndSessionRules();
assert.match(coldReadFailure.error, /mock dynamic read rejection/);
assert.ok(sessionRulesReads > sessionReadsBeforeColdFailure);

// Filtering-mode dynamic/session rules form one logical transaction. If the
// session half is rejected, restore the previous dynamic half and propagate
// the error so mode-manager cannot persist a mode Chrome is not enforcing.
currentDynamicRules = [];
currentSessionRules = [];
rejectSessionUpdate = true;
await assert.rejects(
    rulesetManager.filteringModesToDNR({
        none: new Set([ 'disabled.example' ]),
        basic: new Set([ 'all-urls' ]),
        optimal: new Set(),
        complete: new Set(),
    }),
    /mock session DNR rejection/
);
rejectSessionUpdate = false;
assert.deepEqual(currentDynamicRules, []);
assert.deepEqual(currentSessionRules, []);

// Every dynamic/session writer shares one manager-level queue. A second user
// generation must not even read a stale DNR snapshot while the first atomic
// update is paused inside Chrome.
currentDynamicRules = [ makeRule(9000000) ];
currentSessionRules = [];
local.values.set(
    'compiledFilters.g.queue-a.sandboxFilters.dnrRules',
    [ makeRule(301) ]
);
local.values.set(
    'compiledFilters.g.queue-b.sandboxFilters.dnrRules',
    [ makeRule(302) ]
);
let releaseDynamicUpdate;
let markDynamicUpdateEntered;
const dynamicUpdateEntered = new Promise(resolve => {
    markDynamicUpdateEntered = resolve;
});
dynamicUpdateGate = {
    entered: markDynamicUpdateEntered,
    wait: new Promise(resolve => {
        releaseDynamicUpdate = resolve;
    }),
};
const readsBeforeQueueTest = dynamicRulesReads;
const queuedA = rulesetManager.updateUserRules('queue-a');
await dynamicUpdateEntered;
const queuedB = rulesetManager.updateUserRules('queue-b');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(dynamicRulesReads, readsBeforeQueueTest + 1);
releaseDynamicUpdate();
const [ queuedAResult, queuedBResult ] = await Promise.all([
    queuedA,
    queuedB,
]);
assert.equal(queuedAResult.fatalError, '');
assert.equal(queuedBResult.fatalError, '');
assert.equal(dynamicRulesReads, readsBeforeQueueTest + 2);
assert.equal(
    currentDynamicRules.some(rule =>
        rule.condition.urlFilter === '||example302.test^'
    ),
    true
);

console.log('Runtime durability checks passed.');
