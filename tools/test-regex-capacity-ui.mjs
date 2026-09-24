/*******************************************************************************

    uBlock Plus+ - regex rule capacity and strict-block address in the UI
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    Roadmap step 2: the consumers of the worker's getRegexCapacity report
    (schema: platform/mv3/extension/js/regex-capacity.js) and of the
    strictBlockUrlSource capability.

    - Filter lists: a list's rule count includes its static regex rules.
    - Dashboard > Diagnostics: the "Regex rule capacity" panel, "Check now",
      the strict-block address row and the optional webRequest action.
    - Filter Store: the regex estimate uses the real remaining capacity.
    - Troubleshooting information: regex pools and the address source.

*/

import {
    FakeDocument,
    FakeElement,
    createExtension,
    settle,
    stageModules,
} from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const n = value => value.toLocaleString();

// A report as ruleset-manager.js getRegexCapacity() returns it with the
// default lists, two My filters and ten imported regex rules.
function capacityReport(overrides = {}) {
    return {
        schemaVersion: 1,
        static: {
            limit: 1000, packaged: 473, enabled: 174,
            verifiedWith: 'Chrome/153.0.8010.53',
            rejectedAtBuild: 80,
            rejectedAtBuildReasons: { memory: 79, syntax: 1 },
            skippedByBrowser: null, skippedSamples: [], checkedAt: null,
            ...overrides.static,
        },
        shared: {
            limit: 1000,
            dynamic: {
                stockFallback: 0, developer: 0, sandbox: 2, imported: 10,
                stockResidual: 0, user: 12, other: 0, byOwner: { user: 12 },
            },
            session: { strictBlock: 111, other: 0, byOwner: { strictBlock: 111 } },
            used: 123, free: 877, droppedStrictBlock: 0, droppedImported: 3,
            ...overrides.shared,
        },
        rulesetsNotEnabled: overrides.rulesetsNotEnabled ?? [],
        strictBlock: {
            redirectCount: 1106, userRedirects: 0, userCandidates: 0,
            exclusions: 0, allExcluded: false, droppedSessionLimit: 0,
        },
    };
}

const pairs = list => {
    const out = [];
    for ( let i = 0; i < list.children.length; i += 2 ) {
        out.push([ list.children[i].textContent, list.children[i + 1].textContent ]);
    }
    return out;
};

const deferred = ( ) => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

/******************************************************************************/

// Filter lists: "N rules" counts the regex rules packaged in the static
// ruleset (Chromium) as well as the dynamic fallback; imported lists and
// Firefox packages have no regexStatic.
{
    const staged = await stageModules({
        modules: [ 'filter-lists.js' ],
        stubs: {
            'dashboard.js': 'export const hashFromIterable = ( ) => \'\';\n' +
                'export const nodeFromTemplate = ( ) => null;\n',
        },
        document: new FakeDocument(),
        extension: createExtension(),
    });
    try {
        const { rulesetStatsFromDetails } = await staged.load('filter-lists.js');
        assert.deepEqual(rulesetStatsFromDetails({
            filters: { total: 300, accepted: 290, rejected: 10, converted: 280 },
            rules: { total: 260, plain: 200, regexStatic: 58, regex: 2, rejected: 12 },
        }), { ruleCount: 260, filterCount: 280, unsupportedCount: 12 },
        'Static regex rules are part of the list');
        assert.deepEqual(rulesetStatsFromDetails({
            filters: { total: 3, accepted: 2, rejected: 1 },
            rules: { total: 3, plain: 2, regex: 1 },
        }), { ruleCount: 3, filterCount: 2, unsupportedCount: 0 });
    } finally {
        await staged.cleanup();
    }
}

/******************************************************************************/

// Dashboard > Diagnostics: the markup has every element power-settings.js
// fills, and the regex panel stays hidden until a report arrives.
{
    const html = await fs.readFile(
        path.join(root, 'platform/mv3/extension/dashboard.html'), 'utf8'
    );
    const diagnostics = html.slice(
        html.indexOf('<section data-pane="diagnostics">'),
        html.indexOf('</section>', html.indexOf('<section data-pane="diagnostics">'))
    );
    for ( const pattern of [
        /<div id="regexCapacityPanel" class="powerPanel" hidden>/,
        /<dl id="regexCapacity"><\/dl>/,
        /<button id="verifyStaticRegex" type="button" data-i18n="diagnosticsRegexVerify">/,
        /<div id="strictBlockAddressSetup" hidden>/,
        /<button id="grantStrictBlockWebRequest" type="button" data-i18n="diagnosticsStrictBlockAddressGrant">/,
    ] ) {
        assert.match(diagnostics, pattern);
    }
}

// Dashboard > Diagnostics
{
    const document = new FakeDocument();
    document.body.dataset.pane = 'diagnostics';
    document.register('#refreshDiagnostics', new FakeElement('button'));
    const capabilitiesList = document.register('#runtimeCapabilities', new FakeElement('dl'));
    document.register('#performanceDetails', new FakeElement('dl'));
    document.register('#popupDiagnosticRows', new FakeElement('tbody'));
    document.register('section[data-pane="diagnostics"]', new FakeElement('section'));
    const panel = document.register('#regexCapacityPanel', new FakeElement('div', { hidden: true }));
    const regexList = document.register('#regexCapacity', new FakeElement('dl'));
    const verify = document.register('#verifyStaticRegex', new FakeElement('button'));
    const setup = document.register('#strictBlockAddressSetup', new FakeElement('div', { hidden: true }));
    const grant = document.register('#grantStrictBlockWebRequest', new FakeElement('button'));

    let capabilities = {
        productEdition: 'power', quotas: {},
        strictBlockUrlSource: 'rule-match',
        networkObservationRequestable: true,
        networkObservationPermissionGranted: false,
    };
    let report = capacityReport();
    let pendingCapacity;
    const extension = createExtension({
        dispatch(request) {
            switch ( request.what ) {
            case 'getOptionsPageData':
                return {
                    defaultFilteringMode: 2, autoReload: true, showBlockedCount: true,
                    strictBlockMode: true, popupBlockMode: true,
                };
            case 'getMemoryProfile':
                return { selected: 'auto', effective: 'auto', deviceMemoryGiB: 8 };
            case 'getRuntimeCapabilities':
                return structuredClone(capabilities);
            case 'getPopupDiagnostics':
                return [];
            case 'getRegexCapacity':
                if ( pendingCapacity !== undefined ) { return pendingCapacity.promise; }
                if ( report instanceof Error ) { throw report; }
                return structuredClone(report);
            }
        },
    });
    const statuses = [];
    const staged = await stageModules({
        modules: [
            'power-settings.js', 'power-ui.js', 'power-ui-core.js',
            'backup-schema.js', 'popup-policy.js', 'firewall-core.js',
            'firewall-index.js', 'runtime-capabilities-ui.js',
        ],
        stubs: {
            'dashboard.js': 'export const setOperationStatus = (text, level = \'info\') => ' +
                '{ globalThis.regexCapacityUIStatuses.push([ text, level ]); };\n',
        },
        document,
        extension,
    });
    globalThis.regexCapacityUIStatuses = statuses;
    const requests = what => extension.messages.filter(request => request.what === what);
    const refresh = async ( ) => {
        await document.trigger('#refreshDiagnostics', 'click');
        await settle(10);
    };
    const addressRow = ( ) => pairs(capabilitiesList)
        .find(([ label ]) => label === '[diagnosticsStrictBlockAddress]')?.[1];
    try {
        // The diagnostics pane is open: its data loads at once.
        await staged.load('power-settings.js');
        await settle(20);

        // Every row of the panel, from the report only.
        assert.equal(panel.hidden, false, 'A report shows the panel');
        assert.deepEqual(requests('getRegexCapacity'), [ { what: 'getRegexCapacity' } ],
            'Opening the pane never runs the browser check');
        assert.deepEqual(pairs(regexList), [
            [ '[diagnosticsRegexStatic]', `[diagnosticsRegexUsage:174|${n(1000)}]` ],
            [ '[diagnosticsRegexVerifiedWith]', 'Chrome/153.0.8010.53' ],
            [ '[diagnosticsRegexRejectedAtBuild]', '80' ],
            [ '[diagnosticsRegexSkipped]', '[diagnosticsRegexNotChecked]' ],
            [ '[diagnosticsRegexShared]', `[diagnosticsRegexUsage:123|${n(1000)}]` ],
            [ '[diagnosticsRegexUser]', '12' ],
            [ '[diagnosticsRegexStrictBlock]', '111' ],
            [ '[diagnosticsRegexFree]', '877' ],
            [ '[diagnosticsRegexDropped]', '3' ],
            [ '[diagnosticsRulesetsNotEnabled]', '0' ],
        ]);

        // The address row names how the page learns the address.
        assert.equal(addressRow(), '[diagnosticsStrictBlockAddressExact]');
        for ( const [ source, key ] of [
            [ 'webrequest', 'diagnosticsStrictBlockAddressExact' ],
            [ 'regex-substitution', 'diagnosticsStrictBlockAddressFragment' ],
            [ 'navigation-start', 'diagnosticsStrictBlockAddressApproximate' ],
            [ 'unavailable', 'diagnosticsStrictBlockAddressUnavailable' ],
            [ undefined, 'diagnosticsStrictBlockAddressUnavailable' ],
        ] ) {
            capabilities = { ...capabilities, strictBlockUrlSource: source };
            await refresh();
            assert.equal(addressRow(), `[${key}]`, `${source}`);
        }

        // A build without verdicts, Firefox-like dynamic stock regex, another
        // owner of the shared pool, lists the browser did not enable, and a
        // check which found skipped rules.
        const checkedAt = Date.UTC(2026, 8, 24, 10, 0, 0);
        report = capacityReport({
            static: {
                packaged: 0, enabled: 0, verifiedWith: '', rejectedAtBuild: 0,
                skippedByBrowser: 0, checkedAt,
            },
            shared: {
                dynamic: {
                    stockFallback: 174, developer: null, sandbox: null, imported: null,
                    stockResidual: null, user: 5, other: 4, byOwner: {},
                },
                session: { strictBlock: 0, other: 2, byOwner: {} },
                used: 185, free: 815, droppedStrictBlock: 4, droppedImported: 0,
            },
            rulesetsNotEnabled: [ 'rus-0', 'nor-0' ],
        });
        await refresh();
        assert.deepEqual(pairs(regexList), [
            [ '[diagnosticsRegexStatic]', `[diagnosticsRegexUsage:0|${n(1000)}]` ],
            [ '[diagnosticsRegexVerifiedWith]', '[diagnosticsRegexNotVerified]' ],
            [ '[diagnosticsRegexRejectedAtBuild]', '0' ],
            [ '[diagnosticsRegexSkipped]', '0' ],
            [ '[diagnosticsRegexShared]', `[diagnosticsRegexUsage:185|${n(1000)}]` ],
            [ '[diagnosticsRegexUser]', '5' ],
            [ '[diagnosticsRegexStrictBlock]', '0' ],
            [ '[diagnosticsRegexStockFallback]', '174' ],
            [ '[diagnosticsRegexOther]', '6' ],
            [ '[diagnosticsRegexFree]', '815' ],
            [ '[diagnosticsRegexDropped]', '4' ],
            [ '[diagnosticsRulesetsNotEnabled]', 'rus-0, nor-0' ],
        ], 'The rows add up to the shared usage');

        // Check now: asks the browser, and shows what it skipped.
        report = capacityReport({
            static: {
                skippedByBrowser: 2, checkedAt,
                skippedSamples: [
                    { rulesetId: 'ublock-filters', ruleId: 7, regex: '^a{900}b', reason: 'memoryLimitExceeded' },
                ],
            },
        });
        extension.messages.length = 0;
        const verifying = document.trigger('#verifyStaticRegex', 'click');
        assert.equal(verify.disabled, true, 'Disabled while checking');
        await verifying;
        assert.equal(verify.disabled, false);
        assert.deepEqual(requests('getRegexCapacity'),
            [ { what: 'getRegexCapacity', verifyStatic: true } ]);
        const skippedLabel = regexList.children.findIndex(node =>
            node.textContent === '[diagnosticsRegexSkipped]');
        const skipped = regexList.children[skippedLabel + 1];
        assert.equal(skipped.textContent, `2 · ${new Date(checkedAt).toLocaleString()}`);
        assert.equal(skipped.title, 'ublock-filters: ^a{900}b');
        // Also visible, not only in a tooltip keyboard, touch and screen
        // reader users cannot reach.
        const [ sampleList ] = skipped.children;
        assert.equal(sampleList?.tagName, 'UL');
        assert.deepEqual(sampleList.children.map(item => item.children[0].textContent),
            [ 'ublock-filters: ^a{900}b' ]);
        assert.equal(sampleList.children[0].children[0].tagName, 'CODE');

        // A slower refresh which started before 'Check now' must not replace
        // the check's newer numbers.
        pendingCapacity = deferred();
        const stale = pendingCapacity;
        const refreshing = document.trigger('#refreshDiagnostics', 'click');
        pendingCapacity = undefined;
        report = capacityReport({ static: { skippedByBrowser: 1, checkedAt } });
        await document.trigger('#verifyStaticRegex', 'click');
        stale.resolve(capacityReport({ static: { skippedByBrowser: null } }));
        await refreshing;
        await settle(10);
        assert.equal(regexList.children[skippedLabel + 1].textContent,
            `1 · ${new Date(checkedAt).toLocaleString()}`);

        // A failed check says so and keeps the button usable.
        report = new Error('isRegexSupported failed');
        statuses.length = 0;
        await document.trigger('#verifyStaticRegex', 'click');
        assert.deepEqual(statuses, [ [ '[diagnosticsLoadFailed]', 'error' ] ]);
        assert.equal(verify.disabled, false);

        // A worker without the report: no guessed numbers.
        report = undefined;
        await refresh();
        assert.equal(panel.hidden, true);

        // The optional webRequest permission is offered where the browser
        // can grant it and the page does not use it yet.
        report = capacityReport();
        capabilities = {
            productEdition: 'power', quotas: {},
            strictBlockUrlSource: 'navigation-start',
            networkObservationRequestable: true,
            networkObservationPermissionGranted: false,
        };
        await refresh();
        assert.equal(setup.hidden, false);
        for ( const change of [
            { networkObservationRequestable: false },
            { networkObservationPermissionGranted: true },
            { strictBlockUrlSource: 'webrequest' },
            { strictBlockUrlSource: 'regex-substitution' },
        ] ) {
            const before = capabilities;
            capabilities = { ...capabilities, ...change };
            await refresh();
            assert.equal(setup.hidden, true, JSON.stringify(change));
            capabilities = before;
        }
        await refresh();

        // Declined: nothing changes and the refusal is reported.
        const permissionRequests = [];
        extension.browser.permissions.request = async request => {
            permissionRequests.push(request);
            return false;
        };
        statuses.length = 0;
        await document.trigger('#grantStrictBlockWebRequest', 'click');
        assert.deepEqual(permissionRequests, [ { permissions: [ 'webRequest' ] } ]);
        assert.deepEqual(statuses, [ [ '[loggerPermissionRefused]', 'error' ] ]);
        assert.equal(grant.disabled, false);
        assert.equal(setup.hidden, false);

        // Granted: the diagnostics show what the worker then reports.
        extension.browser.permissions.request = async request => {
            permissionRequests.push(request);
            capabilities = {
                ...capabilities,
                strictBlockUrlSource: 'webrequest',
                networkObservationPermissionGranted: true,
            };
            return true;
        };
        statuses.length = 0;
        await document.trigger('#grantStrictBlockWebRequest', 'click');
        assert.deepEqual(statuses, [ [ '[diagnosticsStrictBlockAddressGranted]', 'info' ] ]);
        assert.equal(addressRow(), '[diagnosticsStrictBlockAddressExact]');
        assert.equal(setup.hidden, true);
        assert.equal(grant.disabled, false);

        // The worker may switch sources after the page first asks: the
        // page asks once more, and shows only what the worker reports.
        capabilities = {
            productEdition: 'power', quotas: {},
            strictBlockUrlSource: 'navigation-start',
            networkObservationRequestable: true,
            networkObservationPermissionGranted: false,
        };
        await refresh();
        let asked = 0;
        const reportedSources = [ 'navigation-start', 'webrequest' ];
        extension.dispatch = (dispatch => request => {
            if ( request.what !== 'getRuntimeCapabilities' ) { return dispatch(request); }
            const source = reportedSources[Math.min(asked++, 1)];
            return { ...capabilities, strictBlockUrlSource: source,
                networkObservationPermissionGranted: true };
        })(extension.dispatch);
        extension.browser.permissions.request = async ( ) => true;
        await document.trigger('#grantStrictBlockWebRequest', 'click');
        assert.equal(asked, 2, 'Asked again once');
        assert.equal(addressRow(), '[diagnosticsStrictBlockAddressExact]');
        assert.equal(setup.hidden, true);
    } finally {
        await staged.cleanup();
    }
}

/******************************************************************************/

// Filter Store: the regex estimate uses the remaining shared capacity.
{
    const catalogBytes = await fs.readFile(
        path.join(root, 'platform/mv3/extension/filter-store/catalog.json')
    );
    const makeInput = ( ) => new FakeElement('input', { addEventListener() {} });
    const setupStore = async dispatch => {
        const document = new FakeDocument();
        document.createDocumentFragment = ( ) => new FakeElement('fragment');
        for ( const selector of [
            '#filterStoreStatus', '#filterStoreEntries', '#filterStoreBundles',
            '#filterStoreBundleSection', '#filterStoreRepositoryList',
            '#filterStoreAddRepository', '#filterStoreSearch', '#filterStoreCategory',
            '#filterStoreLanguage', '#filterStoreProfile', '#filterStoreRepositoryURL',
        ] ) {
            document.register(selector, makeInput());
        }
        const quota = document.register('#filterStoreQuota', makeInput());
        const extension = createExtension({ dispatch });
        extension.browser.runtime.getURL = path =>
            `chrome-extension://test/${path.replace(/^\//, '')}`;
        extension.browser.runtime.sendMessage = request => extension.sendMessage(request);
        const staged = await stageModules({
            modules: [ 'filter-store.js', 'filter-store-model.js', 'verified-source-handoff.js' ],
            stubs: {
                'ext.js': [
                    'const ext = globalThis.dashboardTestExtension;',
                    'export const browser = ext.browser;',
                    'export const runtime = ext.browser.runtime;',
                    'export const i18n = ext.browser.i18n;',
                    'export const localKeys = async ( ) => [];',
                    'export const localRead = async key => ext.storage.get(key);',
                    'export const localWrite = async (key, value) => ext.storage.set(key, value);',
                    'export const localRemove = async key => ext.storage.remove(key);',
                ].join('\n'),
            },
            document,
            extension,
        });
        return { staged, quota, extension };
    };
    const { fetch: realFetch } = globalThis;
    const { error: consoleError } = console;
    globalThis.fetch = async url => {
        assert.equal(url, 'chrome-extension://test/filter-store/catalog.json');
        return {
            ok: true, status: 200, url,
            headers: { get: ( ) => null },
            arrayBuffer: async ( ) => catalogBytes.buffer.slice(
                catalogBytes.byteOffset, catalogBytes.byteOffset + catalogBytes.byteLength
            ),
        };
    };
    try {
        for ( const [ name, capacity, expected ] of [
            // 877 free plus the 10 regex rules imported lists already use,
            // which the estimate counts again for the enabled lists.
            [ 'report', capacityReport(), 887 ],
            // Unknown per-realm split: every user regex rule counts.
            [ 'unattributed', capacityReport({
                shared: {
                    dynamic: { stockFallback: 0, developer: null, sandbox: null,
                        imported: null, stockResidual: null, user: 12, other: 0 },
                },
            }), 889 ],
            [ 'no report', undefined, 1000 ],
            [ 'failed report', new Error('no handler'), 1000 ],
        ] ) {
            console.error = ( ) => {};
            const { staged, quota, extension } = await setupStore(request => {
                switch ( request.what ) {
                case 'getEnabledRulesets': return [ 'ublock-filters' ];
                case 'getImportedLists': return [];
                case 'getRegexCapacity':
                    if ( capacity instanceof Error ) { throw capacity; }
                    return structuredClone(capacity);
                }
            });
            try {
                const { initializeFilterStore, regexQuotaFromCapacity } =
                    await staged.load('filter-store.js');
                await initializeFilterStore();
                console.error = consoleError;
                assert(extension.messages.some(request => request.what === 'getRegexCapacity'));
                assert.match(quota.textContent,
                    new RegExp(`~0/${expected} \\[filterStoreRegexRules\\]`), name);
                assert.equal(regexQuotaFromCapacity(
                    capacity instanceof Error ? undefined : capacity), expected, name);
            } finally {
                console.error = consoleError;
                await staged.cleanup();
            }
        }
    } finally {
        globalThis.fetch = realFetch;
    }
}

/******************************************************************************/

// Troubleshooting information: both regex pools and the address source.
{
    let capacity = capacityReport();
    const extension = createExtension({
        dispatch(request) {
            switch ( request.what ) {
            case 'getDefaultConfig':
            case 'getCurrentConfig':
                return { strictBlockMode: true, popupBlockMode: true, rulesets: [ 'ublock-filters' ] };
            case 'getEnabledRulesets': return [ 'ublock-filters' ];
            case 'getRulesetDetails': return [ { id: 'ublock-filters', rules: { total: 10 } } ];
            case 'getDefaultFilteringMode': return 2;
            case 'getEffectiveUserRules':
            case 'getConsoleOutput':
            case 'getRegisteredContentScripts':
                return [];
            case 'hasBroadHostPermissions': return true;
            case 'getRuntimeCapabilities':
                return {
                    installType: 'development', activeNetworkEngine: 'dnr',
                    eligibleNetworkEngines: [ 'dnr' ], smartPopupObservation: true,
                    strictBlockUrlSource: 'rule-match',
                };
            case 'getRegexCapacity':
                if ( capacity instanceof Error ) { throw capacity; }
                return capacity;
            }
        },
    });
    extension.browser.runtime.getPlatformInfo = async ( ) => ({ os: 'win' });
    extension.browser.runtime.getURL = path => `chrome-extension://test/${path}`;
    const staged = await stageModules({
        modules: [ 'troubleshooting.js' ],
        document: new FakeDocument(),
        extension,
    });
    try {
        const { getTroubleshootingInfo } = await staged.load('troubleshooting.js');
        const lines = (await getTroubleshootingInfo()).split('\n');
        const runtimeAt = lines.indexOf('runtime:');
        assert.notEqual(runtimeAt, -1);
        assert.deepEqual(lines.slice(runtimeAt + 1, runtimeAt + 7), [
            ' install: development',
            ' engine: dnr',
            ' eligible: dnr',
            ' smart popup: true',
            ' regex: static 174/1000, shared 123/1000',
            ' strictblock url: rule-match',
        ]);
        // Without the report, the rest is still produced.
        capacity = new Error('no handler');
        const text = await getTroubleshootingInfo();
        assert.doesNotMatch(text, /regex:/);
        assert.match(text, / strictblock url: rule-match/);
    } finally {
        await staged.cleanup();
    }
}

console.log('Regex capacity UI tests passed');
