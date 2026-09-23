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
const managed = area();
let modes;
let filters;
let rulesets;
let config;
let userDNRError = false;
let loseDNRResponse = false;
let firewallSupported = true;
let disabledFeatures = [];
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
    // Like firewall-manager.js: without top-domain conditions any rule throws.
    case 'getFirewallState': return { supported: firewallSupported };
    case 'previewFirewallRules':
    case 'applyFirewallRules':
        if ( firewallSupported === false && request.text !== '' ) {
            throw new Error('Dynamic firewall requires Chrome 145+ top-domain conditions');
        }
        if ( request.what === 'previewFirewallRules' ) { return { ruleCount: 0 }; }
        local.values.set('firewall.permanent', request.text);
        return { sessionText: request.text };
    case 'getDefaultConfig': return structuredClone(defaults);
    case 'getOptionsPageData': return { disabledFeatures: disabledFeatures.slice() };
    case 'getSandboxFilters': return filters.getSandboxFilters();
    case 'getMemoryProfile': return { selected: 'auto' };
    case 'getPopupPolicies': return { policies: local.values.get('popupPolicies') || {} };
    case 'getFilteringModeDetails': return modes.getFilteringModeDetails(true);
    case 'getFilteringModeRestoreLevels': return modes.getFilteringModeRestoreLevels();
    case 'getAllCustomFilters': return filters.getAllCustomFilters();
    case 'setFilteringModeDetails':
        // Like background.js assertFeatureAllowed().
        if ( disabledFeatures.includes('filteringMode') ) {
            throw new Error('The administrator disabled "filteringMode"');
        }
        return modes.setFilteringModeDetails(request.modes, request.restoreLevels);
    case 'setDeveloperMode': {
        // The worker keeps developer mode off under the develop lock.
        const state = request.state === true && disabledFeatures.includes('develop') === false;
        currentConfig.developerMode = config.rulesetConfig.developerMode = state;
        return state;
    }
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
        async getEnabledRulesets() { return []; },
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
    storage: { local, session, managed },
    tabs: { TAB_ID_NONE: -1 },
};
config = await import('../platform/mv3/extension/js/config.js');
rulesets = await import('../platform/mv3/extension/js/ruleset-manager.js');
const { backupToObject, restoreFromObject } = await import('../platform/mv3/extension/js/backup-restore.js');
let sequence = 0;
async function freshProfile() {
    local.values.clear(); session.values.clear(); managed.values.clear();
    messages.length = 0;
    dynamicRules = []; sessionRules = []; userDNRError = false;
    loseDNRResponse = false; firewallSupported = true; disabledFeatures = [];
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

await check('popup-stored underscore and trailing-dot hostnames round-trip', async ( ) => {
    await freshProfile();
    await modes.setFilteringMode('my_app.intranet.example', 0);
    await modes.setFilteringMode('example.com.', 3);
    const backup = await backupToObject(currentConfig);
    await freshProfile();
    await restoreFromObject(backup);
    assert.equal(await modes.getFilteringMode('my_app.intranet.example'), 0);
    assert.equal(await modes.getFilteringMode('example.com.'), 3);
});

await check('upstream backups keep imported lists recorded only in rulesets', async ( ) => {
    await freshProfile();
    const summary = await restoreFromObject({
        rulesets: [ '+https://filters.example/list.txt', '+http://insecure.example/list.txt' ],
    });
    const request = messages.find(entry => entry.what === 'restoreImportedLists');
    assert.deepEqual(request.lists, [ {
        url: 'https://filters.example/list.txt', enabled: true,
        maxSourceBytes: 5 * 1024 * 1024, maxSourceFetches: 32, requireHTTPSSource: true,
    } ]);
    assert.deepEqual(request.enabledRulesets, [ 'stock', 'https://filters.example/list.txt' ]);
    assert.deepEqual(local.values.get('rulesets.imported').map(list => [ list.id, list.enabled ]),
        [ [ 'https://filters.example/list.txt', true ] ]);
    assert.deepEqual(summary, {
        developerSkipped: false,
        filteringModesSkipped: false,
        firewallRulesSkipped: false,
        importedListsDisabled: [],
        importedListsSkipped: [ 'http://insecure.example/list.txt' ],
    });
});

await check('invalid active developer DNR rules reject before any mutation', async ( ) => {
    await freshProfile();
    await filters.addCustomFilters('old.example', [ '.old' ]);
    local.values.set('userDnrRules', 'old rule text');
    local.values.set('firewall.permanent', '* old-tracker.example * block');
    const before = structuredClone([ ...local.values ]);
    messages.length = 0;
    await assert.rejects(restoreFromObject({
        developerMode: true,
        customFilters: [ [ 'new.example', [ '.new' ] ] ],
        filteringModes: { ...defaults.filteringModes, none: [ 'trusted.example' ] },
        firewallRules: [ '* new-tracker.example * block' ],
        dnrRules: [ 'action:', '  type: bogus', 'condition:', '  urlFilter: ||x^' ],
    }), /DNR syntax at line\(s\) 2/);
    assert.deepEqual(messages.map(entry => entry.what),
        [ 'getFirewallState', 'previewFirewallRules', 'getDefaultConfig', 'getOptionsPageData' ]);
    assert.deepEqual([ ...local.values ], before);
    // The same draft is inert outside developer mode and restores unchanged.
    await restoreFromObject({ dnrRules: [ 'action:', '  type: bogus' ] });
    assert.equal(local.values.get('userDnrRules'), 'action:\n  type: bogus');
});

await check('a late DNR rejection does not skip the restored firewall rules', async ( ) => {
    await freshProfile();
    userDNRError = true;
    await assert.rejects(restoreFromObject({
        developerMode: true,
        firewallRules: [ '* new-tracker.example * block' ],
        dnrRules: 'action:\n  type: block\ncondition:\n  urlFilter: ||new.example^'.split('\n'),
    }), /DNR/);
    assert.equal(local.values.get('firewall.permanent'), '* new-tracker.example * block');
});

await check('firewall rules on a browser without top-domain conditions do not block restore', async ( ) => {
    await freshProfile();
    firewallSupported = false;
    const summary = await restoreFromObject({
        autoReload: false,
        firewallRules: [ '* tracker.example * block' ],
        customFilters: [ [ 'new.example', [ '.ad' ] ] ],
    });
    assert.equal(summary.firewallRulesSkipped, true);
    assert.equal(currentConfig.autoReload, false);
    assert.deepEqual(await filters.getAllCustomFilters(), [ [ 'new.example', [ '.ad' ] ] ]);
    assert.equal(messages.some(entry => entry.what === 'previewFirewallRules'), false);
    assert.equal(local.values.has('firewall.permanent'), false);
    // Invalid firewall text is still rejected before any mutation.
    await freshProfile();
    firewallSupported = false;
    await assert.rejects(restoreFromObject({ firewallRules: [ 'not a rule' ] }));
    assert.deepEqual(messages, []);
});

// Managed disabledFeatures also bind the worker. A lock must not stop restore
// or reset halfway: the locked part is skipped and reported, the rest applies.
const lockedBackup = {
    autoReload: false,
    developerMode: true,
    filteringModes: { ...defaults.filteringModes, none: [ 'restored.example' ] },
    customFilters: [ [ 'new.example', [ '.ad' ] ] ],
    firewallRules: [ '* tracker.example * block' ],
    dnrRules: 'action:\n  type: block\ncondition:\n  urlFilter: ||new.example^'.split('\n'),
};

await check('restore and reset under the filteringMode lock apply every other part', async ( ) => {
    for ( const target of [ lockedBackup, {} ] ) {
        await freshProfile();
        await modes.setFilteringMode('kept.example', 0);
        await filters.addCustomFilters('old.example', [ '.old' ]);
        local.values.set('userDnrRules', 'old draft');
        disabledFeatures = [ 'filteringMode' ];
        messages.length = 0;
        const summary = await restoreFromObject(target);
        assert.equal(summary.filteringModesSkipped, true);
        assert.equal(summary.developerSkipped, false);
        const sent = messages.map(entry => entry.what);
        assert.equal(sent.includes('setFilteringModeDetails'), false);
        for ( const what of [ 'setDeveloperMode', 'setSandboxFilters', 'applyFirewallRules', 'updateUserDnrRules' ] ) {
            assert.ok(sent.includes(what), `${what} must still be sent`);
        }
        assert.equal(await modes.getFilteringMode('kept.example'), 0);
        assert.equal(await modes.getFilteringMode('restored.example'), 2);
        assert.equal(currentConfig.autoReload, target.autoReload ?? true);
        assert.equal(currentConfig.developerMode, target.developerMode ?? false);
        assert.deepEqual(await filters.getAllCustomFilters(), target.customFilters ?? []);
        assert.equal(local.values.get('firewall.permanent'), target.firewallRules?.join('\n') ?? '');
        assert.equal(local.values.get('userDnrRules'), target.dnrRules?.join('\n'));
    }
});

await check('restore and reset under the develop lock keep developer settings', async ( ) => {
    // Under the lock the draft is never activated, so its syntax is not checked.
    const invalidDraft = { ...lockedBackup, dnrRules: [ 'action:', '  type: bogus' ] };
    for ( const target of [ invalidDraft, {} ] ) {
        await freshProfile();
        await filters.addCustomFilters('old.example', [ '.old' ]);
        local.values.set('userDnrRules', 'old draft');
        disabledFeatures = [ 'develop' ];
        messages.length = 0;
        const summary = await restoreFromObject(target);
        assert.equal(summary.developerSkipped, true);
        assert.equal(summary.filteringModesSkipped, false);
        const sent = messages.map(entry => entry.what);
        assert.equal(sent.includes('setDeveloperMode'), false);
        assert.equal(sent.includes('updateUserDnrRules'), false);
        assert.equal(local.values.get('userDnrRules'), 'old draft');
        assert.equal(currentConfig.developerMode, false);
        assert.equal(await modes.getFilteringMode('restored.example'), target.filteringModes ? 0 : 2);
        assert.deepEqual(await filters.getAllCustomFilters(), target.customFilters ?? []);
        assert.equal(local.values.get('firewall.permanent'), target.firewallRules?.join('\n') ?? '');
    }
    // Nothing differs from the reset: nothing to report.
    await freshProfile();
    disabledFeatures = [ 'develop', 'filteringMode' ];
    const summary = await restoreFromObject({});
    assert.equal(summary.developerSkipped, false);
    assert.equal(summary.filteringModesSkipped, false);
});

await check('the filteringMode lock reports only skipped mode changes', async ( ) => {
    await freshProfile();
    // The administrator's Off scope is part of the effective modes only.
    managed.values.set('noFiltering', [ 'managed.example' ]);
    session.values.set('admin.noFiltering', { data: [ 'managed.example' ] });
    disabledFeatures = [ 'filteringMode' ];
    assert.equal(await modes.getFilteringMode('managed.example'), 0);
    // A reset matches the stored default modes.
    let summary = await restoreFromObject({});
    assert.equal(summary.filteringModesSkipped, false);
    // A backup of the same profile matches its effective modes.
    let backup = await backupToObject(currentConfig);
    assert.deepEqual(backup.filteringModes.none, [ 'managed.example' ]);
    assert.deepEqual(local.values.get('filteringModeDetails').none, []);
    messages.length = 0;
    summary = await restoreFromObject(backup);
    assert.equal(summary.filteringModesSkipped, false);
    assert.equal(messages.some(entry => entry.what === 'setFilteringModeDetails'), false);
    // Restore levels are compared as well.
    await modes.setFilteringMode('saved.example', 3);
    await modes.setFilteringMode('saved.example', 0);
    backup = await backupToObject(currentConfig);
    summary = await restoreFromObject(backup);
    assert.equal(summary.filteringModesSkipped, false);
    summary = await restoreFromObject({
        ...backup, filteringModeRestoreLevels: { 'saved.example': 1 },
    });
    assert.equal(summary.filteringModesSkipped, true);
    assert.equal(await modes.getFilteringModeRestoreLevel('saved.example'), 3);
});

await check('a same-profile backup under the develop lock reports nothing', async ( ) => {
    await freshProfile();
    // The editor keeps blank lines between rules, a backup drops them.
    const draft = 'action:\n  type: block\n\n---\n\naction:\n  type: allow';
    local.values.set('userDnrRules', draft);
    disabledFeatures = [ 'develop' ];
    const backup = await backupToObject(currentConfig);
    const summary = await restoreFromObject(backup);
    assert.equal(summary.developerSkipped, false);
    assert.equal(local.values.get('userDnrRules'), draft);
});

assert.deepEqual(failures, [], `Backup lifecycle failures: ${failures.join(', ')}`);
console.log('Backup restore lifecycle tests passed.');
