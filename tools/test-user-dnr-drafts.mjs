/*******************************************************************************

    uBlock Plus+ - developer DNR draft activation regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
let failDynamic = false;
const unsupportedRegexes = new Set();
globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {
        async getEnabledRulesets() { return []; },
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        RuleConditionKeys: { TOP_DOMAINS: true },
        async getDynamicRules() { return structuredClone(dynamicRules); },
        async getSessionRules() { return structuredClone(sessionRules); },
        async isRegexSupported({ regex }) {
            return unsupportedRegexes.has(regex)
                ? { isSupported: false, reason: 'syntaxError' }
                : { isSupported: true };
        },
        async updateDynamicRules(details) {
            dynamicUpdates += 1;
            if ( failDynamic ) { throw new Error('mock dynamic DNR rejection'); }
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

// An explicit save of an invalid draft is rejected. So is any update which
// has no record of the developer rules already installed (a profile updated
// from an earlier version): falling back to none could drop an exception.
for ( const [ draft, options ] of [
    '||invalid-raw-filter.example^',
    'action:\n type: block\ncondition:\n  urlFilter: ||wrong-indent.example^',
    'action:\n  type: unsupported\ncondition:\n  urlFilter: ||invalid-action.example^',
    `${validDraft}\n---\naction:\n  type: allow\ncondition:\n  unsupportedKey: trusted.example`,
].flatMap(draft => [ [ draft, { strictDeveloperDraft: true } ], [ draft, undefined ] ]) ) {
    reset(draft);
    const result = await updateUserRules(undefined, options);
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
    assert.equal(stored.has('userDnrRules.applied'), false);
}

// Fixing the draft activates normally after a rejection; the DNR mutation
// queue remains usable and stock/imported namespaces retain their rules.
stored.set('userDnrRules', validDraft);
const recovered = await updateUserRules();
assert.equal(recovered.fatalError, '');
assert.equal(recovered.added, 1);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), true);
assert.deepEqual(dynamicRules.filter(rule => rule.id < 9000000), oldDynamic.slice(0, 2));
assert.equal(stored.get('userDnrRules.applied'), validDraft,
    'a successful update records the developer rules it installed');

// A saved draft with an error must not break unrelated compiled activations,
// their rollback, recovery or startup. Those keep the developer rules which
// the last successful update installed; only an explicit save reports it.
const typo = 'action:\n type: block\ncondition:\n  urlFilter: ||typo.example^';
stored.set('userDnrRules', typo);
const beforeStrict = structuredClone(dynamicRules);
const strict = await updateUserRules(undefined, { strictDeveloperDraft: true });
assert.match(strict.fatalError, /syntax.*line/i);
assert.deepEqual(dynamicRules, beforeStrict);
stored.set('compiledFilters.g.G2.sandboxFilters.dnrRules', [ {
    id: 1, action: { type: 'block' }, condition: { urlFilter: '||g2.example^' },
} ]);
const activated = await updateUserRules('G2');
assert.equal(activated.fatalError, '');
assert.match(activated.errors[0], /^Developer DNR draft not applied: Invalid developer DNR syntax/);
assert.equal(activated.added, 2);
for ( const filter of [ '||new.example^', '||g2.example^' ] ) {
    assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === filter), true);
}
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||typo.example^'), false);
assert.deepEqual(dynamicRules.filter(rule => rule.id < 9000000), oldDynamic.slice(0, 2));
assert.equal(stored.get('userDnrRules'), typo, 'the draft stays editable');
assert.equal(stored.get('userDnrRules.applied'), validDraft);

// The same holds for a draft which parses but which Chrome cannot represent,
// such as an allow exception with an unsupported regex.
const unsupportedRegex = '^https://allow\\.example/(?=x)';
unsupportedRegexes.add(unsupportedRegex);
stored.set('userDnrRules',
    `action:\n  type: allow\ncondition:\n  regexFilter: ${unsupportedRegex}`);
assert.match((await updateUserRules(undefined, { strictDeveloperDraft: true })).fatalError,
    /allow exception uses an unsupported regex/);
const kept = await updateUserRules('G2');
assert.equal(kept.fatalError, '');
assert.match(kept.errors[0], /^Developer DNR draft not applied: An allow exception/);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), true);
assert.equal(stored.get('userDnrRules.applied'), validDraft);
unsupportedRegexes.clear();

// The actual background activation and restart recovery succeed with such a
// draft and leave no pending activation journal behind.
const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const extract = name => {
    const start = background.indexOf(`async function ${name}(`);
    const end = background.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start);
    return background.slice(start, end);
};
const ACTIVE = 'compiledFilters.activeGeneration';
const PENDING = 'compiledFilters.pendingActivation';
stored.set('userDnrRules', typo);
stored.set(ACTIVE, 'G2');
stored.set('compiledFilters.g.G3.sandboxFilters.dnrRules', [ {
    id: 1, action: { type: 'block' }, condition: { urlFilter: '||g3.example^' },
} ]);
const removedGenerations = [];
const activationContext = vm.createContext({
    Object, Error,
    PENDING_COMPILED_ACTIVATION_KEY: PENDING,
    STAGING_COMPILED_GENERATION_KEY: 'compiledFilters.stagingGeneration',
    updateCompiledFilters: async ( ) => ({ generation: 'G3' }),
    getActiveCompiledGeneration: async ( ) => stored.get(ACTIVE),
    localRead: async key => structuredClone(stored.get(key)),
    localWrite: async (key, value) => { stored.set(key, structuredClone(value)); },
    localRemove: async key => { stored.delete(key); },
    registerUserScripts: async ( ) => ({}),
    restoreUserScripts: async ( ) => {},
    updateUserRules,
    commitCompiledGeneration: async generation => { stored.set(ACTIVE, generation); },
    commitImportedListUpdates: async ( ) => {},
    recordCompiledFilterWarnings: async ( ) => {},
    removeCompiledGeneration: async generation => { removedGenerations.push(generation); },
    ublockPlusErr: ( ) => {},
});
vm.runInContext(extract('activateCompiledFilterRulesNow') + '\n' +
    extract('recoverPendingCompiledActivation'), activationContext);
const activation = await activationContext.activateCompiledFilterRulesNow();
assert.equal(activation.generation, 'G3');
assert.equal(stored.get(ACTIVE), 'G3');
assert.equal(stored.has(PENDING), false);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||g3.example^'), true);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), true);
stored.set(PENDING, { generation: 'G4', previousGeneration: 'G3' });
assert.equal(await activationContext.recoverPendingCompiledActivation(), true);
assert.equal(stored.has(PENDING), false, 'restart recovery must not keep failing on the draft');
assert.equal(stored.get(ACTIVE), 'G3');
assert.deepEqual(removedGenerations.slice(-1), [ 'G4' ]);

// The editor's save message is the explicit, strict path.
const saveCase = (( ) => {
    const start = background.indexOf(`    case 'updateUserDnrRules':`);
    const end = background.indexOf('\n    case ', start + 1);
    assert.ok(start >= 0 && end > start);
    return background.slice(start, end);
})();
const saveCalls = [];
const saveContext = vm.createContext({
    enqueueFilteringMutation: task => task(),
    updateUserRules: async (generation, options) => { saveCalls.push({ generation, options }); },
});
vm.runInContext(`async function dispatch(request) { switch ( request.what ) { ${saveCase} } }`, saveContext);
await saveContext.dispatch({ what: 'updateUserDnrRules' });
assert.equal(saveCalls.length, 1);
assert.equal(saveCalls[0].generation, undefined);
assert.equal(saveCalls[0].options.strictDeveloperDraft, true);

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
assert.equal(stored.get('userDnrRules.applied'), '', 'no developer rules are installed');

// Enabling developer mode with that draft keeps the installed state (none)
// for background activations.
rulesetConfig.developerMode = true;
const enabled = await updateUserRules('normal');
assert.equal(enabled.fatalError, '');
assert.match(enabled.errors[0], /^Developer DNR draft not applied/);
assert.deepEqual(dynamicRules.filter(rule => rule.id >= 9000000)
    .map(rule => rule.condition.urlFilter), [ '||compiled.example^' ]);

// With developer mode off, a failed update never falls back to a recorded
// developer rule set.
stored.set('userDnrRules', validDraft);
stored.set('userDnrRules.applied', validDraft);
rulesetConfig.developerMode = false;
failDynamic = true;
const updatesBeforeFailure = dynamicUpdates;
const rejected = await updateUserRules('normal');
assert.match(rejected.fatalError, /mock dynamic DNR rejection/);
assert.equal(dynamicUpdates, updatesBeforeFailure + 1);
assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), false);
failDynamic = false;

// An intentionally empty/comment-only draft remains a valid clear operation.
reset('# no developer rules\n');
const cleared = await updateUserRules();
assert.equal(cleared.fatalError, '');
assert.equal(cleared.removed, 2);
assert.deepEqual(dynamicRules, oldDynamic.slice(0, 2));
assert.equal(stored.has('userDnrRuleCount'), false);

console.log('Developer DNR draft activation tests passed.');
