/*******************************************************************************

    uBlock Plus+ - forced CSS-cache prune regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import assert from 'node:assert/strict';

const local = new Map();
const session = new Map();
let keysGate;
let rejectKeys = false;
let keysCalls = 0;

function makeArea(values, hooks = {}) {
    return {
        async get(key) {
            if ( key === null ) { return Object.fromEntries(values); }
            const keys = Array.isArray(key) ? key : [ key ];
            const out = {};
            for ( const k of keys ) {
                if ( values.has(k) ) { out[k] = structuredClone(values.get(k)); }
            }
            return out;
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
        async getKeys() {
            await hooks.beforeGetKeys?.();
            return [ ...values.keys() ];
        },
    };
}

globalThis.self = globalThis;
globalThis.chrome = {
    alarms: { async create() { }, async clear() { } },
    declarativeNetRequest: {},
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: {
        local: makeArea(local),
        session: makeArea(session, {
            async beforeGetKeys() {
                keysCalls += 1;
                if ( keysGate ) {
                    const gate = keysGate;
                    keysGate = undefined;
                    gate.entered();
                    await gate.wait;
                }
                if ( rejectKeys ) {
                    rejectKeys = false;
                    throw new Error('mock session failure');
                }
            },
        }),
    },
};

const { pruneCSSCache } = await import('../platform/mv3/extension/js/scripting-manager.js');
const { setMemoryProfile } = await import('../platform/mv3/extension/js/memory-manager.js');

function fillCache(count) {
    for ( const key of [ ...session.keys() ] ) {
        if ( key.startsWith('cache.css.') ) { session.delete(key); }
    }
    for ( let i = 0; i < count; i++ ) {
        session.set(`cache.css.host-${i}.example`, { t: i, s: [ '.ad' ], p: [] });
    }
}

function cacheKeys() {
    return [ ...session.keys() ].filter(key => key.startsWith('cache.css.'));
}

function newGate() {
    const gate = {};
    gate.reached = new Promise(resolve => { gate.entered = resolve; });
    gate.wait = new Promise(resolve => { gate.release = resolve; });
    return gate;
}

// The newest entries are those with the highest timestamps.
const newest = n => Array.from({ length: n }, (_, i) =>
    `cache.css.host-${100 - n + i}.example`
).sort();

// 1. A forced prune which arrives while a regular prune is in flight must not
//    receive that prune's result: it read the previous (larger) profile.
{
    await setMemoryProfile('balanced');
    fillCache(100);
    const gate = keysGate = newGate();
    const regular = pruneCSSCache();
    await gate.reached;
    await setMemoryProfile('low-memory');
    const forced = pruneCSSCache({ force: true });
    const forcedAgain = pruneCSSCache({ force: true });
    assert.equal(forcedAgain, forced, 'forced calls share one queued prune');
    assert.equal(pruneCSSCache(), regular, 'regular calls still share the pending prune');
    keysCalls = 0;
    gate.release();
    await Promise.all([ regular, forced ]);
    assert.equal(keysCalls, 1, 'both forced calls ran a single queued prune');
    assert.deepEqual(cacheKeys().sort(), newest(64),
        'the forced prune applies the new low-memory limit');
}

// 2. A second forced prune (another profile change) during a forced prune
//    must also run with the profile current at its call.
{
    await setMemoryProfile('balanced');
    fillCache(100);
    const gate = keysGate = newGate();
    const first = pruneCSSCache({ force: true });
    await gate.reached;
    await setMemoryProfile('low-memory');
    const second = pruneCSSCache({ force: true });
    assert.notEqual(second, first);
    gate.release();
    await Promise.all([ first, second ]);
    assert.deepEqual(cacheKeys().sort(), newest(64));
}

// 3. A failed pending prune does not cancel the queued forced prune.
{
    await setMemoryProfile('balanced');
    fillCache(100);
    const gate = keysGate = newGate();
    rejectKeys = true;
    const regular = pruneCSSCache();
    await gate.reached;
    await setMemoryProfile('low-memory');
    const forced = pruneCSSCache({ force: true });
    gate.release();
    await assert.rejects(regular, /mock session failure/);
    await forced;
    assert.deepEqual(cacheKeys().sort(), newest(64));
}

// 4. Without a pending prune, a forced call starts immediately.
{
    await setMemoryProfile('balanced');
    fillCache(100);
    await pruneCSSCache({ force: true });
    assert.equal(cacheKeys().length, 100, 'balanced keeps up to 256 entries');
    await setMemoryProfile('low-memory');
    await pruneCSSCache({ force: true });
    assert.deepEqual(cacheKeys().sort(), newest(64));
}

console.log('CSS-cache prune checks passed: forced prunes are never coalesced into an earlier run.');
