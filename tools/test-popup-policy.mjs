/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import {
    appendPopupDiagnostic,
    evaluatePopupCandidate,
    normalizePopupHostname,
    normalizePopupPolicies,
    resolvePopupPolicy,
} from '../platform/mv3/extension/js/popup-policy.js';
import assert from 'node:assert/strict';
import { capturePopupFrameContext } from
    '../platform/mv3/extension/js/popup-frame-context.js';
import { createPopupBlocker } from
    '../platform/mv3/extension/js/popup-blocker.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

assert.equal(normalizePopupHostname(' HTTPS://ExAmPle.COM./path '), 'example.com');
assert.equal(normalizePopupHostname('not a hostname'), '');
assert.equal(normalizePopupHostname('chrome://settings'), '');

const frameGraph = new Map([
    [ 0, { frameId: 0, parentFrameId: -1,
        url: 'https://top.safe.example/root' } ],
    [ 5, { frameId: 5, parentFrameId: 0,
        url: 'https://parent.safe.example/frame' } ],
    [ 6, { frameId: 6, parentFrameId: 5, url: 'about:srcdoc' } ],
    [ 7, { frameId: 7, parentFrameId: 6, url: 'about:blank' } ],
    [ 8, { frameId: 8, parentFrameId: 0,
        url: 'blob:https://safe.example/id' } ],
    [ 9, { frameId: 9, parentFrameId: 0,
        url: 'data:text/html,opaque' } ],
]);
const inheritedContext = await capturePopupFrameContext(
    async ({ frameId }) => frameGraph.get(frameId),
    1,
    7
);
assert.deepEqual(inheritedContext, {
    topURL: 'https://top.safe.example/root',
    topContextComplete: true,
    initiatorURL: 'https://parent.safe.example/frame',
    initiatorContextComplete: true,
});
assert.equal((await capturePopupFrameContext(
    async ({ frameId }) => frameGraph.get(frameId),
    1,
    8
)).initiatorContextComplete, true);
assert.equal((await capturePopupFrameContext(
    async ({ frameId }) => frameGraph.get(frameId),
    1,
    9
)).initiatorContextComplete, false);

const normalized = normalizePopupPolicies({
    'Example.COM': 'strict',
    'ignored.example': 'invalid',
});
assert.deepEqual({ ...normalized }, { 'example.com': 'strict' });
assert.deepEqual(
    resolvePopupPolicy(normalized, 'example.com'),
    { mode: 'strict', matchedHostname: 'example.com' }
);
assert.deepEqual(
    resolvePopupPolicy(normalized, 'shop.example.com'),
    { mode: 'block', matchedHostname: '' }
);
// Without a PSL in the MV3 runtime, policies are exact-host only. In
// particular, public and private suffix policies must never escape into an
// unrelated registrable domain or tenant.
for ( const [ publicSuffix, tenant ] of [
    [ 'co.uk', 'shop.example.co.uk' ],
    [ 'github.io', 'project.github.io' ],
] ) {
    assert.deepEqual(
        resolvePopupPolicy({ [publicSuffix]: 'allow' }, tenant),
        { mode: 'block', matchedHostname: '' }
    );
    assert.deepEqual(
        resolvePopupPolicy({ [publicSuffix]: 'allow' }, publicSuffix),
        { mode: 'allow', matchedHostname: publicSuffix }
    );
}

const evaluate = details => evaluatePopupCandidate({
    policy: 'block',
    openerURL: 'https://news.example/article',
    targetURL: 'https://target.example/page',
    gestureContextAvailable: true,
    burstCount: 1,
    ...details,
});

assert.equal(evaluate({ policy: 'allow' }).action, 'allow');
assert.equal(evaluate({ targetURL: 'about:blank' }).action, 'defer');
assert.equal(evaluate({ openerURL: 'chrome://settings' }).action, 'allow');
assert.equal(evaluate({ targetURL: 'chrome-extension://id/page' }).action, 'allow');
assert.equal(evaluate({
    gestureContextAvailable: false,
}).reason, 'gesture-context-unavailable');
assert.equal(evaluate({
    hasRecentUserGesture: true,
    gestureTargetMatches: true,
}).reason, 'trusted-navigation-target');
assert.deepEqual(
    evaluate({ hasRecentUserGesture: true }),
    {
        action: 'allow',
        reason: 'recent-user-gesture',
        policy: 'block',
        matchedHostname: '',
        openerHostname: 'news.example',
        targetHostname: 'target.example',
        directHostnameLineage: false,
        hadUserGesture: true,
        burstCount: 1,
    }
);
assert.equal(evaluate({}).reason, 'unrelated-hostname-without-user-gesture');
assert.equal(evaluate({
    targetURL: 'https://cdn.news.example/page',
}).reason, 'single-related-hostname-popup');
assert.equal(evaluate({
    targetURL: 'https://cdn.news.example/page',
    burstCount: 2,
}).reason, 'related-hostname-popup-burst');
assert.equal(evaluate({
    policy: 'strict',
    hasRecentUserGesture: true,
}).reason, 'strict-unrelated-hostname');
assert.equal(evaluate({
    policy: 'strict',
    targetURL: 'https://cdn.news.example/page',
    hasRecentUserGesture: true,
}).action, 'allow');
assert.equal(evaluate({
    policy: 'strict',
    targetURL: 'https://cdn.news.example/page',
}).reason, 'strict-without-user-gesture');

// Sibling hostnames are not direct lineage. Recognizing their common
// registrable owner safely requires a packaged PSL; the conservative fallback
// must not guess from a textual suffix because that would merge hosted tenants.
assert.equal(evaluate({
    openerURL: 'https://app.example.com/',
    targetURL: 'https://login.example.com/',
}).reason, 'unrelated-hostname-without-user-gesture');

let history = [];
for ( let i = 0; i < 5; i++ ) {
    history = appendPopupDiagnostic(history, {
        at: i,
        action: 'blocked',
        reason: 'test',
        openerHostname: 'https://example.com/private?token=secret',
        targetHostname: 'https://ads.example/popup?id=private',
    }, 3);
}
assert.equal(history.length, 3);
assert.equal(history[0].at, 2);
assert.equal(history[2].openerHostname, 'example.com');
assert.equal(history[2].targetHostname, 'ads.example');
assert.equal(JSON.stringify(history).includes('secret'), false);

let clock = 1_000_000;
let gestureContexts = [ {
    frameId: 0,
    at: 0,
    sequence: 0,
    targetURL: '',
} ];
const localStorage = new Map();
const sessionStorage = new Map();
const tabState = new Map([
    [ 1, { id: 1, url: 'https://shop.example/page', active: true } ],
]);
const removedTabs = [];
const dependencies = {
    supportsNavigationTargetContext: false,
    tabs: {
        get: async tabId => {
            if ( tabState.has(tabId) === false ) { throw new Error('missing tab'); }
            return tabState.get(tabId);
        },
        remove: async tabId => {
            removedTabs.push(tabId);
            tabState.delete(tabId);
        },
    },
    getGestureContexts: async ( ) => gestureContexts,
    localRead: async key => localStorage.get(key),
    localWrite: async (key, value) => localStorage.set(key, value),
    sessionRead: async key => sessionStorage.get(key),
    sessionWrite: async (key, value) => sessionStorage.set(key, value),
    now: ( ) => clock,
};

const blocker = createPopupBlocker(dependencies);
await blocker.ready;

gestureContexts = [ {
    frameId: 0,
    at: clock,
    sequence: 1,
    targetURL: 'https://login.example.net/',
} ];
tabState.set(2, {
    id: 2,
    openerTabId: 1,
    url: 'https://login.example.net/',
});
assert.equal((await blocker.onTabCreated(tabState.get(2))).reason,
    'trusted-navigation-target');
assert.deepEqual(removedTabs, []);

// One trusted activation may authorize only one new browsing context. A page
// cannot turn a single click into a popup storm.
clock += 20;
tabState.set(3, {
    id: 3,
    openerTabId: 1,
    url: 'https://ads.example.net/',
});
assert.equal((await blocker.onTabCreated(tabState.get(3))).action, 'blocked');
assert.deepEqual(removedTabs, [ 3 ]);

await blocker.setPolicy('shop.example', 'allow');
clock += 6_000;
tabState.set(4, {
    id: 4,
    openerTabId: 1,
    url: 'https://external.example.net/',
});
assert.equal((await blocker.onTabCreated(tabState.get(4))).reason,
    'site-policy-allow');

await blocker.setPolicy('shop.example', 'strict');
clock += 20;
gestureContexts = [ {
    frameId: 2,
    at: clock,
    sequence: 2,
    targetURL: 'https://external.example.net/',
} ];
tabState.set(5, {
    id: 5,
    openerTabId: 1,
    url: 'https://external.example.net/',
});
assert.equal((await blocker.onTabCreated(tabState.get(5))).reason,
    'strict-unrelated-hostname');
assert.deepEqual(removedTabs, [ 3, 5 ]);

clock += 20;
gestureContexts = [ {
    frameId: 0,
    at: clock,
    sequence: 3,
    targetURL: 'https://checkout.shop.example/',
} ];
tabState.set(6, {
    id: 6,
    openerTabId: 1,
    url: 'https://checkout.shop.example/',
});
assert.equal((await blocker.onTabCreated(tabState.get(6))).action, 'allow');

await blocker.setPolicy('shop.example', 'default');
clock += 6_000;
clock += 6_000;
tabState.set(7, { id: 7, openerTabId: 1, url: 'about:blank' });
assert.equal((await blocker.onTabCreated(tabState.get(7))).action, 'defer');
tabState.get(7).url = 'https://tracking.example.net/landing?secret=1';
assert.equal((await blocker.onTabUpdated(
    7,
    { url: tabState.get(7).url },
    tabState.get(7)
)).action, 'blocked');

// A gesture attached to an about:blank candidate must expire before a later
// navigation; otherwise an unrelated delayed popup inherits stale trust.
clock += 20;
gestureContexts = [ {
    frameId: 0,
    at: clock,
    sequence: 5,
    targetURL: 'https://late-gesture.example.net/',
} ];
tabState.set(9, { id: 9, openerTabId: 1, url: 'about:blank' });
assert.equal((await blocker.onTabCreated(tabState.get(9))).action, 'defer');
clock += 5_001;
tabState.get(9).url = 'https://late-gesture.example.net/';
const expiredGestureResult = await blocker.onTabUpdated(
    9,
    { url: tabState.get(9).url },
    tabState.get(9)
);
assert.equal(expiredGestureResult.action, 'blocked');
assert.equal(expiredGestureResult.hadUserGesture, false);
assert.equal(removedTabs.includes(9), true);

// A candidate is not a permanent association with its opener. Once its
// bounded lifetime ends, a late tab update must fail open and forget it.
clock += 20;
gestureContexts = [ {
    frameId: 0,
    at: clock,
    sequence: 6,
    targetURL: 'https://late-candidate.example.net/',
} ];
tabState.set(10, { id: 10, openerTabId: 1, url: 'about:blank' });
assert.equal((await blocker.onTabCreated(tabState.get(10))).action, 'defer');
clock += 30_001;
tabState.get(10).url = 'https://late-candidate.example.net/';
const removedBeforeExpiredCandidate = removedTabs.slice();
assert.deepEqual(
    await blocker.onTabUpdated(
        10,
        { url: tabState.get(10).url },
        tabState.get(10)
    ),
    { action: 'allow', reason: 'candidate-expired' }
);
assert.deepEqual(removedTabs, removedBeforeExpiredCandidate);

const diagnostics = await blocker.getDiagnostics();
assert.equal(diagnostics.some(entry => entry.action === 'blocked'), true);
assert.equal(JSON.stringify(diagnostics).includes('secret'), false);
assert.equal(
    JSON.stringify(sessionStorage.get('popupBlocker.transient'))
        .includes('secret'),
    false
);

// Site policies and pending about:blank candidates survive a service-worker
// lifecycle through bounded storage.session checkpoints.
await blocker.setPolicy('docs.example', 'strict');
clock += 6_000;
tabState.set(8, { id: 8, openerTabId: 1, url: 'about:blank' });
assert.equal((await blocker.onTabCreated(tabState.get(8))).action, 'defer');
tabState.get(8).url = 'https://resume-block.example/path?secret=2';

const restarted = createPopupBlocker(dependencies);
await restarted.ready;
assert.equal(
    (await restarted.getPolicies('docs.example')).effective.mode,
    'strict'
);
assert.equal(
    (await restarted.getPolicies('sub.docs.example')).effective.mode,
    'block'
);
await restarted.resume();
assert.equal(removedTabs.includes(8), true);
assert.equal(
    JSON.stringify(sessionStorage.get('popupBlocker.transient'))
        .includes('secret'),
    false
);
await restarted.clearDiagnostics();
assert.deepEqual(await restarted.getDiagnostics(), []);

// Imported/sandbox popup filters are loaded from the immutable active
// generation only when a popup event wakes the worker. A tabs.onCreated event
// has no source-frame provenance, so compiled blocks wait for
// onCreatedNavigationTarget instead of risking an iframe exception false hit.
const runtimeGeneration1 = '11111111111111111111111111111111';
const runtimeGeneration2 = '22222222222222222222222222222222';
const runtimeLocal = new Map([
    [ 'compiledFilters.activeGeneration', runtimeGeneration1 ],
    [ `compiledFilters.g.${runtimeGeneration1}.importedFilters.popupFilters`, {
        schemaVersion: 1,
        filters: [
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'blocked.example' ] },
                lineNumber: 11,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'allow',
                important: false,
                condition: { requestDomains: [ 'allowed.example' ] },
                lineNumber: 12,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popunder',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'opener.example' ] },
                lineNumber: 13,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'allow',
                important: false,
                condition: {
                    requestDomains: [ 'durable-allow.example' ],
                    initiatorDomains: [ 'opener.example' ],
                },
                lineNumber: 14,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'gesture-block.example' ] },
                lineNumber: 15,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'early-capture.example' ] },
                lineNumber: 16,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'allow',
                important: false,
                condition: {
                    requestDomains: [ 'early-capture.example' ],
                    initiatorDomains: [ 'opener.example' ],
                    topDomains: [ 'opener.example' ],
                },
                lineNumber: 17,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'inherited-frame.example' ] },
                lineNumber: 18,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'allow',
                important: false,
                condition: {
                    requestDomains: [ 'inherited-frame.example' ],
                    initiatorDomains: [ 'safe.example' ],
                },
                lineNumber: 19,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { requestDomains: [ 'mode-off.example' ] },
                lineNumber: 20,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: {
                    requestDomains: [ 'fallback-opener.example' ],
                },
                lineNumber: 21,
            },
            {
                schemaVersion: 1,
                routeCode: 'popup-observer-runtime',
                kind: 'popup',
                action: 'block',
                important: false,
                condition: { urlFilter: '/old-fallback-path' },
                lineNumber: 22,
            },
        ],
    } ],
    [ `compiledFilters.g.${runtimeGeneration2}.importedFilters.popupFilters`, {
        schemaVersion: 1,
        filters: [ {
            schemaVersion: 1,
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            important: false,
            condition: { requestDomains: [ 'generation-two.example' ] },
            lineNumber: 21,
        } ],
    } ],
]);
const runtimeSession = new Map();
const runtimeLocalReads = [];
let runtimeFilteringMode = 1;
const runtimeNoFilteringHostnames = new Set();
let runtimeGestureContexts = [];
let runtimeGestureHook;
let runtimeSourceContextOverride;
let runtimeStockKey = 'stock-empty';
let runtimeStockFilters = [];
const runtimeTabs = new Map([
    [ 100, { id: 100, url: 'https://opener.example/start' } ],
]);
const runtimeRemoved = [];
const runtimeDependencies = {
    tabs: {
        get: async tabId => {
            if ( runtimeTabs.has(tabId) === false ) {
                throw new Error('missing runtime tab');
            }
            return runtimeTabs.get(tabId);
        },
        remove: async tabId => {
            runtimeRemoved.push(tabId);
            runtimeTabs.delete(tabId);
        },
    },
    getFilteringMode: async hostname =>
        runtimeNoFilteringHostnames.has(hostname) ? 0 : runtimeFilteringMode,
    getGestureContexts: async ( ) => {
        runtimeGestureHook?.();
        return runtimeGestureContexts;
    },
    getStockPopupSnapshot: async ( ) => ({
        key: runtimeStockKey,
        filters: runtimeStockFilters,
    }),
    getSourceContext: async (tabId, frameId) => {
        if ( runtimeSourceContextOverride !== undefined ) {
            return runtimeSourceContextOverride(tabId, frameId);
        }
        const topURL = runtimeTabs.get(tabId)?.url || '';
        const initiatorURL = frameId === 0
            ? topURL
            : `https://frame${frameId}.opener.example/context/${tabId}`;
        return {
            topURL,
            topContextComplete: topURL !== '',
            initiatorURL,
            initiatorContextComplete: initiatorURL !== '',
        };
    },
    getSourceFrameURL: async (tabId, frameId) =>
        `https://frame${frameId}.opener.example/context/${tabId}`,
    localRead: async key => {
        runtimeLocalReads.push(key);
        return runtimeLocal.get(key);
    },
    localWrite: async (key, value) => runtimeLocal.set(key, value),
    sessionRead: async key => runtimeSession.get(key),
    sessionWrite: async (key, value) => runtimeSession.set(key, value),
    now: ( ) => clock,
};
const runtimeBlocker = createPopupBlocker(runtimeDependencies);
await runtimeBlocker.ready;

// Basic mode never materializes imported popup filters. This keeps a large
// imported list out of the service-worker heap until a site actually enables
// Optimal/Complete mode.
await runtimeBlocker.setPolicy('opener.example', 'allow');
runtimeLocalReads.length = 0;
runtimeTabs.set(99, {
    id: 99,
    openerTabId: 100,
    url: 'https://unrelated.example/path',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 99,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: 'https://unrelated.example/path',
})).reason, 'site-policy-allow');
assert.equal(runtimeLocalReads.some(key =>
    key.endsWith('importedFilters.popupFilters')
), false);
await runtimeBlocker.onTabRemoved(99);
await runtimeBlocker.setPolicy('opener.example', 'default');

// Packaged stock popup corpora run in Basic mode. In Optimal mode they share
// one priority lattice with imported filters rather than winning by list order.
runtimeStockKey = 'stock-enabled';
runtimeStockFilters = [
    {
        schemaVersion: 1,
        routeCode: 'popup-observer-runtime',
        kind: 'popup',
        action: 'block',
        important: false,
        condition: { requestDomains: [ 'stock-block.example' ] },
        lineNumber: 501,
    },
    {
        schemaVersion: 1,
        routeCode: 'popup-observer-runtime',
        kind: 'popup',
        action: 'block',
        important: false,
        condition: { requestDomains: [ 'allowed.example' ] },
        lineNumber: 502,
    },
];
runtimeTabs.set(98, {
    id: 98,
    openerTabId: 100,
    url: 'https://stock-block.example/path',
});
const stockBasicBlock = await runtimeBlocker.onNavigationTarget({
    tabId: 98,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: runtimeTabs.get(98).url,
});
assert.equal(stockBasicBlock.action, 'blocked');
assert.equal(stockBasicBlock.matchedRealm, 'stock');
assert.equal(runtimeRemoved.includes(98), true);
runtimeRemoved.length = 0;
runtimeFilteringMode = 2;

runtimeTabs.set(101, {
    id: 101,
    openerTabId: 100,
    url: 'https://blocked.example/path',
});
assert.equal(
    (await runtimeBlocker.onTabCreated(runtimeTabs.get(101))).reason,
    'compiled-popup-context-pending'
);
assert.deepEqual(runtimeRemoved, []);
const compiledBlock = await runtimeBlocker.onNavigationTarget({
    tabId: 101,
    sourceTabId: 100,
    sourceFrameId: 2,
    url: 'https://blocked.example/path',
});
assert.equal(compiledBlock.action, 'blocked');
assert.equal(compiledBlock.reason, 'compiled-popup-filter');
assert.deepEqual(runtimeRemoved, [ 101 ]);

// Oversized paths are reduced to a canonical origin plus an incompleteness
// bit, never to an empty URL. Hostname-only and broad rules therefore cannot
// be bypassed merely by crossing the runtime's path-memory bound.
const oversizedPopupURL = `https://blocked.example/${'a'.repeat(9_000)}`;
runtimeTabs.set(110, {
    id: 110,
    openerTabId: 100,
    url: oversizedPopupURL,
});
const oversizedHostnameBlock = await runtimeBlocker.onNavigationTarget({
    tabId: 110,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: oversizedPopupURL,
});
assert.equal(oversizedHostnameBlock.action, 'blocked');
assert.equal(oversizedHostnameBlock.reason, 'compiled-popup-filter');
assert.equal(runtimeRemoved.includes(110), true);

runtimeTabs.set(102, {
    id: 102,
    openerTabId: 100,
    url: 'https://allowed.example/path',
});
const compiledAllow = await runtimeBlocker.onNavigationTarget({
    tabId: 102,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: 'https://allowed.example/path',
});
assert.equal(compiledAllow.action, 'allow');
assert.equal(compiledAllow.reason, 'compiled-popup-filter');
assert.equal(compiledAllow.matchedRealm, 'imported');
assert.equal(runtimeTabs.has(102), true);

// Exact, one-shot navigation intent wins before a broad compiled $popup
// block, matching the original engine's trusted-link safeguard.
runtimeGestureContexts = [ {
    frameId: 0,
    at: clock,
    sequence: 101,
    targetURL: 'https://gesture-block.example/legitimate',
} ];
runtimeTabs.set(105, {
    id: 105,
    openerTabId: 100,
    url: 'https://gesture-block.example/legitimate',
});
const trustedCompiledBypass = await runtimeBlocker.onNavigationTarget({
    tabId: 105,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: runtimeTabs.get(105).url,
});
assert.equal(trustedCompiledBypass.action, 'allow');
assert.equal(trustedCompiledBypass.reason, 'trusted-navigation-target');
assert.equal(runtimeRemoved.includes(105), false);
runtimeGestureContexts = [];
await runtimeBlocker.onTabRemoved(105);

// Root and source URLs must be captured before gesture collection. Simulate
// an immediate opener navigation inside that later await; the immutable
// source snapshot still selects the constrained allow exception.
runtimeTabs.set(106, {
    id: 106,
    openerTabId: 100,
    url: 'https://early-capture.example/path',
});
runtimeGestureHook = ( ) => {
    runtimeTabs.get(100).url = 'https://changed-during-gesture.example/';
    runtimeGestureHook = undefined;
};
const earlyCaptureAllow = await runtimeBlocker.onNavigationTarget({
    tabId: 106,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: runtimeTabs.get(106).url,
});
assert.equal(earlyCaptureAllow.action, 'allow');
assert.equal(earlyCaptureAllow.reason, 'compiled-popup-filter');
assert.equal(runtimeRemoved.includes(106), false);
runtimeTabs.get(100).url = 'https://opener.example/start';
await runtimeBlocker.onTabRemoved(106);

// An about:blank/srcdoc child inherits its resolved parent provenance; blob
// frame URLs likewise expose their embedded origin to domain conditions.
for ( const [ tabId, initiatorURL ] of [
    [ 107, 'https://parent.safe.example/frame' ],
    [ 108, 'blob:https://safe.example/id' ],
] ) {
    runtimeSourceContextOverride = ( ) => ({
        topURL: 'https://opener.example/start',
        topContextComplete: true,
        initiatorURL,
        initiatorContextComplete: true,
    });
    runtimeTabs.set(tabId, {
        id: tabId,
        openerTabId: 100,
        url: 'https://inherited-frame.example/path',
    });
    const inheritedAllow = await runtimeBlocker.onNavigationTarget({
        tabId,
        sourceTabId: 100,
        sourceFrameId: 7,
        url: runtimeTabs.get(tabId).url,
    });
    assert.equal(inheritedAllow.action, 'allow');
    assert.equal(inheritedAllow.reason, 'compiled-popup-filter');
    assert.equal(runtimeRemoved.includes(tabId), false);
    await runtimeBlocker.onTabRemoved(tabId);
}
runtimeSourceContextOverride = undefined;

// No-filtering on the tab which would be closed is authoritative even when
// the opener is in Optimal mode and a broad compiled popup rule matches.
runtimeNoFilteringHostnames.add('mode-off.example');
runtimeTabs.set(109, {
    id: 109,
    openerTabId: 100,
    url: 'https://mode-off.example/path',
});
const noFilteringTarget = await runtimeBlocker.onNavigationTarget({
    tabId: 109,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: runtimeTabs.get(109).url,
});
assert.equal(noFilteringTarget.action, 'allow');
assert.equal(noFilteringTarget.reason, 'popup-filtering-disabled');
assert.equal(runtimeRemoved.includes(109), false);
runtimeNoFilteringHostnames.delete('mode-off.example');
await runtimeBlocker.onTabRemoved(109);

// A generation pointer change invalidates the in-worker snapshot without a
// keepalive or a duplicate raw-filter copy.
runtimeLocal.set('compiledFilters.activeGeneration', runtimeGeneration2);
runtimeTabs.set(103, {
    id: 103,
    openerTabId: 100,
    url: 'https://generation-two.example/path',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 103,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: 'https://generation-two.example/path',
})).action, 'blocked');
assert.equal(runtimeRemoved.includes(103), true);

// A complete initiator hostname survives worker eviction as a redacted
// origin. Re-reading the opener's now-changed URL would turn this exception
// into a false block.
runtimeLocal.set('compiledFilters.activeGeneration', runtimeGeneration1);
runtimeTabs.set(104, {
    id: 104,
    openerTabId: 100,
    url: 'https://durable-allow.example/path',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 104,
    sourceTabId: 100,
    sourceFrameId: 0,
    url: 'https://durable-allow.example/path',
})).action, 'allow');
const runtimeRestarted = createPopupBlocker(runtimeDependencies);
await runtimeRestarted.ready;
runtimeTabs.get(100).url = 'https://changed-after-restart.example/';
const durableAllow = await runtimeRestarted.onTabUpdated(
    104,
    { url: runtimeTabs.get(104).url },
    runtimeTabs.get(104)
);
assert.equal(durableAllow.action, 'allow');
assert.equal(durableAllow.reason, 'compiled-popup-filter');
assert.equal(runtimeRemoved.includes(104), false);
runtimeTabs.get(100).url = 'https://opener.example/start';
await Promise.all([
    runtimeBlocker.onTabRemoved(104),
    runtimeRestarted.onTabRemoved(104),
]);

// When the opener navigates after creating a surviving target tab, a typed
// $popunder rule closes the original opener, not the new target.
runtimeLocal.set('compiledFilters.activeGeneration', runtimeGeneration1);
await runtimeBlocker.setPolicy('opener.example', 'allow');
runtimeTabs.set(200, { id: 200, url: 'https://opener.example/original' });
runtimeTabs.set(201, {
    id: 201,
    openerTabId: 200,
    url: 'https://benign.example/new-tab',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 201,
    sourceTabId: 200,
    sourceFrameId: 0,
    url: 'https://benign.example/new-tab',
})).reason, 'site-policy-allow');
runtimeTabs.get(200).url = 'https://landing.example/replaced';
const popunderBlock = await runtimeBlocker.onTabUpdated(
    200,
    { url: runtimeTabs.get(200).url },
    runtimeTabs.get(200)
);
assert.equal(popunderBlock.action, 'blocked');
assert.equal(popunderBlock.kind, 'popunder');
assert.equal(runtimeRemoved.includes(200), true);
assert.equal(runtimeTabs.has(201), true);

// An opener path beyond the context-memory bound is retained as an origin,
// but that origin must never be labelled complete. Path exceptions may be
// hidden in the discarded suffix, so a later popunder decision fails open.
runtimeSourceContextOverride = ( ) => undefined;
const oversizedOpenerURL = `https://opener.example/${'x'.repeat(9_000)}`;
runtimeTabs.set(240, { id: 240, url: oversizedOpenerURL });
runtimeTabs.set(241, {
    id: 241,
    openerTabId: 240,
    url: 'https://benign.example/oversized-opener-target',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 241,
    sourceTabId: 240,
    sourceFrameId: 0,
    url: runtimeTabs.get(241).url,
})).reason, 'site-policy-allow');
runtimeTabs.get(240).url = 'https://landing.example/oversized-replaced';
await runtimeBlocker.onTabUpdated(
    240,
    { url: runtimeTabs.get(240).url },
    runtimeTabs.get(240)
);
assert.equal(runtimeRemoved.includes(240), false);
assert.equal(runtimeTabs.has(241), true);
runtimeSourceContextOverride = undefined;
await runtimeBlocker.onTabRemoved(241);

// A definitive compiled $popup allow is result=allow, not no-match; it must
// suppress a later $popunder decision for the same surviving target.
runtimeTabs.set(210, { id: 210, url: 'https://opener.example/original' });
runtimeTabs.set(211, {
    id: 211,
    openerTabId: 210,
    url: 'https://allowed.example/new-tab',
});
const popupAllowBeforePopunder = await runtimeBlocker.onNavigationTarget({
    tabId: 211,
    sourceTabId: 210,
    sourceFrameId: 0,
    url: runtimeTabs.get(211).url,
});
assert.equal(popupAllowBeforePopunder.action, 'allow');
assert.equal(popupAllowBeforePopunder.reason, 'compiled-popup-filter');
runtimeTabs.get(210).url = 'https://landing.example/replaced';
await runtimeBlocker.onTabUpdated(
    210,
    { url: runtimeTabs.get(210).url },
    runtimeTabs.get(210)
);
assert.equal(runtimeRemoved.includes(210), false);
assert.equal(runtimeTabs.has(211), true);
await runtimeBlocker.onTabRemoved(211);

// Ordinary hostname-specific $popup rules retain uBO's conservative
// popunder fallback. A path-only popup rule is intentionally not promoted.
runtimeTabs.set(220, {
    id: 220,
    url: 'https://fallback-opener.example/original',
});
runtimeTabs.set(221, {
    id: 221,
    openerTabId: 220,
    url: 'https://benign.example/fallback-target',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 221,
    sourceTabId: 220,
    sourceFrameId: 0,
    url: runtimeTabs.get(221).url,
})).action, 'allow');
runtimeTabs.get(220).url = 'https://landing.example/after-fallback';
const hostnamePopupFallback = await runtimeBlocker.onTabUpdated(
    220,
    { url: runtimeTabs.get(220).url },
    runtimeTabs.get(220)
);
assert.equal(hostnamePopupFallback.action, 'blocked');
assert.equal(hostnamePopupFallback.kind, 'popup');
assert.equal(runtimeRemoved.includes(220), true);

runtimeTabs.set(230, {
    id: 230,
    url: 'https://path-only.example/old-fallback-path',
});
runtimeTabs.set(231, {
    id: 231,
    openerTabId: 230,
    url: 'https://benign.example/path-only-target',
});
assert.equal((await runtimeBlocker.onNavigationTarget({
    tabId: 231,
    sourceTabId: 230,
    sourceFrameId: 0,
    url: runtimeTabs.get(231).url,
})).action, 'allow');
runtimeTabs.get(230).url = 'https://landing.example/path-only';
await runtimeBlocker.onTabUpdated(
    230,
    { url: runtimeTabs.get(230).url },
    runtimeTabs.get(230)
);
assert.equal(runtimeRemoved.includes(230), false);
assert.equal(runtimeTabs.has(231), true);
await runtimeBlocker.onTabRemoved(231);

// A platform without onCreatedNavigationTarget must keep using the Smart
// policy instead of leaving every potentially matching compiled rule pending
// forever.
runtimeTabs.set(300, {
    id: 300,
    url: 'https://observer-off.example/start',
});
runtimeTabs.set(301, {
    id: 301,
    openerTabId: 300,
    url: 'https://blocked.example/path',
});
const noObserverBlocker = createPopupBlocker({
    ...runtimeDependencies,
    getGestureContexts: async ( ) => [ {
        frameId: 0,
        at: 0,
        sequence: 0,
        targetURL: '',
    } ],
    supportsNavigationTargetContext: false,
});
await noObserverBlocker.ready;
const noObserverResult = await noObserverBlocker.onTabCreated(
    runtimeTabs.get(301)
);
assert.equal(noObserverResult.action, 'blocked');
assert.equal(
    noObserverResult.reason,
    'unrelated-hostname-without-user-gesture'
);
assert.equal(runtimeRemoved.includes(301), true);

const compiledDiagnostics = await runtimeBlocker.getDiagnostics();
const popupDiagnostic = compiledDiagnostics.find(entry =>
    entry.filterLineNumber === 11
);
assert.equal(popupDiagnostic.filterKind, 'popup');
assert.equal(popupDiagnostic.filterRealm, 'imported');
const stockDiagnostic = compiledDiagnostics.find(entry =>
    entry.filterLineNumber === 501
);
assert.equal(stockDiagnostic.filterKind, 'popup');
assert.equal(stockDiagnostic.filterRealm, 'stock');
assert.equal(JSON.stringify(compiledDiagnostics).includes('/path'), false);

// Lifecycle regressions use real asynchronous dependency boundaries. A read
// completing late must never override a newer navigation or a user's Off.
function delayedResult() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function lifecycleFilter(kind, hostname, action = 'block', initiatorDomains) {
    return {
        schemaVersion: 1,
        routeCode: 'popup-observer-runtime',
        kind,
        action,
        important: false,
        condition: {
            requestDomains: [ hostname ],
            ...(initiatorDomains ? { initiatorDomains } : {}),
        },
        lineNumber: action === 'allow' ? 2 : 1,
    };
}

function lifecycleFixture(options = {}) {
    const state = {
        enabled: true,
        clock: 1_000_000,
        modes: new Map(),
        gestures: [ { frameId: 0, at: 0, sequence: 0, targetURL: '' } ],
        removed: [],
        session: new Map(),
        tabs: new Map([
            [ 1, { id: 1, url: 'https://shop.example/start' } ],
            [ 2, { id: 2, openerTabId: 1,
                url: options.targetURL || 'https://ads.example/popup' } ],
        ]),
    };
    const dependency = {
        tabs: {
            async get(id) {
                await state.beforeGet?.(id);
                if ( state.tabs.has(id) === false ) { throw new Error('gone'); }
                return { ...state.tabs.get(id) };
            },
            async remove(id) { state.removed.push(id); state.tabs.delete(id); },
        },
        isEnabled: ( ) => state.enabled,
        now: ( ) => state.clock,
        getFilteringMode: async hostname => {
            state.modeRead?.(hostname);
            return state.modes.get(hostname) ?? 3;
        },
        getGestureContexts: async (tabId, frameId) => {
            assert.equal(tabId, 1);
            return state.gestureRead?.(frameId) ?? state.gestures;
        },
        getStockPopupSnapshot: async ( ) => {
            await state.stockRead?.();
            return { filters: options.filters || [
                lifecycleFilter('popup', 'ads.example'),
            ] };
        },
        getSourceContext: async ( ) => state.sourceContext || {
            topURL: state.tabs.get(1).url,
            topContextComplete: true,
            initiatorURL: state.tabs.get(1).url,
            initiatorContextComplete: true,
        },
        sessionRead: async key => structuredClone(state.session.get(key)),
        sessionWrite: async (key, value) =>
            state.session.set(key, structuredClone(value)),
    };
    state.blocker = createPopupBlocker(dependency);
    state.restart = ( ) => createPopupBlocker(dependency);
    state.open = (sourceFrameId = 0) => state.blocker.onNavigationTarget({
        tabId: 2, sourceTabId: 1, sourceFrameId, url: state.tabs.get(2).url,
    });
    return state;
}

for ( const offKind of [ 'global', 'opener', 'target' ] ) {
    const fixture = lifecycleFixture();
    const entered = delayedResult();
    const release = delayedResult();
    fixture.stockRead = async ( ) => { entered.resolve(); await release.promise; };
    const pending = fixture.open();
    await entered.promise;
    if ( offKind === 'global' ) { fixture.enabled = false; }
    if ( offKind === 'opener' ) { fixture.modes.set('shop.example', 0); }
    if ( offKind === 'target' ) { fixture.modes.set('ads.example', 0); }
    release.resolve();
    assert.equal((await pending).action, 'allow', `${offKind} during corpus read`);
    assert.deepEqual(fixture.removed, []);
}

for ( const offKind of [ 'global', 'current-opener' ] ) {
    const fixture = lifecycleFixture({
        targetURL: 'https://benign.example/new-tab',
        filters: [ lifecycleFilter('popunder', 'shop.example') ],
    });
    await fixture.blocker.setPolicy('shop.example', 'allow');
    await fixture.open();
    fixture.tabs.get(1).url = 'https://landing.example/replaced';
    if ( offKind === 'global' ) { fixture.enabled = false; }
    if ( offKind === 'current-opener' ) { fixture.modes.set('landing.example', 0); }
    await fixture.blocker.onTabUpdated(1,
        { url: fixture.tabs.get(1).url }, fixture.tabs.get(1));
    assert.deepEqual(fixture.removed, [], `Popunder respects ${offKind} Off`);
}

{
    const fixture = lifecycleFixture({ filters: [] });
    const entered = delayedResult();
    const release = delayedResult();
    fixture.beforeGet = async id => {
        if ( id !== 2 ) { return; }
        entered.resolve();
        await release.promise;
    };
    const pending = fixture.open();
    await entered.promise;
    await fixture.blocker.setPolicy('shop.example', 'allow');
    release.resolve();
    assert.equal((await pending).reason, 'site-policy-allow');
    assert.deepEqual(fixture.removed, []);
}

for ( const restart of [ false, true ] ) {
    const fixture = lifecycleFixture();
    fixture.gestures = [ {
        frameId: 0, at: fixture.clock, sequence: 1,
        targetURL: fixture.tabs.get(2).url,
    } ];
    assert.equal((await fixture.open()).reason, 'trusted-navigation-target');
    fixture.clock += 6_000;
    const active = restart ? fixture.restart() : fixture.blocker;
    if ( restart ) { await active.resume(); }
    for ( const update of [ { status: 'complete' }, { title: 'Sign in' },
        { audible: true } ] ) {
        await active.onTabUpdated(2, update, fixture.tabs.get(2));
    }
    assert.deepEqual(fixture.removed, [], `Slow trusted popup; restart=${restart}`);
    if ( restart ) {
        // Its path was not persisted, so future decisions about this old
        // candidate fail open after eviction instead of guessing at intent.
        assert.equal(fixture.session.get('popupBlocker.transient').candidates.length, 0);
        continue;
    }
    fixture.tabs.get(2).url = 'https://ads.example/new-ad-redirect';
    await active.onTabUpdated(2, { url: fixture.tabs.get(2).url }, fixture.tabs.get(2));
    assert.deepEqual(fixture.removed, [ 2 ], 'A changed destination still evaluates');
}

for ( const change of [ 'redirect', 'removed' ] ) {
    const fixture = lifecycleFixture();
    await fixture.blocker.setPolicy('shop.example', 'allow');
    const entered = delayedResult();
    const release = delayedResult();
    fixture.stockRead = async ( ) => { entered.resolve(); await release.promise; };
    const stale = fixture.open();
    await entered.promise;
    let fresh;
    if ( change === 'removed' ) {
        await fixture.blocker.onTabRemoved(2);
    } else {
        const newEvaluation = delayedResult();
        fixture.modeRead = hostname => {
            if ( hostname === 'safe.example' ) { newEvaluation.resolve(); }
        };
        fixture.tabs.get(2).url = 'https://safe.example/accepted';
        fresh = fixture.blocker.onTabUpdated(2,
            { url: fixture.tabs.get(2).url }, fixture.tabs.get(2));
        await newEvaluation.promise;
    }
    release.resolve();
    assert.equal((await stale).action, 'defer', `Stale decision after ${change}`);
    if ( fresh ) { assert.equal((await fresh).action, 'allow'); }
    assert.deepEqual(fixture.removed, []);
}

for ( const inheritedURL of [ 'about:blank', 'about:blank#anchor',
    'about:blank?query', 'about:srcdoc#anchor' ] ) {
    const fixture = lifecycleFixture({ filters: [
        lifecycleFilter('popup', 'ads.example'),
        lifecycleFilter('popup', 'ads.example', 'allow', [ 'safe.example' ]),
    ] });
    fixture.sourceContext = await capturePopupFrameContext(
        async ({ frameId }) => new Map([
            [ 0, { url: 'https://shop.example/start', parentFrameId: -1 } ],
            [ 4, { url: 'https://safe.example/embedded', parentFrameId: 0 } ],
            [ 9, { url: inheritedURL, parentFrameId: 4 } ],
        ]).get(frameId), 1, 9
    );
    assert.equal(fixture.sourceContext.initiatorURL, 'https://safe.example/embedded');
    assert.equal((await fixture.open(9)).action, 'allow', inheritedURL);
    assert.deepEqual(fixture.removed, []);
}

{
    const fixture = lifecycleFixture();
    const queriedFrames = [];
    fixture.gestureRead = frameId => {
        queriedFrames.push(frameId);
        return frameId === 70 ? [ {
            frameId: 70, at: fixture.clock, sequence: 1,
            targetURL: fixture.tabs.get(2).url,
        } ] : [ { frameId: 0, at: 0, sequence: 0, targetURL: '' } ];
    };
    assert.equal((await fixture.blocker.onTabCreated(fixture.tabs.get(2))).action, 'defer');
    assert.equal((await fixture.open(70)).reason, 'trusted-navigation-target');
    assert.deepEqual(queriedFrames, [ -1, 70 ]);
    assert.deepEqual(fixture.removed, []);
}

{
    const fixture = lifecycleFixture({ filters: [] });
    assert.equal((await fixture.blocker.onTabCreated(fixture.tabs.get(2))).reason,
        'gesture-context-unavailable');
    assert.equal((await fixture.open(70)).reason, 'gesture-context-unavailable',
        'A sibling response cannot imply that the actual opener lacked activation');
    assert.deepEqual(fixture.removed, []);
}

{
    const removed = [];
    const writes = [];
    const unavailable = createPopupBlocker({
        tabs: {
            get: async id => ({ id, url: 'https://shop.example/' }),
            remove: async id => removed.push(id),
        },
        getGestureContexts: async ( ) => [ { frameId: 0, at: 0, sequence: 0 } ],
        localRead: async ( ) => { throw new Error('policy database unavailable'); },
        localWrite: async (...args) => writes.push(args),
        sessionWrite: async (...args) => writes.push(args),
    });
    assert.equal((await unavailable.onNavigationTarget({
        tabId: 2, sourceTabId: 1, sourceFrameId: 0, url: 'https://ads.example/',
    })).reason, 'popup-state-unavailable');
    await unavailable.resume();
    await assert.rejects(unavailable.getPolicies('shop.example'), /unavailable/);
    await assert.rejects(unavailable.setPolicy('shop.example', 'strict'), /unavailable/);
    assert.deepEqual(removed, []);
    assert.deepEqual(writes, []);
}

for ( const lateSnapshot of [ false, true ] ) {
    const states = new Map([
        [ 1, { id: 1, url: 'https://actual.example/' } ],
        [ 3, { id: 3, url: 'https://provisional.example/' } ],
        [ 2, { id: 2, openerTabId: 3, url: 'https://ads.example/popup' } ],
        [ 4, { id: 4, openerTabId: 3, url: 'https://ads.example/popup' } ],
    ]);
    const removed = [];
    const session = new Map();
    const observer = createPopupBlocker({
        tabs: {
            get: async id => ({ ...states.get(id) }),
            remove: async id => removed.push(id),
        },
        now: ( ) => 100_000,
        getGestureContexts: async ( ) => [ {
            frameId: 0, at: 100_000, sequence: 1,
            targetURL: 'https://ads.example/popup',
        } ],
        getStockPopupSnapshot: async ( ) => ({
            filters: [ lifecycleFilter('popup', 'ads.example') ],
        }),
        getSourceContext: async tabId => ({
            topURL: states.get(tabId).url, topContextComplete: true,
            initiatorURL: states.get(tabId).url, initiatorContextComplete: true,
        }),
        sessionWrite: async (key, value) => session.set(key, structuredClone(value)),
    });
    await observer.ready;
    const snapshot = delayedResult();
    const provisional = observer.onTabCreated(states.get(2), lateSnapshot
        ? snapshot.promise : Promise.resolve(states.get(3)));
    if ( lateSnapshot ) { await Promise.resolve(); }
    else { await provisional; }
    const authoritative = await observer.onNavigationTarget({
        tabId: 2, sourceTabId: 1, sourceFrameId: 0, url: states.get(2).url,
    });
    assert.equal(authoritative.reason, 'trusted-navigation-target');
    assert.equal(authoritative.openerHostname, 'actual.example');
    if ( lateSnapshot ) {
        snapshot.resolve(states.get(3));
        assert.equal((await provisional).reason, 'popup-context-changed');
    }
    // A wrong opener attribution must not consume the actual activation or
    // increase the next burst count belonging to that unrelated tab.
    assert.equal((await observer.onNavigationTarget({
        tabId: 4, sourceTabId: 3, sourceFrameId: 0, url: states.get(4).url,
    })).reason, 'trusted-navigation-target');
    const checkpoint = session.get('popupBlocker.transient');
    assert.equal(checkpoint.candidates.find(candidate => candidate.tabId === 2)
        .openerTabId, 1);
    assert.equal(checkpoint.bursts.find(([ tabId ]) => tabId === 3)[2], 1);
    assert.deepEqual(removed, []);
}

// Old registrations must fail open even when their target-only data contains
// a matching block. Only the observer has authoritative opener/intent context.
const preventPopupSource = await fs.readFile(path.join(
    import.meta.dirname,
    '..',
    'platform',
    'mv3',
    'extension',
    'js',
    'scripting',
    'prevent-popup.js'
), 'utf8');

function runPreventPopup(xto, runtime) {
    let closed = false;
    const target = new URL('https://target.example/popup');
    const context = {
        URL,
        self: {
            close: ( ) => { closed = true; },
            preventPopupDetails: [ {
                block: {
                    hostnames: [],
                    regexes: [
                        'target.example',
                        JSON.stringify([ {
                            re: 'target\\.example/popup',
                            f: '',
                            xto,
                        } ]),
                    ],
                },
                allow: {
                    hostnames: [],
                    regexes: [],
                },
            } ],
            preventPopupTarget: target,
        },
    };
    if ( runtime !== undefined ) {
        context.self.chrome = { runtime };
    }
    context.self.top = context.self;
    vm.runInNewContext(preventPopupSource, context);
    return closed;
}

assert.equal(runPreventPopup([ 'target.example' ]), false);
assert.equal(runPreventPopup([ 'excluded.example' ]), false);
let compiledMessageSent = false;
assert.equal(runPreventPopup([ 'excluded.example' ], {
    sendMessage: ( ) => {
        compiledMessageSent = true;
        return new Promise(( ) => { });
    },
}), false);
assert.equal(compiledMessageSent, false);
assert.doesNotMatch(preventPopupSource, /\bawait\b|\(async\s*\(/);

const [ backgroundSource, popupHTML, popupSource ] = await Promise.all([
    fs.readFile(path.join(
        import.meta.dirname,
        '..',
        'platform',
        'mv3',
        'extension',
        'js',
        'background.js'
    ), 'utf8'),
    fs.readFile(path.join(
        import.meta.dirname,
        '..',
        'platform',
        'mv3',
        'extension',
        'popup.html'
    ), 'utf8'),
    fs.readFile(path.join(
        import.meta.dirname,
        '..',
        'platform',
        'mv3',
        'extension',
        'js',
        'popup.js'
    ), 'utf8'),
]);
const gestureCollectorSource = backgroundSource.slice(
    backgroundSource.indexOf('async function getPopupGestureContexts('),
    backgroundSource.indexOf('async function getPopupSourceFrameURL(')
);
const messagedFrames = [];
const collectorContext = vm.createContext({
    Object,
    webextFlavor: 'chromium',
    browser: {
        webNavigation: {
            getAllFrames: async ( ) => Array.from({ length: 80 }, (_, frameId) => ({ frameId })),
        },
        tabs: {
            sendMessage: async (tabId, message, { frameId }) => {
                void tabId; void message;
                messagedFrames.push(frameId);
                return { sequence: frameId === 70 ? 1 : 0 };
            },
        },
    },
});
vm.runInContext(gestureCollectorSource, collectorContext);
const collected = await collectorContext.getPopupGestureContexts(1, 70);
assert.equal(messagedFrames.length, 64, 'Source priority preserves message cap');
assert.equal(messagedFrames[0], 70);
assert.equal(new Set(messagedFrames).size, 64);
assert.equal(collected.find(context => context.frameId === 70)?.sequence, 1);
assert.match(
    backgroundSource,
    /popupPanelData[\s\S]{0,1600}popupPolicy:\s*results\[4\]\.effective/
);
assert.match(backgroundSource, /case 'setPopupPolicy':/);
assert.match(popupHTML, /id="popupPolicySelect"/);
for ( const mode of [ 'default', 'allow', 'block', 'strict' ] ) {
    assert.match(popupHTML, new RegExp(`<option value="${mode}"`));
}
assert.match(
    popupSource,
    /const mode = ev\.target\.value;[\s\S]{0,300}what:\s*'setPopupPolicy',[\s\S]{0,100}\bmode,/
);

console.log('Context-aware popup policy tests passed');
