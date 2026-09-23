/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    applyFreshImportedListMetadata,
    applyImportedListRefreshFailure,
    importedListRefreshTime,
    isImportedListRefreshDue,
    isPendingImportedRefreshStale,
    pendingImportedMetadataKey,
} from '../platform/mv3/extension/js/imported-list-metadata.js';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const token = 'a'.repeat(32);
assert.equal(
    pendingImportedMetadataKey('https://filters.example/list.txt'),
    'rulesets.imported.pendingMetadata.https://filters.example/list.txt'
);
const list = {
    time: { updated: 123 },
    name: 'Old name',
    expires: 7,
};

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        compiledIntegrity: {
            algorithm: 'sha256',
            digest: 'b'.repeat(64),
            bytes: 10,
        },
    }, 456),
    { fresh: false, modified: false }
);
assert.equal(list.time.updated, 123);

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        metadataToken: token,
        title: 'Fresh name',
        expires: 2,
        rejections: [ {
            status: 'deferred',
            disposition: 'deferred',
            reasonCode: 'popup-runtime-consumer-required',
            lineNumber: 7,
        } ],
    }, 456),
    { fresh: true, modified: true }
);
assert.equal(list.time.updated, 456);
assert.equal(list.name, 'Fresh name');
assert.equal(list.compiledMetadataToken, token);
assert.deepEqual(list.rejections, [ {
    status: 'deferred',
    disposition: 'deferred',
    reasonCode: 'popup-runtime-consumer-required',
    lineNumber: 7,
} ]);

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        metadataToken: token,
        title: 'Must not be applied twice',
    }, 789),
    { fresh: true, modified: false }
);
assert.equal(list.time.updated, 456);
assert.equal(list.name, 'Fresh name');

const importedListsSource = await fs.readFile(new URL(
    '../platform/mv3/extension/js/imported-lists.js',
    import.meta.url
), 'utf8');
assert.match(
    importedListsSource,
    /export function cleanupCommittedImportedListUpdates\(updates\)/
);
assert.match(
    importedListsSource,
    /commitImportedListUpdates\(updates, options = \{\}\)/
);
assert.match(importedListsSource, /options\.cleanup !== false/);

// Refresh schedule: unpinned lists expire, pinned bytes never do, and a
// failed refresh backs off instead of retrying on every alarm or wake.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
{
    const unpinned = { expires: 1, time: { updated: 1000 } };
    assert.equal(importedListRefreshTime(unpinned), 1000 + DAY);
    assert.equal(isImportedListRefreshDue(unpinned, 1000 + DAY - 1), false);
    assert.equal(isImportedListRefreshDue(unpinned, 1000 + DAY), true);
    assert.equal(importedListRefreshTime({ time: { updated: 0 } }), 7 * DAY);
    assert.equal(isImportedListRefreshDue({
        ...unpinned,
        sourceIntegrity: { algorithm: 'sha256', digest: 'b'.repeat(64), bytes: 1 },
    }, Number.MAX_SAFE_INTEGER), false);

    const failedAt = 1000 + 2 * DAY;
    assert.equal(applyImportedListRefreshFailure(unpinned, {
        metadataToken: token,
    }), false);
    assert.equal(applyImportedListRefreshFailure(unpinned, {
        refreshFailed: true, failedAt, message: `Filter list failed (HTTP 404) ${'x'.repeat(400)}`,
    }), true);
    assert.equal(importedListRefreshTime(unpinned), failedAt + HOUR);
    // The cause stays visible on the list while its cache gets older.
    assert.equal(unpinned.refreshError.at, failedAt);
    assert.match(unpinned.refreshError.message, /^Filter list failed \(HTTP 404\)/);
    assert.equal(unpinned.refreshError.message.length, 300);
    assert.equal(isImportedListRefreshDue(unpinned, failedAt + HOUR - 1), false);
    // Crash recovery can commit the same activation twice.
    assert.equal(applyImportedListRefreshFailure(unpinned, {
        refreshFailed: true, failedAt,
    }), false);
    assert.equal(unpinned.time.refreshFailures, 1);
    const delays = [];
    for ( let i = 1, at = failedAt; i <= 6; i++ ) {
        at += HOUR;
        applyImportedListRefreshFailure(unpinned, { refreshFailed: true, failedAt: at });
        delays.push(unpinned.time.retryAfter - at);
    }
    assert.deepEqual(delays, [ 2, 4, 8, 16, 24, 24 ].map(n => n * HOUR),
        'Exponential backoff is bounded by one day and the list period');
    assert.equal(applyFreshImportedListMetadata(unpinned, {
        metadataToken: 'c'.repeat(32),
    }, failedAt + DAY).modified, true);
    assert.equal(unpinned.time.retryAfter, undefined);
    assert.equal(unpinned.time.refreshFailures, undefined);
    assert.equal(unpinned.refreshError, undefined, 'A successful refresh clears the error');
    assert.equal(importedListRefreshTime(unpinned), failedAt + 2 * DAY);

    // A refresh awaiting its commit is trusted only briefly: past that, the
    // generations including it have failed to activate. A sidecar without a
    // valid fetch time, including one from a clock set back, is stale.
    const fetchedAt = 10 * DAY;
    assert.equal(isPendingImportedRefreshStale({ fetchedAt }, fetchedAt), false);
    assert.equal(isPendingImportedRefreshStale({ fetchedAt }, fetchedAt + HOUR - 1), false);
    assert.equal(isPendingImportedRefreshStale({ fetchedAt }, fetchedAt + HOUR), true);
    assert.equal(isPendingImportedRefreshStale({ fetchedAt }, fetchedAt - 1), true);
    assert.equal(isPendingImportedRefreshStale({}, fetchedAt), true);
}

// The scheduled job must keep every cache: the compiler replaces a list only
// after its refresh compiled, and a failure is committed as a backoff.
{
    const makeStorageArea = ( ) => {
        const values = new Map();
        return {
            values,
            async get(keys) {
                const names = keys === null || keys === undefined
                    ? Array.from(values.keys())
                    : Array.isArray(keys) ? keys : [ keys ];
                return Object.fromEntries(names.filter(key => values.has(key))
                    .map(key => [ key, structuredClone(values.get(key)) ]));
            },
            async set(entries) {
                for ( const [ key, value ] of Object.entries(entries) ) {
                    values.set(key, structuredClone(value));
                }
            },
            async remove(keys) {
                for ( const key of Array.isArray(keys) ? keys : [ keys ] ) {
                    values.delete(key);
                }
            },
            async getKeys() { return Array.from(values.keys()); },
        };
    };
    const local = makeStorageArea();
    globalThis.self = globalThis;
    globalThis.chrome = {
        alarms: { async clear() { }, async create() { } },
        i18n: { getMessage: ( ) => '' },
        runtime: {
            getManifest: ( ) => ({ permissions: [] }),
            getURL: (value = '') => `chrome-extension://test/${value}`,
            async sendMessage() { },
        },
        storage: { local, session: makeStorageArea(), managed: makeStorageArea() },
    };
    const importedLists = await import(new URL(
        '../platform/mv3/extension/js/imported-lists.js', import.meta.url
    ));
    const now = Date.now();
    const pinnedURL = 'https://filters.example/pinned.txt';
    const expiredURL = 'https://filters.example/expired.txt';
    const freshURL = 'https://filters.example/fresh.txt';
    const makeList = (id, updated, extra = {}) => ({
        id, enabled: true, expires: 1, time: { added: 0, updated }, ...extra,
    });
    local.values.set('rulesets.imported', [
        makeList(pinnedURL, now - 30 * DAY, { sourceIntegrity: {
            algorithm: 'sha256', digest: 'd'.repeat(64), bytes: 10,
        } }),
        makeList(expiredURL, now - 2 * DAY),
        makeList(freshURL, now),
    ]);
    const cacheKeys = [ pinnedURL, expiredURL, freshURL ].flatMap(url => [
        `rulesets.imported.compiled.${url}`, pendingImportedMetadataKey(url),
    ]);
    cacheKeys.forEach(key => local.values.set(key, { serialized: 'cached' }));
    assert.equal(await importedLists.updateImportedLists(), 1);
    assert.deepEqual(cacheKeys.filter(key => local.values.has(key) === false), [],
        'No cache or pending metadata is removed before a refresh succeeds');

    const failedAt = now;
    await importedLists.commitImportedListUpdates([ {
        listid: expiredURL, refreshFailed: true, failedAt, message: 'HTTP 404',
    } ]);
    const expired = local.values.get('rulesets.imported')
        .find(list => list.id === expiredURL);
    assert.equal(expired.time.retryAfter, failedAt + HOUR);
    assert.equal(expired.time.updated, now - 2 * DAY,
        'A failed refresh does not pretend the list is up to date');
    assert.deepEqual(expired.refreshError, { at: failedAt, message: 'HTTP 404' },
        'getImportedLists exposes why the list is not up to date');
    assert.deepEqual((await importedLists.getImportedLists())
        .find(list => list.id === expiredURL).refreshError, expired.refreshError);
    assert.equal(await importedLists.updateImportedLists(), 0,
        'The alarm retry does not refetch during the backoff');
    assert.deepEqual(local.values.get('deferredJobs'), [
        { name: 'updateImportedLists', time: failedAt + HOUR },
    ], 'The next attempt is scheduled for the end of the backoff');
}

console.log('Imported-list metadata tests passed');
