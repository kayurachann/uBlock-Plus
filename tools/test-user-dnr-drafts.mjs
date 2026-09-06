/*******************************************************************************

    uBlock Plus+ - developer DNR draft activation regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';

const stored = new Map();
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
const oldDynamic = [
    { id: 11, action: { type: 'block' }, condition: { urlFilter: '||stock.example^' } },
    { id: 8000000, action: { type: 'block' }, condition: { urlFilter: '||imported.example^' } },
    { id: 9000000, action: { type: 'block' }, condition: { urlFilter: '||old.example^' } },
    { id: 9000001, action: { type: 'allow' }, condition: { urlFilter: '||trusted.example^' } },
];
const oldSession = [ {
    id: 15, action: { type: 'allow' }, condition: { initiatorDomains: [ 'trusted.example' ] },
} ];
let dynamicRules;
let sessionRules;
let dynamicUpdates;
let sessionUpdates;
globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {
        async getEnabledRulesets() { return []; },
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        RuleConditionKeys: { TOP_DOMAINS: true },
        async getDynamicRules() { return structuredClone(dynamicRules); },
        async getSessionRules() { return structuredClone(sessionRules); },
        async isRegexSupported() { return { isSupported: true }; },
        async updateDynamicRules(details) {
            dynamicUpdates += 1;
            dynamicRules = dynamicRules.filter(rule =>
                (details.removeRuleIds || []).includes(rule.id) === false
            ).concat(structuredClone(details.addRules || []));
        },
        async updateSessionRules(details) {
            sessionUpdates += 1;
            sessionRules = sessionRules.filter(rule =>
                (details.removeRuleIds || []).includes(rule.id) === false
            ).concat(structuredClone(details.addRules || []));
        },
    },
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: { local },
};
const { rulesetConfig } = await import('../platform/mv3/extension/js/config.js');
const { updateUserRules } = await import('../platform/mv3/extension/js/ruleset-manager.js');
const validDraft = 'action:\n  type: block\ncondition:\n  urlFilter: ||new.example^';
function reset(draft) {
    stored.clear();
    stored.set('userDnrRules', draft);
    stored.set('userDnrRuleCount', 2);
    stored.set('unrelated.settings', { keep: true });
    dynamicRules = structuredClone(oldDynamic);
    sessionRules = structuredClone(oldSession);
    dynamicUpdates = sessionUpdates = 0;
    rulesetConfig.developerMode = true;
}

for ( const draft of [
    '||invalid-raw-filter.example^',
    'action:\n type: block\ncondition:\n  urlFilter: ||wrong-indent.example^',
    'action:\n  type: unsupported\ncondition:\n  urlFilter: ||invalid-action.example^',
    `${validDraft}\n---\naction:\n  type: allow\ncondition:\n  unsupportedKey: trusted.example`,
] ) {
    reset(draft);
    const result = await updateUserRules();
    assert.match(result.fatalError, /syntax.*line/i);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.deepEqual(result.errors, [ result.fatalError ]);
    assert.equal(dynamicUpdates, 0, 'A partial parse must never replace active rules');
    assert.equal(sessionUpdates, 0);
    assert.deepEqual(dynamicRules, oldDynamic);
    assert.deepEqual(sessionRules, oldSession);
    assert.equal(stored.get('userDnrRules'), draft, 'Retain the draft for correction');
    assert.equal(stored.get('userDnrRuleCount'), 2);
    assert.deepEqual(stored.get('unrelated.settings'), { keep: true });
}

// Fixing the draft activates normally after a rejection; the DNR mutation
// queue remains usable and stock/imported namespaces retain their rules.
stored.set('userDnrRules', validDraft);
const recovered = await updateUserRules();
assert.equal(recovered.fatalError, '');
assert.equal(recovered.added, 1);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), true);
assert.deepEqual(dynamicRules.filter(rule => rule.id < 9000000), oldDynamic.slice(0, 2));

// A malformed saved draft is inert while developer mode is off. Normal
// compiled user filters can still activate without discarding the saved draft.
reset('invalid saved draft');
rulesetConfig.developerMode = false;
stored.set('compiledFilters.g.normal.sandboxFilters.dnrRules', [ {
    id: 1, action: { type: 'block' }, condition: { urlFilter: '||compiled.example^' },
} ]);
const normal = await updateUserRules('normal');
assert.equal(normal.fatalError, '');
assert.equal(normal.added, 1);
assert.equal(stored.get('userDnrRules'), 'invalid saved draft');
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||compiled.example^'), true);

// An intentionally empty/comment-only draft remains a valid clear operation.
reset('# no developer rules\n');
const cleared = await updateUserRules();
assert.equal(cleared.fatalError, '');
assert.equal(cleared.removed, 2);
assert.deepEqual(dynamicRules, oldDynamic.slice(0, 2));
assert.equal(stored.has('userDnrRuleCount'), false);

console.log('Developer DNR draft activation tests passed.');
