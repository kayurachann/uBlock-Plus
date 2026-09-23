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
import vm from 'node:vm';

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
    let sourceText = [
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
    const includedSources = new Map();
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
    // Optional override for the source response; it may throw to model a
    // network failure.
    let respond;
    globalThis.fetch = async (url, options) => {
        if ( url === './scriptlet.template.js' ) {
            return new Response(await fs.readFile(path.join(temporaryRoot,
                'js/offscreen/scriptlet.template.js'), 'utf8'));
        }
        assert.ok(url === sourceURL || includedSources.has(url));
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        fetchCount += 1;
        const response = respond?.(url) ??
            new Response(includedSources.get(url) ?? sourceText);
        Object.defineProperty(response, 'url', { value: url });
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

    // Community anti-adblock filters use platform branches. Exercise all
    // three real entry paths, including verified bytes before preprocessing.
    sourceText = [
        '! Title: Conditional anti-adblock regression',
        '!#if env_mv3 && env_chromium',
        '||anti.example^$script',
        'page.example##+js(set, antiAdblockReady, true)',
        '!#if env_firefox',
        '@@||anti.example^$script',
        'page.example#@#+js(set, antiAdblockReady, true)',
        '!#endif',
        '!#else',
        '||wrong-platform.example^$image',
        '!#endif',
        '!#if !env_mv3',
        '||anti.example^$script,badfilter',
        'page.example#@#+js()',
        '!#endif',
        '!#if cap_html_filtering',
        '||html-only.example^$script',
        '!#endif',
    ].join('\n');
    const conditionalBytes = new TextEncoder().encode(sourceText);
    const conditionalDigest = Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', conditionalBytes)
    ), byte => byte.toString(16).padStart(2, '0')).join('');
    const outputs = [];
    for ( const [ index, kind ] of [ 'fetched', 'pinned', 'personal' ].entries() ) {
        generation = String(index + 5).repeat(32);
        persisted.delete(cacheKey);
        sandboxText = kind === 'personal' ? sourceText : '';
        lists.length = 0;
        if ( kind !== 'personal' ) {
            lists.push({ id: sourceURL, enabled: true,
                ...(kind === 'pinned' ? { sourceIntegrity: {
                    algorithm: 'sha256', digest: conditionalDigest,
                    bytes: conditionalBytes.length,
                } } : {}),
            });
        }
        const compiled = await run();
        assert.equal(compiled.persisted, true, `${kind}: ${JSON.stringify(compiled.errors)}`);
        const realm = kind === 'personal' ? 'sandbox' : 'imported';
        const key = `compiledFilters.g.${generation}.${realm}Filters`;
        const rules = persisted.get(`${key}.dnrRules`);
        assert.equal(rules.length, 1, `${kind}: inactive block/allow/badfilter`);
        assert.equal(rules[0].action.type, 'block');
        assert.deepEqual(rules[0].condition.requestDomains, [ 'anti.example' ]);
        assert.equal(persisted.has(`${key}.scriptletExceptions`), false,
            `${kind}: inactive scriptlet exceptions cannot cancel an active fix`);
        const scripts = persisted.get(`${key}.userScripts`);
        assert.equal(scripts.MAIN.length, 1);
        const page = vm.createContext({ URL, Request, EventTarget, console,
            document: { location: { origin: 'https://page.example' },
                readyState: 'complete', currentScript: {} } });
        vm.runInContext('self = globalThis; window = globalThis;', page);
        vm.runInContext(scripts.MAIN[0].code, page);
        page.document.currentScript = {};
        assert.equal(page.antiAdblockReady, true, `${kind}: compiled anti-adblock scriptlet executes`);
        outputs.push(rules);
        if ( kind === 'pinned' ) {
            assert.equal(compiled.compiledIntegrityUpdates[0].compiledIntegrity.digest,
                conditionalDigest, 'Integrity remains bound to original bytes');
        }
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(outputs[1], outputs[2]);

    // A condition whose meaning is unknown must not install both branches.
    // Report the source line and leave the last active generation untouched.
    generation = '8'.repeat(32);
    sandboxText = '!#if unknown_platform\n||unknown.example^$script\n!#endif';
    const unsupportedCondition = await run();
    assert.equal(unsupportedCondition.persisted, false);
    assert.match(unsupportedCondition.errors.at(-1).message,
        /Unsupported filter condition at line 1/);
    assert.equal(Array.from(persisted.keys()).some(key =>
        key.startsWith(`compiledFilters.g.${generation}.`)
    ), false);
    for ( const [ key, value ] of originalActive ) {
        assert.deepEqual(persisted.get(key), value);
    }

    let structuralGeneration = 256;
    for ( const invalidText of [
        '!#else\n||wrong.example^',
        '!#endif\n||wrong.example^',
        '!#if env_mv3\n||first.example^\n!#else\n' +
            '||second.example^\n!#else\n||third.example^\n!#endif',
        '!#if env_mv3\n||unterminated.example^',
    ] ) {
        sourceText = invalidText;
        const bytes = new TextEncoder().encode(sourceText);
        const digest = Array.from(new Uint8Array(
            await crypto.subtle.digest('SHA-256', bytes)
        ), byte => byte.toString(16).padStart(2, '0')).join('');
        for ( const kind of [ 'fetched', 'pinned', 'personal' ] ) {
            generation = (++structuralGeneration).toString(16).padStart(32, '0');
            persisted.delete(cacheKey);
            sandboxText = kind === 'personal' ? sourceText : '';
            lists.length = 0;
            if ( kind !== 'personal' ) {
                lists.push({ id: sourceURL, enabled: true,
                    ...(kind === 'pinned' ? { sourceIntegrity: {
                        algorithm: 'sha256', digest, bytes: bytes.length,
                    } } : {}),
                });
            }
            const invalid = await run();
            assert.equal(invalid.persisted, false, `${kind}: malformed structure`);
            assert.match(invalid.errors.at(-1).message, /Invalid filter conditional structure at line/);
            assert.equal(Array.from(persisted.keys()).some(key =>
                key.startsWith(`compiledFilters.g.${generation}.`)
            ), false);
            for ( const [ key, value ] of originalActive ) {
                assert.deepEqual(persisted.get(key), value,
                    'Malformed sources never replace the active generation');
            }
        }
    }

    // Check unknown symbols before either fetch expansion or direct pruning
    // can coerce the first operand into false and drop a protective exception.
    const guardedCondition = expression => `!#if ${expression}\n` +
        '@@||guarded.example^\n!#else\n||guarded.example^\n!#endif';
    const unknownExpressions = [
        'unknown_platform || env_firefox', 'env_firefox || unknown_platform',
        'unknown_platform || env_mv3', 'env_mv3 || unknown_platform',
        'unknown_platform && env_firefox', 'env_firefox && unknown_platform',
        '(unknown_platform || env_firefox)',
    ];
    const conditionCases = [
        ...unknownExpressions.map(expression => ({
            text: guardedCondition(expression), accepted: false,
        })),
        { text: '!#if (env_mv3 && env_chromium)\n' +
            `${guardedCondition(unknownExpressions[0])}\n!#endif`, accepted: false },
        { text: '!#if env_firefox\n' +
            `${guardedCondition(unknownExpressions[0])}\n!#else\n` +
            '||kept.example^$script\n!#endif', accepted: true },
        { text: '!#if env_mv3 || env_firefox\n||kept.example^$script\n!#else\n' +
            `${guardedCondition(unknownExpressions[0])}\n!#endif`, accepted: true },
        { text: '!#if cap_future_feature\n' +
            `${guardedCondition(unknownExpressions[0])}\n!#else\n` +
            '||kept.example^$script\n!#endif', accepted: true },
    ];
    for ( const { text, accepted } of conditionCases ) {
        sourceText = text;
        const bytes = new TextEncoder().encode(sourceText);
        const digest = Array.from(new Uint8Array(
            await crypto.subtle.digest('SHA-256', bytes)
        ), byte => byte.toString(16).padStart(2, '0')).join('');
        for ( const kind of [ 'fetched', 'pinned', 'personal' ] ) {
            generation = (++structuralGeneration).toString(16).padStart(32, '0');
            persisted.delete(cacheKey);
            sandboxText = kind === 'personal' ? sourceText : '';
            lists.length = 0;
            if ( kind !== 'personal' ) {
                lists.push({ id: sourceURL, enabled: true,
                    ...(kind === 'pinned' ? { sourceIntegrity: {
                        algorithm: 'sha256', digest, bytes: bytes.length,
                    } } : {}),
                });
            }
            const result = await run();
            assert.equal(result.persisted, accepted, `${kind}: ${sourceText}`);
            if ( accepted ) {
                const realm = kind === 'personal' ? 'sandbox' : 'imported';
                const rules = persisted.get(
                    `compiledFilters.g.${generation}.${realm}Filters.dnrRules`
                );
                assert.equal(rules.length, 1);
                assert.equal(rules[0].action.type, 'block');
                assert.deepEqual(rules[0].condition.requestDomains, [ 'kept.example' ]);
            } else {
                assert.match(result.errors.at(-1).message,
                    /Unsupported filter condition at line/);
                assert.equal(Array.from(persisted.keys()).some(key =>
                    key.startsWith(`compiledFilters.g.${generation}.`)
                ), false, 'No generation containing an uncertain branch is staged');
            }
            for ( const [ key, value ] of originalActive ) {
                assert.deepEqual(persisted.get(key), value,
                    'Compiling or rejecting input never changes active protection');
            }
        }
    }

    // Included files are validated while their original delimiters still
    // exist. Invalid content in an inactive include is never fetched.
    const includeURL = new URL('child.txt', sourceURL).href;
    for ( const [ includeText, expectedError ] of [
        [ '!#if env_mv3\n||first.example^\n!#else\n!#else\n!#endif',
            /Invalid filter conditional structure at line 4: duplicate !#else/ ],
        [ guardedCondition(unknownExpressions[0]),
            /Unsupported filter condition at line 1/ ],
    ] ) {
        includedSources.set(includeURL, includeText);
        for ( const active of [ false, true ] ) {
            generation = (++structuralGeneration).toString(16).padStart(32, '0');
            sourceText = `!#if ${active ? 'env_mv3' : 'env_firefox'}\n` +
                '!#include child.txt\n!#endif\n||included.example^$script';
            lists.length = 0;
            lists.push({ id: sourceURL, enabled: true });
            sandboxText = '';
            persisted.delete(cacheKey);
            const beforeFetches = fetchCount;
            const included = await run();
            assert.equal(included.persisted, !active);
            assert.equal(fetchCount - beforeFetches, active ? 2 : 1);
            if ( active ) {
                assert.match(included.errors.at(-1).message, expectedError);
            } else {
                assert.equal(persisted.get(
                    `compiledFilters.g.${generation}.importedFilters.dnrRules`
                ).length, 1);
            }
        }
    }

    const sha256Hex = async text => Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    ), byte => byte.toString(16).padStart(2, '0')).join('');
    const importedRules = ( ) => persisted.get(
        `compiledFilters.g.${generation}.importedFilters.dnrRules`
    )?.map(rule => rule.condition.requestDomains).flat();
    sandboxText = '';

    // A pinned source refetched over the network (after a restore, a disable
    // or a compiler upgrade) is gzip-encoded by raw.githubusercontent.com:
    // Content-Length counts encoded bytes and must not reject a body whose
    // decoded size and digest match.
    sourceText = '! Title: Pinned gzip fixture\n||pinned-gzip.example^$script\n';
    lists.length = 0;
    lists.push({ id: sourceURL, enabled: true, sourceIntegrity: {
        algorithm: 'sha256', digest: await sha256Hex(sourceText),
        bytes: new TextEncoder().encode(sourceText).length,
    } });
    persisted.delete(cacheKey);
    respond = ( ) => new Response(sourceText, { headers: {
        'content-encoding': 'gzip', 'content-length': '17',
    } });
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const gzipped = await run();
    assert.equal(gzipped.persisted, true, JSON.stringify(gzipped.errors));
    assert.deepEqual(importedRules(), [ 'pinned-gzip.example' ]);
    respond = undefined;
    // Pinned bytes are immutable: an expired pinned list is never refetched.
    Object.assign(lists[0], { expires: 1, time: { updated: 0 } });
    let fetchesBefore = fetchCount;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const pinnedExpired = await run();
    assert.equal(pinnedExpired.persisted, true, JSON.stringify(pinnedExpired.errors));
    assert.equal(fetchCount, fetchesBefore);
    assert.deepEqual(importedRules(), [ 'pinned-gzip.example' ]);

    // An expired list keeps its last complete compilation until a
    // replacement has been fetched and compiled. One unreachable list must
    // not fail every later compilation of personal and imported filters.
    const dayMs = 24 * 60 * 60 * 1000;
    const expiredList = { id: sourceURL, enabled: true, expires: 1,
        time: { updated: 0 } };
    lists.length = 0;
    lists.push(expiredList);
    persisted.delete(cacheKey);
    sourceText = '! Title: Last good\n||last-good.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const installed = await run();
    assert.equal(installed.persisted, true, JSON.stringify(installed.errors));
    // What the service worker commits after activation.
    expiredList.compiledMetadataToken = installed.importedListUpdates[0].metadataToken;
    expiredList.time.updated = Date.now() - 2 * dayMs;
    sandboxText = '||personal.example^$image';
    for ( const [ label, failure, cause ] of [
        [ 'network', ( ) => { throw new TypeError('fetch failed'); },
            /failed \(network error or redirect; redirects are not followed\)/ ],
        [ 'status', ( ) => new Response('gone', { status: 404 }), /failed \(HTTP 404\)/ ],
        [ 'size', ( ) => new Response('x'.repeat(6 * 1024 * 1024)),
            /exceeds its size limit/ ],
        [ 'condition', ( ) => new Response('!#if unknown_platform\n||new.example^\n!#endif'),
            /Unsupported filter condition at line 1/ ],
    ] ) {
        respond = failure;
        const fetchesBefore = fetchCount;
        generation = (++structuralGeneration).toString(16).padStart(32, '0');
        const kept = await run();
        assert.equal(kept.persisted, true, `${label}: ${JSON.stringify(kept.errors)}`);
        assert.equal(fetchCount - fetchesBefore, 1, `${label}: one refresh attempt`);
        assert.deepEqual(importedRules(), [ 'last-good.example' ], label);
        assert.equal(persisted.get(
            `compiledFilters.g.${generation}.sandboxFilters.dnrRules`
        ).length, 1, `${label}: personal filters still compile`);
        assert.equal(kept.importedListUpdates.length, 1);
        const [ refreshFailure ] = kept.importedListUpdates;
        assert.equal(refreshFailure.listid, sourceURL);
        assert.equal(refreshFailure.refreshFailed, true);
        assert.equal(Number.isFinite(refreshFailure.failedAt), true);
        assert.match(refreshFailure.message, cause, label);
        assert.equal(persisted.get(cacheKey).pendingMetadataToken,
            expiredList.compiledMetadataToken, `${label}: cache kept`);
    }
    sandboxText = '';
    // A successful refresh replaces the cache and stages fresh metadata.
    respond = undefined;
    sourceText = '! Title: Refreshed\n||refreshed.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const refreshed = await run();
    assert.equal(refreshed.persisted, true, JSON.stringify(refreshed.errors));
    assert.deepEqual(importedRules(), [ 'refreshed.example' ]);
    assert.equal(refreshed.importedListUpdates[0].title, 'Refreshed');
    assert.notEqual(refreshed.importedListUpdates[0].metadataToken,
        expiredList.compiledMetadataToken);
    // Until that metadata commits, the new cache is current: no refetch.
    fetchesBefore = fetchCount;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const uncommitted = await run();
    assert.equal(uncommitted.persisted, true, JSON.stringify(uncommitted.errors));
    assert.equal(fetchCount, fetchesBefore);
    assert.equal(uncommitted.importedListUpdates[0].metadataToken,
        refreshed.importedListUpdates[0].metadataToken);
    // A list which is not due is never refetched.
    expiredList.compiledMetadataToken = refreshed.importedListUpdates[0].metadataToken;
    expiredList.time.updated = Date.now();
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.equal((await run()).persisted, true);
    assert.equal(fetchCount, fetchesBefore);

    // A refresh which compiles but prevents activation, for example by
    // exceeding a DNR quota, never commits. Once generations with it have
    // failed for a while, the compilation which last activated returns, so
    // personal filters activate again, and the list is retried after a
    // backoff until upstream fixes it.
    const metadataKey = `rulesets.imported.pendingMetadata.${sourceURL}`;
    const hourMs = 60 * 60 * 1000;
    const lastGood = structuredClone(persisted.get(cacheKey));
    expiredList.time.updated = Date.now() - 2 * dayMs;
    sourceText = '! Title: Unactivatable\n||unactivatable.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const unactivatable = await run();
    assert.equal(unactivatable.persisted, true, JSON.stringify(unactivatable.errors));
    assert.equal(fetchCount - fetchesBefore, 1);
    assert.deepEqual(importedRules(), [ 'unactivatable.example' ]);
    assert.deepEqual(persisted.get(metadataKey).previous, lastGood,
        'The last activated compilation is kept until the refresh commits');
    assert.equal(Object.hasOwn(unactivatable.importedListUpdates[0], 'previous'), false,
        'Staged updates, and so the activation journal, stay small');
    // Activation retries within the grace period reuse the refresh.
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.deepEqual((await run()).importedListUpdates.map(update => update.metadataToken),
        unactivatable.importedListUpdates.map(update => update.metadataToken));
    assert.equal(fetchCount - fetchesBefore, 1);
    persisted.get(metadataKey).fetchedAt = Date.now() - 2 * hourMs;
    sandboxText = '||personal.example^$image';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const fallback = await run();
    assert.equal(fallback.persisted, true, JSON.stringify(fallback.errors));
    assert.equal(fetchCount - fetchesBefore, 1, 'Falling back does not refetch');
    assert.deepEqual(importedRules(), [ 'refreshed.example' ]);
    assert.equal(persisted.get(
        `compiledFilters.g.${generation}.sandboxFilters.dnrRules`
    ).length, 1);
    assert.deepEqual(persisted.get(cacheKey), lastGood);
    assert.equal(persisted.has(metadataKey), false);
    assert.equal(fallback.importedListUpdates.length, 1);
    assert.equal(fallback.importedListUpdates[0].refreshFailed, true);
    assert.match(fallback.importedListUpdates[0].message, /could not be activated/);
    sandboxText = '';
    // What the service worker commits: the backoff defers the next attempt,
    // which then fetches the newer upstream version.
    expiredList.time.retryAfter = Date.now() + hourMs;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.equal((await run()).persisted, true);
    assert.equal(fetchCount - fetchesBefore, 1);
    expiredList.time.retryAfter = Date.now() - 1;
    sourceText = '! Title: Fixed upstream\n||fixed.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.equal((await run()).persisted, true);
    assert.equal(fetchCount - fetchesBefore, 2);
    assert.deepEqual(importedRules(), [ 'fixed.example' ]);
    delete expiredList.time.retryAfter;
    // With no activated version to return to, as on first install or with a
    // sidecar written before `fetchedAt` existed, a stale refresh is fetched
    // again, and a newer upstream version replaces it.
    const firstInstall = { id: sourceURL, enabled: true, expires: 1, time: { updated: 0 } };
    lists.length = 0;
    lists.push(firstInstall);
    persisted.delete(cacheKey);
    sourceText = '! Title: First version\n||first-version.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.equal((await run()).persisted, true);
    assert.equal(persisted.get(metadataKey).previous, undefined);
    delete persisted.get(metadataKey).fetchedAt;
    sourceText = '! Title: Second version\n||second-version.example^$script';
    fetchesBefore = fetchCount;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const refetched = await run();
    assert.equal(refetched.persisted, true, JSON.stringify(refetched.errors));
    assert.equal(fetchCount - fetchesBefore, 1);
    assert.deepEqual(importedRules(), [ 'second-version.example' ]);
    assert.equal(refetched.importedListUpdates[0].title, 'Second version');
    lists.length = 0;
    lists.push(expiredList);
    // Without a usable cache, the failure names the list and its cause.
    persisted.delete(cacheKey);
    respond = ( ) => new Response('gone', { status: 404 });
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const uncached = await run();
    assert.equal(uncached.persisted, false);
    assert.deepEqual(uncached.errors.map(({ listid }) => listid), [ sourceURL ]);
    assert.match(uncached.errors[0].message, /failed \(HTTP 404\)/);
    respond = undefined;
    // So does a compile-stage failure, rather than blaming 'compiler'.
    sourceText = '!#if unknown_platform\n||unknown.example^\n!#endif';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const unsupported = await run();
    assert.equal(unsupported.persisted, false);
    assert.deepEqual(unsupported.errors.map(({ listid }) => listid), [ sourceURL ]);
    assert.match(unsupported.errors[0].message, /Unsupported filter condition at line 1/);

    // A Filter Store batch share bounds the first fetch of a list only.
    // Once installed, a list which grows refreshes under the per-list limit.
    const batchList = { id: sourceURL, enabled: true, maxSourceBytes: 64,
        expires: 1, time: { updated: 0 } };
    lists.length = 0;
    lists.push(batchList);
    persisted.delete(cacheKey);
    sourceText = `! Title: Batch\n||batch.example^$script\n!${'x'.repeat(64)}`;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const overShare = await run();
    assert.equal(overShare.persisted, false);
    assert.match(overShare.errors[0].message, /exceeds its size limit/);
    sourceText = '||batch.example^$script';
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const withinShare = await run();
    assert.equal(withinShare.persisted, true, JSON.stringify(withinShare.errors));
    batchList.compiledMetadataToken = withinShare.importedListUpdates[0].metadataToken;
    batchList.time.updated = Date.now() - 2 * dayMs;
    sourceText = `! Title: Batch\n||grown.example^$script\n!${'x'.repeat(4096)}`;
    fetchesBefore = fetchCount;
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    const grown = await run();
    assert.equal(grown.persisted, true, JSON.stringify(grown.errors));
    assert.equal(fetchCount - fetchesBefore, 1);
    assert.deepEqual(importedRules(), [ 'grown.example' ]);
    assert.equal(grown.importedListUpdates.some(update => update.refreshFailed), false);

    // Regex scopes from an imported list which could backtrack exponentially
    // never reach page code, including those in older cached compilations.
    // The compiler reports them for the scriptlet diagnostics.
    lists.length = 0;
    lists.push({ id: sourceURL, enabled: true });
    persisted.delete(cacheKey);
    sourceText = [
        'site.example##+js(set, probeValue, 1)',
        '/^((.+)+)+x$/#@#+js(set, probeValue, 1)',
        '/^(.+)+x$/##+js(set, otherValue, 1)',
        '/^safe\\.example$/#@#+js(set, otherValue, 1)',
    ].join('\n');
    for ( const warm of [ false, true ] ) {
        generation = (++structuralGeneration).toString(16).padStart(32, '0');
        const hostile = await run();
        assert.equal(hostile.persisted, true, JSON.stringify(hostile.errors));
        const key = `compiledFilters.g.${generation}.importedFilters`;
        const exceptions = persisted.get(`${key}.scriptletExceptions`);
        assert.equal(JSON.stringify(exceptions).includes('(.+)+'), false, `warm: ${warm}`);
        assert.equal(JSON.stringify(persisted.get(`${key}.userScripts`))
            .includes('(.+)+'), false);
        assert.ok(exceptions.some(entry =>
            entry.hostnames.includes('/^safe\\.example$/')
        ), 'Safe regex exceptions are kept verbatim');
        assert.ok(exceptions.some(entry => entry.hostnames.includes('*')),
            'An unsafe exception widens instead of disappearing');
        assert.match(persisted.get(`${key}.scriptletWarnings`)[0],
            /contain 2 scriptlet regex hostname\(s\)/);
    }
    sourceText = 'site.example##+js(set, probeValue, 1)';
    persisted.delete(cacheKey);
    generation = (++structuralGeneration).toString(16).padStart(32, '0');
    assert.equal((await run()).persisted, true);
    assert.equal(persisted.has(
        `compiledFilters.g.${generation}.importedFilters.scriptletWarnings`
    ), false);

    // Restore a selected source for the messaging boundary checks below.
    lists.length = 0;
    lists.push({ id: sourceURL, enabled: true });
    handleStorage = createCompilerStorageHandler({
        generation, lists, storage, isCurrent: ( ) => isCurrent,
    });

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
