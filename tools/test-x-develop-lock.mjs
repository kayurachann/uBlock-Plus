/*******************************************************************************

    uBlock Plus+ - managed 'develop' lock regressions
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    With managed disabledFeatures ["develop"], no extension page (a restore
    included) may turn developer mode on, and developer DNR drafts install
    no rules: those installed before the lock are removed.

*******************************************************************************/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const stored = new Map();
let managed = { disabledFeatures: [ 'develop' ] };
const local = {
    async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [ keys ])
            .filter(key => stored.has(key))
            .map(key => [ key, structuredClone(stored.get(key)) ]));
    },
    async set(entries) {
        for ( const [ key, value ] of Object.entries(entries) ) {
            stored.set(key, structuredClone(value));
        }
    },
    async remove(keys) {
        for ( const key of Array.isArray(keys) ? keys : [ keys ] ) { stored.delete(key); }
    },
};
const stockRules = [
    { id: 11, action: { type: 'block' }, condition: { urlFilter: '||stock.example^' } },
    { id: 8000000, action: { type: 'block' }, condition: { urlFilter: '||imported.example^' } },
];
const developerRule = { id: 9000000, action: { type: 'allow' }, condition: { urlFilter: '||old-developer.example^' } };
let dynamicRules = [];
globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {
        async getEnabledRulesets() { return []; },
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        RuleConditionKeys: { TOP_DOMAINS: true },
        async getDynamicRules() { return structuredClone(dynamicRules); },
        async getSessionRules() { return []; },
        async isRegexSupported() { return { isSupported: true }; },
        async updateDynamicRules(details) {
            dynamicRules = dynamicRules.filter(rule =>
                (details.removeRuleIds || []).includes(rule.id) === false
            ).concat(structuredClone(details.addRules || []));
        },
        async updateSessionRules() {},
    },
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: {
        local,
        managed: {
            async get(key) { return { [key]: structuredClone(managed[key]) }; },
        },
    },
};
const { rulesetConfig } = await import('../platform/mv3/extension/js/config.js');
const { updateUserRules } = await import('../platform/mv3/extension/js/ruleset-manager.js');
const draft = 'action:\n  type: block\ncondition:\n  urlFilter: ||developer.example^';
const hasRule = filter => dynamicRules.some(rule => rule.condition.urlFilter === filter);

function reset(lock) {
    managed = { disabledFeatures: lock ? [ 'develop' ] : [] };
    stored.clear();
    // The cache adminReadEx() reads first; the managed read refreshes it.
    stored.set('admin.disabledFeatures', { data: managed.disabledFeatures });
    stored.set('userDnrRules', draft);
    stored.set('userDnrRules.applied', 'action:\n  type: allow\ncondition:\n  urlFilter: ||old-developer.example^');
    dynamicRules = structuredClone([ ...stockRules, developerRule ]);
    rulesetConfig.developerMode = true;
}

// Under the lock a saved or restored draft installs nothing, and the
// developer rules installed before the lock are removed.
for ( const options of [ undefined, { strictDeveloperDraft: true } ] ) {
    reset(true);
    const result = await updateUserRules(undefined, options);
    assert.equal(result.fatalError, '');
    assert.equal(hasRule('||developer.example^'), false, 'The draft installs no rules under the lock');
    assert.equal(hasRule('||old-developer.example^'), false, 'Earlier developer rules are removed');
    assert.deepEqual(dynamicRules, stockRules, 'Stock and imported rules stay');
    assert.equal(stored.get('userDnrRules.applied'), '');
    assert.equal(stored.get('userDnrRules'), draft, 'The draft itself is kept');
}

// Without the lock the draft is installed as before.
reset(false);
assert.equal((await updateUserRules()).fatalError, '');
assert.equal(hasRule('||developer.example^'), true);
assert.equal(stored.get('userDnrRules.applied'), draft);

// The worker keeps developer mode off under the lock, whichever page asks.
{
    const background = (await readFile(new URL(
        '../platform/mv3/extension/js/background.js', import.meta.url
    ), 'utf8')).replace(/\r\n/g, '\n');
    const start = background.indexOf('async function setDeveloperMode(');
    const end = background.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start);
    let disabledFeatures = [ 'develop' ];
    const events = [];
    const context = vm.createContext({
        Array,
        rulesetConfig: { developerMode: false },
        adminReadEx: async key => key === 'disabledFeatures' ? disabledFeatures : undefined,
        toggleDeveloperMode: state => { events.push(`toggle:${state}`); },
        broadcastMessage: message => { events.push(`broadcast:${message.developerMode}`); },
        saveRulesetConfig: async ( ) => { events.push('save'); },
    });
    vm.runInContext(background.slice(start, end), context);
    assert.equal(await context.setDeveloperMode(true), false, 'A restore cannot turn developer mode on');
    assert.equal(context.rulesetConfig.developerMode, false);
    assert.deepEqual(events, [ 'toggle:false', 'broadcast:false', 'save' ]);
    disabledFeatures = [ 'picker' ];
    assert.equal(await context.setDeveloperMode(true), true);
    disabledFeatures = undefined;
    assert.equal(await context.setDeveloperMode(true), true);
}

console.log('Managed develop lock: developer mode stays off and developer DNR drafts install no rules.');
