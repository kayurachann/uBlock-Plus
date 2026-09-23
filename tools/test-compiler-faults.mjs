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
    DEFAULT_LIST_CACHE_MAX_AGE_DAYS,
    listCacheMaxAgeDays,
    readCachedList,
} from '../platform/mv3/list-cache-policy.js';

import {
    MAX_IMPORTED_SOURCE_BYTES,
    MAX_IMPORTED_SOURCE_FETCHES,
    createImportedFetchBudget,
    isCredentialFreeHTTPS,
} from '../platform/mv3/extension/js/imported-fetch-policy.js';

import {
    cleanupFailedCompiledGeneration,
    finalizeFailedOffscreenCompilation,
    setupManagedOffscreenDocument,
} from '../platform/mv3/extension/js/offscreen-lifecycle.js';

import {
    deserializeCompiledListOr,
    isCompiledListData,
} from '../platform/mv3/extension/js/compiled-cache.js';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isVerifiedSourceKey } from '../platform/mv3/extension/js/verified-source-handoff.js';
import os from 'node:os';
import path from 'node:path';

function newCompiledListData() {
    return {
        dnrRules: [],
        networkUnits: [],
        badfilterKeys: [],
        specificCosmeticDetails: new Map(),
        scriptletDetails: new Map(),
        filterStats: {
            total: 0,
            accepted: 0,
            rejected: 0,
            routed: 0,
            deferred: 0,
        },
        popupFilters: [],
        rejections: [],
        ruleStats: {
            total: 0,
            plain: 0,
            regex: 0,
        },
    };
}

// Only complete compiler payloads may be accepted from persistent cache.
assert.equal(isCompiledListData(newCompiledListData()), true);
assert.equal(isCompiledListData({
    ...newCompiledListData(),
    filterStats: {
        total: 1,
        accepted: 0,
        rejected: 1,
        routed: 1,
        deferred: 1,
    },
    popupFilters: [ {
        schemaVersion: 1,
        routeCode: 'popup-compiler-required',
        kind: 'popup',
        action: 'block',
        important: false,
        condition: {
            requestDomains: [ 'ads.example' ],
            domainType: 'firstParty',
        },
        lineNumber: 1,
    } ],
    rejections: [ {
        status: 'deferred',
        disposition: 'deferred',
        reasonCode: 'unsupported-domain-type',
        classification: 'popup-compiler-required',
        lineNumber: 1,
    } ],
}), true);
assert.equal(isCompiledListData({
    ...newCompiledListData(),
    filterStats: {
        total: 1,
        accepted: 1,
        rejected: 0,
        routed: 1,
        deferred: 0,
    },
    popupFilters: [ {
        schemaVersion: 1,
        routeCode: 'popup-observer-runtime',
        kind: 'popup',
        action: 'block',
        important: false,
        condition: { requestDomains: [ 'ads.example' ] },
        lineNumber: 1,
    } ],
}), true);
for ( const invalid of [
    null,
    {},
    { ...newCompiledListData(), dnrRules: {} },
    { ...newCompiledListData(), networkUnits: undefined },
    { ...newCompiledListData(), badfilterKeys: [ null ] },
    { ...newCompiledListData(), networkUnits: [ { key: 'x', dnrRules: [ null ], popupFilters: [] } ] },
    { ...newCompiledListData(), specificCosmeticDetails: [] },
    { ...newCompiledListData(), scriptletDetails: {} },
    {
        ...newCompiledListData(),
        filterStats: { total: -1, accepted: 0, rejected: 0 },
    },
    {
        ...newCompiledListData(),
        filterStats: {
            total: 1,
            accepted: 1,
            rejected: 1,
            routed: 0,
            deferred: 0,
        },
    },
    {
        ...newCompiledListData(),
        filterStats: {
            total: 1,
            accepted: 0,
            rejected: 1,
            routed: 1,
            deferred: 2,
        },
    },
    {
        ...newCompiledListData(),
        rejections: [ {
            status: 'deferred',
            disposition: 'deferred',
            reasonCode: 'some-other-reason',
            lineNumber: 1,
        } ],
    },
    {
        ...newCompiledListData(),
        popupFilters: [ {
            schemaVersion: 1,
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            condition: { requestDomains: [ 'ads.example' ] },
            lineNumber: 1,
        } ],
    },
    {
        ...newCompiledListData(),
        popupFilters: [ {
            schemaVersion: 1,
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            important: false,
            condition: { domainType: 'firstParty' },
            lineNumber: 1,
        } ],
    },
    {
        ...newCompiledListData(),
        popupFilters: [ {
            schemaVersion: 1,
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            important: false,
            condition: { requestDomains: [ 'ads.example' ] },
            lineNumber: 1,
        } ],
    },
    {
        ...newCompiledListData(),
        popupFilters: [ {
            schemaVersion: 1,
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            important: false,
            condition: { domainType: 'firstParty' },
            lineNumber: 1,
        } ],
        rejections: [ {
            status: 'deferred',
            disposition: 'deferred',
            reasonCode: 'unsupported-request-methods',
            classification: 'popup-compiler-required',
            lineNumber: 1,
        } ],
    },
    {
        ...newCompiledListData(),
        ruleStats: { total: 0, plain: 0.5, regex: 0 },
    },
] ) {
    assert.equal(isCompiledListData(invalid), false);
}

// A healthy cache is returned without invoking the refresh callback.
{
    const compiled = newCompiledListData();
    let invalidations = 0;
    const actual = await deserializeCompiledListOr(
        'serialized',
        value => {
            assert.equal(value, 'serialized');
            return compiled;
        },
        ( ) => {
            invalidations += 1;
        }
    );
    assert.equal(actual, compiled);
assert.equal(invalidations, 0);
}

// Legacy/manual records which predate explicit limits must still receive hard
// finite defaults in the compiler. Caller-provided values can only lower the
// limits, never disable or increase them.
{
    assert.deepEqual(createImportedFetchBudget(), {
        maximumBytes: MAX_IMPORTED_SOURCE_BYTES,
        maximumFetches: MAX_IMPORTED_SOURCE_FETCHES,
        usedBytes: 0,
    });
    assert.deepEqual(createImportedFetchBudget({
        maxBytes: Number.POSITIVE_INFINITY,
        maxFetches: Number.POSITIVE_INFINITY,
    }), {
        maximumBytes: MAX_IMPORTED_SOURCE_BYTES,
        maximumFetches: MAX_IMPORTED_SOURCE_FETCHES,
        usedBytes: 0,
    });
    assert.deepEqual(createImportedFetchBudget({
        maxBytes: 1024,
        maxFetches: 2,
    }), {
        maximumBytes: 1024,
        maximumFetches: 2,
        usedBytes: 0,
    });
    assert.equal(isCredentialFreeHTTPS('https://filters.example/list'), true);
    assert.equal(isCredentialFreeHTTPS('http://filters.example/list'), false);
    assert.equal(
        isCredentialFreeHTTPS('https://user:secret@filters.example/list'),
        false
    );
}

// Verified-source handoffs are accepted only when the whole key matches the
// anchored format and its digest is bound to the selected Filter Store entry.
{
    const digest = 'a'.repeat(64);
    const key = `filterStore.verifiedSource.1725148800000.${'b'.repeat(32)}.${digest}`;
    assert.equal(isVerifiedSourceKey(key, digest), true);
    assert.equal(isVerifiedSourceKey(key, 'c'.repeat(64)), false);
    assert.equal(isVerifiedSourceKey(`${key}.extra`, digest), false);
    assert.equal(isVerifiedSourceKey(`${key}/../other`, digest), false);
}

{
    const fetchSource = await fs.readFile(new URL(
        '../platform/mv3/extension/js/offscreen/fetch-list.js',
        import.meta.url
    ), 'utf8');
    assert.doesNotMatch(fetchSource, /POSITIVE_INFINITY/);
    assert.match(fetchSource, /credentials:\s*'omit'/);
    assert.match(fetchSource, /redirect:\s*'error'/);
    assert.doesNotMatch(fetchSource, /redirect:\s*'follow'/);
    assert.match(fetchSource, /isCredentialFreeHTTPS\(response\.url\)/);

    const compilerSource = await fs.readFile(new URL(
        '../platform/mv3/extension/js/offscreen/compile-filters.js',
        import.meta.url
    ), 'utf8');
    assert.match(
        compilerSource,
        /isVerifiedSourceKey\(\s*list\.verifiedSourceKey,\s*integrity\.digest\s*\)/
    );
    assert.match(compilerSource, /redirect:\s*'error'/);
    assert.doesNotMatch(compilerSource, /redirect:\s*'follow'/);
}

// Corrupt bytes and structurally invalid payloads both fall back to an
// awaited refresh, so one damaged list cannot abort the whole compiler run.
for ( const deserialize of [
    ( ) => { throw new Error('corrupt cache'); },
    ( ) => ({ dnrRules: [] }),
] ) {
    const refreshed = newCompiledListData();
    let refreshFinished = false;
    const actual = await deserializeCompiledListOr(
        'corrupt',
        deserialize,
        async ( ) => {
            await Promise.resolve();
            refreshFinished = true;
            return refreshed;
        }
    );
    assert.equal(refreshFinished, true);
    assert.equal(actual, refreshed);
}

// Normal setup closes stale state first, then creates one document.
{
    const events = [];
    const result = await setupManagedOffscreenDocument({
        closeDocument: async ( ) => { events.push('close'); },
        createDocument: async ( ) => { events.push('create'); },
        isCancelled: ( ) => false,
    });
    assert.equal(result, true);
    assert.deepEqual(events, [ 'close', 'create' ]);
}

// Cancellation while stale state is being closed must prevent creation.
{
    const closeGate = Promise.withResolvers();
    const closeEntered = Promise.withResolvers();
    const events = [];
    let cancelled = false;
    const setup = setupManagedOffscreenDocument({
        closeDocument: async ( ) => {
            events.push('close');
            closeEntered.resolve();
            await closeGate.promise;
        },
        createDocument: async ( ) => { events.push('create'); },
        isCancelled: ( ) => cancelled,
    });
    await closeEntered.promise;
    cancelled = true;
    closeGate.resolve();
    assert.equal(await setup, false);
    assert.deepEqual(events, [ 'close' ]);
}

// Cancellation while createDocument is pending requires a second close after
// that late creation settles; otherwise an orphan offscreen document survives.
{
    const createGate = Promise.withResolvers();
    const createEntered = Promise.withResolvers();
    const events = [];
    let cancelled = false;
    const setup = setupManagedOffscreenDocument({
        closeDocument: async ( ) => { events.push('close'); },
        createDocument: async ( ) => {
            events.push('create');
            createEntered.resolve();
            await createGate.promise;
        },
        isCancelled: ( ) => cancelled,
    });
    await createEntered.promise;
    cancelled = true;
    createGate.resolve();
    assert.equal(await setup, false);
    assert.deepEqual(events, [ 'close', 'create', 'close' ]);
}

// Remove generation data before its recovery marker. A failed generation
// cleanup must leave the marker in place for startup recovery to retry.
{
    const events = [];
    await cleanupFailedCompiledGeneration({
        removeGeneration: async ( ) => { events.push('generation'); },
        removeMarker: async ( ) => { events.push('marker'); },
    });
    assert.deepEqual(events, [ 'generation', 'marker' ]);
}

{
    const failure = new Error('storage removal failed');
    const events = [];
    await assert.rejects(
        cleanupFailedCompiledGeneration({
            removeGeneration: async ( ) => {
                events.push('generation');
                throw failure;
            },
            removeMarker: async ( ) => { events.push('marker'); },
        }),
        failure
    );
    assert.deepEqual(events, [ 'generation' ]);
}

// A timeout may occur while createDocument() is still pending. Its late work
// must settle before the final close and generation cleanup, or generation
// keys can be written after their recovery marker has already been removed.
{
    const createGate = Promise.withResolvers();
    const createEntered = Promise.withResolvers();
    const events = [];
    let cancelled = false;
    const setupPromise = setupManagedOffscreenDocument({
        closeDocument: async ( ) => { events.push('close'); },
        createDocument: async ( ) => {
            events.push('create');
            createEntered.resolve();
            await createGate.promise;
            events.push('write-generation');
        },
        isCancelled: ( ) => cancelled,
    });
    await createEntered.promise;
    cancelled = true;
    const finalized = finalizeFailedOffscreenCompilation({
        setupPromise,
        closeDocument: async ( ) => { events.push('close'); },
        cleanupGeneration: ( ) => cleanupFailedCompiledGeneration({
            removeGeneration: async ( ) => { events.push('generation'); },
            removeMarker: async ( ) => { events.push('marker'); },
        }),
    });
    createGate.resolve();
    await finalized;
    assert.deepEqual(events, [
        'close',
        'create',
        'write-generation',
        'close',
        'close',
        'generation',
        'marker',
    ]);
}

// The ruleset build caches downloaded lists across builds. A cached list
// older than the limit is downloaded again, so a release built weeks later
// cannot silently ship old stock rulesets; Infinity reuses a preserved set.
{
    assert.equal(listCacheMaxAgeDays(new Map(), {}), DEFAULT_LIST_CACHE_MAX_AGE_DAYS);
    assert.equal(listCacheMaxAgeDays(new Map([ [ 'listCacheMaxAgeDays', '2' ] ]),
        { UBLOCK_PLUS_LIST_CACHE_MAX_AGE_DAYS: '9' }), 2);
    assert.equal(listCacheMaxAgeDays(new Map(),
        { UBLOCK_PLUS_LIST_CACHE_MAX_AGE_DAYS: 'Infinity' }), Number.POSITIVE_INFINITY);
    for ( const invalid of [ '-1', 'soon' ] ) {
        assert.throws(( ) => listCacheMaxAgeDays(
            new Map([ [ 'listCacheMaxAgeDays', invalid ] ])
        ), /Invalid list cache maximum age/);
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-list-cache-'));
    try {
        const day = 24 * 60 * 60 * 1000;
        const file = path.join(directory, 'easylist.txt');
        await fs.writeFile(file, '||ads.example^');
        const stale = new Date(Date.now() - 8 * day);
        await fs.utimes(file, stale, stale);
        assert.equal(await readCachedList(file, 7), undefined,
            'An eight-day-old download is fetched again');
        const reused = await readCachedList(file, Number.POSITIVE_INFINITY);
        assert.equal(reused.content, '||ads.example^');
        assert.ok(Math.abs(Date.parse(reused.fetchedAt) - stale.getTime()) < 2000,
            'The log records when a reused list was downloaded');
        const recent = new Date(Date.now() - 6 * day);
        await fs.utimes(file, recent, recent);
        assert.equal((await readCachedList(file, 7)).content, '||ads.example^');
        assert.equal(await readCachedList(path.join(directory, 'missing.txt'), 7),
            undefined);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
    const makeRulesets = await fs.readFile(new URL(
        '../platform/mv3/make-rulesets.js', import.meta.url
    ), 'utf8');
    assert.equal(makeRulesets.match(/await readCachedList\(/g)?.length, 2,
        'Stock list and DNR source caches both honour the age limit');
    assert.doesNotMatch(makeRulesets, /fs\.readFile\(\s*`\$\{cacheDir\}\/\$\{(?:platform|fname)/);
}

console.log('Compiler fault-recovery tests passed');
