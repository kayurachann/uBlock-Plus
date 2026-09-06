/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ublock-offscreen-storage-')
);
const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
const originalChrome = globalThis.chrome;
try {
    // Assemble the same compiler modules as the package, without a build or
    // network dependency. Run the real entry point with runtime as its only
    // extension API, matching Chromium's offscreen document environment.
    await fs.cp(path.join(root, 'platform/mv3/extension/js'),
        path.join(temporaryRoot, 'js'), { recursive: true });
    await fs.mkdir(path.join(temporaryRoot, 'lib'), { recursive: true });
    await fs.writeFile(path.join(temporaryRoot, 'package.json'),
        '{"type":"module"}\n');
    await Promise.all([
        ...[ 'arglist-parser', 'jsonpath', 'redirect-resources',
            'static-filtering-parser', 'urlskip' ].map(name => fs.copyFile(
            path.join(root, `src/js/${name}.js`),
            path.join(temporaryRoot, `js/${name}.js`)
            )),
        fs.copyFile(path.join(root, 'src/js/regex-analyzer.js'),
            path.join(temporaryRoot, 'js/offscreen/regex-analyzer.js')),
        fs.copyFile(path.join(root, 'src/lib/punycode.js'),
            path.join(temporaryRoot, 'js/punycode.js')),
        fs.cp(path.join(root, 'src/js/resources'),
            path.join(temporaryRoot, 'js/resources'), { recursive: true }),
        fs.cp(path.join(root, 'src/lib/csstree'),
            path.join(temporaryRoot, 'lib/csstree'), { recursive: true }),
        fs.copyFile(path.join(root,
            'platform/mv3/extension/lib/s14e-serializer/s14e-serializer.js'),
        path.join(temporaryRoot, 'lib/s14e-serializer.js')),
    ]);
    const {
        createCompilerStorageClient,
        createCompilerStorageHandler,
    } = await import(pathToFileURL(path.join(temporaryRoot,
        'js/offscreen-storage.js')));
    const { COMPILED_FILTERS_REVISION } = await import(pathToFileURL(
        path.join(temporaryRoot, 'js/compiled-cache.js')
    ));
    let generation = 'a'.repeat(32);
    const sourceURL = 'https://retest.invalid/fixture.txt';
    const sourceText = [
        '! Title: Offscreen regression fixture',
        '||ads.example^$script',
        '||popup.example^$popup',
    ].join('\n');
    const lists = [ { id: sourceURL, enabled: true } ];
    let sandboxText = '||sandbox.example^$image';
    const persisted = new Map([
        [ 'compiledFilters.activeGeneration', 'b'.repeat(32) ],
        [ `compiledFilters.g.${'b'.repeat(32)}.importedFilters.dnrRules`,
            [ { id: 9000000, action: { type: 'block' },
                condition: { urlFilter: 'last-good' } } ] ],
    ]);
    const originalActive = structuredClone(Array.from(persisted));
    let resultReady;
    let handleStorage;
    let failGenerationWrite = false;
    let failRead = false;
    let isCurrent = true;
    let fetchCount = 0;
    const operations = [];
    const storage = {
        async get(keys) {
            if ( failRead ) { throw new Error('mock unreadable cache'); }
            return Object.fromEntries(keys.filter(key => persisted.has(key))
                .map(key => [ key, structuredClone(persisted.get(key)) ]));
        },
        async set(values) {
            if ( failGenerationWrite && Object.keys(values).some(key =>
                key.startsWith(`compiledFilters.g.${generation}.`)
            ) ) {
                throw new Error('mock storage quota failure');
            }
            for ( const [ key, value ] of Object.entries(values) ) {
                persisted.set(key, structuredClone(value));
            }
        },
        async remove(keys) {
            keys.forEach(key => persisted.delete(key));
        },
    };
    const runtime = {
        async sendMessage(request) {
            switch ( request.what ) {
            case 'compileFilters:getResourceTypes':
                return [ 'main_frame', 'sub_frame', 'script', 'image', 'other' ];
            case 'compileFilters:getMemoryProfile':
                return { importCompileConcurrency: 1 };
            case 'compileFilters:getUserList':
                return sandboxText;
            case 'compileFilters:getEnabledImportedLists':
                return lists;
            case 'compileFilters:storage':
                operations.push(structuredClone(request));
                try {
                    const result = await handleStorage(
                        JSON.parse(JSON.stringify(request))
                    );
                    return JSON.parse(JSON.stringify(result));
                } catch ( reason ) {
                    return { ok: false, error: reason.message };
                }
            case 'compileFilters:result':
                resultReady.resolve(request);
                break;
            default:
                break;
            }
        },
    };
    globalThis.self = { chrome: { runtime } };
    globalThis.chrome = globalThis.self.chrome;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, sourceURL);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        fetchCount += 1;
        const response = new Response(sourceText);
        Object.defineProperty(response, 'url', { value: sourceURL });
        return response;
    };
    let sequence = 0;
    const run = async ( ) => {
        handleStorage = createCompilerStorageHandler({
            generation, lists, storage, isCurrent: ( ) => isCurrent,
        });
        resultReady = Promise.withResolvers();
        self.location = { href:
            `chrome-extension://test/js/offscreen/compile-filters.html?generation=${generation}` };
        const entryURL = pathToFileURL(path.join(temporaryRoot,
            'js/offscreen/compile-filters.js'));
        entryURL.searchParams.set('run', ++sequence);
        const timeout = setTimeout(( ) => resultReady.reject(
            new Error('Offscreen compiler did not report a result')
        ), 5000);
        try {
            await import(entryURL);
            return await resultReady.promise;
        } finally {
            clearTimeout(timeout);
        }
    };
    const result = await run();
    assert.equal(result.persisted, true, JSON.stringify(result.errors));
    assert.equal(operations.length > 0, true);
    assert.equal(fetchCount, 1);
    assert.equal(result.importedListUpdates[0].title,
        'Offscreen regression fixture');
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.importedFilters.dnrRules`
    ).length, 1);
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.importedFilters.popupFilters`
    ).filters.length, 1);
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.sandboxFilters.dnrRules`
    ).length, 1);

    // Warm caches and pending metadata survive a new compiler generation.
    generation = 'c'.repeat(32);
    const warm = await run();
    assert.equal(warm.persisted, true, JSON.stringify(warm.errors));
    assert.equal(fetchCount, 1);
    assert.equal(warm.importedListUpdates[0].metadataToken,
        result.importedListUpdates[0].metadataToken);

    // Personal cancellation must resolve against unmerged source units in a
    // warm imported cache, including the separate popup observer corpus.
    sandboxText += '\n||ads.example^$badfilter,script\n||popup.example^$popup,badfilter';
    generation = '3'.repeat(32);
    const cancelled = await run();
    assert.equal(cancelled.persisted, true, JSON.stringify(cancelled.errors));
    assert.equal(fetchCount, 1);
    assert.equal(persisted.has(
        `compiledFilters.g.${generation}.importedFilters.dnrRules`
    ), false);
    assert.equal(persisted.has(
        `compiledFilters.g.${generation}.importedFilters.popupFilters`
    ), false);
    sandboxText = '||sandbox.example^$image';
    generation = '4'.repeat(32);
    const restored = await run();
    assert.equal(restored.persisted, true, JSON.stringify(restored.errors));
    assert.equal(fetchCount, 1);
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.importedFilters.dnrRules`
    ).length, 1);
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.importedFilters.popupFilters`
    ).filters.length, 1);

    const cacheKey = `rulesets.imported.compiled.${sourceURL}`;
    // An intact cache from an older compiler must rebuild from source, so a
    // previously discarded exception cannot survive an extension update.
    const legacyCache = structuredClone(persisted.get(cacheKey));
    delete legacyCache.compilerRevision;
    persisted.set(cacheKey, legacyCache);
    generation = '2'.repeat(32);
    const migrated = await run();
    assert.equal(migrated.persisted, true, JSON.stringify(migrated.errors));
    assert.equal(fetchCount, 2);
    assert.equal(persisted.get(cacheKey).compilerRevision,
        COMPILED_FILTERS_REVISION);
    assert.notEqual(migrated.importedListUpdates[0].metadataToken,
        warm.importedListUpdates[0].metadataToken);

    // A corrupt current-revision cache is removed and fetched through HTTPS.
    persisted.set(cacheKey, {
        compilerRevision: COMPILED_FILTERS_REVISION,
        serialized: 'corrupt payload',
    });
    generation = 'd'.repeat(32);
    const repaired = await run();
    assert.equal(repaired.persisted, true, JSON.stringify(repaired.errors));
    assert.equal(fetchCount, 3);
    assert.equal(operations.some(request => request.operation === 'remove' &&
        request.keys.includes(cacheKey)), true);

    // A browser storage rejection cannot become persisted:true or an empty
    // replacement. The active marker and previous generation stay untouched.
    generation = 'e'.repeat(32);
    failGenerationWrite = true;
    const rejected = await run();
    assert.equal(rejected.persisted, false);
    assert.match(rejected.errors.at(-1).message, /mock storage quota failure/);
    assert.equal(Array.from(persisted.keys()).some(key =>
        key.startsWith(`compiledFilters.g.${generation}.`)
    ), false);
    failGenerationWrite = false;
    failRead = true;
    generation = 'f'.repeat(32);
    const unreadable = await run();
    assert.equal(unreadable.persisted, false);
    assert.match(unreadable.errors.at(-1).message, /mock unreadable cache/);
    failRead = false;
    for ( const [ key, value ] of originalActive ) {
        assert.deepEqual(persisted.get(key), value);
    }

    // Filter Store handoffs remain one-shot and integrity checked even though
    // their bytes now cross runtime messaging instead of a direct storage API.
    const bytes = new TextEncoder().encode(sourceText);
    const digest = Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes)
    ), byte => byte.toString(16).padStart(2, '0')).join('');
    const verifiedKey =
        `filterStore.verifiedSource.${Date.now()}.${'1'.repeat(32)}.${digest}`;
    lists[0] = {
        ...lists[0],
        verifiedSourceKey: verifiedKey,
        sourceIntegrity: { algorithm: 'sha256', digest, bytes: bytes.length },
    };
    persisted.delete(cacheKey);
    persisted.set(verifiedKey, {
        sourceURL, digest, bytes: bytes.length, text: sourceText,
    });
    generation = '0'.repeat(32);
    const pinned = await run();
    assert.equal(pinned.persisted, true, JSON.stringify(pinned.errors));
    assert.equal(fetchCount, 3);
    assert.equal(persisted.has(verifiedKey), false);
    assert.equal(pinned.compiledIntegrityUpdates[0].compiledIntegrity.digest,
        digest);

    const client = createCompilerStorageClient(runtime, generation);
    for ( const request of [
        { operation: 'get', keys: null },
        { operation: 'get', keys: 'compiledFilters.activeGeneration' },
        { operation: 'set', values: { 'compiledFilters.activeGeneration': 'x' } },
        { operation: 'remove', keys: originalActive[1][0] },
        { operation: 'set', values: { 'rulesets.imported.compiled.https://unselected.invalid/': {} } },
        { operation: 'set', values: { [verifiedKey]: {} } },
        { operation: 'set', values: null },
        { operation: 'clear' },
    ] ) {
        await assert.rejects(handleStorage({ generation, ...request }),
            /outside its staging scope|Invalid compiler storage/);
    }
    await assert.rejects(handleStorage({
        generation: '1'.repeat(32), operation: 'get', keys: cacheKey,
    }), /no longer active/);
    isCurrent = false;
    await assert.rejects(client.get(cacheKey), /no longer active/);
    await assert.rejects(createCompilerStorageClient({
        async sendMessage() { return undefined; },
    }, generation).get(cacheKey), /Compiler storage request failed/);
    await assert.rejects(createCompilerStorageClient({
        async sendMessage() { throw new Error('mock disconnected worker'); },
    }, generation).get(cacheKey), /mock disconnected worker/);

    // A storage request resolves only after the worker's actual write settles.
    // Reporting success earlier could activate an absent/partial generation.
    const writeEntered = Promise.withResolvers();
    const writeGate = Promise.withResolvers();
    const delayedHandler = createCompilerStorageHandler({
        generation,
        lists,
        storage: {
            async set() {
                writeEntered.resolve();
                await writeGate.promise;
            },
        },
    });
    const delayedClient = createCompilerStorageClient({
        sendMessage: request => delayedHandler(request),
    }, generation);
    let acknowledged = false;
    const writing = delayedClient.set({
        [`compiledFilters.g.${generation}.importedFilters.dnrRules`]: [],
    }).then(( ) => { acknowledged = true; });
    await writeEntered.promise;
    assert.equal(acknowledged, false);
    writeGate.resolve();
    await writing;
    assert.equal(acknowledged, true);
} finally {
    globalThis.fetch = originalFetch;
    globalThis.self = originalSelf;
    globalThis.chrome = originalChrome;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
console.log('Offscreen storage integration checks passed.');
