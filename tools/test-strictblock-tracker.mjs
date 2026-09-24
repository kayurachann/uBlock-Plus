/* uBlock Plus+ - strict-block address tracker and page. GPL-3.0-or-later. */
//
// The tracker (strictblock-tracker.js) runs on mocked browser events with the
// timings measured in Chrome 153 (tmp/design/step2-regex-pool report C1-C13):
// source preference, event filtering, freshness, late events, the
// navigation-start fallback, tab removal, the storage.session mirror, owners.
// The page (strictblock.js) runs on the dashboard test harness: fragment
// first, then the worker's answer carried in the history entry, the notes,
// Proceed, and the list named from the owner.

import {
    FakeDocument,
    FakeElement,
    createExtension,
    stageModules,
} from './dashboard-test-harness.mjs';
import {
    LAST_MATCH_STORAGE_KEY,
    PLAN_STORAGE_KEY,
    createStrictBlockTracker,
    sanitizeStrictBlockOwner,
} from '../platform/mv3/extension/js/strictblock-tracker.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planStrictBlockSessionRules } from '../platform/mv3/extension/js/strictblock-rules.js';
import { setImmediate as turn } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/******************************************************************************/

// A realistic plan: My filters, imported and stock redirects plus the
// exclusion allows which share the strict-block session ID range.
const redirectAction = { type: 'redirect', redirect: { extensionPath: '/strictblock.html' } };
const plan = planStrictBlockSessionRules({
    flavor: 'chromium',
    strictBlockMode: true,
    hasOmnipotence: true,
    exactUrlSource: true,
    stock: [ { rulesetId: 'ublock-filters', rules: [
        { id: 7, action: redirectAction, priority: 29,
            condition: { requestDomains: [ 'stock.test' ], resourceTypes: [ 'main_frame' ] } },
    ] } ],
    user: [
        { realm: 'sandbox', rules: [ { id: 3, action: redirectAction, priority: 10,
            condition: { urlFilter: '||mine.test^', resourceTypes: [ 'main_frame' ] } } ] },
        { realm: 'imported', rules: [ { id: 5, action: redirectAction, priority: 40,
            condition: { urlFilter: '||imported.test^', resourceTypes: [ 'main_frame' ] } } ] },
    ],
    excludedHostnames: [ 'ok.test' ],
});
const rangeOf = (owner, action) => {
    const range = plan.owners.find(o => o[2] === owner && o[3] === action);
    assert.ok(range, `${owner} ${action}`);
    return range[0];
};
const sandboxId = rangeOf('sandbox', 'redirect');
const importedId = rangeOf('imported', 'redirect');
const stockId = rangeOf('stock:ublock-filters', 'redirect');
const allowId = rangeOf('sandbox', 'allow');
assert.ok(plan.redirectCount === 3 && plan.counts.allows >= 2);

/******************************************************************************/

function makeEvent() {
    const listeners = new Set();
    return {
        listeners,
        filters: [],
        addListener(fn, filter) {
            listeners.add(fn);
            this.filters.push(filter);
        },
        removeListener(fn) { listeners.delete(fn); },
        hasListener(fn) { return listeners.has(fn); },
        emit(...args) {
            for ( const fn of Array.from(listeners) ) { fn(...args); }
        },
    };
}

function makeEnv({
    webRequest = false,
    ruleMatch = true,
    webNavigation = true,
    session = new Map(),
    matchedRules,
    permissionGranted,
    ...options
} = {}) {
    const env = {
        clock: 1790237150000,
        session,
        timers: new Map(),
        nextTimer: 1,
        matchedRulesCalls: [],
    };
    env.dnr = {
        SESSION_RULESET_ID: '_session',
        DYNAMIC_RULESET_ID: '_dynamic',
        onRuleMatchedDebug: ruleMatch ? makeEvent() : undefined,
        getMatchedRules: matchedRules === undefined ? undefined : async filter => {
            env.matchedRulesCalls.push(filter);
            if ( matchedRules instanceof Error ) { throw matchedRules; }
            return { rulesMatchedInfo: matchedRules };
        },
    };
    env.webRequestNamespace = webRequest
        ? { onBeforeRedirect: makeEvent(), onBeforeRequest: makeEvent() }
        : undefined;
    env.webNavigation = webNavigation ? { onBeforeNavigate: makeEvent() } : undefined;
    env.granted = permissionGranted;
    env.tracker = createStrictBlockTracker({
        dnr: env.dnr,
        webRequest: ( ) => env.webRequestNamespace,
        webNavigation: env.webNavigation,
        permissions: env.granted === undefined ? undefined : {
            contains: async ( ) => env.granted,
        },
        sessionRead: async key => structuredClone(env.session.get(key)),
        sessionWrite: async (key, value) => { env.session.set(key, structuredClone(value)); },
        now: ( ) => env.clock,
        setTimer: (fn, ms) => {
            const id = env.nextTimer++;
            env.timers.set(id, { fn, ms });
            return id;
        },
        clearTimer: id => { env.timers.delete(id); },
        ...options,
    });
    env.fireTimers = ( ) => {
        for ( const [ id, timer ] of Array.from(env.timers) ) {
            env.timers.delete(id);
            timer.fn();
        }
    };
    env.at = t => { env.clock = t; return env; };
    env.match = (tabId, url, ruleId, extra = {}) => env.dnr.onRuleMatchedDebug.emit({
        request: { type: 'main_frame', tabId, frameId: 0, url, ...extra.request },
        rule: { rulesetId: '_session', ruleId, ...extra.rule },
    });
    env.redirect = (tabId, url, redirectUrl, extra = {}) => env.webRequestNamespace.onBeforeRedirect.emit({
        type: 'main_frame', tabId, frameId: 0, url, redirectUrl, ...extra,
    });
    env.request = (tabId, url, requestId, extra = {}) => env.webRequestNamespace.onBeforeRequest.emit({
        type: 'main_frame', tabId, frameId: 0, url, requestId, ...extra,
    });
    env.navigate = (tabId, url, frameId = 0, extra = {}) =>
        env.tracker.onBeforeNavigate({ tabId, frameId, url, ...extra });
    return env;
}

// Lets the tracker's queued promise callbacks run; fake timers never fire
// on their own.
const settle = async (rounds = 8) => {
    for ( let i = 0; i < rounds; i++ ) {
        await turn();
    }
};

// Starts getDetails() and reports whether it settled without a timer.
const ask = async (env, tabId, timeOrigin) => {
    let result;
    const promise = env.tracker.getDetails(tabId, timeOrigin).then(r => { result = r; return r; });
    await settle();
    return { promise, get result() { return result; } };
};

const guidRedirect = 'chrome-extension://59b93d32-0631-4265-ae8c-401fb08688f9/strictblock.html';

/******************************************************************************/

// The tracker is a pure module: every browser API is injected.
{
    const source = await fs.readFile(
        path.join(projectRoot, 'platform/mv3/extension/js/strictblock-tracker.js'), 'utf8');
    const imports = Array.from(source.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm), m => m[1]);
    assert.deepEqual(imports, [ './strictblock-rules.js' ]);
    assert.doesNotMatch(source, /\b(?:chrome|browser)\.[a-z]/, 'no global extension API');
}

/******************************************************************************/

// Source preference: webrequest > rule-match > navigation-start > unavailable.
{
    const env = makeEnv({ webRequest: true, ruleMatch: true });
    assert.equal(env.tracker.urlSource(), 'navigation-start',
        'no exact source is claimed before its listener is registered');
    env.tracker.registerTopLevelListeners();
    env.tracker.registerTopLevelListeners();
    assert.equal(env.tracker.urlSource(), 'webrequest');
    assert.equal(env.tracker.isExact(), true);
    for ( const name of [ 'onBeforeRedirect', 'onBeforeRequest' ] ) {
        assert.equal(env.webRequestNamespace[name].listeners.size, 1, name);
        assert.deepEqual(env.webRequestNamespace[name].filters,
            [ { urls: [ '<all_urls>' ], types: [ 'main_frame' ] } ], name);
    }
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0,
        'the onRuleMatchedDebug firehose is never registered next to webRequest');
    env.tracker.setActive(true);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0);
    env.tracker.setActive(false);
    assert.equal(env.webRequestNamespace.onBeforeRedirect.listeners.size, 1,
        'the main-frame webRequest listener stays while inactive');
    assert.equal(env.webRequestNamespace.onBeforeRequest.listeners.size, 1);
}
// onBeforeRedirect alone misses every block after a server redirect: a
// namespace without onBeforeRequest is not an exact source.
{
    const env = makeEnv({ webRequest: true, ruleMatch: true });
    delete env.webRequestNamespace.onBeforeRequest;
    env.tracker.registerTopLevelListeners();
    assert.equal(env.tracker.urlSource(), 'rule-match');
    assert.equal(env.webRequestNamespace.onBeforeRedirect.listeners.size, 0);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 1);
}
{
    const env = makeEnv({ ruleMatch: true });
    env.tracker.registerTopLevelListeners();
    assert.equal(env.tracker.urlSource(), 'rule-match');
    assert.equal(env.tracker.isExact(), true);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 1,
        'registered at the top level, so a match wakes the worker');
}
{
    const env = makeEnv({ ruleMatch: false });
    env.tracker.registerTopLevelListeners();
    assert.equal(env.tracker.urlSource(), 'navigation-start');
    assert.equal(env.tracker.isExact(), false);
}
{
    const env = makeEnv({ ruleMatch: false, webNavigation: false });
    env.tracker.registerTopLevelListeners();
    assert.equal(env.tracker.urlSource(), 'unavailable');
    assert.deepEqual(await env.tracker.getDetails(1, env.clock), { url: '', source: 'none' });
}

// setActive adds and removes the onRuleMatchedDebug listener; every call
// means the plan changed.
{
    const env = makeEnv({ ruleMatch: true });
    env.tracker.registerTopLevelListeners();
    const event = env.dnr.onRuleMatchedDebug;
    env.tracker.setActive(false);
    assert.equal(event.listeners.size, 0);
    assert.equal(env.tracker.urlSource(), 'rule-match', 'the source does not depend on the plan');
    env.tracker.setActive(true);
    assert.equal(event.listeners.size, 1);
    env.tracker.setActive(true);
    assert.equal(event.listeners.size, 1);
    env.tracker.setPlan({ redirectCount: 0, owners: [] });
    assert.equal(event.listeners.size, 0);
    env.tracker.setPlan(plan);
    assert.equal(event.listeners.size, 1);
    assert.equal(env.tracker.snapshot().ruleMatchListener, true);
}

/******************************************************************************/

// rule-match filtering: main_frame, the session ruleset, and redirect ranges
// of the plan only (exclusion allows share the ID range).
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const url = 'http://mine.test/page';
    env.match(1, url, sandboxId, { request: { type: 'sub_frame' } });
    env.match(1, url, sandboxId, { rule: { rulesetId: '_dynamic' } });
    env.match(1, url, sandboxId, { rule: { rulesetId: 'ublock-filters' } });
    env.match(1, 'http://ok.test/', allowId);
    env.match(1, url, 1000000);
    env.match(1, url, 7000001);
    env.match(1, 'chrome://settings/', sandboxId);
    env.match(1, 'data:text/html,x', sandboxId);
    env.match(-1, url, sandboxId);
    assert.deepEqual(env.tracker.snapshot().records, []);
    env.at(1790237150010).match(1, url, sandboxId);
    assert.deepEqual(env.tracker.snapshot().records, [ [ 1, {
        url, t: 1790237150010, source: 'rule-match', ruleId: sandboxId,
        owner: { kind: 'sandbox', source: 3 },
    } ] ]);
}

// webRequest: the redirect target is the use_dynamic_url GUID host, and it
// may carry a query and a fragment.
{
    const env = makeEnv({ webRequest: true });
    env.tracker.registerTopLevelListeners();
    env.redirect(4, 'http://ok.test:4346/redir', 'https://ok.test:4346/redir');
    env.redirect(4, 'http://ok.test:4346/x', 'chrome-extension://59b93d32-0631-4265-ae8c-401fb08688f9/other.html');
    env.redirect(4, 'http://ok.test:4346/x', 'moz-extension://59b93d32/strictblock.html');
    env.redirect(4, 'http://ok.test:4346/x', `${guidRedirect}`, { type: 'sub_frame' });
    env.redirect(-1, 'http://ok.test:4346/x', guidRedirect);
    env.redirect(4, 'ftp://ok.test/x', guidRedirect);
    assert.deepEqual(env.tracker.snapshot().records, []);
    const url = 'http://blocked2.test:4346/q?y=10';
    env.at(1790237174232).redirect(4, url, `${guidRedirect}?rs=abc#frag0`);
    const [ [ tabId, rec ] ] = env.tracker.snapshot().records;
    assert.equal(tabId, 4);
    assert.deepEqual(rec, { url, t: 1790237174232, source: 'webrequest' });
    // The static extension ID is accepted as well.
    env.redirect(5, url, 'chrome-extension://iecohobhkoadkjnknmhlohdambhnncpd/strictblock.html');
    assert.equal(env.tracker.snapshot().records.length, 2);
}

// webRequest after a server redirect, in the order Chrome 153 fires the
// events (tmp/t7/debug-webrequest.mjs, requestId 41): there is no
// onBeforeRedirect for the DNR hop, only onBeforeRequest for strictblock.html
// with the same requestId, and the start of the navigation reaches the worker
// last. The page gets the address it was redirected to, without waiting.
{
    const env = makeEnv({ webRequest: true, ruleMatch: false });
    env.tracker.registerTopLevelListeners();
    const timeOrigin = 1790237162146.3;
    const start = 'http://ok.test:36610/redirect?to=http%3A%2F%2F007itshop.com';
    const blocked = 'http://007itshop.com:36610/c4/after-redirect?q=4';
    env.at(timeOrigin + 20).request(3, start, '41', { timeStamp: timeOrigin + 1 });
    env.at(timeOrigin + 22).redirect(3, start, blocked, { requestId: '41', timeStamp: timeOrigin + 18 });
    env.at(timeOrigin + 23).request(3, blocked, '41', { timeStamp: timeOrigin + 19 });
    // Another tab's request in between must not mix in.
    env.request(4, 'http://other.test/', '42');
    assert.deepEqual(env.tracker.snapshot().records, []);
    env.at(timeOrigin + 25).request(3, `${guidRedirect}`, '41', { timeStamp: timeOrigin + 24 });
    env.at(timeOrigin + 71).navigate(3, start, 0, { timeStamp: timeOrigin });
    assert.deepEqual(env.tracker.snapshot().records, [ [ 3, {
        url: blocked, t: timeOrigin + 24, source: 'webrequest',
    } ] ]);
    const pending = await ask(env, 3, timeOrigin);
    assert.equal(env.timers.size, 0, 'no wait for a navigation which started earlier');
    assert.deepEqual(pending.result, { url: blocked, source: 'webrequest' });
    // An extension page without a web address before it, or a sub-frame,
    // records nothing.
    env.request(5, guidRedirect, '51');
    env.request(5, 'http://sub.test/', '52', { type: 'sub_frame' });
    env.request(5, guidRedirect, '52');
    assert.deepEqual(env.tracker.snapshot().records, []);
}

// webRequest, direct block: onBeforeRedirect names it, and the following
// onBeforeRequest for strictblock.html does not record it a second time.
{
    const env = makeEnv({ webRequest: true, ruleMatch: false });
    env.tracker.registerTopLevelListeners();
    const blocked = 'http://blocked.test/direct';
    let writes = 0;
    const write = env.session.set.bind(env.session);
    env.session.set = (key, value) => { writes += 1; return write(key, value); };
    env.request(6, blocked, '61');
    env.redirect(6, blocked, guidRedirect, { requestId: '61' });
    env.request(6, guidRedirect, '61');
    await env.tracker.flush();
    assert.equal(env.tracker.snapshot().records.length, 1);
    assert.equal(writes, 1);
}
// Removing the permission removes both listeners.
{
    const env = makeEnv({ webRequest: true, permissionGranted: true });
    env.tracker.registerTopLevelListeners();
    const namespace = env.webRequestNamespace;
    env.granted = false;
    assert.equal(await env.tracker.permissionsChanged(), 'rule-match');
    assert.equal(namespace.onBeforeRedirect.listeners.size, 0);
    assert.equal(namespace.onBeforeRequest.listeners.size, 0);
}

/******************************************************************************/

// Freshness with the measured timings: the match arrives 2-70 ms after the
// page's timeOrigin (C1-C13), and the page gets it without waiting.
for ( const [ name, timeOrigin, t, url ] of [
    [ 'C1 new tab', 1790237158283.6, 1790237158315, 'http://blocked.test:4346/some/path?q=1#frag' ],
    [ 'C2 typed', 1790237159602.9, 1790237159607, 'http://blocked.test:4346/typed?t=2' ],
    [ 'C4 server redirect', 1790237162915.2, 1790237162950, 'http://blocked.test:4346/secret/landing?x=2' ],
    [ 'C8 cold worker', 1790237169551.6, 1790237169622, 'http://blocked.test:4346/cold?c=8' ],
    [ 'C13 second', 1790237181179.1, 1790237181181, 'http://blocked.test:4346/second?n=13' ],
] ) {
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    env.at(t).match(9, url, stockId);
    const pending = await ask(env, 9, timeOrigin);
    assert.equal(env.timers.size, 0, `${name}: no wait`);
    assert.deepEqual(pending.result, {
        url, source: 'rule-match', owner: { kind: 'stock', rulesetId: 'ublock-filters', source: 7 },
    }, name);
}

// C13, two quick navigations in one tab (measured): the first match at
// 181130, the second navigation starts at 181180, its page's timeOrigin is
// 181179.1 and its match arrives at 181181. The first address, 49 ms before
// the page's timeOrigin, is inside the clock slack but superseded by the
// later navigation: the page waits for its own match instead of showing it.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const first = 'http://blocked.test:4346/first?n=13';
    const second = 'http://blocked.test:4346/second?n=13';
    env.at(1790237181129).navigate(13, first);
    env.at(1790237181130).match(13, first, sandboxId);
    env.at(1790237181180).navigate(13, second);
    const pending = await ask(env, 13, 1790237181179.1);
    assert.equal(pending.result, undefined, 'the first address is stale for the second page');
    assert.deepEqual(Array.from(env.timers.values(), t => t.ms), [ 1500 ]);
    env.at(1790237181181).match(13, second, sandboxId);
    assert.deepEqual(await pending.promise, {
        url: second, source: 'rule-match', owner: { kind: 'sandbox', source: 3 },
    });
    assert.equal(env.timers.size, 0, 'the timer is cleared');
    assert.deepEqual(env.tracker.snapshot().pendingTabs, []);
    // Both matches already in: the second page gets the second address.
    const both = makeEnv();
    both.tracker.registerTopLevelListeners();
    both.tracker.setPlan(plan);
    both.at(1790237181129).navigate(13, first);
    both.at(1790237181130).match(13, first, sandboxId);
    both.at(1790237181180).navigate(13, second);
    both.at(1790237181181).match(13, second, sandboxId);
    const late = await ask(both, 13, 1790237181179.1);
    assert.equal(late.result.url, second);
    // With the navigation's own start time (webNavigation timeStamp) the
    // second navigation supersedes the first address just the same.
    const stamped = makeEnv();
    stamped.tracker.registerTopLevelListeners();
    stamped.tracker.setPlan(plan);
    stamped.at(1790237181130).match(13, first, sandboxId);
    stamped.at(1790237181200).navigate(13, second, 0, { timeStamp: 1790237181178 });
    assert.equal((await ask(stamped, 13, 1790237181179.1)).result, undefined);
    assert.equal(stamped.timers.size, 1);
    // A navigation start to the same address does not supersede (the
    // navigation event often arrives after the match, C10-C12).
    const same = makeEnv();
    same.tracker.registerTopLevelListeners();
    same.tracker.setPlan(plan);
    same.at(1790237174232).match(10, 'http://blocked2.test:4346/q?y=10', stockId);
    same.at(1790237174278).navigate(10, 'http://blocked2.test:4346/q?y=10');
    const pendingSame = await ask(same, 10, 1790237174200.5);
    assert.equal(pendingSame.result.url, 'http://blocked2.test:4346/q?y=10');
}

// C4 with rule-match: after a server redirect the start of the redirecting
// navigation arrives after the match of the address it led to (measured:
// match 35 ms, navigation start 71 ms after timeOrigin). It started before
// the match, so it supersedes nothing: the page gets the address at once
// instead of after the 1,500 ms wait.
{
    const timeOrigin = 1790237162146.2;
    const start = 'http://ok.test:4346/redirect?to=blocked';
    const blocked = 'http://blocked.test:4346/secret/landing?x=2';
    // Timed by the navigation's own start (webNavigation timeStamp).
    const stamped = makeEnv();
    stamped.tracker.registerTopLevelListeners();
    stamped.tracker.setPlan(plan);
    stamped.at(timeOrigin + 35).match(9, blocked, stockId);
    stamped.at(timeOrigin + 71).navigate(9, start, 0, { timeStamp: timeOrigin - 1 });
    const pending = await ask(stamped, 9, timeOrigin);
    assert.equal(stamped.timers.size, 0, 'no wait');
    assert.equal(pending.result.url, blocked);
    // Without a timeStamp (arrival time): a record from after timeOrigin
    // can only belong to this page.
    const arrival = makeEnv();
    arrival.tracker.registerTopLevelListeners();
    arrival.tracker.setPlan(plan);
    arrival.at(timeOrigin + 35).match(9, blocked, stockId);
    arrival.at(timeOrigin + 60).navigate(9, start);
    const unstamped = await ask(arrival, 9, timeOrigin);
    assert.equal(arrival.timers.size, 0, 'no wait');
    assert.equal(unstamped.result.url, blocked);
}

// A match older than timeOrigin - 100 ms belongs to an earlier page; a late
// event resolves the waiter. Inside the slack, the clock difference between
// page and worker is absorbed.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const timeOrigin = 1790237200000.4;
    env.at(timeOrigin - 150).match(3, 'http://mine.test/old', sandboxId);
    const pending = await ask(env, 3, timeOrigin);
    assert.equal(pending.result, undefined);
    env.at(timeOrigin + 900).match(3, 'http://mine.test/new', sandboxId);
    assert.equal((await pending.promise).url, 'http://mine.test/new');
    env.at(timeOrigin - 40).match(4, 'http://mine.test/skewed', sandboxId);
    assert.equal((await ask(env, 4, timeOrigin)).result.url, 'http://mine.test/skewed');
    assert.deepEqual(await env.tracker.getDetails(1.5, timeOrigin), { url: '', source: 'none' });
    assert.deepEqual(await env.tracker.getDetails(3, Number.NaN), { url: '', source: 'none' });
}

// No exact event within 1,500 ms: the navigation start, marked approximate;
// nothing within 1,000 ms before timeOrigin: no address at all.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const timeOrigin = 1790237300000.2;
    env.at(timeOrigin + 1).navigate(6, 'http://start.test/redir?to=x');
    env.navigate(6, 'http://start.test/frame', 1);
    env.navigate(6, 'chrome-extension://iecohobhkoadkjnknmhlohdambhnncpd/strictblock.html');
    env.navigate(6, 'about:blank');
    const pending = await ask(env, 6, timeOrigin);
    assert.equal(pending.result, undefined, 'an exact source is listening: wait for it');
    assert.deepEqual(Array.from(env.timers.values(), t => t.ms), [ 1500 ]);
    env.fireTimers();
    assert.deepEqual(await pending.promise, { url: 'http://start.test/redir?to=x', source: 'navigation-start' });
    env.at(timeOrigin - 1500).navigate(7, 'http://start.test/old');
    const stale = await ask(env, 7, timeOrigin);
    env.fireTimers();
    assert.deepEqual(await stale.promise, { url: '', source: 'none' });
}

// Without an exact source (packed install, no webRequest) only the
// navigation start can come, possibly after the page asked (C10-C12: up to
// 46 ms after the match).
{
    const env = makeEnv({ ruleMatch: false });
    env.tracker.registerTopLevelListeners();
    const timeOrigin = 1790237310000.2;
    env.at(timeOrigin - 2).navigate(6, 'http://start.test/known');
    const known = await ask(env, 6, timeOrigin);
    assert.equal(env.timers.size, 0);
    assert.deepEqual(known.result, { url: 'http://start.test/known', source: 'navigation-start' });
    const pending = await ask(env, 7, timeOrigin);
    assert.equal(pending.result, undefined);
    env.at(timeOrigin + 46).navigate(7, 'http://start.test/late');
    assert.deepEqual(await pending.promise, { url: 'http://start.test/late', source: 'navigation-start' });
    assert.equal(env.timers.size, 0);
    const never = await ask(env, 8, timeOrigin);
    env.fireTimers();
    assert.deepEqual(await never.promise, { url: '', source: 'none' });
    // An inactive plan removes the firehose: nothing exact is awaited.
    const inactive = makeEnv();
    inactive.tracker.registerTopLevelListeners();
    inactive.tracker.setActive(false);
    inactive.at(timeOrigin + 3).navigate(9, 'http://start.test/inactive');
    assert.equal((await ask(inactive, 9, timeOrigin)).result.source, 'navigation-start');
    assert.equal(inactive.timers.size, 0);
}

// A superseded record which no newer event replaced is still better than
// the navigation start once the wait is over.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const timeOrigin = 1790237400000.7;
    env.at(timeOrigin - 30).match(8, 'http://blocked.test/final', sandboxId);
    env.at(timeOrigin - 10).navigate(8, 'http://redirector.test/');
    const pending = await ask(env, 8, timeOrigin);
    assert.equal(pending.result, undefined);
    env.fireTimers();
    assert.equal((await pending.promise).url, 'http://blocked.test/final');
}

// Tab removal forgets the tab and releases its waiters.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const timeOrigin = 1790237500000.1;
    env.at(timeOrigin + 5).navigate(11, 'http://gone.test/');
    env.at(timeOrigin - 500).match(11, 'http://gone.test/old', sandboxId);
    env.at(timeOrigin - 500).match(12, 'http://kept.test/', sandboxId);
    await env.tracker.flush();
    const pending = await ask(env, 11, timeOrigin);
    env.tracker.onTabRemoved(11);
    assert.deepEqual(await pending.promise, { url: '', source: 'none' });
    assert.equal(env.timers.size, 0);
    const snapshot = env.tracker.snapshot();
    assert.deepEqual(snapshot.records.map(([ tabId ]) => tabId), [ 12 ]);
    assert.deepEqual(snapshot.navigations, []);
    assert.deepEqual(snapshot.pendingTabs, []);
    await env.tracker.flush();
    assert.deepEqual(env.session.get(LAST_MATCH_STORAGE_KEY).records.map(([ tabId ]) => tabId), [ 12 ]);
}

// 64-tab LRU, records and navigation starts alike.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    for ( let tabId = 1; tabId <= 70; tabId++ ) {
        env.match(tabId, `http://mine.test/${tabId}`, sandboxId);
        env.navigate(tabId, `http://mine.test/${tabId}`);
        if ( tabId === 50 ) { env.match(7, 'http://mine.test/7b', sandboxId); }
    }
    const { records, navigations } = env.tracker.snapshot();
    assert.equal(records.length, 64);
    assert.equal(navigations.length, 64);
    const tabs = records.map(([ tabId ]) => tabId);
    // Tab 7 was recorded again after tab 50: the six oldest go.
    assert.equal(tabs.includes(7), true, 'a recent record moves to the end');
    assert.deepEqual([ 1, 2, 3, 4, 5, 6 ].filter(tabId => tabs.includes(tabId)), []);
    assert.equal(tabs[0], 8);
    assert.equal(tabs.at(-1), 70);
    await env.tracker.flush();
    assert.equal(env.session.get(LAST_MATCH_STORAGE_KEY).records.length, 64);
    const small = makeEnv({ maxTabs: 2 });
    small.tracker.registerTopLevelListeners();
    small.tracker.setPlan(plan);
    for ( const tabId of [ 1, 2, 3 ] ) { small.match(tabId, 'http://mine.test/', sandboxId); }
    assert.deepEqual(small.tracker.snapshot().records.map(([ tabId ]) => tabId), [ 2, 3 ]);
}

/******************************************************************************/

// storage.session mirror: a worker restarted between the event and the
// page's question still answers; malformed entries are dropped; records the
// new worker received itself win.
{
    const session = new Map();
    const before = makeEnv({ session });
    before.tracker.registerTopLevelListeners();
    before.tracker.setPlan(plan);
    const timeOrigin = 1790237600000.5;
    before.at(timeOrigin + 20).match(21, 'http://mine.test/before-restart', sandboxId);
    before.at(timeOrigin + 20).match(22, 'http://mine.test/also-before', sandboxId);
    await before.tracker.flush();
    const mirror = session.get(LAST_MATCH_STORAGE_KEY);
    assert.equal(mirror.schemaVersion, 1);
    mirror.records.push(
        [ -1, { url: 'http://x.test/', t: timeOrigin, source: 'rule-match' } ],
        [ 23, { url: 'javascript:alert(1)', t: timeOrigin, source: 'rule-match' } ],
        [ 24, { url: 'http://x.test/', t: timeOrigin, source: 'navigation-start' } ],
        [ 25, { url: 'http://x.test/', t: 'soon', source: 'webrequest' } ],
        [ 26, { url: 'http://x.test/', t: timeOrigin, source: 'webrequest', owner: { kind: 'evil' } } ],
        'garbage',
    );
    session.set(PLAN_STORAGE_KEY, plan);
    const after = makeEnv({ session });
    after.tracker.registerTopLevelListeners();
    after.at(timeOrigin + 30).match(22, 'http://mine.test/after-restart', sandboxId);
    const pending = await ask(after, 21, timeOrigin);
    assert.deepEqual(pending.result, {
        url: 'http://mine.test/before-restart', source: 'rule-match',
        owner: { kind: 'sandbox', source: 3 },
    });
    assert.equal((await ask(after, 22, timeOrigin)).result.url, 'http://mine.test/after-restart');
    // Answered records are dropped; what nobody asked for yet stays.
    const tabs = after.tracker.snapshot().records.map(([ tabId ]) => tabId);
    assert.deepEqual(tabs, [ 26 ]);
    assert.equal(after.tracker.snapshot().records[0][1].owner, undefined);
    await after.tracker.flush();
    assert.deepEqual(session.get(LAST_MATCH_STORAGE_KEY).records.map(([ tabId ]) => tabId), [ 26 ]);
}

// storage.session is open to content scripts: a stored record from the
// future is refused, since it would win every later selection.
{
    const session = new Map();
    const timeOrigin = 1790237610000.5;
    session.set(LAST_MATCH_STORAGE_KEY, { schemaVersion: 1, records: [
        [ 27, { url: 'http://planted.test/', t: timeOrigin + 60000, source: 'webrequest' } ],
        [ 28, { url: 'http://recent.test/', t: timeOrigin + 5, source: 'webrequest' } ],
    ] });
    const env = makeEnv({ session, ruleMatch: false });
    env.at(timeOrigin + 50);
    env.tracker.registerTopLevelListeners();
    const none = await ask(env, 99, timeOrigin);
    env.fireTimers();
    await none.promise;
    assert.deepEqual(env.tracker.snapshot().records.map(([ tabId ]) => tabId), [ 28 ]);
}

// The page carries the address in its own history entry: once answered, the
// record is gone from memory and from the storage.session copy.
{
    const env = makeEnv();
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    const timeOrigin = 1790237620000.5;
    env.at(timeOrigin + 10).match(29, 'http://mine.test/secret?q=1', sandboxId);
    await env.tracker.flush();
    assert.equal(env.session.get(LAST_MATCH_STORAGE_KEY).records.length, 1);
    assert.equal((await ask(env, 29, timeOrigin)).result.url, 'http://mine.test/secret?q=1');
    await env.tracker.flush();
    assert.deepEqual(env.tracker.snapshot().records, []);
    assert.deepEqual(env.session.get(LAST_MATCH_STORAGE_KEY).records, []);
}

// A worker woken by the match itself has no plan in memory: the record is
// kept and checked against the session plan when the page asks.
{
    const session = new Map([ [ PLAN_STORAGE_KEY, plan ] ]);
    const env = makeEnv({ session });
    env.tracker.registerTopLevelListeners();
    const timeOrigin = 1790237700000.3;
    env.at(timeOrigin + 10).match(31, 'http://ok.test/', allowId);
    env.at(timeOrigin + 10).match(32, 'http://imported.test/doc', importedId);
    const allowed = await ask(env, 31, timeOrigin);
    assert.equal(allowed.result, undefined, 'an exclusion allow is not a blocked address');
    env.fireTimers();
    assert.deepEqual(await allowed.promise, { url: '', source: 'none' });
    assert.deepEqual((await ask(env, 32, timeOrigin)).result, {
        url: 'http://imported.test/doc', source: 'rule-match', owner: { kind: 'imported', source: 5 },
    });
    // After the plan is known, allow matches are dropped at once.
    env.match(33, 'http://ok.test/', allowId);
    assert.equal(env.tracker.snapshot().records.some(([ tabId ]) => tabId === 33), false);
    // A plan change drops the cached owners and reads the new plan.
    const renumbered = structuredClone(plan);
    for ( const range of renumbered.owners ) { range[2] = range[3] === 'redirect' ? 'imported' : range[2]; }
    session.set(PLAN_STORAGE_KEY, renumbered);
    env.tracker.setActive(true);
    env.at(timeOrigin + 20).match(34, 'http://mine.test/x', sandboxId);
    assert.deepEqual((await ask(env, 34, timeOrigin)).result.owner, { kind: 'imported', source: 3 });
}

/******************************************************************************/

// Owner of a webRequest record: best effort through getMatchedRules.
{
    const timeOrigin = 1790237800000.9;
    const matchedRules = [
        { rule: { rulesetId: '_session', ruleId: allowId }, tabId: 41, timeStamp: timeOrigin + 9 },
        { rule: { rulesetId: 'ublock-filters', ruleId: 10 }, tabId: 41, timeStamp: timeOrigin + 8 },
        { rule: { rulesetId: '_session', ruleId: stockId }, tabId: 41, timeStamp: timeOrigin + 1 },
        { rule: { rulesetId: '_session', ruleId: importedId }, tabId: 41, timeStamp: timeOrigin + 5 },
    ];
    const env = makeEnv({ webRequest: true, matchedRules, session: new Map([ [ PLAN_STORAGE_KEY, plan ] ]) });
    env.tracker.registerTopLevelListeners();
    env.at(timeOrigin + 6).redirect(41, 'http://imported.test/a', guidRedirect);
    const pending = await ask(env, 41, timeOrigin);
    assert.deepEqual(pending.result, {
        url: 'http://imported.test/a', source: 'webrequest', owner: { kind: 'imported', source: 5 },
    });
    assert.deepEqual(env.matchedRulesCalls, [ { tabId: 41, minTimeStamp: Math.floor(timeOrigin - 100) } ]);
    // The navigation-start source is named the same way.
    const approximate = makeEnv({ ruleMatch: false, matchedRules, session: new Map([ [ PLAN_STORAGE_KEY, plan ] ]) });
    approximate.tracker.registerTopLevelListeners();
    approximate.at(timeOrigin + 1).navigate(41, 'http://imported.test/start');
    const approx = await ask(approximate, 41, timeOrigin);
    approximate.fireTimers();
    assert.deepEqual(await approx.promise, {
        url: 'http://imported.test/start', source: 'navigation-start', owner: { kind: 'imported', source: 5 },
    });
    // A failing or absent getMatchedRules leaves the owner unknown.
    for ( const rules of [ new Error('quota'), undefined ] ) {
        const failing = makeEnv({ webRequest: true, matchedRules: rules, session: new Map([ [ PLAN_STORAGE_KEY, plan ] ]) });
        failing.tracker.registerTopLevelListeners();
        failing.at(timeOrigin + 6).redirect(42, 'http://imported.test/b', guidRedirect);
        assert.deepEqual((await ask(failing, 42, timeOrigin)).result, {
            url: 'http://imported.test/b', source: 'webrequest',
        });
    }
}

assert.deepEqual(sanitizeStrictBlockOwner({ kind: 'stock', rulesetId: 'fra-0', source: 2, x: 1 }),
    { kind: 'stock', rulesetId: 'fra-0', source: 2 });
for ( const owner of [ null, 'sandbox', { kind: 'stock' }, { kind: 'stock', rulesetId: '../x' },
    { kind: 'developer' } ] ) {
    assert.equal(sanitizeStrictBlockOwner(owner), undefined, JSON.stringify(owner));
}

// The optional webRequest permission granted, then removed, while the worker
// runs: the firehose goes away and comes back.
{
    const env = makeEnv({ ruleMatch: true, permissionGranted: false });
    env.tracker.registerTopLevelListeners();
    env.tracker.setActive(true);
    assert.equal(env.tracker.urlSource(), 'rule-match');
    assert.equal(await env.tracker.permissionsChanged(), 'rule-match', 'no namespace, no source');
    env.webRequestNamespace = { onBeforeRedirect: makeEvent(), onBeforeRequest: makeEvent() };
    assert.equal(await env.tracker.permissionsChanged(), 'rule-match', 'a namespace without the grant is not a source');
    assert.equal(env.webRequestNamespace.onBeforeRedirect.listeners.size, 0);
    env.granted = true;
    assert.equal(await env.tracker.permissionsChanged(), 'webrequest');
    assert.equal(env.webRequestNamespace.onBeforeRedirect.listeners.size, 1);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0);
    env.granted = false;
    assert.equal(await env.tracker.permissionsChanged(), 'rule-match');
    assert.equal(env.webRequestNamespace.onBeforeRedirect.listeners.size, 0);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 1);
    env.tracker.setActive(false);
    env.granted = true;
    await env.tracker.permissionsChanged();
    env.granted = false;
    await env.tracker.permissionsChanged();
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0, 'inactive stays inactive');
}

// The low-memory profile gives up the onRuleMatchedDebug firehose, which
// keeps the worker alive while the user browses: the source becomes the
// navigation start, and the change is reported so the plan is rebuilt. The
// main-frame webRequest source stays.
{
    const env = makeEnv({ ruleMatch: true });
    env.tracker.registerTopLevelListeners();
    env.tracker.setPlan(plan);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 1);
    assert.equal(env.tracker.setLowMemory(true), true);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0);
    assert.equal(env.tracker.urlSource(), 'navigation-start');
    assert.equal(env.tracker.isExact(), false);
    assert.equal(env.tracker.setLowMemory(true), false, 'no change');
    env.tracker.setPlan(plan);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 0, 'a new plan does not bring it back');
    const timeOrigin = 1790237630000.5;
    env.at(timeOrigin + 2).navigate(30, 'http://mine.test/start');
    const pending = await ask(env, 30, timeOrigin);
    assert.equal(env.timers.size, 0, 'nothing exact to wait for');
    assert.equal(pending.result.source, 'navigation-start');
    assert.equal(env.tracker.setLowMemory(false), true);
    assert.equal(env.dnr.onRuleMatchedDebug.listeners.size, 1);
    assert.equal(env.tracker.urlSource(), 'rule-match');
    const granted = makeEnv({ webRequest: true, ruleMatch: true });
    granted.tracker.registerTopLevelListeners();
    assert.equal(granted.tracker.setLowMemory(true), false);
    assert.equal(granted.tracker.urlSource(), 'webrequest');
    assert.equal(granted.webRequestNamespace.onBeforeRequest.listeners.size, 1);
}

/******************************************************************************/

// The page. Each run stages a fresh copy of strictblock.js on the dashboard
// harness; dom.js, fetch.js and the extension are stubs.

FakeElement.prototype.appendChild = function(node) {
    this.children.push(node);
    return node;
};

const pageDomStub = `
const doc = globalThis.dashboardTestDocument;
const targets = target => {
    if ( typeof target === 'string' ) { return doc.all(target); }
    if ( target === null || target === undefined ) { return []; }
    return Array.isArray(target) ? target : [ target ];
};
export const qs$ = a => doc.one(a);
export const dom = {
    body: doc.body,
    attr(target, name, value) {
        for ( const elem of targets(target) ) {
            if ( value === undefined ) { return elem.getAttribute(name); }
            if ( value === null ) { elem.removeAttribute(name); }
            else { elem.setAttribute(name, value); }
        }
    },
    prop(target, name, value) {
        for ( const elem of targets(target) ) {
            if ( value === undefined ) { return elem[name]; }
            elem[name] = value;
        }
    },
    text(target, text) {
        for ( const elem of targets(target) ) { elem.textContent = text; }
    },
    clear(target) { for ( const elem of targets(target) ) { elem.children = []; } },
    create(tagName) { return doc.createElement(tagName); },
    on(target, type, callback) { doc.handlers.push({ target, type, callback }); },
    cl: {
        add(target, name) { for ( const elem of targets(target) ) { elem.classList.add(name); } },
        remove(target, ...names) { for ( const elem of targets(target) ) { elem.classList.remove(...names); } },
        toggle(target, name, state) { for ( const elem of targets(target) ) { elem.classList.toggle(name, state); } },
    },
};
`;

const pageFetchStub = `
export const fetchJSON = async path => {
    globalThis.strictblockTestFetches.push(path);
    return structuredClone(globalThis.strictblockTestFiles[path]);
};
`;

const urlskipSource = await fs.readFile(path.join(projectRoot, 'src/js/urlskip.js'), 'utf8');

const textOf = node => {
    if ( typeof node === 'string' ) { return node; }
    if ( node instanceof Object === false ) { return ''; }
    return `${node.textContent || ''}${(node.children || []).map(textOf).join('')}`;
};

const pageMessage = (key, substitutions) => {
    if ( key === 'strictblockReasonSentence1' ) { return 'Blocked by {{listname}}.'; }
    if ( substitutions !== undefined ) { return `[${key}:${substitutions}]`; }
    return `[${key}]`;
};

const stagedPages = [];

async function runPage({
    hash = '',
    state = null,
    rulesets = [],
    files = {},
    details,
    pageSource,
} = {}) {
    const document = new FakeDocument();
    const register = (selector, tagName = 'div', props = {}) =>
        document.register(selector, new FakeElement(tagName, props));
    const page = {
        document,
        urlText: register('#theURL > p > span:first-of-type', 'span'),
        theURL: register('#theURL'),
        parsed: register('#parsed', 'ul'),
        toggleParse: register('#toggleParse', 'span'),
        reason: register('#reason'),
        urlskip: register('#urlskip'),
        urlNote: register('#urlNote', 'p'),
        disableWarning: register('#disableWarning', 'input'),
        checkbox: register('.input.checkbox', 'span'),
        back: register('#back', 'button', { style: {} }),
        bye: register('#bye', 'button', { style: {} }),
        proceed: register('#proceed', 'button'),
        replaced: [],
        replaceStates: 0,
    };
    page.urlText.append(' ');
    page.toggleParse.classList.add('hidden');
    for ( const elem of [ page.reason, page.urlskip, page.urlNote ] ) {
        elem.setAttribute('hidden', '');
    }
    document.body.classList.add('loading');
    document.createTextNode = text => text;
    const extension = createExtension({
        getMessage: pageMessage,
        dispatch: async request => {
            switch ( request.what ) {
            case 'getEnabledRulesetsDetails':
                return structuredClone(rulesets);
            case 'getStrictBlockDetails':
                if ( details instanceof Error ) { throw details; }
                return structuredClone(details);
            case 'excludeFromStrictBlock':
                return;
            }
        },
    });
    page.messages = extension.messages;
    const staged = await stageModules({
        modules: pageSource === undefined ? [ 'strictblock.js' ] : [],
        stubs: {
            'dom.js': pageDomStub,
            'fetch.js': pageFetchStub,
            'urlskip.js': urlskipSource,
            ...(pageSource === undefined ? {} : { 'strictblock.js': pageSource }),
        },
        document,
        extension,
        location: `chrome-extension://iecohobhkoadkjnknmhlohdambhnncpd/strictblock.html${hash}`,
    });
    stagedPages.push(staged);
    const location = globalThis.location;
    location.replace = url => { page.replaced.push(url); };
    globalThis.history = {
        length: 1,
        state: structuredClone(state),
        replaceState(newState, title, url) {
            page.replaceStates += 1;
            this.state = structuredClone(newState);
            location.hash = new URL(url, location.href).hash;
        },
        back() {},
    };
    globalThis.close = ( ) => {};
    globalThis.DocumentFragment = class extends FakeElement {
        constructor() { super('#document-fragment'); }
    };
    globalThis.strictblockTestFiles = files;
    globalThis.strictblockTestFetches = page.fetches = [];
    await import(`${pathToFileURL(path.join(staged.staging, 'strictblock.js')).href}`);
    for ( let i = 0; i < 50 && document.body.classList.contains('loading'); i++ ) {
        await settle(1);
    }
    await settle();
    page.location = location;
    page.history = globalThis.history;
    page.proceedHandlers = document.handlers.filter(h => h.target === '#proceed' && h.type === 'click');
    page.clickProceed = async ( ) => {
        await Promise.all(page.proceedHandlers.map(h => h.callback({})));
        await settle();
    };
    return page;
}

const stockRulesets = [
    { id: 'ublock-filters', name: 'uBlock filters – Ads', rules: { strictblock: 3 } },
    { id: 'easylist', name: 'EasyList', rules: { strictblock: 1 } },
];

// No fragment: the worker's answer, then carried in the history entry.
{
    const url = 'http://blocked.test:4346/secret/landing?x=2';
    const page = await runPage({
        rulesets: stockRulesets,
        details: { url, source: 'rule-match', owner: { kind: 'sandbox', source: 3 } },
    });
    const ask = page.messages.find(m => m.what === 'getStrictBlockDetails');
    assert.equal(ask.timeOrigin, performance.timeOrigin);
    assert.equal(page.location.hash, `#${url}`);
    assert.deepEqual(page.history.state, {
        ublockPlusStrictBlock: { source: 'rule-match', owner: { kind: 'sandbox' } },
    });
    assert.equal(textOf(page.urlText).includes('blocked.test'), true);
    assert.equal(textOf(page.urlText).replace(' ', ''), url);
    assert.equal(page.urlNote.getAttribute('hidden'), '');
    assert.equal(page.proceed.disabled, false);
    assert.equal(textOf(page.reason), 'Blocked by [myFiltersPageName].');
    assert.equal(page.reason.getAttribute('hidden'), null);
    assert.deepEqual(page.fetches, [], 'a known owner needs no rule search');
    assert.equal(page.document.body.classList.contains('loading'), false);
    await page.clickProceed();
    assert.deepEqual(page.messages.at(-1), {
        what: 'excludeFromStrictBlock', hostname: 'blocked.test', permanent: false,
    });
    assert.deepEqual(page.replaced, [ url ]);
}

// Back/Forward, reload, duplicate: the fragment and the state are enough,
// and an approximate address stays marked as such.
{
    const page = await runPage({
        hash: '#http://start.test/redir?to=1',
        state: { other: 1, ublockPlusStrictBlock: { source: 'navigation-start' } },
        rulesets: stockRulesets,
        files: { '/rulesets/strictblock/ublock-filters': [], '/rulesets/strictblock/easylist': [] },
    });
    assert.equal(page.messages.some(m => m.what === 'getStrictBlockDetails'), false);
    assert.equal(page.replaceStates, 0);
    assert.equal(page.urlNote.getAttribute('hidden'), null);
    assert.equal(page.urlNote.textContent, '[strictblockPlusUrlApproximate]');
    assert.equal(page.proceed.disabled, false);
    // A permanent "don't warn" must not rest on a guessed host: after a
    // server redirect the navigation started at the redirector.
    assert.equal(page.disableWarning.disabled, true);
    assert.equal(page.checkbox.getAttribute('disabled'), '');
    page.disableWarning.checked = true;
    await page.clickProceed();
    assert.deepEqual(page.messages.at(-1), {
        what: 'excludeFromStrictBlock', hostname: 'start.test', permanent: false,
    });
    assert.deepEqual(page.replaced, [ 'http://start.test/redir?to=1' ]);
}

// An exact address keeps the permanent choice.
{
    const page = await runPage({
        details: { url: 'http://blocked.test/x', source: 'webrequest' },
        rulesets: stockRulesets,
    });
    assert.notEqual(page.disableWarning.disabled, true);
    page.disableWarning.checked = true;
    await page.clickProceed();
    assert.deepEqual(page.messages.at(-1), {
        what: 'excludeFromStrictBlock', hostname: 'blocked.test', permanent: true,
    });
}

// The approximate source from the worker shows the note on first display.
{
    const page = await runPage({
        details: { url: 'http://start.test/', source: 'navigation-start', owner: { kind: 'stock', rulesetId: 'easylist' } },
        rulesets: stockRulesets,
    });
    assert.equal(page.urlNote.textContent, '[strictblockPlusUrlApproximate]');
    assert.equal(page.disableWarning.disabled, true);
    assert.equal(textOf(page.reason), 'Blocked by EasyList.');
    assert.deepEqual(page.history.state.ublockPlusStrictBlock, {
        source: 'navigation-start', owner: { kind: 'stock', rulesetId: 'easylist' },
    });
}

// No address: nothing to show, nothing to proceed to, no site to exclude.
// Non-web addresses are never used, from the fragment or from the worker.
for ( const [ hash, details ] of [
    [ '', { url: '', source: 'none' } ],
    [ '', undefined ],
    [ '', new Error('no receiver') ],
    [ '#javascript:alert(1)', { url: 'chrome://settings/', source: 'rule-match' } ],
    [ '#chrome://settings/', { url: 'javascript:alert(1)', source: 'webrequest' } ],
    [ '#file:///etc/passwd', { url: 'data:text/html,x', source: 'webrequest' } ],
] ) {
    const page = await runPage({ hash, details, rulesets: stockRulesets });
    const label = `${hash} ${JSON.stringify(details)}`;
    assert.equal(page.messages.some(m => m.what === 'getStrictBlockDetails'), true, label);
    assert.equal(page.theURL.getAttribute('hidden'), '', label);
    assert.equal(page.urlNote.getAttribute('hidden'), null, label);
    assert.equal(page.urlNote.textContent, '[strictblockPlusUrlUnavailable]', label);
    assert.equal(page.proceed.disabled, true, label);
    assert.equal(page.disableWarning.disabled, true, label);
    assert.equal(page.checkbox.getAttribute('disabled'), '', label);
    assert.equal(page.proceedHandlers.length, 0, label);
    assert.equal(page.replaceStates, 0, label);
    assert.equal(page.reason.getAttribute('hidden'), '', label);
    assert.equal(page.document.body.classList.contains('loading'), false, label);
}

// The source of the block, from the owner.
for ( const [ owner, text ] of [
    [ { kind: 'stock', rulesetId: 'ublock-filters' }, 'Blocked by uBlock filters – Ads.' ],
    [ { kind: 'imported' }, 'Blocked by [3pGroupImported].' ],
    [ { kind: 'sandbox' }, 'Blocked by [myFiltersPageName].' ],
] ) {
    const page = await runPage({
        details: { url: 'http://blocked.test/', source: 'webrequest', owner },
        rulesets: stockRulesets,
    });
    assert.equal(textOf(page.reason), text);
}

// Unknown owner: the rule files are searched only when they carry the URL in
// a regexSubstitution (Firefox builds). An extensionPath file with urlFilter
// rules has no regex: it must not match everything.
{
    const extensionPathFile = [ { id: 1, priority: 29, action: redirectAction,
        condition: { urlFilter: '||other.test^', resourceTypes: [ 'main_frame' ] } } ];
    const legacyFile = [ { id: 1, priority: 29,
        action: { type: 'redirect', redirect: { regexSubstitution: '/strictblock.html#\\0' } },
        condition: { regexFilter: '^https?://ads\\.example/', requestDomains: [ 'example' ],
            resourceTypes: [ 'main_frame' ] } } ];
    const onlyExtensionPath = await runPage({
        hash: '#http://ads.example/x',
        rulesets: [ stockRulesets[0] ],
        files: { '/rulesets/strictblock/ublock-filters': extensionPathFile },
    });
    assert.equal(onlyExtensionPath.reason.getAttribute('hidden'), '');
    assert.equal(textOf(onlyExtensionPath.reason), '');
    const legacy = await runPage({
        hash: '#http://ads.example/x',
        rulesets: stockRulesets,
        files: {
            '/rulesets/strictblock/ublock-filters': extensionPathFile,
            '/rulesets/strictblock/easylist': legacyFile,
        },
    });
    assert.equal(textOf(legacy.reason), 'Blocked by EasyList.');
    assert.equal(legacy.messages.some(m => m.what === 'getStrictBlockDetails'), false);
}

for ( const staged of stagedPages ) { await staged.cleanup(); }

console.log('Strict-block tracker and page tests passed.');
