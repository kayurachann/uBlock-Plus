/* uBlock Plus+ — popup data regressions. GPL-3.0-or-later. */
import {
    countSitePopupBlocks,
    matchesPendingPermission,
} from '../platform/mv3/extension/js/popup-panel-data.js';
import assert from 'node:assert/strict';

const ledger = [
    { action: 'blocked', openerHostname: 'example.com' },
    { action: 'block-failed', openerHostname: 'example.com' },
    { action: 'blocked', openerHostname: 'other.example' },
    { action: 'blocked', openerHostname: 'sub.example.com' },
    { action: 'allow', openerHostname: 'example.com' },
    { action: 'defer', openerHostname: 'example.com' },
    null,
];
assert.equal(countSitePopupBlocks(ledger, 'example.com'), 1);
assert.equal(countSitePopupBlocks(ledger, ''), 0);
assert.equal(countSitePopupBlocks(undefined, 'example.com'), 0);
assert.equal(countSitePopupBlocks(ledger, 'unknown.example'), 0);

const pending = {
    requestId: 'popup-request-1',
    hostname: 'example.com',
    createdAt: 1000,
};
assert.equal(matchesPendingPermission(pending, [ 'example.com' ], 1001), true);
assert.equal(matchesPendingPermission(pending, [ 'other.example' ], 1001), false);
assert.equal(matchesPendingPermission(pending, [ 'all-urls' ], 1001), false);
assert.equal(matchesPendingPermission(pending, [], 1001), false);
assert.equal(matchesPendingPermission(pending, [ 'example.com' ], 31001), false);
assert.equal(matchesPendingPermission(pending, [ 'example.com' ], 999), false);
assert.equal(matchesPendingPermission(undefined, [ 'example.com' ], 1001), false);
assert.equal(matchesPendingPermission({ ...pending, createdAt: NaN }, [], 1001), false);
assert.equal(matchesPendingPermission({ ...pending, requestId: '' }, [ 'example.com' ], 1001), false);
console.log('Popup site counts and permission handoff tests passed');
