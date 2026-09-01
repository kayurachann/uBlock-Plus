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

function newCompiledListData() {
    return {
        dnrRules: [],
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
        condition: { requestDomains: [ 'ads.example' ] },
        lineNumber: 1,
    } ],
    rejections: [ {
        status: 'deferred',
        disposition: 'deferred',
        reasonCode: 'popup-runtime-consumer-required',
        lineNumber: 1,
    } ],
}), true);
for ( const invalid of [
    null,
    {},
    { ...newCompiledListData(), dnrRules: {} },
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

console.log('Compiler fault-recovery tests passed');
