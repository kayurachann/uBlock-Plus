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
            // Tab 2 is asked only about navigations inside the popup itself.
            if ( tabId === 2 ) {
                assert.equal(frameId, 0);
                await state.popupGestureRead?.();
                return state.popupGestures || [];
            }
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

// A user-opened login/checkout popup keeps working while the user spends more
// than the gesture lifetime inside it. Navigation within the accepted
// destination's hostname lineage is checked against compiled filters only; a
// fragment change is not a navigation. A cross-host move is judged again.
for ( const [ label, gestureTarget ] of [
    [ 'exact', 'https://www.paypal.example/checkoutnow?token=abc' ],
    [ 'button', '' ],
] ) {
    const steps = [
        [ 12_000, 'https://www.paypal.example/webapps/hermes?token=abc', [] ],
        [ 6_000, 'https://www.paypal.example/webapps/hermes?token=abc#login', [] ],
        [ 6_000, 'https://paypal.example/signin', [] ],
        [ 1_000, 'https://checkout.paypal.example/pay', [ 2 ] ],
    ];
    const fixture = lifecycleFixture({
        targetURL: 'https://www.paypal.example/checkoutnow?token=abc',
    });
    fixture.gestures = [ {
        frameId: 0, at: fixture.clock, sequence: 1, targetURL: gestureTarget,
    } ];
    assert.equal((await fixture.open()).reason, gestureTarget === ''
        ? 'recent-user-gesture' : 'trusted-navigation-target');
    for ( const [ delay, url, removed ] of steps ) {
        fixture.clock += delay;
        fixture.tabs.get(2).url = url;
        await fixture.blocker.onTabUpdated(2, { url }, fixture.tabs.get(2));
        assert.deepEqual(fixture.removed, removed, `${label}: ${url}`);
        if ( removed.length !== 0 ) { break; }
        await fixture.blocker.onTabUpdated(2, { status: 'complete' },
            fixture.tabs.get(2));
        assert.deepEqual(fixture.removed, removed, `${label}: ${url} loaded`);
    }
}

for ( const [ url, removed ] of [
    [ 'https://checkout.shop.example/step-2', [] ],
    [ 'https://tracker.example/landing', [ 2 ] ],
] ) {
    const fixture = lifecycleFixture({
        targetURL: 'https://checkout.shop.example/cart',
    });
    await fixture.blocker.setPolicy('shop.example', 'strict');
    fixture.gestures = [ {
        frameId: 0, at: fixture.clock, sequence: 1, targetURL: '',
    } ];
    assert.equal((await fixture.open()).reason,
        'strict-related-hostname-user-gesture');
    fixture.clock += 12_000;
    fixture.tabs.get(2).url = url;
    await fixture.blocker.onTabUpdated(2, { url }, fixture.tabs.get(2));
    assert.deepEqual(fixture.removed, removed, `Strict trusted popup to ${url}`);
}

// A compiled block for the new URL still applies inside a trusted popup.
{
    const fixture = lifecycleFixture({
        targetURL: 'https://news.example/article',
        filters: [ lifecycleFilter('popup', 'ads.news.example') ],
    });
    fixture.gestures = [ {
        frameId: 0, at: fixture.clock, sequence: 1,
        targetURL: fixture.tabs.get(2).url,
    } ];
    assert.equal((await fixture.open()).reason, 'trusted-navigation-target');
    fixture.clock += 12_000;
    fixture.tabs.get(2).url = 'https://ads.news.example/landing';
    assert.equal((await fixture.blocker.onTabUpdated(2,
        { url: fixture.tabs.get(2).url }, fixture.tabs.get(2))).action,
    'blocked');
    assert.deepEqual(fixture.removed, [ 2 ]);
}

// Changing only the fragment while a compiled decision is pending cannot
// discard that decision.
{
    const fixture = lifecycleFixture();
    fixture.gestures = [ {
        frameId: 0, at: fixture.clock, sequence: 1,
        targetURL: fixture.tabs.get(2).url,
    } ];
    assert.equal((await fixture.open()).reason, 'trusted-navigation-target');
    fixture.clock += 6_000;
    const entered = delayedResult();
    const release = delayedResult();
    fixture.stockRead = async ( ) => { entered.resolve(); await release.promise; };
    fixture.tabs.get(2).url = 'https://ads.example/next';
    const pending = fixture.blocker.onTabUpdated(2,
        { url: fixture.tabs.get(2).url }, fixture.tabs.get(2));
    await entered.promise;
    fixture.tabs.get(2).url = 'https://ads.example/next#escape';
    await fixture.blocker.onTabUpdated(2, { url: fixture.tabs.get(2).url },
        fixture.tabs.get(2));
    release.resolve();
    assert.equal((await pending).action, 'blocked');
    assert.deepEqual(fixture.removed, [ 2 ]);
}

// Inside a tab the user opened, the user may follow a link to another site
// long after the opening gesture expired. The navigation start is checked
// against the popup's own document while it is still loaded; only a link the
// user activated for exactly that URL counts. Anything else is judged again.
{
    const trustedPopup = async ( ) => {
        const fixture = lifecycleFixture({
            targetURL: 'https://news.other.example/result',
            filters: [ lifecycleFilter('popup', 'ads.example') ],
        });
        fixture.gestures = [ {
            frameId: 0, at: fixture.clock, sequence: 1,
            targetURL: fixture.tabs.get(2).url,
        } ];
        assert.equal((await fixture.open()).reason, 'trusted-navigation-target');
        fixture.clock += 10_000;
        fixture.navigate = async (url, activationTarget, committedURL = url) => {
            fixture.popupGestures = activationTarget === undefined ? [] : [ {
                frameId: 0, at: fixture.clock - 50, sequence: 7,
                targetURL: activationTarget,
            } ];
            await fixture.blocker.onBeforeNavigate({ tabId: 2, frameId: 0, url });
            fixture.tabs.get(2).url = committedURL;
            return fixture.blocker.onTabUpdated(2, { url: committedURL },
                fixture.tabs.get(2));
        };
        return fixture;
    };

    // An outbound link, then in-site navigations of the chosen site.
    let fixture = await trustedPopup();
    assert.equal((await fixture.navigate(
        'https://www.youtube.example/watch?v=1',
        'https://www.youtube.example/watch?v=1'
    )).reason, 'trusted-destination-navigation');
    fixture.clock += 2_000;
    fixture.tabs.get(2).url = 'https://www.youtube.example/watch?v=2';
    await fixture.blocker.onTabUpdated(2, { url: fixture.tabs.get(2).url },
        fixture.tabs.get(2));
    assert.deepEqual(fixture.removed, [], 'User link to another site');
    // A later script redirect is judged again.
    await fixture.navigate('https://tracker.example/landing', undefined);
    assert.deepEqual(fixture.removed, [ 2 ], 'Script redirect afterwards');

    // A server redirect belongs to the navigation the user started.
    fixture = await trustedPopup();
    await fixture.navigate('https://t.example/r/abc', 'https://t.example/r/abc',
        'https://login.live.example/signin');
    assert.deepEqual(fixture.removed, [], 'Redirected user navigation');

    // A click elsewhere, or no signal at all, proves nothing.
    fixture = await trustedPopup();
    await fixture.navigate('https://tracker.example/landing',
        'https://news.other.example/next-page');
    assert.deepEqual(fixture.removed, [ 2 ], 'Unrelated activation');
    fixture = await trustedPopup();
    fixture.tabs.get(2).url = 'https://tracker.example/landing';
    await fixture.blocker.onTabUpdated(2, { url: fixture.tabs.get(2).url },
        fixture.tabs.get(2));
    assert.deepEqual(fixture.removed, [ 2 ], 'No navigation signal');

    // Compiled filters still apply to the destination.
    fixture = await trustedPopup();
    assert.equal((await fixture.navigate('https://ads.example/landing',
        'https://ads.example/landing')).action, 'blocked');
    assert.deepEqual(fixture.removed, [ 2 ], 'Compiled block after user link');

    // The URL change may arrive while the old document is still being asked;
    // it and any later update wait for the answer, in order.
    fixture = await trustedPopup();
    const entered = delayedResult();
    const release = delayedResult();
    fixture.popupGestureRead = async ( ) => {
        entered.resolve();
        await release.promise;
    };
    fixture.popupGestures = [ {
        frameId: 0, at: fixture.clock, sequence: 3,
        targetURL: 'https://www.youtube.example/',
    } ];
    const started = fixture.blocker.onBeforeNavigate({
        tabId: 2, frameId: 0, url: 'https://www.youtube.example/',
    });
    await entered.promise;
    fixture.tabs.get(2).url = 'https://www.youtube.example/';
    const updated = fixture.blocker.onTabUpdated(2,
        { url: fixture.tabs.get(2).url }, fixture.tabs.get(2));
    const loaded = fixture.blocker.onTabUpdated(2, { status: 'complete' },
        fixture.tabs.get(2));
    release.resolve();
    await started;
    assert.equal((await updated).reason, 'trusted-destination-navigation');
    await loaded;
    assert.deepEqual(fixture.removed, [], 'Slow activation answer');

    // Only accepted popups are probed, and only for their top frame.
    fixture = lifecycleFixture();
    let probes = 0;
    fixture.popupGestureRead = async ( ) => { probes += 1; };
    await fixture.blocker.setPolicy('shop.example', 'allow');
    await fixture.open();
    await fixture.blocker.onBeforeNavigate({
        tabId: 2, frameId: 0, url: 'https://elsewhere.example/',
    });
    fixture = await trustedPopup();
    fixture.popupGestureRead = async ( ) => { probes += 1; };
    await fixture.blocker.onBeforeNavigate({
        tabId: 2, frameId: 3, url: 'https://frame.example/',
    });
    await fixture.blocker.onBeforeNavigate({
        tabId: 9, frameId: 0, url: 'https://unrelated.example/',
    });
    assert.equal(probes, 0);
}

// Padding a popup URL must not switch off popup protection. Ordinary list
// sizes against long landing URLs stay within the compiled matcher budget, so
// the contextual policy still judges the popup.
for ( const policy of [ 'block', 'strict' ] ) {
    const targetURL = `https://adsterra-landing.example.net/landing?x=${'a'.repeat(900)}`;
    const fixture = lifecycleFixture({
        targetURL,
        filters: Array.from({ length: 500 }, (_, index) => ({
            schemaVersion: 1,
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            important: false,
            condition: { urlFilter: `/ad-path-${index}/` },
            lineNumber: index + 1,
        })),
    });
    await fixture.blocker.setPolicy('shop.example', policy);
    const result = await fixture.open();
    assert.equal(result.action, 'blocked', `${policy}: ${result.reason}`);
    assert.equal(result.reason, policy === 'strict'
        ? 'strict-without-user-gesture'
        : 'unrelated-hostname-without-user-gesture');
    assert.deepEqual(fixture.removed, [ 2 ]);
}

// Padding past the 8 KB bound, where only the origin is kept, must not switch
// popup protection off either. Stock-like exceptions anchored to other hosts
// are ruled out by hostname; one which could still match keeps deferring.
{
    const stockLike = (lineNumber, action, condition, routeCode) => ({
        schemaVersion: 1,
        routeCode: routeCode || 'popup-observer-runtime',
        kind: 'popup',
        action,
        important: false,
        condition,
        lineNumber,
    });
    const filters = [
        stockLike(1, 'allow', { urlFilter: '||google.*/search' }),
        stockLike(2, 'allow', {
            urlFilter: '||www.google.*/search?q=*&oq=*&sourceid=chrome&',
            domainType: 'thirdParty',
        }, 'popup-compiler-required'),
        stockLike(3, 'allow', { urlFilter: '||ads.shopee.*/' }),
        stockLike(4, 'block', { urlFilter: '/earn.php?z=' }),
    ];
    for ( const policy of [ 'block', 'strict' ] ) {
        const fixture = lifecycleFixture({
            targetURL: `https://adsterra-landing.example.net/landing?x=${'a'.repeat(9_000)}`,
            filters,
        });
        await fixture.blocker.setPolicy('shop.example', policy);
        const result = await fixture.open();
        assert.equal(result.action, 'blocked', `${policy}: ${result.reason}`);
        assert.equal(result.reason, policy === 'strict'
            ? 'strict-without-user-gesture'
            : 'unrelated-hostname-without-user-gesture');
        assert.deepEqual(fixture.removed, [ 2 ]);
    }
    const fixture = lifecycleFixture({
        targetURL: `https://www.google.example/search?q=${'a'.repeat(9_000)}`,
        filters,
    });
    await fixture.blocker.setPolicy('shop.example', 'strict');
    assert.equal((await fixture.open()).action, 'defer');
    assert.deepEqual(fixture.removed, []);
}

// URL changes of ordinary tabs (single-page applications change them many
// times a minute) must not rewrite the popup checkpoint.
{
    const writes = [];
    const session = new Map();
    const tabs = new Map([
        [ 1, { id: 1, url: 'https://shop.example/start' } ],
        [ 2, { id: 2, openerTabId: 1, url: 'https://shop.example/popup' } ],
        [ 3, { id: 3, openerTabId: 2, url: 'https://shop.example/chain' } ],
        [ 99, { id: 99, url: 'https://spa.example/#/feed' } ],
    ]);
    let clock = 5_000_000;
    const observer = createPopupBlocker({
        tabs: {
            get: async id => {
                if ( tabs.has(id) === false ) { throw new Error('gone'); }
                return { ...tabs.get(id) };
            },
            remove: async id => { tabs.delete(id); },
        },
        now: ( ) => clock,
        getFilteringMode: async ( ) => 3,
        getGestureContexts: async ( ) => [
            { frameId: 0, at: 0, sequence: 0, targetURL: '' },
        ],
        getSourceContext: async tabId => ({
            topURL: tabs.get(tabId).url, topContextComplete: true,
            initiatorURL: tabs.get(tabId).url, initiatorContextComplete: true,
        }),
        sessionRead: async key => structuredClone(session.get(key)),
        sessionWrite: async (key, value) => {
            writes.push(key);
            session.set(key, structuredClone(value));
        },
    });
    await observer.ready;
    const transientWrites = ( ) => writes.filter(key =>
        key === 'popupBlocker.transient'
    ).length;
    for ( const url of [ 'https://spa.example/#/profile',
        'https://spa.example/watch?v=2' ] ) {
        tabs.get(99).url = url;
        await observer.onTabUpdated(99, { url }, tabs.get(99));
    }
    assert.equal(transientWrites(), 0, 'Unrelated tab URL changes');

    // A same-site popup chain: tab 2 opens tab 3, so tab 2 is both a
    // candidate and a burst opener.
    for ( const [ tabId, sourceTabId ] of [ [ 2, 1 ], [ 3, 2 ] ] ) {
        assert.equal((await observer.onNavigationTarget({
            tabId, sourceTabId, sourceFrameId: 0, url: tabs.get(tabId).url,
        })).reason, 'single-related-hostname-popup');
    }
    let checkpoint = session.get('popupBlocker.transient');
    assert.equal(checkpoint.bursts.some(([ tabId ]) => tabId === 2), true);
    const writesBeforeOpenerUpdate = transientWrites();
    tabs.get(1).url = 'https://shop.example/next';
    await observer.onTabUpdated(1, { url: tabs.get(1).url }, tabs.get(1));
    assert.equal(transientWrites(), writesBeforeOpenerUpdate,
        'A popunder check with no decision writes nothing');

    await observer.onTabRemoved(2);
    checkpoint = session.get('popupBlocker.transient');
    assert.equal(checkpoint.candidates.some(entry => entry.tabId === 2), false);
    assert.equal(checkpoint.bursts.some(([ tabId ]) => tabId === 2), false,
        'A removed candidate tab also drops its own burst entry');

    // An expiry removed while scanning popunder candidates is persisted.
    clock += 2_001;
    tabs.set(4, { id: 4, openerTabId: 1, url: 'https://shop.example/help' });
    assert.equal((await observer.onNavigationTarget({
        tabId: 4, sourceTabId: 1, sourceFrameId: 0, url: tabs.get(4).url,
    })).reason, 'single-related-hostname-popup');
    clock += 30_001;
    const writesBeforeExpiry = transientWrites();
    tabs.get(1).url = 'https://shop.example/later';
    await observer.onTabUpdated(1, { url: tabs.get(1).url }, tabs.get(1));
    assert.equal(transientWrites(), writesBeforeExpiry + 1);
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
                return frameId === 70
                    ? { sequence: 2, recent: [
                        { at: 1, sequence: 1, targetURL: 'https://a.example/' },
                        { at: 2, sequence: 2, targetURL: 'https://b.example/' },
                    ] }
                    : { sequence: 0 };
            },
        },
    },
});
vm.runInContext(gestureCollectorSource, collectorContext);
const collected = await collectorContext.getPopupGestureContexts(1, 70);
assert.equal(messagedFrames.length, 64, 'Source priority preserves message cap');
assert.equal(messagedFrames[0], 70);
assert.equal(new Set(messagedFrames).size, 64);
assert.equal(collected.find(context => context.frameId === 70)?.sequence, 2);
// Every recent activation of a frame reaches the observer, which pairs each
// one with the tab it actually opened.
assert.equal(collected.find(context => context.frameId === 70)?.recent.length, 2);
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
