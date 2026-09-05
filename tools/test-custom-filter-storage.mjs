/*******************************************************************************

    uBlock Plus+ - custom filter storage lifecycle regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';
import process from 'node:process';

const values = new Map();
let writeGate;
let rejectRead = false;
let rejectWrite = false;
let rejectRemove = false;
const leakedRejections = [];
process.on('unhandledRejection', reason => leakedRejections.push(reason));
const storage = {
    async get(key) {
        if ( rejectRead ) { rejectRead = false; throw new Error('mock read failure'); }
        return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {};
    },
    async set(entries) {
        if ( writeGate ) {
            const gate = writeGate;
            writeGate = undefined;
            gate.entered();
            await gate.wait;
        }
        if ( rejectWrite ) { rejectWrite = false; throw new Error('mock write failure'); }
        for ( const [ key, value ] of Object.entries(entries) ) {
            values.set(key, structuredClone(value));
        }
    },
    async remove(keys) {
        if ( rejectRemove ) { rejectRemove = false; throw new Error('mock remove failure'); }
        for ( const key of Array.isArray(keys) ? keys : [ keys ] ) { values.delete(key); }
    },
    async getKeys() { return [ ...values.keys() ]; },
};
globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {},
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: { local: storage },
};
let sequence = 0;
const newManager = async (initial = {}) => {
    values.clear();
    for ( const [ key, value ] of Object.entries(initial) ) { values.set(key, value); }
    rejectRead = rejectWrite = rejectRemove = false;
    sequence += 1;
    return import(`../platform/mv3/extension/js/filter-manager.js?storage=${sequence}`);
};
const failures = [];
async function check(name, task) {
    try { await task(); console.log(`PASS ${name}`); }
    catch ( error ) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const tick = ( ) => new Promise(resolve => setTimeout(resolve, 0));

await check('successful mutation waits for durable storage', async ( ) => {
    const manager = await newManager();
    let markEntered;
    let release;
    const entered = new Promise(resolve => { markEntered = resolve; });
    writeGate = {
        entered: markEntered,
        wait: new Promise(resolve => { release = resolve; }),
    };
    let settled = false;
    const mutation = manager.addCustomFilters('example.com', [ '.ad' ])
        .then(value => { settled = true; return value; });
    await entered;
    await tick();
    try { assert.equal(settled, false); }
    finally { release(); await mutation; }
    assert.deepEqual(values.get('site.example.com'), [ '.ad' ]);
});

await check('concurrent same-site additions preserve both selectors', async ( ) => {
    const manager = await newManager({ 'site.example.com': [ '.original' ] });
    await Promise.all([
        manager.addCustomFilters('example.com', [ '.ad' ]),
        manager.addCustomFilters('example.com', [ '.sponsor' ]),
    ]);
    assert.deepEqual(await manager.customFiltersFromHostname('example.com'),
        [ '.ad', '.original', '.sponsor' ]);
});

await check('failed read cannot replace an existing filter set', async ( ) => {
    const manager = await newManager({ 'site.example.com': [ '.original' ] });
    rejectRead = true;
    await assert.rejects(manager.addCustomFilters('example.com', [ '.new' ]), /read failure/);
    assert.deepEqual(values.get('site.example.com'), [ '.original' ]);
});

await check('failed write rejects the mutation and queue recovers', async ( ) => {
    const manager = await newManager();
    rejectWrite = true;
    const rejected = manager.addCustomFilters('example.com', [ '.failed' ]);
    // Attach a subsequent read before the failed write settles to observe any
    // poisoned internal queue without hiding an unhandled rejection.
    const next = rejected.then(( ) => manager.getAllCustomFilters()).catch(( ) => {});
    await assert.rejects(rejected, /write failure/);
    await next;
    await manager.addCustomFilters('example.com', [ '.working' ]);
    assert.deepEqual(await manager.customFiltersFromHostname('example.com'), [ '.working' ]);
});

await check('remove failures reject and retain unrelated filters', async ( ) => {
    const manager = await newManager({
        'site.example.com': [ '.ad' ], 'site.other.example': [ '.other' ],
    });
    rejectRemove = true;
    await assert.rejects(manager.removeAllCustomFilters('example.com'), /remove failure/);
    assert.deepEqual(values.get('site.other.example'), [ '.other' ]);
    await manager.removeAllCustomFilters('example.com');
    assert.deepEqual(await manager.getAllCustomFilters(), [ [ 'other.example', [ '.other' ] ] ]);
});

await tick();
if ( leakedRejections.length ) {
    failures.push('no leaked storage rejections');
    console.error(`FAIL ${leakedRejections.length} leaked storage rejections`);
}
assert.deepEqual(failures, [], `Custom-filter lifecycle failures: ${failures.join(', ')}`);
console.log('Custom filter storage lifecycle tests passed.');
