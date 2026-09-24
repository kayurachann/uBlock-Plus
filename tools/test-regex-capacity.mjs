/*******************************************************************************

    uBlock Plus+ - shared regex capacity and the strict-block session plan
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    1. planUserRegexBudget: the regex overflow policy of user-rules updates.
    2. summarizeRegexCapacity: the numbers of Diagnostics > Regex capacity.
    3. The real offscreen compiler stores strict-block redirect templates, and
       the real ruleset manager installs them against a DNR mock which
       enforces Chrome's shared regex quota, unique IDs, the session rule
       limit and the rejection of unknown (`_`) rule properties.

    Every integration case sets up its own state; REGEX_CAPACITY_CASE=<name>
    runs one case (plus the shared compile).

*******************************************************************************/

import {
    STATIC_REGEX_LIMIT,
    planUserRegexBudget,
    summarizeRegexCapacity,
} from '../platform/mv3/extension/js/regex-capacity.js';
import {
    deriveUserStrictBlockRules,
    ownerForRuleId,
} from '../platform/mv3/extension/js/strictblock-rules.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const clone = value => structuredClone(value);
const regexBlock = (regexFilter, priority = 10) => ({
    action: { type: 'block' }, condition: { regexFilter }, priority,
});
const regexAllow = regexFilter => ({
    action: { type: 'allow' }, condition: { regexFilter }, priority: 30,
});

/******************************************************************************/

// 1. Overflow policy: only imported regex rules which are not exceptions are
// dropped, from the end; everything else is fatal as before.
{
    const rules = [
        regexBlock('developer'),
        regexBlock('sandbox'),
        { action: { type: 'block' }, condition: { urlFilter: '||plain.example^' } },
        regexAllow('imported-allow'),
        regexBlock('imported-1'),
        { action: { type: 'redirect', redirect: { extensionPath: '/x.js' } },
            condition: { regexFilter: 'imported-2' } },
        { action: { type: 'allowAllRequests' },
            condition: { regexFilter: 'imported-frame-allow', resourceTypes: [ 'main_frame' ] } },
        { action: { type: 'modifyHeaders', responseHeaders: [] },
            condition: { regexFilter: 'imported-3' } },
        regexBlock('residual'),
    ];
    const owners = [ 'developer', 'sandbox', 'imported', 'imported', 'imported',
        'imported', 'imported', 'imported', 'stock-residual' ];
    const fits = planUserRegexBudget({ rules, owners, retainedRegexCount: 2, maxRegexCount: 10 });
    assert.equal(fits.fatal, false);
    assert.equal(fits.droppedImported, 0);
    assert.equal(fits.rules.length, rules.length);
    assert.deepEqual(fits.counts, { developer: 1, sandbox: 1, imported: 5, stockResidual: 1 });
    assert.equal(fits.required, 10);

    // Two over: the last two droppable imported rules go, in tail order.
    const over = planUserRegexBudget({ rules, owners, retainedRegexCount: 4, maxRegexCount: 10 });
    assert.equal(over.fatal, false);
    assert.equal(over.droppedImported, 2);
    assert.deepEqual(over.rules.map(rule => rule.condition.regexFilter ?? rule.condition.urlFilter), [
        'developer', 'sandbox', '||plain.example^', 'imported-allow', 'imported-1',
        'imported-frame-allow', 'residual',
    ]);
    assert.deepEqual(over.owners, [ 'developer', 'sandbox', 'imported', 'imported',
        'imported', 'imported', 'stock-residual' ]);
    assert.equal(over.required, 10);

    // Far over: every droppable imported rule goes, exceptions, My filters,
    // developer rules and residuals stay, and the plan is fatal.
    const fatal = planUserRegexBudget({ rules, owners, retainedRegexCount: 8, maxRegexCount: 10 });
    assert.equal(fatal.fatal, true);
    assert.equal(fatal.droppedImported, 3);
    assert.equal(fatal.required, 13);
    for ( const kept of [ 'developer', 'sandbox', 'imported-allow', 'imported-frame-allow', 'residual' ] ) {
        assert.ok(fatal.rules.some(rule => rule.condition.regexFilter === kept), kept);
    }

    // No limit reported by the browser: nothing is dropped.
    const unlimited = planUserRegexBudget({ rules, owners, retainedRegexCount: 5000 });
    assert.equal(unlimited.fatal, false);
    assert.equal(unlimited.droppedImported, 0);
}

/******************************************************************************/

// 2. Capacity report numbers.
{
    const stockRulesets = [
        { id: 'a', rules: { regexStatic: 100, regex: 0,
            rejectedReasons: { 'unsupported-regex-memory': 5, 'unsupported-regex-syntax': 1,
                'unsupported-domain': 9 } } },
        { id: 'b', rules: { regexStatic: 74, regex: 0 } },
        { id: 'c', rules: { regexStatic: 300, rejectedReasons: { 'unsupported-regex-memory': 50 } } },
        { id: 'd', rules: { regex: 3 } },
    ];
    const dynamicRules = [
        { id: 5, condition: { regexFilter: 'stock-fallback' } },
        { id: 6, condition: { urlFilter: 'stock-plain' } },
        { id: 6100000, condition: { regexFilter: 'engine-profile' } },
        { id: 9000000, condition: { regexFilter: 'developer' } },
        { id: 9000001, condition: { regexFilter: 'sandbox' } },
        { id: 9000002, condition: { regexFilter: 'imported-1' } },
        { id: 9000003, condition: { regexFilter: 'imported-2' } },
        { id: 9000004, condition: { urlFilter: 'plain' } },
    ];
    const sessionRules = [
        { id: 1, condition: { regexFilter: 'strict-1' } },
        { id: 2, condition: { regexFilter: 'strict-2' } },
        { id: 3, condition: { requestDomains: [ 'strict.example' ] } },
        { id: 7000001, condition: { regexFilter: 'firewall' } },
    ];
    const userRecord = { schemaVersion: 1, developer: 1, sandbox: 1, imported: 2,
        stockResidual: 0, droppedImported: 7 };
    const plan = { schemaVersion: 1, redirectCount: 3, userCandidates: 4,
        counts: { sandbox: 2, imported: 1 },
        dropped: { stockRegexPool: 3, userRegexPool: 1, stockSessionLimit: 2, userSessionLimit: 0 } };
    const staticCheck = { schemaVersion: 1, extensionVersion: '1.2.0', chromeMajor: 153,
        byRuleset: { a: { checked: 100, skipped: 2 }, b: { checked: 74, skipped: 1 } },
        samples: [ { rulesetId: 'a', ruleId: 9, regex: 'x'.repeat(300), reason: 'memoryLimitExceeded' },
            { rulesetId: 'c', ruleId: 1, regex: 'y', reason: 'memoryLimitExceeded' } ],
        checkedAt: 1234 };
    const input = {
        sharedLimit: 1000, dynamicRules, sessionRules, userRecord, plan,
        stockRulesets, enabledRulesetIds: [ 'a', 'b', 'd' ],
        regexDetails: { schemaVersion: 1, verifiedWith: 'Chrome/153.0.8010.53', staticRegexLimit: 1000 },
        staticCheck, extensionVersion: '1.2.0', chromeMajor: 153,
        rulesetsNotEnabled: [ 'c' ], exclusions: { all: false, hosts: [ 'a.example', 'b.example' ] },
    };
    const report = summarizeRegexCapacity(input);
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.static, {
        limit: STATIC_REGEX_LIMIT, packaged: 474, enabled: 174,
        verifiedWith: 'Chrome/153.0.8010.53',
        rejectedAtBuild: 6, rejectedAtBuildReasons: { memory: 5, syntax: 1 },
        skippedByBrowser: 3,
        skippedSamples: [ { rulesetId: 'a', ruleId: 9, regex: `${'x'.repeat(160)}…`,
            reason: 'memoryLimitExceeded' } ],
        checkedAt: 1234,
    });
    assert.deepEqual(report.shared, {
        limit: 1000,
        dynamic: { stockFallback: 1, developer: 1, sandbox: 1, imported: 2,
            stockResidual: 0, user: 4, other: 1,
            byOwner: { stockRegexFallback: 1, engineProfile: 1, user: 4 } },
        session: { strictBlock: 2, other: 1, byOwner: { strictBlock: 2, firewall: 1 } },
        used: 9, free: 991, droppedStrictBlock: 4, droppedImported: 7,
    });
    assert.deepEqual(report.rulesetsNotEnabled, [ 'c' ]);
    assert.deepEqual(report.strictBlock, { redirectCount: 3, userRedirects: 3,
        userCandidates: 4, exclusions: 2, allExcluded: false, droppedSessionLimit: 2 });

    // The per-realm split is only reported for the rules it describes, and a
    // static check only for this package, browser version and every enabled
    // list with static regex.
    const stale = summarizeRegexCapacity({ ...input,
        userRecord: { ...userRecord, imported: 3 },
        staticCheck: { ...staticCheck, chromeMajor: 152 } });
    assert.equal(stale.shared.dynamic.user, 4);
    for ( const realm of [ 'developer', 'sandbox', 'imported', 'stockResidual' ] ) {
        assert.equal(stale.shared.dynamic[realm], null, realm);
    }
    assert.equal(stale.static.skippedByBrowser, null);
    assert.deepEqual(stale.static.skippedSamples, []);
    const partial = summarizeRegexCapacity({ ...input,
        staticCheck: { ...staticCheck, byRuleset: { a: staticCheck.byRuleset.a } } });
    assert.equal(partial.static.skippedByBrowser, null);
    // Old packages and Firefox have no static regex report.
    const legacy = summarizeRegexCapacity({ ...input, regexDetails: undefined,
        stockRulesets: [ { id: 'a', rules: { regex: 211 } } ] });
    assert.equal(legacy.static.verifiedWith, '');
    assert.equal(legacy.static.enabled, 0);
    // Nothing installed: the whole pool is free.
    const empty = summarizeRegexCapacity({ sharedLimit: 1000 });
    assert.equal(empty.shared.free, 1000);
    assert.equal(empty.shared.dynamic.developer, null);
}

/******************************************************************************/

// 3. Integration.

function makeStorageArea(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        async get(keys) {
            const names = keys === null || keys === undefined
                ? Array.from(values.keys())
                : Array.isArray(keys) ? keys : [ keys ];
            return Object.fromEntries(names.filter(key => values.has(key))
                .map(key => [ key, clone(values.get(key)) ]));
        },
        async set(entries) {
            for ( const [ key, value ] of Object.entries(entries) ) {
                values.set(key, clone(value));
            }
        },
        async remove(keys) {
            for ( const key of Array.isArray(keys) ? keys : [ keys ] ) { values.delete(key); }
        },
        async getKeys() { return Array.from(values.keys()); },
        async setAccessLevel() { },
    };
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const local = makeStorageArea();
const session = makeStorageArea();
const events = [];
let dynamicRules = [];
let sessionRules = [];
let enabledRulesets = [ 'stock-a' ];
let grantedOrigins = [ '<all_urls>' ];
let failDynamicOnce = false;
let failStaticOnce = false;
const unsupportedRegexes = new Map();
const disabledStatic = new Map([ [ 'stock-a', [] ], [ 'stock-b', [] ] ]);

const hasPrivateProperty = value => JSON.stringify(value).includes('"_');
const regexCount = rules => rules.filter(rule => rule.condition?.regexFilter).length;
function applyUpdate(current, other, { removeRuleIds = [], addRules = [] }, namespace) {
    for ( const rule of addRules ) {
        if ( Number.isSafeInteger(rule.id) === false || rule.id < 1 ) {
            throw new Error(`Rule with id ${rule.id} is invalid`);
        }
        if ( hasPrivateProperty(rule) ) {
            throw new Error(`Rule with id ${rule.id}: unexpected property`);
        }
    }
    const removed = new Set(removeRuleIds);
    const next = current.filter(rule => removed.has(rule.id) === false).concat(clone(addRules));
    if ( new Set(next.map(rule => rule.id)).size !== next.length ) {
        throw new Error(`${namespace}: rule IDs must be unique`);
    }
    if ( regexCount(next) + regexCount(other) > dnr.MAX_NUMBER_OF_REGEX_RULES ) {
        throw new Error('shared regex quota exceeded');
    }
    if ( namespace === 'session' && next.length > dnr.MAX_NUMBER_OF_SESSION_RULES ) {
        throw new Error('session rule quota exceeded');
    }
    return next;
}

const dnr = {
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_SESSION_RULES: 5000,
    SESSION_RULESET_ID: '_session',
    RuleConditionKeys: { TOP_DOMAINS: true },
    async getDynamicRules() { return clone(dynamicRules); },
    async getSessionRules() { return clone(sessionRules); },
    async getEnabledRulesets() { return enabledRulesets.slice(); },
    async getAvailableStaticRuleCount() { return 1000; },
    async isRegexSupported({ regex }) {
        const reason = unsupportedRegexes.get(regex);
        return reason ? { isSupported: false, reason } : { isSupported: true };
    },
    async updateDynamicRules(details) {
        events.push('dynamic');
        if ( failDynamicOnce ) {
            failDynamicOnce = false;
            throw new Error('Injected dynamic failure');
        }
        dynamicRules = applyUpdate(dynamicRules, sessionRules, details, 'dynamic');
    },
    async updateSessionRules(details) {
        events.push('session');
        sessionRules = applyUpdate(sessionRules, dynamicRules, details, 'session');
    },
    async updateEnabledRulesets() { },
    async getDisabledRuleIds({ rulesetId }) { return (disabledStatic.get(rulesetId) ?? []).slice(); },
    async updateStaticRules({ rulesetId, disableRuleIds = [], enableRuleIds = [] }) {
        events.push('static');
        if ( failStaticOnce ) {
            failStaticOnce = false;
            throw new Error('Injected static failure');
        }
        const ids = new Set(disabledStatic.get(rulesetId));
        enableRuleIds.forEach(id => ids.delete(id));
        disableRuleIds.forEach(id => ids.add(id));
        disabledStatic.set(rulesetId, Array.from(ids));
    },
};

const stockStrictBlock = [
    { id: 1, priority: 29, action: { type: 'redirect', redirect: { extensionPath: '/strictblock.html' } },
        condition: { requestDomains: [ 'stock-bad.example' ], resourceTypes: [ 'main_frame' ] } },
    { id: 2, priority: 29, action: { type: 'redirect', redirect: { extensionPath: '/strictblock.html' } },
        condition: { regexFilter: '^https?://stock-regex\\.example/', resourceTypes: [ 'main_frame' ] } },
];
const stockMain = [
    { id: 1, priority: 10, action: { type: 'block' }, condition: { urlFilter: '||plain.example^' } },
    { id: 2, priority: 10, action: { type: 'block' }, condition: { regexFilter: '^https://static-ok\\.example/' } },
    { id: 3, priority: 10, action: { type: 'block' }, condition: { regexFilter: '^https://static-skipped\\.example/' } },
];
const digestA = sha256('stock-a');
const digestB = sha256('stock-b');
const manifest = {
    version: '1.2.0',
    declarative_net_request: { rule_resources: [
        { id: 'stock-a', enabled: true, path: '/rulesets/main/stock-a.json' },
        { id: 'stock-b', enabled: false, path: '/rulesets/main/stock-b.json' },
    ] },
};
const packaged = new Map([
    [ '/rulesets/ruleset-details.json', [
        { id: 'stock-a', name: 'Stock A', enabled: true, rules: { total: 3, plain: 1,
            regexStatic: 2, regex: 0, strictblock: 2,
            rejectedReasons: { 'unsupported-regex-memory': 3 } } },
        { id: 'stock-b', name: 'Stock B', enabled: false, rules: { total: 1, plain: 0,
            regexStatic: 1, regex: 0 } },
    ] ],
    [ '/rulesets/strictblock/stock-a.json', stockStrictBlock ],
    [ '/rulesets/main/stock-a.json', stockMain ],
    [ '/rulesets/regex-details.json', { schemaVersion: 1, verifiedWith: 'Chrome/153.0.8010.53',
        staticRegexLimit: 1000, staticRegexCount: 3, digest: 'd'.repeat(64) } ],
    [ '/rulesets/badfilter-details.json', { schemaVersion: 1, rulesets: {
        'stock-a': { badfilterKeys: [], digest: digestA },
        'stock-b': { badfilterKeys: [], digest: digestB },
    } } ],
    [ '/rulesets/badfilter/stock-a.json', { schemaVersion: 1, digest: digestA, deferredKeys: [],
        badfilterKeys: [], rules: [ { id: 1, keys: [ sha256('stock-a-filter') ], complete: true } ] } ],
]);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-regex-capacity-'));
const originalFetch = globalThis.fetch;
let compileRequest;
let importedListText = '';
const importedListURL = 'https://lists.invalid/imported.txt';
let sandboxText = '';
let handleCompilerStorage;
let compileResult;

globalThis.self = globalThis;
globalThis.location = { href: 'chrome-extension://test/js/offscreen/compile-filters.html' };
globalThis.chrome = {
    alarms: { async clear() { }, async create() { } },
    declarativeNetRequest: dnr,
    i18n: { getMessage() { return ''; }, getUILanguage() { return 'en'; } },
    permissions: { async getAll() { return { origins: grantedOrigins.slice() }; } },
    runtime: {
        id: 'test',
        getManifest() { return clone(manifest); },
        getURL(value = '') { return `chrome-extension://test/${value.replace(/^\//, '')}`; },
        async sendMessage(request) {
            switch ( request.what ) {
            case 'compileFilters:getResourceTypes':
                return [ 'main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest', 'other' ];
            case 'compileFilters:getMemoryProfile':
                return { importCompileConcurrency: 1 };
            case 'compileFilters:getUserList':
                return sandboxText;
            case 'compileFilters:getEnabledImportedLists':
                return importedListText ? [ { id: importedListURL, enabled: true } ] : [];
            case 'compileFilters:getEnabledStockRulesets':
                return [];
            case 'compileFilters:storage':
                try {
                    return clone(await handleCompilerStorage(clone(request)));
                } catch ( reason ) {
                    return { ok: false, error: reason.message };
                }
            case 'compileFilters:result':
                compileResult.resolve(request);
                break;
            default:
                break;
            }
        },
    },
    storage: { local, session, managed: makeStorageArea() },
    tabs: { TAB_ID_NONE: -1 },
};
globalThis.fetch = async (url, options) => {
    const href = `${url}`;
    if ( href === importedListURL ) {
        assert.equal(options?.credentials, 'omit');
        const response = new Response(importedListText);
        Object.defineProperty(response, 'url', { value: href });
        return response;
    }
    if ( packaged.has(href) ) {
        return new Response(JSON.stringify(packaged.get(href)));
    }
    if ( href.startsWith('/rulesets/') ) {
        return new Response('', { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${href}`);
};

try {
    // The package layout: extension js/ plus the classic modules the
    // compiler imports (same assembly as test-offscreen-storage.mjs).
    await fs.cp(path.join(root, 'platform/mv3/extension/js'),
        path.join(temporaryRoot, 'js'), { recursive: true });
    await fs.mkdir(path.join(temporaryRoot, 'lib'), { recursive: true });
    await fs.writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}\n');
    await Promise.all([
        ...[ 'arglist-parser', 'jsonpath', 'redirect-resources',
            'static-filtering-parser', 'urlskip' ].map(name => fs.copyFile(
            path.join(root, `src/js/${name}.js`),
            path.join(temporaryRoot, `js/${name}.js`)
            )),
        fs.copyFile(path.join(root, 'src/js/regex-analyzer.js'),
            path.join(temporaryRoot, 'js/offscreen/regex-analyzer.js')),
        fs.copyFile(path.join(root, 'src/lib/punycode.js'),
            path.join(temporaryRoot, 'js/punycode.js')),
        fs.cp(path.join(root, 'src/js/resources'),
            path.join(temporaryRoot, 'js/resources'), { recursive: true }),
        fs.cp(path.join(root, 'src/lib/csstree'),
            path.join(temporaryRoot, 'lib/csstree'), { recursive: true }),
        fs.copyFile(path.join(root,
            'platform/mv3/extension/lib/s14e-serializer/s14e-serializer.js'),
        path.join(temporaryRoot, 'lib/s14e-serializer.js')),
    ]);
    const jsURL = name => pathToFileURL(path.join(temporaryRoot, 'js', name));
    const { createCompilerStorageHandler } = await import(jsURL('offscreen-storage.js'));
    const { rulesetConfig } = await import(jsURL('config.js'));
    const manager = await import(jsURL('ruleset-manager.js'));

    // Compile My filters and one imported list with the real offscreen
    // compiler into a generation, as the service worker would.
    let compileSequence = 0;
    const compile = async generation => {
        const lists = importedListText ? [ { id: importedListURL, enabled: true } ] : [];
        handleCompilerStorage = createCompilerStorageHandler({
            generation, lists, storage: local, isCurrent: ( ) => true,
        });
        globalThis.location = { href:
            `chrome-extension://test/js/offscreen/compile-filters.html?generation=${generation}` };
        compileResult = Promise.withResolvers();
        const entry = jsURL('offscreen/compile-filters.js');
        entry.searchParams.set('run', `${++compileSequence}`);
        const timer = setTimeout(( ) => compileResult.reject(new Error('compiler timeout')), 10000);
        try {
            await import(entry);
            compileRequest = await compileResult.promise;
        } finally {
            clearTimeout(timer);
        }
        assert.equal(compileRequest.persisted, true, JSON.stringify(compileRequest.errors));
    };
    const compiledKey = (generation, key) => `compiledFilters.g.${generation}.${key}`;
    const compiledGeneration = 'a'.repeat(32);
    sandboxText = [
        '||evil.example^$document',
        '||evil-important.example^$doc,important',
        '@@||good.example^$document',
        '||scoped.example^$doc,domain=a.example',
        '||hostonly.example^',
        '/^https?:\\/\\/regexdoc\\.example\\/[a-z]+/$doc',
    ].join('\n');
    importedListText = [ '! Title: Imported fixture', '||imported-evil.example^$doc' ].join('\n');
    await compile(compiledGeneration);

    // Hand-made generations use the same derivation as the compiler.
    const storeGeneration = (generation, realms) => {
        for ( const realm of [ 'sandbox', 'imported' ] ) {
            const rules = realms[realm] ?? [];
            local.values.set(compiledKey(generation, `${realm}Filters.dnrRules`), clone(rules));
            const templates = deriveUserStrictBlockRules(rules);
            if ( templates.length ) {
                local.values.set(compiledKey(generation, `${realm}Filters.strictBlockRules`), templates);
            } else {
                local.values.delete(compiledKey(generation, `${realm}Filters.strictBlockRules`));
            }
            local.values.set(compiledKey(generation, `${realm}Filters.badfilterKeys`),
                clone(realms[`${realm}BadfilterKeys`] ?? []));
        }
    };
    const docBlock = (host, priority = 10) => ({ action: { type: 'block' },
        condition: { requestDomains: [ host ], resourceTypes: [ 'main_frame' ] }, priority });

    const planRecord = ( ) => session.values.get('strictBlock.plan');
    const ownedSession = ( ) => sessionRules.filter(rule => rule.id >= 1 && rule.id < 1000000);
    const redirects = ( ) => ownedSession().filter(rule => rule.action.type === 'redirect');
    const redirectFor = host => redirects().find(rule =>
        JSON.stringify(rule.condition).includes(host));
    const planNotifications = [];
    let exactUrlSource = true;
    manager.setStrictBlockPlanListener(record => { planNotifications.push(clone(record)); });
    manager.setStrictBlockUrlSourceProvider(( ) => exactUrlSource);
    const firewallRule = { id: 7000000, priority: 1500000, action: { type: 'allow' },
        condition: { requestDomains: [ 'firewall.example' ] } };
    // Another owner's rule shaped like the legacy strict-block allow (29,
    // main_frame, requestDomains): the old shape heuristic claimed it.
    const lookalike = { id: 7000029, priority: 29, action: { type: 'allow' },
        condition: { requestDomains: [ 'lookalike.example' ], resourceTypes: [ 'main_frame' ] } };
    const reset = ( ) => {
        dynamicRules = [];
        sessionRules = [ clone(firewallRule), clone(lookalike) ];
        enabledRulesets = [ 'stock-a' ];
        grantedOrigins = [ '<all_urls>' ];
        exactUrlSource = true;
        failDynamicOnce = failStaticOnce = false;
        dnr.MAX_NUMBER_OF_REGEX_RULES = 1000;
        unsupportedRegexes.clear();
        disabledStatic.set('stock-a', []);
        rulesetConfig.strictBlockMode = true;
        rulesetConfig.enabledRulesets = [ 'stock-a', 'stock-b' ];
        local.values.delete('excludedStrictBlockHostnames');
        session.values.delete('excludedStrictBlockHostnames');
        session.values.delete('strictBlock.plan');
        local.values.delete('regexCapacity.user');
        local.values.delete('regexCapacity.staticCheck');
        planNotifications.length = 0;
        events.length = 0;
    };
    const install = async generation => {
        const result = await manager.updateUserRules(generation);
        assert.equal(result.fatalError, '', JSON.stringify(result.errors));
        assert.equal(result.regexUsage, undefined, 'internal fields do not leak');
        assert.equal(result.dynamicRegexCount, undefined);
        return result;
    };

    const cases = [];
    const test = (name, fn) => cases.push([ name, fn ]);

    test('compiler-templates', async ( ) => {
        // Only explicit document blocks without narrowing conditions get a
        // template; exceptions, $doc,domain= and hostname-only filters do not.
        const dnrRules = local.values.get(compiledKey(compiledGeneration, 'sandboxFilters.dnrRules'));
        const templates = local.values.get(compiledKey(compiledGeneration, 'sandboxFilters.strictBlockRules'));
        assert.ok(Array.isArray(templates), 'the compiler stores sandbox strict-block templates');
        const text = JSON.stringify(templates);
        for ( const host of [ 'evil.example', 'evil-important', 'regexdoc' ] ) {
            assert.ok(text.includes(host), host);
        }
        for ( const host of [ 'good.example', 'scoped.example', 'hostonly.example' ] ) {
            assert.equal(text.includes(host), false, host);
        }
        assert.equal(templates.length, 3);
        assert.equal(hasPrivateProperty(templates), false);
        for ( const template of templates ) {
            assert.deepEqual(template.action, { type: 'redirect',
                redirect: { extensionPath: '/strictblock.html' } });
            assert.deepEqual(template.condition.resourceTypes, [ 'main_frame' ]);
            const source = dnrRules[template.id - 1];
            assert.equal(source.action.type, 'block', 'the template points at its block');
            assert.equal(template.priority, source.priority);
        }
        const important = templates.find(t => JSON.stringify(t).includes('evil-important'));
        const plain = templates.find(t => JSON.stringify(t.condition).includes('"evil.example'));
        assert.ok(important.priority > plain.priority, '$important keeps its higher tier');
        const imported = local.values.get(compiledKey(compiledGeneration, 'importedFilters.strictBlockRules'));
        assert.equal(imported.length, 1);
        assert.ok(JSON.stringify(imported).includes('imported-evil.example'));
        // A realm without document blocks stores no key.
        sandboxText = '||nodoc.example^$image';
        importedListText = '';
        const plainGeneration = 'b'.repeat(32);
        await compile(plainGeneration);
        assert.equal(local.values.has(compiledKey(plainGeneration, 'sandboxFilters.strictBlockRules')), false);
        assert.equal(local.values.has(compiledKey(plainGeneration, 'importedFilters.strictBlockRules')), false);
    });

    test('user-redirects', async ( ) => {
        const result = await install(compiledGeneration);
        assert.deepEqual(result.errors, []);
        const sandboxRules = local.values.get(compiledKey(compiledGeneration, 'sandboxFilters.dnrRules'));
        // The dynamic block stays the fallback, at its own priority.
        const block = dynamicRules.find(rule => rule.action.type === 'block' &&
            JSON.stringify(rule.condition).includes('"evil.example'));
        assert.equal(block.priority, 1000010);
        const redirect = redirectFor('"evil.example');
        assert.equal(redirect.priority, 1000011, 'My filters redirect at P+1');
        assert.deepEqual(redirect.action, { type: 'redirect',
            redirect: { extensionPath: '/strictblock.html' } });
        assert.deepEqual(redirect.condition.resourceTypes, [ 'main_frame' ]);
        assert.equal(redirectFor('evil-important').priority, 1000041);
        assert.equal(redirectFor('imported-evil').priority, 11, 'imported redirect at P+1');
        const regexRedirect = redirectFor('regexdoc');
        assert.equal(typeof regexRedirect.condition.regexFilter, 'string');
        // Stock strict-block rules are plain extensionPath redirects at 29.
        assert.equal(redirectFor('stock-bad.example').priority, 29);
        assert.equal(redirectFor('stock-regex').priority, 29);
        assert.equal(redirects().length, 6);
        assert.equal(ownedSession().some(rule => rule.action.type === 'allow'), false,
            'no exclusion allow without exclusions');
        assert.equal(hasPrivateProperty(sessionRules), false);
        // Other owners' session rules are untouched.
        assert.ok(sessionRules.some(rule => rule.id === firewallRule.id));
        assert.ok(sessionRules.some(rule => rule.id === lookalike.id));
        // The plan record resolves every redirect to its owner and source.
        const plan = planRecord();
        assert.equal(plan.schemaVersion, 1);
        assert.equal(plan.generation, compiledGeneration);
        assert.equal(plan.redirectCount, 6);
        assert.equal(plan.userCandidates, 4);
        assert.equal(plan.exactUrlSource, true);
        const owner = ownerForRuleId(plan.owners, redirect.id);
        assert.equal(owner.kind, 'sandbox');
        assert.equal(JSON.stringify(sandboxRules[owner.source - 1].condition)
            .includes('"evil.example'), true);
        assert.deepEqual(ownerForRuleId(plan.owners, redirectFor('imported-evil').id).kind, 'imported');
        assert.deepEqual(ownerForRuleId(plan.owners, redirectFor('stock-bad').id),
            { kind: 'stock', rulesetId: 'stock-a', source: 1 });
        assert.equal(planNotifications.at(-1).redirectCount, 6);
        // Regex usage of the installed user rules, per realm.
        const usage = local.values.get('regexCapacity.user');
        assert.equal(usage.generation, compiledGeneration);
        assert.equal(usage.sandbox, 1);
        assert.equal(usage.imported, 0);
        assert.equal(usage.droppedImported, 0);
        // An identical rebuild leaves the installed rules alone.
        events.length = 0;
        await manager.updateSessionRules();
        assert.deepEqual(events, []);
    });

    test('exclusions', async ( ) => {
        await install(compiledGeneration);
        await manager.excludeFromStrictBlock('evil.example', true);
        await manager.excludeFromStrictBlock('stock-bad.example', false);
        const excluded = [ 'evil.example', 'stock-bad.example' ];
        for ( const rule of redirects() ) {
            assert.deepEqual(rule.condition.excludedRequestDomains, excluded,
                'every redirect carves out the excluded hosts');
        }
        // One allow per user base priority defeats the dynamic fallback block
        // there; the stock allow at 29 unblocks non-candidate stock blocks.
        const allows = ownedSession().filter(rule => rule.action.type === 'allow');
        assert.deepEqual(allows.map(rule => rule.priority).sort((a, b) => a - b),
            [ 10, 29, 1000010, 1000040 ]);
        for ( const allow of allows ) {
            assert.deepEqual(allow.condition, { requestDomains: excluded,
                resourceTypes: [ 'main_frame' ] });
        }
        assert.equal(await manager.isStrictBlockExcluded('sub.evil.example'), true);
        assert.equal(await manager.isStrictBlockExcluded('evil.example.org'), false);
        assert.deepEqual(await manager.getStrictBlockExclusions(),
            { all: false, hosts: excluded, layers: [] });
        // A provider which excludes everything removes every redirect.
        manager.setStrictBlockExclusionProvider(( ) => ({ all: true }));
        await manager.updateSessionRules();
        assert.equal(ownedSession().length, 0);
        manager.setStrictBlockExclusionProvider();
        await manager.updateSessionRules();
        assert.equal(redirects().length, 6);
    });

    test('no-omnipotence', async ( ) => {
        await install(compiledGeneration);
        await manager.excludeFromStrictBlock('evil.example', true);
        await manager.excludeFromStrictBlock('temporary.example', false);
        grantedOrigins = [ 'https://one.example/*' ];
        await manager.updateSessionRules();
        // A redirect lacking host access would shadow its block: none remain,
        // the dynamic fallback blocks do, and the "don't warn" choices survive.
        assert.equal(ownedSession().length, 0);
        assert.ok(dynamicRules.some(rule => JSON.stringify(rule.condition).includes('"evil.example')));
        assert.deepEqual(local.values.get('excludedStrictBlockHostnames'), [ 'evil.example' ]);
        assert.deepEqual(session.values.get('excludedStrictBlockHostnames'), [ 'temporary.example' ]);
        assert.equal(planRecord().redirectCount, 0);
        // A worker start with access regained rebuilds the plan.
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, false);
        grantedOrigins = [ '<all_urls>' ];
        const regained = await manager.reconcileStrictBlockSessionRules();
        assert.equal(regained.rebuilt, true);
        assert.equal(redirects().length, 6);
        assert.equal(regained.plan.redirectCount, 6);
        // Access lost while the worker slept: the next start removes them.
        grantedOrigins = [];
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, true);
        assert.equal(ownedSession().length, 0);
        // A lost plan record with installed rules is rebuilt as well.
        grantedOrigins = [ '<all_urls>' ];
        await manager.updateSessionRules();
        session.values.delete('strictBlock.plan');
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, true);
        assert.equal(planRecord().redirectCount, 6);
    });

    test('strict-mode-off', async ( ) => {
        await install(compiledGeneration);
        await manager.excludeFromStrictBlock('evil.example', true);
        await manager.setStrictBlockMode(false);
        assert.equal(ownedSession().length, 0);
        assert.deepEqual(local.values.get('excludedStrictBlockHostnames'), [ 'evil.example' ],
            'turning strict blocking off keeps the "don\'t warn" choices');
        assert.equal(planNotifications.at(-1).redirectCount, 0);
        await manager.setStrictBlockMode(true);
        assert.equal(redirects().length, 6);
        assert.deepEqual(redirectFor('stock-bad').condition.excludedRequestDomains, [ 'evil.example' ]);
        // Turned off, then the worker stopped before the rebuild: the next
        // start removes the redirects.
        rulesetConfig.strictBlockMode = false;
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, true);
        assert.equal(ownedSession().length, 0);
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, false);
        // Turned back on, the setting saved, and the worker stopped before
        // the rebuild: the next start (also a wake) installs the redirects.
        rulesetConfig.strictBlockMode = true;
        const restored = await manager.reconcileStrictBlockSessionRules();
        assert.equal(restored.rebuilt, true);
        assert.equal(redirects().length, 6);
        assert.equal(restored.plan.configuredMode, true);
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, false);
        // "Exclude everything" keeps the plan inactive with the setting on:
        // that is not stale, and wakes do not rebuild it again and again.
        manager.setStrictBlockExclusionProvider(( ) => ({ all: true }));
        try {
            await manager.updateSessionRules();
            assert.equal(planRecord().strictBlockMode, false);
            assert.equal(planRecord().configuredMode, true);
            assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, false);
        } finally {
            manager.setStrictBlockExclusionProvider();
        }
    });

    test('no-exact-source', async ( ) => {
        exactUrlSource = false;
        await install(compiledGeneration);
        // Without an exact URL source the page could not name the address:
        // user $doc filters stay plain blocks, stock strict blocking stays.
        assert.deepEqual(redirects().map(rule => rule.priority), [ 29, 29 ]);
        assert.equal(planRecord().userCandidates, 4);
        assert.equal(planRecord().exactUrlSource, false);
        exactUrlSource = true;
        assert.equal((await manager.reconcileStrictBlockSessionRules()).rebuilt, true);
        assert.equal(redirects().length, 6);
    });

    test('failed-dynamic-update', async ( ) => {
        await install(compiledGeneration);
        const beforeSession = clone(sessionRules);
        const beforePlan = clone(planRecord());
        const beforeDynamic = clone(dynamicRules);
        storeGeneration('failed', { sandbox: [ docBlock('new.example') ] });
        failDynamicOnce = true;
        const result = await manager.updateUserRules('failed');
        assert.match(result.fatalError, /Injected dynamic failure/);
        assert.deepEqual(dynamicRules, beforeDynamic);
        assert.deepEqual(sessionRules, beforeSession, 'the previous session plan stays installed');
        assert.deepEqual(planRecord(), beforePlan);
        // The next rebuild still follows the installed generation.
        await manager.updateSessionRules();
        assert.equal(redirectFor('new.example'), undefined);
        assert.ok(redirectFor('"evil.example'));
    });

    test('legacy-replaced', async ( ) => {
        await install(compiledGeneration);
        // Session rules of 1.2.x: regexSubstitution redirects with IDs 1..826
        // and the exclusion allow.
        const legacy = Array.from({ length: 826 }, (_, i) => ({
            id: i + 1, priority: 29,
            action: { type: 'redirect', redirect: {
                regexSubstitution: 'chrome-extension://test/strictblock.html#\\0' } },
            condition: { regexFilter: `^https?://legacy-${i}\\.example/`, resourceTypes: [ 'main_frame' ] },
        }));
        sessionRules = [ ...legacy, clone(firewallRule), clone(lookalike) ];
        session.values.delete('strictBlock.plan');
        const result = await manager.updateSessionRules();
        assert.equal(result.error, undefined);
        assert.equal(sessionRules.some(rule => rule.action.redirect?.regexSubstitution), false);
        assert.equal(redirects().length, 6);
        assert.deepEqual(sessionRules.filter(rule => rule.id >= 1000000).map(rule => rule.id).sort(),
            [ firewallRule.id, lookalike.id ], 'other owners keep their rules');
    });

    test('snapshot-ownership', async ( ) => {
        await install(compiledGeneration);
        const plan = clone(planRecord());
        const installed = clone(ownedSession());
        const state = await manager.snapshotNativeRulesetState();
        assert.deepEqual(state.sessionRules.map(rule => rule.id).sort((a, b) => a - b),
            installed.map(rule => rule.id).sort((a, b) => a - b),
            'the snapshot owns session IDs 1..999,999 only, whatever their priority');
        assert.ok(state.sessionRules.some(rule => rule.priority === 1000011));
        assert.equal(state.sessionRules.some(rule => rule.id === lookalike.id), false);
        assert.deepEqual(state.strictBlockPlan, plan);
        // Restore after the plan changed: rules and plan record come back.
        await manager.excludeFromStrictBlock('evil.example', true);
        assert.notDeepEqual(ownedSession(), installed);
        planNotifications.length = 0;
        await manager.restoreNativeRulesetState(state);
        assert.deepEqual(clone(ownedSession()).sort((a, b) => a.id - b.id),
            installed.sort((a, b) => a.id - b.id));
        assert.deepEqual(planRecord(), plan);
        assert.equal(planNotifications.at(-1).redirectCount, plan.redirectCount);
        assert.ok(sessionRules.some(rule => rule.id === lookalike.id));
    });

    test('restore-generation', async ( ) => {
        // A rollback restores the dynamic rules of the generation the caller
        // makes active again: later session plans must read that
        // generation's templates, not those of the generation rolled back.
        const { ACTIVE_COMPILED_GENERATION_KEY } = await import(jsURL('compiled-storage.js'));
        local.values.set(ACTIVE_COMPILED_GENERATION_KEY, compiledGeneration);
        await install(compiledGeneration);
        const state = await manager.snapshotNativeRulesetState();
        storeGeneration('rolled-back', { sandbox: [ docBlock('rolled-back.example') ] });
        await install('rolled-back');
        assert.ok(redirectFor('rolled-back.example'));
        await manager.restoreNativeRulesetState(state);
        try {
            await manager.excludeFromStrictBlock('unrelated.example', false);
            assert.equal(redirectFor('rolled-back.example'), undefined,
                'no redirect from the rolled-back generation');
            assert.ok(redirectFor('"evil.example'), 'redirects of the restored generation');
            assert.equal(planRecord().generation, compiledGeneration);
        } finally {
            local.values.delete(ACTIVE_COMPILED_GENERATION_KEY);
        }
    });

    test('imported-regex-overflow', async ( ) => {
        dnr.MAX_NUMBER_OF_REGEX_RULES = 6;
        dynamicRules = [ { id: 3, action: { type: 'block' }, condition: { regexFilter: 'stock-fallback' } } ];
        const firewallRegex = { id: 7000001, priority: 1500000, action: { type: 'block' },
            condition: { regexFilter: 'firewall-regex' } };
        sessionRules.push(clone(firewallRegex));
        // Retained: stock fallback + firewall regex. Wanted: 1 My filters regex,
        // 1 imported regex exception and 5 imported regex blocks: 9 > 6.
        storeGeneration('overflow', {
            sandbox: [ regexBlock('mine') ],
            imported: [ regexAllow('imported-allow'),
                ...[ 1, 2, 3, 4, 5 ].map(i => regexBlock(`imported-${i}`)) ],
        });
        const result = await install('overflow');
        assert.deepEqual(result.errors, [
            '3 imported regex rule(s) were not installed: the browser\'s 6-rule regex limit is full',
            '1 lower-priority strict-block regex rule(s) could not fit the shared 6-rule pool',
        ]);
        const installed = dynamicRules.map(rule => rule.condition.regexFilter);
        assert.deepEqual(installed, [ 'stock-fallback', 'mine', 'imported-allow', 'imported-1', 'imported-2' ]);
        assert.ok(sessionRules.some(rule => rule.id === firewallRegex.id),
            'another owner\'s session regex is never displaced');
        assert.equal(local.values.get('regexCapacity.user').droppedImported, 3);
        assert.equal(local.values.get('regexCapacity.user').imported, 3);
        // The strict-block regex (stock) no longer fits and is reported.
        assert.equal(redirectFor('stock-regex'), undefined);
        assert.equal(planRecord().dropped.stockRegexPool, 1);
        // Still over after every droppable imported rule: fatal, last-good kept.
        const before = clone(dynamicRules);
        storeGeneration('fatal', { sandbox: [ 1, 2, 3, 4, 5 ].map(i => regexBlock(`mine-${i}`)) });
        const fatal = await manager.updateUserRules('fatal');
        assert.match(fatal.fatalError, /Dynamic regex plan requires 7\/6 rules/);
        assert.deepEqual(dynamicRules, before);
        // Strict-block regex rules make room for a larger user plan; the
        // firewall's do not.
        dnr.MAX_NUMBER_OF_REGEX_RULES = 8;
        storeGeneration('room', { sandbox: [ regexBlock('mine') ] });
        await install('room');
        assert.ok(redirectFor('stock-regex'), 'the plan uses the capacity left');
        storeGeneration('grow', { sandbox: [ 1, 2, 3, 4, 5, 6 ].map(i => regexBlock(`grow-${i}`)) });
        events.length = 0;
        const grown = await install('grow');
        assert.equal(redirectFor('stock-regex'), undefined);
        assert.match(grown.errors.join('\n'),
            /1 lower-priority strict-block regex rule\(s\) could not fit the shared 8-rule pool/);
        assert.ok(sessionRules.some(rule => rule.id === firewallRegex.id));
        assert.equal(events[0], 'session', 'displaced before the dynamic update');
    });

    test('badfilter-ordering', async ( ) => {
        await install(compiledGeneration);
        // A personal $badfilter of a stock filter: static rules are disabled
        // under the stock badfilter journal.
        storeGeneration('badfilter', {
            sandbox: [ docBlock('bf-doc.example') ],
            sandboxBadfilterKeys: [ 'stock-a-filter' ],
        });
        events.length = 0;
        await install('badfilter');
        assert.ok(redirectFor('bf-doc.example'));
        const order = [ 'dynamic', 'static', 'session' ].map(event => events.indexOf(event));
        assert.ok(order.every(index => index >= 0), JSON.stringify(events));
        assert.ok(order[0] < order[1] && order[1] < order[2],
            `the session plan follows the committed journal: ${events}`);
        assert.deepEqual(disabledStatic.get('stock-a'), [ 1 ]);
        // A failed static step rolls the whole update back, and the recovery
        // finds the session plan it snapshotted, without ID collisions.
        await install(compiledGeneration);
        assert.deepEqual(disabledStatic.get('stock-a'), []);
        const installedSession = clone(sessionRules);
        failStaticOnce = true;
        const failed = await manager.updateUserRules('badfilter');
        assert.match(failed.fatalError, /Injected static failure/);
        assert.doesNotMatch(failed.fatalError, /recovery pending/);
        assert.deepEqual(clone(sessionRules).sort((a, b) => a.id - b.id),
            installedSession.sort((a, b) => a.id - b.id));
        assert.ok(redirectFor('"evil.example'));
        assert.equal(redirectFor('bf-doc.example'), undefined);
    });

    test('capacity-report', async ( ) => {
        await install(compiledGeneration);
        unsupportedRegexes.set('^https://static-skipped\\.example/', 'memoryLimitExceeded');
        const report = await manager.getRegexCapacity();
        assert.equal(report.static.limit, 1000);
        assert.equal(report.static.packaged, 3);
        assert.equal(report.static.enabled, 2);
        assert.equal(report.static.verifiedWith, 'Chrome/153.0.8010.53');
        assert.equal(report.static.rejectedAtBuild, 3);
        assert.equal(report.static.skippedByBrowser, null, 'not checked yet');
        assert.deepEqual(report.rulesetsNotEnabled, [ 'stock-b' ]);
        const dynamicRegex = regexCount(dynamicRules);
        const sessionRegex = regexCount(sessionRules);
        assert.equal(report.shared.used, dynamicRegex + sessionRegex);
        assert.equal(report.shared.free, 1000 - dynamicRegex - sessionRegex);
        assert.equal(report.shared.dynamic.sandbox, 1);
        assert.equal(report.shared.session.strictBlock, 2);
        assert.equal(report.strictBlock.redirectCount, 6);
        assert.equal(report.strictBlock.userRedirects, 4);
        const checked = await manager.getRegexCapacity({ verifyStatic: true });
        assert.equal(checked.static.skippedByBrowser, 1);
        assert.deepEqual(checked.static.skippedSamples, [ { rulesetId: 'stock-a', ruleId: 3,
            regex: '^https://static-skipped\\.example/', reason: 'memoryLimitExceeded' } ]);
        assert.equal(local.values.get('regexCapacity.staticCheck').extensionVersion, '1.2.0');
        // Shown later without checking again.
        const later = await manager.getRegexCapacity();
        assert.equal(later.static.skippedByBrowser, 1);
    });

    const only = process.env.REGEX_CAPACITY_CASE;
    for ( const [ name, fn ] of cases ) {
        if ( only && only !== name ) { continue; }
        reset();
        try {
            await fn();
        } catch ( reason ) {
            reason.message = `[${name}] ${reason.message}`;
            throw reason;
        }
    }
} finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Regex capacity: overflow policy, report numbers, compiler templates, session plan, exclusions, host access, recovery and ordering checks passed.');
