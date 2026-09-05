/*******************************************************************************

    uBlock Plus+ - popup observer authority and legacy bypass regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';
import { createPopupBlocker } from '../platform/mv3/extension/js/popup-blocker.js';
import { evaluateCompiledPopupFilters } from '../platform/mv3/extension/js/compiled-popup-matcher.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import vm from 'node:vm';

const artifact = process.argv[2];
const extension = path.resolve(artifact || 'platform/mv3/extension');
let targetHostname = 'target.example';
let legacyDetails = [ {
    id: 'fixture',
    block: { hostnames: [ targetHostname ], regexes: [] },
    allow: { hostnames: [], regexes: [] },
} ];
let stockFilters = [ {
    schemaVersion: 1, routeCode: 'popup-observer-runtime', kind: 'popup',
    action: 'block', important: false,
    condition: { requestDomains: [ targetHostname ] },
    lineNumber: 1,
} ];
if ( artifact ) {
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    const enabled = manifest.declarative_net_request.rule_resources
        .filter(resource => resource.enabled).map(resource => resource.id);
    const dataContext = { self: {} };
    stockFilters = [];
    for ( const id of enabled ) {
        const script = path.join(extension, 'rulesets/scripting/popup', `${id}.js`);
        try { await fs.access(script); } catch { continue; }
        vm.runInNewContext(await fs.readFile(script, 'utf8'), dataContext);
        const corpus = JSON.parse(await fs.readFile(
            path.join(extension, 'rulesets/popup', `${id}.json`), 'utf8'));
        stockFilters.push(...corpus.filters);
    }
    legacyDetails = dataContext.self.preventPopupDetails;
    assert.ok(legacyDetails?.length > 0, 'Artifact must exercise actual stock popup data');
    targetHostname = legacyDetails.find(details => details.id === 'easylist')
        ?.block.hostnames.find(hostname => hostname === 's.id') ||
        legacyDetails.find(details => details.block.hostnames.length)
            .block.hostnames[0];
}
const targetURL = `https://${targetHostname}/`;
let supportedTargetURL = targetURL;
if ( artifact ) {
    // Legacy hostname tables also contain rules the bounded observer compiler
    // defers (e.g. oversized grouped domain lists). Select a positive case from
    // the actual runnable corpus and prove it matches with complete context.
    const candidates = stockFilters.filter(filter =>
        filter.action === 'block' &&
        typeof filter.condition.urlFilter === 'string' &&
        filter.condition.urlFilter.startsWith('/') &&
        /[|*^]/.test(filter.condition.urlFilter) === false
    ).map(filter => `https://popup.example${filter.condition.urlFilter}fixture`);
    supportedTargetURL = candidates.find(url => evaluateCompiledPopupFilters(
        [ { id: 'stock', filters: stockFilters } ], {
            kind: 'popup', targetURL: url, targetURLComplete: true,
            initiatorURL: 'https://trusted.example/',
            topURL: 'https://trusted.example/', initiatorContextComplete: true,
            filteringMode: 2,
        }
    ).action === 'block');
    assert.equal(typeof supportedTargetURL, 'string',
        'Require an actual supported stock popup block, not a legacy-only target');
}

globalThis.self = globalThis;
globalThis.chrome = {
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
};
const { registerPreventPopup } = await import(pathToFileURL(
    path.join(extension, 'js/prevent-popup.js')));
const context = {
    filteringModeDetails: {
        none: new Set([ 'trusted.example' ]), basic: new Set(),
        optimal: new Set([ 'all-urls' ]), complete: new Set(),
    },
    rulesetsDetails: legacyDetails.map(details => ({ id: details.id, popups: 1 })),
    toAdd: [],
};
await registerPreventPopup(context);
assert.equal(context.toAdd.length, 1);
assert.deepEqual(context.toAdd[0].js, [ '/js/scripting/popup-context.js' ]);

// A script-opened target can be closed by window.close(), so the target must
// not close itself before the observer can check its trusted opener.
let directCloses = 0;
const listeners = new Map();
let gestureHandler;
const targetWindow = {
    preventPopupDetails: structuredClone(legacyDetails),
    preventPopupTarget: new URL(targetURL),
    opener: { location: { hostname: 'trusted.example' } },
    close() { directCloses += 1; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    chrome: { runtime: { onMessage: { addListener(listener) { gestureHandler = listener; } } } },
};
targetWindow.top = targetWindow;
for ( const file of context.toAdd[0].js ) {
    vm.runInNewContext(await fs.readFile(path.join(extension, file.slice(1)), 'utf8'), {
        self: targetWindow,
    });
}
assert.equal(directCloses, 0);
listeners.get('click')({
    isTrusted: true, type: 'click', target: { localName: 'a', href: targetURL },
});
let gesture;
gestureHandler({ what: 'getPopupGestureContext' }, {}, value => { gesture = value; });
assert.equal(gesture.targetURL, targetURL, 'Intent context must remain available');
assert.equal(gesture.sequence, 1);

// Even a stale persisted registration invoking the compatibility entry point
// with a matching packaged corpus must remain inert during worker startup.
vm.runInNewContext(await fs.readFile(
    path.join(extension, 'js/scripting/prevent-popup.js'), 'utf8'), { self: targetWindow });
assert.equal(directCloses, 0);
assert.equal(targetWindow.preventPopupDetails, undefined);

async function observe(options = {}) {
    const removed = [];
    const opener = { id: 10, url: 'https://trusted.example/' };
    const observedURL = options.targetURL || supportedTargetURL;
    const target = { id: 11, openerTabId: 10, url: observedURL };
    const local = new Map();
    const session = new Map();
    const blocker = createPopupBlocker({
        tabs: {
            async get(id) { return id === 10 ? opener : target; },
            async remove(id) { removed.push(id); },
        },
        getFilteringMode: async hostname => options.openerOff && hostname === 'trusted.example' ? 0 : 2,
        getStockPopupSnapshot: async ( ) => ({ key: 'authority', filters: stockFilters }),
        getSourceContext: async ( ) => ({
            topURL: opener.url, topContextComplete: true,
            initiatorURL: opener.url, initiatorContextComplete: true,
        }),
        getGestureContexts: async ( ) => options.intent ? [ {
            frameId: 0, at: 1000, sequence: 1, targetURL: observedURL,
        } ] : [],
        localRead: async key => local.get(key),
        localWrite: async (key, value) => local.set(key, value),
        sessionRead: async key => session.get(key),
        sessionWrite: async (key, value) => session.set(key, value),
        now: ( ) => 1000,
    });
    await blocker.ready;
    const result = options.unknownContext
        ? await blocker.onTabCreated(target)
        : await blocker.onNavigationTarget({
            tabId: 11, sourceTabId: 10, sourceFrameId: 0, url: observedURL,
        });
    return { result, removed };
}

for ( const options of [ { openerOff: true }, { intent: true } ] ) {
    const { result, removed } = await observe(options);
    assert.equal(result.action, 'allow');
    assert.deepEqual(removed, []);
}
const legacyTargetOff = await observe({ openerOff: true, targetURL });
assert.equal(legacyTargetOff.result.action, 'allow');
assert.deepEqual(legacyTargetOff.removed, []);
const pending = await observe({ unknownContext: true });
assert.equal(pending.result.action, 'defer');
assert.deepEqual(pending.removed, []);
const blocked = await observe();
assert.equal(blocked.result.action, 'blocked');
assert.equal(blocked.result.reason, 'compiled-popup-filter');
assert.deepEqual(blocked.removed, [ 11 ]);

console.log(`Popup observer authority tests passed${artifact
    ? ` for legacy target ${targetHostname} and supported block ${supportedTargetURL}`
    : ''}.`);
