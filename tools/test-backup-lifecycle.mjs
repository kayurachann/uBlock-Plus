/*******************************************************************************

    uBlock Plus+ - backup/restore orchestration lifecycle regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';

const defaults = {
    autoReload: true, developerMode: false, showBlockedCount: true,
    strictBlockMode: true, popupBlockMode: true, rulesets: [ 'stock' ],
    filteringModes: { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] },
};
function area() {
    const values = new Map();
    return {
        values,
        async get(keys) {
            const names = keys === null ? [ ...values.keys() ]
                : Array.isArray(keys) ? keys : [ keys ];
            return Object.fromEntries(names.filter(key => values.has(key))
                .map(key => [ key, structuredClone(values.get(key)) ]));
        },
        async set(entries) {
            for ( const [ key, value ] of Object.entries(entries) ) {
                values.set(key, structuredClone(value));
            }
        },
        async remove(keys) {
            for ( const key of Array.isArray(keys) ? keys : [ keys ] ) { values.delete(key); }
        },
        async getKeys() { return [ ...values.keys() ]; },
    };
}
const local = area();
const session = area();
let modes;
let filters;
let rulesets;
let config;
let userDNRError = false;
let loseDNRResponse = false;
let dynamicRules = [];
let sessionRules = [];
const messages = [];
let currentConfig;
const replaceRules = (previous, details) => previous.filter(rule =>
    (details.removeRuleIds || []).includes(rule.id) === false
).concat(structuredClone(details.addRules || []));
const selectRules = (rules, options) => structuredClone(options?.ruleIds
    ? rules.filter(rule => options.ruleIds.includes(rule.id)) : rules);

async function dispatch(request) {
    messages.push(structuredClone(request));
    switch ( request.what ) {
    case 'getDefaultConfig': return structuredClone(defaults);
    case 'getSandboxFilters': return filters.getSandboxFilters();
    case 'getMemoryProfile': return { selected: 'auto' };
    case 'getPopupPolicies': return { policies: local.values.get('popupPolicies') || {} };
    case 'getFilteringModeDetails': return modes.getFilteringModeDetails(true);
    case 'getFilteringModeRestoreLevels': return modes.getFilteringModeRestoreLevels();
    case 'getAllCustomFilters': return filters.getAllCustomFilters();
    case 'setFilteringModeDetails':
        return modes.setFilteringModeDetails(request.modes, request.restoreLevels);
    case 'removeAllCustomFilters': return filters.removeAllCustomFilters(request.hostname);
    case 'addManyCustomFilters':
        return Promise.all(request.entries.map(([ hostname, selectors ]) =>
            filters.addCustomFilters(hostname, selectors)));
    case 'setSandboxFilters': return filters.setSandboxFilters(request.text);
    case 'updateUserDnrRules': {
        const result = await rulesets.updateUserRules();
        if ( loseDNRResponse ) { throw new Error('mock lost DNR response'); }
        return result;
    }
    case 'restoreImportedLists':
        local.values.set('rulesets.imported', request.lists.map(list => ({
            ...list, id: list.url, enabled: request.enabledRulesets.includes(list.url),
        })));
        currentConfig.enabledRulesets = request.enabledRulesets.slice();
        return true;
    case 'replacePopupPolicies':
        local.values.set('popupPolicies', structuredClone(request.policies));
        return;
    case 'setMemoryProfile': local.values.set('memoryProfile', request.profile); return;
    default: {
        const setting = request.what.slice(3);
        const key = setting.charAt(0).toLowerCase() + setting.slice(1);
        assert.ok(Object.hasOwn(defaults, key), `Unexpected message ${request.what}`);
        currentConfig[key] = request.state;
        config.rulesetConfig[key] = request.state;
    }
    }
}

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.chrome = {
    declarativeNetRequest: {
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        async getDynamicRules(options) { return selectRules(dynamicRules, options); },
        async getSessionRules(options) { return selectRules(sessionRules, options); },
        async updateDynamicRules(details) {
            if ( userDNRError && (details.addRules || []).some(rule => rule.id >= 9000000) ) {
                throw new Error('mock restored DNR rejection');
            }
            dynamicRules = replaceRules(dynamicRules, details);
        },
        async updateSessionRules(details) { sessionRules = replaceRules(sessionRules, details); },
        async isRegexSupported() { return { isSupported: true }; },
    },
    i18n: { getMessage() { return ''; } },
    permissions: { async getAll() { return { origins: [ '<all_urls>' ] }; } },
    runtime: {
        getManifest() { return { version: '1.0.0', permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
        sendMessage: dispatch,
    },
    storage: { local, session, managed: area() },
    tabs: { TAB_ID_NONE: -1 },
};
config = await import('../platform/mv3/extension/js/config.js');
rulesets = await import('../platform/mv3/extension/js/ruleset-manager.js');
const { backupToObject, restoreFromObject } = await import('../platform/mv3/extension/js/backup-restore.js');
let sequence = 0;
async function freshProfile() {
    local.values.clear(); session.values.clear();
    messages.length = 0;
    dynamicRules = []; sessionRules = []; userDNRError = false;
    loseDNRResponse = false;
    currentConfig = { ...defaults, enabledRulesets: [ 'stock' ] };
    Object.assign(config.rulesetConfig, currentConfig);
    sequence += 1;
    modes = await import(`../platform/mv3/extension/js/mode-manager.js?backup=${sequence}`);
    filters = await import(`../platform/mv3/extension/js/filter-manager.js?backup=${sequence}`);
}
const failures = [];
async function check(name, task) {
    try { await task(); console.log(`PASS ${name}`); }
    catch ( error ) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

let powerBackup;
await freshProfile();
await modes.setFilteringMode('saved.example', 3);
await modes.setFilteringMode('saved.example', 0);
powerBackup = await backupToObject(currentConfig);

await check('backup restores power level identically in a fresh profile', async ( ) => {
    await freshProfile();
    await restoreFromObject(powerBackup);
    assert.equal(await modes.getFilteringMode('saved.example'), 0);
    assert.equal(await modes.getFilteringModeRestoreLevel('saved.example'), 3);
});

await check('backup replaces stale metadata in an existing profile', async ( ) => {
    await freshProfile();
    await modes.setFilteringMode('saved.example', 1);
    await modes.setFilteringMode('saved.example', 0);
    await restoreFromObject(powerBackup);
    assert.equal(await modes.getFilteringModeRestoreLevel('saved.example'), 3);
});

await check('reset clears prior restore levels and keeps unrelated storage', async ( ) => {
    await freshProfile();
    await modes.setFilteringMode('saved.example', 3);
    await modes.setFilteringMode('saved.example', 0);
    local.values.set('unrelated.extension.state', { preserved: true });
    await restoreFromObject({});
    assert.deepEqual(local.values.get('filteringModeRestoreLevels') || {}, {});
    assert.equal(await modes.getFilteringMode('saved.example'), 2);
    assert.deepEqual(local.values.get('unrelated.extension.state'), { preserved: true });
});

await check('malformed hostname/default scopes reject before any mutation', async ( ) => {
    for ( const invalid of [
        { ...defaults.filteringModes, none: [ '*.example.com' ] },
        { ...defaults.filteringModes, none: [ 'https://example.com/path' ] },
        { ...defaults.filteringModes, none: [ '' ] },
        { ...defaults.filteringModes, none: [ 'all-urls' ] },
        { none: [], basic: [], optimal: [], complete: [] },
        { ...defaults.filteringModes, none: [ 'example.com' ], basic: [ 'example.com' ] },
    ] ) {
        await freshProfile();
        await assert.rejects(restoreFromObject({ filteringModes: invalid }), /filteringMode|hostname|default/i);
        assert.deepEqual(messages, []);
        assert.equal(local.values.size, 0);
    }
});

await check('invalid power-restore metadata rejects before mutation', async ( ) => {
    for ( const restoreLevels of [
        [], { 'example.com': 0 }, { 'example.com': 4 },
        { '*.example.com': 3 }, { 'https://example.com': 2 },
    ] ) {
        await freshProfile();
        await assert.rejects(restoreFromObject({ filteringModeRestoreLevels: restoreLevels }));
        assert.deepEqual(messages, []);
        assert.equal(local.values.size, 0);
    }
});

await check('valid IP and international hostnames survive backup normalization', async ( ) => {
    await freshProfile();
    await restoreFromObject({ filteringModes: {
        ...defaults.filteringModes,
        none: [ '127.0.0.1', '[::1]', 'BÜCHER.example' ],
    } });
    assert.deepEqual((await modes.getFilteringModeDetails(true)).none,
        [ '127.0.0.1', '[::1]', 'xn--bcher-kva.example' ]);
});

await check('restore recovers an interrupted mode transaction before replacing it', async ( ) => {
    await freshProfile();
    local.values.set('filteringModeDetails', {
        ...defaults.filteringModes, none: [ 'uncommitted.example' ],
    });
    session.values.set('filteringModeDetails', local.values.get('filteringModeDetails'));
    local.values.set('filteringModeTransaction', {
        version: 1, previousModes: defaults.filteringModes,
        previousRestoreLevels: { 'stale.example': 1 },
    });
    await restoreFromObject(powerBackup);
    assert.equal(await modes.getFilteringMode('uncommitted.example'), 2);
    assert.equal(await modes.getFilteringMode('saved.example'), 0);
    assert.deepEqual(await modes.getFilteringModeRestoreLevels(), { 'saved.example': 3 });
    assert.equal(local.values.has('filteringModeTransaction'), false);
});

await check('restore rejects DNR activation failure and preserves prior rule text', async ( ) => {
    await freshProfile();
    const oldText = 'action:\n  type: block\ncondition:\n  urlFilter: ||old.example^';
    const newText = 'action:\n  type: block\ncondition:\n  urlFilter: ||new.example^';
    local.values.set('userDnrRules', oldText);
    dynamicRules = [ { id: 9000000, action: { type: 'block' }, condition: { urlFilter: '||old.example^' } } ];
    userDNRError = true;
    await assert.rejects(restoreFromObject({
        developerMode: true, dnrRules: newText.split('\n'),
    }), /DNR|restored/);
    assert.equal(local.values.get('userDnrRules'), oldText);
    assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||old.example^'), true);
});

await check('custom restore merges duplicate host entries and replaces previous filters', async ( ) => {
    await freshProfile();
    await filters.addCustomFilters('old.example', [ '.old' ]);
    await restoreFromObject({
        customFilters: [ [ 'new.example', [ '.one' ] ], [ 'new.example', [ '.two' ] ] ],
    });
    assert.deepEqual(await filters.getAllCustomFilters(), [ [ 'new.example', [ '.one', '.two' ] ] ]);
});

await check('lost activation response does not undo text of committed DNR rules', async ( ) => {
    await freshProfile();
    const newText = 'action:\n  type: block\ncondition:\n  urlFilter: ||new.example^';
    local.values.set('userDnrRules', 'old rule text');
    loseDNRResponse = true;
    await assert.rejects(restoreFromObject({
        developerMode: true, dnrRules: newText.split('\n'),
    }), /lost DNR response/);
    assert.equal(local.values.get('userDnrRules'), newText);
    assert.equal(dynamicRules.some(rule => rule.condition.urlFilter === '||new.example^'), true);
});

assert.deepEqual(failures, [], `Backup lifecycle failures: ${failures.join(', ')}`);
console.log('Backup restore lifecycle tests passed.');
