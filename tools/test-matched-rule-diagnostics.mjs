/* uBlock Plus+ — matched-rule provenance regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

const listeners = new Set();
const runtimeRules = { _dynamic: [], _session: [] };
const reads = [];
const fetched = [];
let rejectReads = false;
let readGate;
let pendingReads = 0;
let peakPendingReads = 0;
const readRules = async (kind, options) => {
    reads.push({ kind, options });
    if ( rejectReads ) { throw new Error('mock rule lookup failure'); }
    const result = structuredClone(runtimeRules[kind].filter(rule =>
        options?.ruleIds === undefined || options.ruleIds.includes(rule.id)
    ));
    if ( readGate !== undefined ) {
        pendingReads += 1;
        peakPendingReads = Math.max(peakPendingReads, pendingReads);
        try {
            await readGate;
        } finally {
            pendingReads -= 1;
        }
    }
    return result;
};
globalThis.self = globalThis;
globalThis.chrome = {
    runtime: {
        getManifest: () => ({ permissions: [ 'declarativeNetRequestFeedback' ] }),
        getURL: path => `chrome-extension://fixture/${path}`,
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: {
        DYNAMIC_RULESET_ID: '_dynamic',
        SESSION_RULESET_ID: '_session',
        getDynamicRules: options => readRules('_dynamic', options),
        getSessionRules: options => readRules('_session', options),
        onRuleMatchedDebug: {
            addListener: listener => listeners.add(listener),
            removeListener: listener => listeners.delete(listener),
        },
    },
};
globalThis.fetch = async url => {
    fetched.push(url);
    if ( url !== '/rulesets/main/stock.json' ) {
        throw new Error(`Unexpected ruleset asset: ${url}`);
    }
    return { json: async () => [{
        id: 7, action: { type: 'block' }, condition: { urlFilter: 'stock.example' },
    }] };
};

const { getMatchedRules, toggleDeveloperMode } = await import(
    '../platform/mv3/extension/js/debug.js'
);
const emit = (rulesetId, ruleId, url, tabId = 12) => {
    for ( const listener of listeners ) {
        listener({ rule: { rulesetId, ruleId }, request: { tabId, url } });
    }
};
const blockRule = urlFilter => ({
    id: 1, action: { type: 'block' }, condition: { urlFilter },
});
toggleDeveloperMode(true);

runtimeRules._session = [ blockRule('session.example') ];
emit('_session', 1, 'https://session.example/');
let entries = await getMatchedRules(12);
assert.equal(entries.length, 1);
assert.equal(entries[0]?.rule?.condition?.urlFilter, 'session.example',
    'session matches must resolve through the session DNR API');
assert.equal(entries[0].rule.id, '_session/1');
assert.equal(fetched.length, 0, 'runtime rules are not packaged JSON assets');

runtimeRules._dynamic = [ blockRule('before.example') ];
emit('_dynamic', 1, 'https://before.example/');
entries = await getMatchedRules(12);
assert.equal(entries[0].rule.condition.urlFilter, 'before.example');
runtimeRules._dynamic = [ blockRule('after.example') ];
emit('_dynamic', 1, 'https://after.example/');
entries = await getMatchedRules(12);
assert.equal(entries[0].rule.condition.urlFilter, 'after.example',
    'a reused runtime ID must not retain its previous rule details');
assert.equal(entries[1].rule.condition.urlFilter, 'before.example',
    'existing history must retain the rule resolved when its match arrived');
assert.equal(entries[1].request.url, 'https://before.example/');
assert.ok(reads.every(read => read.options?.ruleIds?.length === 1),
    'event lookup must request only its matched runtime rule');

runtimeRules._dynamic = [];
emit('_dynamic', 1, 'https://removed.example/');
entries = await getMatchedRules(12);
assert.equal(entries[0].request.url, 'https://removed.example/');
assert.deepEqual(entries[0].rule, { id: '_dynamic/1' },
    'a removed rule keeps its reference without inventing a match condition');
rejectReads = true;
emit('_session', 1, 'https://lookup-failed.example/');
entries = await getMatchedRules(12);
assert.deepEqual(entries[0].rule, { id: '_session/1' });
rejectReads = false;

emit('stock', 7, 'https://stock.example/');
entries = await getMatchedRules(12);
assert.equal(entries[0].rule.condition.urlFilter, 'stock.example');
assert.deepEqual(await getMatchedRules(99), []);
emit('_session', 1, 'https://background.example/', -1);
assert.equal((await getMatchedRules(99))[0].request.tabId, -1);

for ( let i = 0; i < 260; i++ ) {
    emit('_session', 1, `https://bounded.example/${i}`);
}
entries = await getMatchedRules(12);
assert.equal(entries.length, 256);
assert.equal(entries[0].request.url, 'https://bounded.example/259');
toggleDeveloperMode(false);
assert.equal(listeners.size, 0);
assert.deepEqual(await getMatchedRules(12), []);

// Delayed browser APIs must not create an unbounded backlog behind the ring.
let releaseReads;
readGate = new Promise(resolve => { releaseReads = resolve; });
reads.length = 0;
peakPendingReads = 0;
toggleDeveloperMode(true);
for ( let i = 0; i < 3000; i++ ) {
    emit('_session', 1, `https://slow-api.example/${i}`);
}
assert.ok(reads.length > 0 && reads.length <= 32,
    'a burst must bound pending browser lookups independently of the ring');
assert.ok(peakPendingReads <= 32,
    'no more than 32 rule-detail reads may remain in flight');
entries = await getMatchedRules(12);
assert.equal(entries.length, 256);
assert.equal(entries[0].request.url, 'https://slow-api.example/2999');
assert.ok(entries.every(entry =>
    Object.keys(entry.rule).length === 1 && entry.rule.id === '_session/1'
), 'overflow must keep match references without waiting or inventing details');
const issuedBeforeToggle = reads.length;
toggleDeveloperMode(false);
toggleDeveloperMode(true);
emit('_session', 1, 'https://slow-api.example/after-toggle');
assert.equal(reads.length, issuedBeforeToggle,
    'toggling off/on must not reset the budget for unfinished API reads');
assert.deepEqual((await getMatchedRules(12))[0].rule, { id: '_session/1' });
toggleDeveloperMode(false);
readGate = undefined;
releaseReads();
await nextTurn();
assert.equal(pendingReads, 0);
assert.equal(reads.length, issuedBeforeToggle,
    'discarded events must not trigger delayed queued lookups');

// An already-open log request must not return cleared history after disable.
readGate = new Promise(resolve => { releaseReads = resolve; });
toggleDeveloperMode(true);
emit('_session', 1, 'https://cleared-history.example/');
assert.equal(pendingReads, 1,
    'settled lookups must release capacity for the next developer session');
const pendingLog = getMatchedRules(12);
toggleDeveloperMode(false);
assert.deepEqual(await getMatchedRules(12), []);
readGate = undefined;
releaseReads();
assert.deepEqual(await pendingLog, [],
    'an in-flight log response must respect subsequent developer-mode disable');
assert.equal(pendingReads, 0);
console.log('Matched-rule diagnostic provenance tests passed.');
