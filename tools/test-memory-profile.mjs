/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const extensionJS = path.join(root, 'platform', 'mv3', 'extension', 'js');

const profileModule = await import(pathToFileURL(
    path.join(extensionJS, 'memory-profile.js')
));

const {
    MEMORY_PROFILE_AUTO,
    MEMORY_PROFILE_BALANCED,
    MEMORY_PROFILE_LOW,
    normalizeMemoryProfile,
    resolveMemoryProfile,
} = profileModule;

assert.equal(normalizeMemoryProfile('invalid'), MEMORY_PROFILE_AUTO);
assert.equal(resolveMemoryProfile(MEMORY_PROFILE_AUTO, 4).effective,
    MEMORY_PROFILE_LOW);
assert.equal(resolveMemoryProfile(MEMORY_PROFILE_AUTO, 8).effective,
    MEMORY_PROFILE_BALANCED);
assert.equal(resolveMemoryProfile(MEMORY_PROFILE_AUTO).effective,
    MEMORY_PROFILE_BALANCED);
assert.equal(resolveMemoryProfile(MEMORY_PROFILE_BALANCED, 2).effective,
    MEMORY_PROFILE_BALANCED);

const lowProfile = resolveMemoryProfile(MEMORY_PROFILE_LOW, 16);
assert.equal(lowProfile.importCompileConcurrency, 1);
assert.equal(lowProfile.cssCacheMaxEntries, 64);
assert.equal(lowProfile.cssCacheHighWatermark, 72);
assert.equal(lowProfile.retainScriptingMetadata, false);

function makeStorageArea(initial = {}) {
    const values = new Map(Object.entries(initial));
    const calls = { get: 0, set: 0 };
    const select = keys => {
        if ( keys === null || keys === undefined ) {
            return Object.fromEntries(values);
        }
        const selected = {};
        for ( const key of Array.isArray(keys) ? keys : [ keys ] ) {
            if ( values.has(key) ) { selected[key] = values.get(key); }
        }
        return selected;
    };
    return {
        values,
        calls,
        beforeSet: undefined,
        async get(keys) {
            calls.get += 1;
            return select(keys);
        },
        async set(entries) {
            calls.set += 1;
            await this.beforeSet?.(entries);
            for ( const [ key, value ] of Object.entries(entries) ) {
                values.set(key, value);
            }
        },
        async remove(keys) {
            for ( const key of Array.isArray(keys) ? keys : [ keys ] ) {
                values.delete(key);
            }
        },
        async getKeys() {
            return Array.from(values.keys());
        },
        async getBytesInUse(keys = null) {
            return new TextEncoder().encode(JSON.stringify(select(keys))).length;
        },
        async setAccessLevel() {
        },
    };
}

const enabledList = 'https://filters.example/enabled.txt';
const orphanList = 'https://filters.example/orphan.txt';
const local = makeStorageArea({
    'rulesets.imported': [ { id: enabledList, enabled: true } ],
    [`rulesets.imported.compiled.${enabledList}`]: 'enabled-cache',
    [`rulesets.imported.compiled.${orphanList}`]: 'orphan-cache',
    [`rulesets.imported.pendingMetadata.${enabledList}`]: {
        metadataToken: 'a'.repeat(32),
    },
    [`rulesets.imported.pendingMetadata.${orphanList}`]: {
        metadataToken: 'b'.repeat(32),
    },
    'filterStore.verifiedSource.legacy-malformed': { text: 'stale' },
    'sandboxFilters.dnrRules': [ { id: 1 } ],
});
const session = makeStorageArea({
    'cache.css.example.com': { t: 1, s: [ '.ad' ], p: [] },
});

globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {},
    i18n: {},
    runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        sendMessage: async ( ) => {},
    },
    storage: { local, session },
};

const managerModule = await import(pathToFileURL(
    path.join(extensionJS, 'memory-manager.js')
));

const initialized = await managerModule.initializeMemoryProfile(2);
assert.equal(initialized.selected, MEMORY_PROFILE_AUTO);
assert.equal(initialized.effective, MEMORY_PROFILE_LOW);
assert.equal(local.values.get('memoryProfile'), MEMORY_PROFILE_AUTO);
assert.equal(local.values.get('memoryProfile.deviceMemoryGiB'), 2);

const rememberedAuto = await managerModule.getMemoryProfileConfig();
assert.equal(rememberedAuto.effective, MEMORY_PROFILE_LOW);
assert.equal(rememberedAuto.deviceMemoryGiB, 2);

const explicit = await managerModule.setMemoryProfile(
    MEMORY_PROFILE_BALANCED,
    2
);
assert.equal(explicit.effective, MEMORY_PROFILE_BALANCED);
assert.equal(local.values.get('memoryProfile'), MEMORY_PROFILE_BALANCED);

// Repeated and concurrent hot-path reads do not cross the storage boundary.
const beforeReads = { local: { ...local.calls }, session: { ...session.calls } };
for ( let i = 0; i < 100; i++ ) {
    assert.equal(await managerModule.getMemoryProfileConfig(2), explicit);
}
assert.ok((await Promise.all(Array.from({ length: 100 }, ( ) =>
    managerModule.getMemoryProfileConfig()
))).every(profile => profile === explicit));
assert.deepEqual({ local: local.calls, session: session.calls }, beforeReads);

// A fresh worker shares one cold initialization even for concurrent requests.
const restarted = await import(pathToFileURL(
    path.join(extensionJS, 'memory-manager.js')
).href + '?restart');
const coldReads = local.calls.get;
const coldWrites = session.calls.set;
const cold = await Promise.all(Array.from({ length: 20 }, ( ) =>
    restarted.getMemoryProfileConfig()
));
assert.ok(cold.every(profile => profile === cold[0]));
assert.equal(cold[0].deviceMemoryGiB, 2);
assert.equal(cold[0].effective, MEMORY_PROFILE_BALANCED);
assert.equal(local.calls.get - coldReads, 2);
assert.equal(session.calls.set - coldWrites, 1);

local.beforeSet = async entries => {
    if ( 'memoryProfile' in entries ) { throw new Error('profile write failed'); }
};
await assert.rejects(managerModule.setMemoryProfile(MEMORY_PROFILE_LOW, 2),
    /profile write failed/);
assert.equal(await managerModule.getMemoryProfileConfig(), explicit);
assert.equal(local.values.get('memoryProfile'), MEMORY_PROFILE_BALANCED);
local.beforeSet = undefined;

// A settings change must finish durably before a following read or change.
let releaseWrite;
const heldWrite = new Promise(resolve => { releaseWrite = resolve; });
let notifyWrite;
const writeStarted = new Promise(resolve => { notifyWrite = resolve; });
local.beforeSet = async entries => {
    if ( entries.memoryProfile !== MEMORY_PROFILE_LOW ) { return; }
    notifyWrite();
    await heldWrite;
};
const firstChange = managerModule.setMemoryProfile(MEMORY_PROFILE_LOW, 2);
await writeStarted;
const interveningRead = managerModule.getMemoryProfileConfig();
const secondChange = managerModule.setMemoryProfile(MEMORY_PROFILE_AUTO, 8);
releaseWrite();
assert.equal((await firstChange).effective, MEMORY_PROFILE_LOW);
assert.equal((await interveningRead).effective, MEMORY_PROFILE_LOW);
assert.equal((await secondChange).effective, MEMORY_PROFILE_BALANCED);
assert.equal(session.values.get('memoryProfile.runtime').deviceMemoryGiB, 8);
local.beforeSet = undefined;

// Session publication failure is retryable; never cache an unpublished result.
session.beforeSet = async ( ) => { throw new Error('session write failed'); };
await assert.rejects(managerModule.setMemoryProfile(MEMORY_PROFILE_LOW, 2),
    /session write failed/);
session.beforeSet = undefined;
assert.equal((await managerModule.getMemoryProfileConfig()).effective,
    MEMORY_PROFILE_LOW);
assert.equal(session.values.get('memoryProfile.runtime').effective, MEMORY_PROFILE_LOW);

// New coarse hints remain observable, including Auto after an explicit profile.
await managerModule.setMemoryProfile(MEMORY_PROFILE_AUTO, 2);
assert.equal((await managerModule.getMemoryProfileConfig(8)).effective,
    MEMORY_PROFILE_BALANCED);
assert.equal((await managerModule.getMemoryProfileConfig(2)).effective, MEMORY_PROFILE_LOW);
session.beforeSet = async ( ) => { throw new Error('hint publication failed'); };
await assert.rejects(managerModule.getMemoryProfileConfig(8), /hint publication failed/);
session.beforeSet = undefined;
assert.equal((await managerModule.getMemoryProfileConfig()).deviceMemoryGiB, 8);
assert.equal(session.values.get('memoryProfile.runtime').effective, MEMORY_PROFILE_BALANCED);

const telemetry = await managerModule.runMemoryCleanup({
    deviceMemoryGiB: 2,
});
assert.equal(
    local.values.has(`rulesets.imported.compiled.${enabledList}`),
    true
);
assert.equal(
    local.values.has(`rulesets.imported.compiled.${orphanList}`),
    false
);
assert.equal(
    local.values.has(`rulesets.imported.pendingMetadata.${enabledList}`),
    true
);
assert.equal(
    local.values.has(`rulesets.imported.pendingMetadata.${orphanList}`),
    false
);
assert.equal(
    local.values.has('filterStore.verifiedSource.legacy-malformed'),
    false
);
assert.equal(telemetry.cleanup.removedLocalKeys, 3);
assert.equal(telemetry.localOnly, true);
assert.equal(
    telemetry.storage.session.categories.cssResultCache.keyCount,
    1
);

console.log('Low-memory profile and cleanup checks passed.');
