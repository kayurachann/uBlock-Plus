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
