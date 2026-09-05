/* uBlock Plus+ — existing dashboard navigation regression. GPL-3.0-or-later. */
import assert from 'node:assert/strict';

const calls = [];
globalThis.self = globalThis;
let existing = [ { id: 7, windowId: 2, url: 'chrome-extension://test/dashboard.html#settings' } ];
globalThis.chrome = {
    runtime: { getURL: value => `chrome-extension://test${value}` },
    tabs: {
        async query(query) { calls.push([ 'query', query ]); return existing; },
        async update(id, details) { calls.push([ 'update', id, details ]); },
        async create(details) { calls.push([ 'create', details ]); },
    },
    windows: {
        async update(id, details) { calls.push([ 'focus', id, details ]); },
    },
};
const { gotoURL } = await import('../platform/mv3/extension/js/ext-utils.js');
await gotoURL('/dashboard.html#filters');
assert.deepEqual(calls, [
    [ 'query', { url: 'chrome-extension://test/dashboard.html', windowType: 'normal' } ],
    [ 'focus', 2, { focused: true } ],
    [ 'update', 7, { active: true, url: 'chrome-extension://test/dashboard.html#filters' } ],
]);
calls.length = 0;
existing[0].url = 'chrome-extension://test/dashboard.html#filters';
await gotoURL('/dashboard.html#filters');
assert.deepEqual(calls.at(-1), [ 'update', 7, { active: true } ]);
calls.length = 0;
existing = [];
await gotoURL('/dashboard.html#siteRules');
assert.deepEqual(calls.at(-1), [ 'create', {
    active: true, url: 'chrome-extension://test/dashboard.html#siteRules',
} ]);
console.log('Dashboard pane navigation tests passed');
