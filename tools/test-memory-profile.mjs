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
        async get(keys) {
            return select(keys);
        },
        async set(entries) {
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
