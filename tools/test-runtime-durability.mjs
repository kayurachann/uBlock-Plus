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
let currentSessionRules = [];
let enabledStaticRulesets = [];
const sessionRuleUpdates = [];

const dnr = {
    DYNAMIC_RULESET_ID: '_dynamic',
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    RuleConditionKeys: { TOP_DOMAINS: true },
    async getDynamicRules() {
        dynamicRulesReads += 1;
        return structuredClone(currentDynamicRules);
    },
    async getSessionRules() {
        return structuredClone(currentSessionRules);
    },
    async getEnabledRulesets() {
        return enabledStaticRulesets.slice();
    },
    async isRegexSupported() {
        return { isSupported: true };
    },
    async updateDynamicRules(details) {
        if ( rejectDynamicUpdate ) { throw new Error('mock DNR rejection'); }
        const removed = new Set(details.removeRuleIds || []);
        currentDynamicRules = currentDynamicRules
            .filter(rule => removed.has(rule.id) === false)
            .concat(structuredClone(details.addRules || []));
    },
    async updateSessionRules(details) {
        sessionRuleUpdates.push(structuredClone(details));
        const removed = new Set(details.removeRuleIds || []);
        currentSessionRules = currentSessionRules
            .filter(rule => removed.has(rule.id) === false)
            .concat(structuredClone(details.addRules || []));
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

// Stock-regex replacement must project the retained imported/user regexes as
// well. Otherwise a stock increase can skip the pre-emptive session cleanup
// because the old implementation compared a stock-only after-count with an
// all-realms before-count.
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
globalThis.fetch = originalFetch;
assert.equal(stockUpdate.error, undefined);
assert.deepEqual(sessionRuleUpdates[0], { removeRuleIds: [ 77 ] });
assert.equal(currentSessionRules.length, 0);
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

console.log('Runtime durability checks passed.');
