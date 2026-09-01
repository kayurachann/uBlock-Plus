/*******************************************************************************

    uBlock Plus+ - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

*/

import {
    ACTIVE_COMPILED_GENERATION_KEY,
    COMPILED_GENERATION_PREFIX,
    COMPILED_LOGICAL_KEYS,
    PENDING_COMPILED_ACTIVATION_KEY,
    STAGING_COMPILED_GENERATION_KEY,
} from './compiled-storage.js';

import {
    DEFAULT_MEMORY_PROFILE,
    normalizeMemoryProfile,
    resolveMemoryProfile,
} from './memory-profile.js';

import {
    browser,
    localRead,
    localRemove,
    localWrite,
    sessionWrite,
} from './ext.js';

import {
    PENDING_IMPORTED_METADATA_PREFIX,
} from './imported-list-metadata.js';

import { parseVerifiedSourceKey } from './verified-source-handoff.js';

/******************************************************************************/

const PROFILE_KEY = 'memoryProfile';
const DEVICE_MEMORY_KEY = 'memoryProfile.deviceMemoryGiB';
const RUNTIME_KEY = 'memoryProfile.runtime';
const TELEMETRY_KEY = 'memoryProfile.telemetry';
const IMPORT_CACHE_PREFIX = 'rulesets.imported.compiled.';

let selectedProfilePromise;
let runtimeProfile;

/******************************************************************************/

async function readSelectedProfile() {
    if ( selectedProfilePromise === undefined ) {
        selectedProfilePromise = localRead(PROFILE_KEY).then(value =>
            normalizeMemoryProfile(value)
        );
    }
    return selectedProfilePromise;
}

async function persistRuntimeProfile(deviceMemoryGiB) {
    const selected = await readSelectedProfile();
    let memoryHint = resolveMemoryProfile(
        DEFAULT_MEMORY_PROFILE,
        deviceMemoryGiB
    ).deviceMemoryGiB;
    if ( memoryHint === null ) {
        memoryHint = await localRead(DEVICE_MEMORY_KEY);
    } else if ( memoryHint !== await localRead(DEVICE_MEMORY_KEY) ) {
        // The browser exposes only a coarse value. Keep it locally so Auto
        // remains stable when a restarted service worker omits the API.
        await localWrite(DEVICE_MEMORY_KEY, memoryHint);
    }
    const resolved = resolveMemoryProfile(selected, memoryHint);
    if (
        runtimeProfile?.selected === resolved.selected &&
        runtimeProfile?.effective === resolved.effective &&
        runtimeProfile?.deviceMemoryGiB === resolved.deviceMemoryGiB
    ) {
        return runtimeProfile;
    }
    runtimeProfile = resolved;
    await sessionWrite(RUNTIME_KEY, resolved);
    return resolved;
}

export async function initializeMemoryProfile(deviceMemoryGiB) {
    const selected = await readSelectedProfile();
    if ( await localRead(PROFILE_KEY) !== selected ) {
        await localWrite(PROFILE_KEY, selected);
    }
    return persistRuntimeProfile(deviceMemoryGiB);
}

export async function getMemoryProfileConfig(deviceMemoryGiB) {
    return persistRuntimeProfile(deviceMemoryGiB);
}

export async function setMemoryProfile(value, deviceMemoryGiB) {
    const selected = normalizeMemoryProfile(value);
    selectedProfilePromise = Promise.resolve(selected);
    runtimeProfile = undefined;
    await localWrite(PROFILE_KEY, selected);
    return persistRuntimeProfile(deviceMemoryGiB);
}

/******************************************************************************/

async function getKeysWithoutValues(area) {
    if ( typeof area?.getKeys !== 'function' ) { return; }
    try {
        return await area.getKeys();
    } catch {
    }
}

async function getBytesInUse(area, keys = null) {
    if ( typeof area?.getBytesInUse !== 'function' ) { return; }
    try {
        return await area.getBytesInUse(keys);
    } catch {
    }
}

async function summarizeStorageArea(area, categoryDefinitions) {
    const keys = await getKeysWithoutValues(area);
    const summary = {
        bytes: await getBytesInUse(area) ?? null,
        keyCount: Array.isArray(keys) ? keys.length : null,
        keyEnumerationAvailable: Array.isArray(keys),
        categories: {},
    };
    for ( const [ name, predicate ] of categoryDefinitions ) {
        if ( Array.isArray(keys) === false ) {
            summary.categories[name] = {
                bytes: null,
                keyCount: null,
            };
            continue;
        }
        const categoryKeys = keys.filter(predicate);
        summary.categories[name] = {
            bytes: categoryKeys.length !== 0
                ? await getBytesInUse(area, categoryKeys)
                : 0,
            keyCount: categoryKeys.length,
        };
    }
    return summary;
}

export async function collectMemoryTelemetry(options = {}) {
    const { force = false, cleanup } = options;
    const profile = await getMemoryProfileConfig(options.deviceMemoryGiB);
    if ( force === false ) {
        const previous = await localRead(TELEMETRY_KEY);
        const minInterval = profile.telemetryMinIntervalMinutes * 60000;
        if ( Date.now() - (previous?.recordedAt ?? 0) < minInterval ) {
            return previous;
        }
    }

    const compiledOutputs = new Set(COMPILED_LOGICAL_KEYS);
    const [ local, session ] = await Promise.all([
        summarizeStorageArea(browser.storage.local, [
            [ 'importedCompilationCache', key =>
                key.startsWith(IMPORT_CACHE_PREFIX) ||
                key.startsWith(PENDING_IMPORTED_METADATA_PREFIX) ],
            [ 'compiledOutputs', key => compiledOutputs.has(key) ||
                key.startsWith(COMPILED_GENERATION_PREFIX) ],
            [ 'stockCosmeticData', key => key.startsWith('css.specific.') ],
        ]),
        summarizeStorageArea(browser.storage.session, [
            [ 'cssResultCache', key => key.startsWith('cache.css.') ],
            [ 'diagnostics', key => key === 'console' ],
        ]),
    ]);

    const telemetry = {
        schemaVersion: 1,
        recordedAt: Date.now(),
        profile,
        storage: { local, session },
        cleanup: cleanup ?? null,
        localOnly: true,
    };
    await localWrite(TELEMETRY_KEY, telemetry);
    return telemetry;
}

/******************************************************************************/

export async function runMemoryCleanup(options = {}) {
    const importedLists = await localRead('rulesets.imported') || [];
    const enabledIds = new Set(
        importedLists.filter(a => a.enabled === true).map(a => a.id)
    );
    const localKeys = await getKeysWithoutValues(browser.storage.local);
    const result = {
        ranAt: Date.now(),
        removedLocalKeys: 0,
        skippedKeyCleanup: Array.isArray(localKeys) === false,
    };

    // Compiled data for a disabled/removed imported list is only an
    // intermediate cache. The currently active DNR rules and user scripts are
    // stored under separate keys, so removing an orphan cannot weaken current
    // filtering.
    if ( Array.isArray(localKeys) ) {
        const toRemove = [];
        for ( const key of localKeys ) {
            let listid;
            if ( key.startsWith(IMPORT_CACHE_PREFIX) ) {
                listid = key.slice(IMPORT_CACHE_PREFIX.length);
            } else if ( key.startsWith(PENDING_IMPORTED_METADATA_PREFIX) ) {
                listid = key.slice(PENDING_IMPORTED_METADATA_PREFIX.length);
            } else {
                continue;
            }
            if ( enabledIds.has(listid) ) { continue; }
            toRemove.push(key);
        }
        const verifiedCutoff = Date.now() - 10 * 60 * 1000;
        for ( const key of localKeys ) {
            const parsed = parseVerifiedSourceKey(key);
            if ( parsed === undefined ) {
                if ( key.startsWith('filterStore.verifiedSource.') ) {
                    toRemove.push(key);
                }
                continue;
            }
            if ( parsed.createdAt >= verifiedCutoff ) {
                continue;
            }
            toRemove.push(key);
        }
        const [ activeGeneration, pendingActivation, stagingGeneration,
            rulesetTransaction ] = await Promise.all([
            localRead(ACTIVE_COMPILED_GENERATION_KEY),
            localRead(PENDING_COMPILED_ACTIVATION_KEY),
            localRead(STAGING_COMPILED_GENERATION_KEY),
            localRead('rulesets.pendingTransaction'),
            ]);
        const retainedGenerations = new Set([
            activeGeneration,
            pendingActivation?.generation,
            pendingActivation?.previousGeneration,
            stagingGeneration,
            rulesetTransaction?.previousGeneration,
        ].filter(value => typeof value === 'string' && value !== ''));
        for ( const key of localKeys ) {
            if ( key.startsWith(COMPILED_GENERATION_PREFIX) === false ) {
                continue;
            }
            const suffix = key.slice(COMPILED_GENERATION_PREFIX.length);
            const separator = suffix.indexOf('.');
            if ( separator === -1 ) { continue; }
            const generation = suffix.slice(0, separator);
            if ( retainedGenerations.has(generation) ) { continue; }
            toRemove.push(key);
        }
        if ( toRemove.length !== 0 ) {
            const uniqueKeys = Array.from(new Set(toRemove));
            await localRemove(uniqueKeys);
            result.removedLocalKeys = uniqueKeys.length;
        }
    }

    return collectMemoryTelemetry({
        force: true,
        cleanup: result,
        deviceMemoryGiB: options.deviceMemoryGiB,
    });
}

export async function getMemoryTelemetry(options = {}) {
    if ( options.refresh === true ) {
        return collectMemoryTelemetry({
            force: true,
            deviceMemoryGiB: options.deviceMemoryGiB,
        });
    }
    return await localRead(TELEMETRY_KEY) || collectMemoryTelemetry({
        force: true,
        deviceMemoryGiB: options.deviceMemoryGiB,
    });
}

export { DEFAULT_MEMORY_PROFILE };

/******************************************************************************/
