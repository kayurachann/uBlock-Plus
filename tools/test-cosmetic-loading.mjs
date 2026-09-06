/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const scripting = path.join(root, 'platform/mv3/extension/js/scripting');
const source = (await fs.readFile(path.join(scripting, 'css-specific.js'), 'utf8'))
    .replace(/\nvoid 0;\s*$/, '');
const isolatedSource = await fs.readFile(path.join(scripting, 'isolated-api.js'), 'utf8');
const procedural = JSON.stringify({ selector: '.procedural', tasks: [] });
const canceledProcedural = JSON.stringify({ selector: '.canceled-procedural', tasks: [] });
const declarative = JSON.stringify({ selector: '.declarative', cssable: true, tasks: [] });

function dictionary(selectors, refs, overrides = {}) {
    return {
        hostnames: [ 'test.example' ],
        hasEntities: false,
        regexes: [],
        selectors,
        selectorLists: [ refs ],
        selectorListRefs: [ 0 ],
        ...overrides,
    };
}

const dictionaries = Array.from({ length: 12 }, (_, i) => dictionary(
    [ `.ad-${i}`, '.shared' ], '0,1'
));
dictionaries[0] = dictionary([
    '.ad-0', '.shared', procedural, canceledProcedural, declarative,
], '0,1,2,3,4');
dictionaries.push(dictionary([ '.entity-ad' ], '0', {
    hostnames: [ 'example.*' ], hasEntities: true,
}));
dictionaries.push(dictionary([ '.regex-ad' ], '0', {
    hostnames: [], regexes: [ 'test', '^test\\.example$', 0 ],
}));
// Exceptions in a later batch must cancel both CSS and procedural selectors.
dictionaries.push(dictionary([ '.ad-0', canceledProcedural ], '-1,-2'));

async function run(options = {}) {
    const {
        profile = { importCompileConcurrency: 1 },
        none = [],
        topHostname = 'test.example',
        cached,
        rejectProfile = false,
        rejectDictionary = -1,
        missingDictionary = -1,
        malformedDictionary = -1,
        modeDetails = { none },
        readModeDetails = ( ) => modeDetails,
        beforeDictionaryRead,
    } = options;
    const inserted = [];
    const procedurals = [];
    const declaratives = [];
    const sessionWrites = [];
    const messages = [];
    const dictionaryReads = [];
    let active = 0;
    let peak = 0;
    let profileReads = 0;
    const context = vm.createContext({
        document: { location: {
            hostname: 'test.example', origin: 'https://test.example',
            ancestorOrigins: [],
        } },
        chrome: {
            storage: {
                local: { async get(key) {
                    if ( key === 'filteringModeDetails' ) {
                        return { [key]: structuredClone(readModeDetails()) };
                    }
                    const id = Number(key.slice('css.specific.list-'.length));
                    dictionaryReads.push(id);
                    active += 1;
                    peak = Math.max(peak, active);
                    try {
                        await beforeDictionaryRead?.(id);
                        // Keep requests outstanding to measure the actual
                        // number of overlapping dictionary deserializations.
                        await new Promise(resolve => setTimeout(resolve, 2));
                        if ( id === rejectDictionary ) { throw new Error('storage read failed'); }
                        if ( id === missingDictionary ) { return {}; }
                        if ( id === malformedDictionary ) { return { [key]: {} }; }
                        return { [key]: structuredClone(dictionaries[id]) };
                    } finally {
                        active -= 1;
                    }
                } },
                session: {
                    async get(key) {
                        if ( key === 'memoryProfile.runtime' ) {
                            profileReads += 1;
                            if ( rejectProfile ) { throw new Error('session unavailable'); }
                            return { [key]: profile };
                        }
                        return { [key]: structuredClone(cached) };
                    },
                    async set(entries) { sessionWrites.push(structuredClone(entries)); },
                },
            },
            runtime: { async sendMessage(message) { messages.push(message); } },
        },
        cssAPI: { insert(css) { inserted.push(css); } },
        specificImports: dictionaries.map((_, i) => `list-${i}`),
        ProceduralFiltererAPI: class {
            addProcedurals(values) { procedurals.push(...values); }
            addDeclaratives(values) { declaratives.push(...values); }
        },
    });
    context.self = context;
    vm.runInContext(isolatedSource, context);
    context.isolatedAPI.contexts.entries = [ {
        hns: [ 'test.example', 'example', '*' ], ens: [ 'example.*' ],
    } ];
    if ( topHostname !== 'test.example' ) {
        context.isolatedAPI.contexts.entries.push({ hns: [ topHostname ] });
    }
    await vm.runInContext(source, context);
    return {
        inserted, procedurals, declaratives, sessionWrites, messages,
        dictionaryReads, peak, profileReads,
    };
}

const low = await run();
assert.equal(low.peak, 1, 'low-memory lookup must deserialize only one dictionary at a time');
assert.equal(low.dictionaryReads.length, dictionaries.length);
assert.equal(low.inserted.length, 1);
assert.equal(low.inserted[0].includes('.ad-0'), false, 'later CSS exception is honored');
assert.equal(low.inserted[0].includes('.ad-11'), true, 'later batch still filters');
assert.equal(low.inserted[0].includes('.entity-ad'), true, 'entity matching is preserved');
assert.equal(low.inserted[0].includes('.regex-ad'), true, 'regular-expression matching is preserved');
assert.equal(low.inserted[0].match(/\.shared/g).length, 1, 'duplicate selectors remain deduplicated');
assert.deepEqual(low.procedurals.map(value => value.selector), [ '.procedural' ]);
assert.deepEqual(low.declaratives.map(value => value.selector), [ '.declarative' ]);
assert.equal(low.messages.filter(value => value.what === 'noteCSSCacheWrite').length, 1);

const balanced = await run({ profile: { importCompileConcurrency: 2 } });
assert.equal(balanced.peak, 2);
assert.deepEqual(balanced.inserted, low.inserted);
assert.deepEqual(JSON.parse(JSON.stringify(balanced.procedurals)),
    JSON.parse(JSON.stringify(low.procedurals)));

for ( const options of [
    { profile: null },
    { profile: { importCompileConcurrency: 128 } },
    { rejectProfile: true },
] ) {
    const fallback = await run(options);
    assert.equal(fallback.peak, 1, 'missing or invalid profile uses the conservative lookup budget');
    assert.deepEqual(fallback.inserted, low.inserted, 'lookup budget never drops filters');
}

for ( const topHostname of [ 'test.example', 'child.test.example' ] ) {
    const off = await run({ none: [ 'test.example' ], topHostname });
    assert.equal(off.dictionaryReads.length, 0, 'Off pages do not load cosmetic dictionaries');
    assert.equal(off.inserted.length, 0);
    assert.equal(off.procedurals.length, 0);
}
const lookalike = await run({ none: [ 'example' ], topHostname: 'notexample' });
assert.equal(lookalike.dictionaryReads.length, dictionaries.length,
    'Off scope must respect hostname boundaries');

const cacheHit = await run({ cached: {
    t: Math.round(Date.now() / (5 * 60000)), s: [ '.cached' ], p: [],
} });
assert.equal(cacheHit.dictionaryReads.length, 0);
assert.equal(cacheHit.profileReads, 0, 'warm cache does not need another profile read');
assert.deepEqual(cacheHit.inserted, [ '.cached{display:none!important;}' ]);
assert.equal(cacheHit.sessionWrites.length, 0);

for ( const options of [
    { rejectDictionary: 4 },
    { rejectDictionary: dictionaries.length - 1 },
    { missingDictionary: dictionaries.length - 1 },
    { malformedDictionary: dictionaries.length - 1 },
] ) {
    const failedRead = await run(options);
    assert.equal(failedRead.inserted.length, 0,
        'unavailable dictionaries may contain exceptions: fail open for the entire lookup');
    assert.equal(failedRead.procedurals.length, 0);
    assert.equal(failedRead.declaratives.length, 0);
    assert.equal(failedRead.sessionWrites.length, 0,
        'a partial result must not poison the session cache');
    assert.equal(failedRead.messages.length, 0);
}
const retry = await run();
assert.deepEqual(retry.inserted, low.inserted,
    'a later navigation can retry without a cached partial result');

for ( const modeDetails of [ null, {}, { none: null }, { none: [ null ] } ] ) {
    const unknownScope = await run({ modeDetails });
    assert.equal(unknownScope.dictionaryReads.length, 0);
    assert.equal(unknownScope.inserted.length, 0, 'unknown Off scopes must fail open');
    assert.equal(unknownScope.sessionWrites.length, 0);
}

for ( const changedModes of [ { none: [ 'test.example' ] }, null ] ) {
    let currentModes = { none: [] };
    let notifyRead;
    const readStarted = new Promise(resolve => { notifyRead = resolve; });
    let releaseRead;
    const pausedRead = new Promise(resolve => { releaseRead = resolve; });
    const loading = run({
        readModeDetails: ( ) => currentModes,
        async beforeDictionaryRead(id) {
            if ( id !== 5 ) { return; }
            notifyRead();
            await pausedRead;
        },
    });
    await readStarted;
    currentModes = changedModes;
    releaseRead();
    const canceled = await loading;
    assert.equal(canceled.dictionaryReads.length, dictionaries.length);
    assert.equal(canceled.inserted.length, 0, 'a mode change during lookup cancels old filtering');
    assert.equal(canceled.procedurals.length, 0);
    assert.equal(canceled.sessionWrites.length, 0, 'old lookup must not repopulate the cleared cache');
}

console.log(`Cosmetic loading checks passed: ${dictionaries.length} dictionaries, ` +
    'peak 1 (low-memory) / 2 (balanced), identical filters and exceptions.');
