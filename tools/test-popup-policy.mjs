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
import { createPopupBlocker } from
    '../platform/mv3/extension/js/popup-blocker.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

assert.equal(normalizePopupHostname(' HTTPS://ExAmPle.COM./path '), 'example.com');
assert.equal(normalizePopupHostname('not a hostname'), '');
assert.equal(normalizePopupHostname('chrome://settings'), '');

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

// Regression: an excluded target at sorted index 0 must be recognized, while
// a non-matching exclusion must not suppress a matching popup regex.
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
assert.equal(runPreventPopup([ 'excluded.example' ]), true);
let compiledMessageSent = false;
assert.equal(runPreventPopup([ 'excluded.example' ], {
    sendMessage: ( ) => {
        compiledMessageSent = true;
        return new Promise(( ) => { });
    },
}), true);
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
    /what:\s*'setPopupPolicy'[\s\S]{0,160}mode:\s*ev\.target\.value/
);

console.log('Context-aware popup policy tests passed');
