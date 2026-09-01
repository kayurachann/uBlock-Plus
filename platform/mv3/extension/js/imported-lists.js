/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2026-present Raymond Hill

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

    Home: https://github.com/gorhill/uBlock
*/

import {
    applyFreshImportedListMetadata,
    pendingImportedMetadataKey,
} from './imported-list-metadata.js';

import {
    localKeys,
    localRead,
    localRemove,
    localWrite,
} from './ext.js';

import {
    registerJob,
    removeJob,
} from './alarms.js';
import { isVerifiedSourceKey } from './verified-source-handoff.js';
import { ubolLog } from './debug.js';

/******************************************************************************/

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PINNED_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_FILTER_SOURCE_FETCHES = 32;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
let pendingImportedMutation = Promise.resolve();

function enqueueImportedMutation(task) {
    const result = pendingImportedMutation.then(task);
    pendingImportedMutation = result.catch(( ) => { });
    return result;
}

function normalizeSourceIntegrity(value) {
    if ( value?.algorithm !== 'sha256' ) { return; }
    if ( SHA256_PATTERN.test(value.digest) === false ) { return; }
    if ( Number.isSafeInteger(value.bytes) === false || value.bytes < 0 ||
        value.bytes > MAX_PINNED_SOURCE_BYTES ) { return; }
    return {
        algorithm: 'sha256',
        digest: value.digest,
        bytes: value.bytes,
    };
}

/******************************************************************************/

async function getCompiledListIds() {
    const out = new Set();
    const compiledPrefix = 'rulesets.imported.compiled.';
    const metadataPrefix = pendingImportedMetadataKey('');
    const keys = await localKeys();
    for ( const key of keys ) {
        if ( key.startsWith(compiledPrefix) ) {
            out.add(key.slice(compiledPrefix.length));
            continue;
        }
        if ( key.startsWith(metadataPrefix) ) {
            out.add(key.slice(metadataPrefix.length));
        }
    }
    return Array.from(out);
}

/******************************************************************************/

async function scheduleImportedListsUpdate(lists) {
    let earlierTime = 0;
    for ( const list of lists ) {
        if ( list.enabled !== true ) { continue; }
        const updateTime = list.time.updated + list.expires * MS_PER_DAY;
        if ( earlierTime !== 0 && earlierTime < updateTime ) { continue; }
        earlierTime = updateTime;
    }
    if ( earlierTime ) {
        return registerJob('updateImportedLists', earlierTime);
    }
    return removeJob('updateImportedLists');
}

/******************************************************************************/

export async function getEnabledImportedLists() {
    const importedLists = await localRead('rulesets.imported') || [];
    return importedLists.filter(a => a.enabled);
}

/******************************************************************************/

export async function getImportedLists() {
    const importedLists = await localRead('rulesets.imported') || [];
    return importedLists || [];
}

/******************************************************************************/

export function updateEnabledImportedLists(toEnable, toDisable) {
    return enqueueImportedMutation(async ( ) => {
        const importedLists = await getImportedLists();
        const reImported = /^[a-z-]+:\/\//;
        const enableRulesetIds = toEnable.filter(a => reImported.test(a));
        const disableRulesetIds = toDisable.filter(a => reImported.test(a));
        if ( enableRulesetIds.length === 0 ) {
            if ( disableRulesetIds.length === 0 ) { return false; }
        }
        let modified = false;
        for ( const list of importedLists ) {
            if ( toEnable.includes(list.id) ) {
                if ( list.enabled === true ) { continue; }
                list.enabled = true;
                modified = true;
            } else if ( toDisable.includes(list.id) ) {
                if ( list.enabled !== true ) { continue; }
                list.enabled = false;
                modified = true;
            }
        }
        if ( modified ) {
            await saveImportedListsNow(importedLists);
        }
        return modified;
    });
}

/******************************************************************************/

async function saveImportedListsNow(lists) {
    const compiledLists = await getCompiledListIds();
    const enabledListIds = lists.filter(a => a.enabled).map(a => a.id);
    const toRemove = [];
    for ( const listid of compiledLists ) {
        if ( enabledListIds.includes(listid) ) { continue; }
        toRemove.push(`rulesets.imported.compiled.${listid}`);
        toRemove.push(pendingImportedMetadataKey(listid));
    }
    await Promise.all([
        toRemove.length ? localRemove(toRemove) : false,
        localWrite('rulesets.imported', lists),
        scheduleImportedListsUpdate(lists),
    ]);
}

export function saveImportedLists(lists) {
    return enqueueImportedMutation(( ) => saveImportedListsNow(lists));
}

/******************************************************************************/

export function enableImportedRulesets(rulesets) {
    return enqueueImportedMutation(async ( ) => {
        const toEnable = new Set(rulesets);
        const importedLists = await getImportedLists();
        let modified = 0;
        for ( const list of importedLists ) {
            if ( toEnable.has(list.id) ) {
                if ( list.enabled === true ) { continue; }
                list.enabled = true;
                modified += 1;
            } else {
                if ( list.enabled !== true ) { continue; }
                list.enabled = false;
                modified += 1;
            }
        }
        if ( modified ) {
            await saveImportedListsNow(importedLists);
        }
        return modified;
    });
}

/******************************************************************************/

export async function getImportedListCompiledData(listid) {
    const cached = await localRead(`rulesets.imported.compiled.${listid}`);
    return {
        listid,
        serialized: typeof cached === 'string'
            ? cached
            : cached?.serialized,
    };
}

/******************************************************************************/

export function updateImportedListData(listid, details) {
    return enqueueImportedMutation(async ( ) => {
        if ( Object.hasOwn(details, 'compiled') ) {
            if ( details.compiled ) {
                await localWrite(`rulesets.imported.compiled.${listid}`, details.compiled);
            } else {
                await localRemove([
                    `rulesets.imported.compiled.${listid}`,
                    pendingImportedMetadataKey(listid),
                ]);
            }
        }
        const lists = await getImportedLists();
        const list = lists.find(a => listid === a.id);
        if ( list === undefined ) { return; }
        list.time.updated = Date.now();
        if ( details.title ) { list.name = details.title; }
        if ( details.homeURL ) { list.homeURL = details.homeURL; }
        if ( details.expires ) { list.expires = details.expires; }
        if ( Object.hasOwn(details, 'verifiedSourceKey') ) {
            if ( details.verifiedSourceKey ) {
                list.verifiedSourceKey = details.verifiedSourceKey;
            } else {
                delete list.verifiedSourceKey;
            }
        }
        if ( details.filterStats ) { list.filters = details.filterStats; }
        if ( details.ruleStats ) { list.rules = details.ruleStats; }
        if ( Object.hasOwn(details, 'compiledIntegrity') ) {
            const compiledIntegrity = normalizeSourceIntegrity(
            details.compiledIntegrity
            );
            if ( compiledIntegrity ) {
                list.compiledIntegrity = compiledIntegrity;
            } else {
                delete list.compiledIntegrity;
            }
        }
        await saveImportedListsNow(lists);
        return { listid };
    });
}

/******************************************************************************/

// URL will be ruleset id

export function addImportedLists(toImport) {
    return enqueueImportedMutation(async ( ) => {
        const lists = await getImportedLists();
        const pendingMetadataKeys = [];
        let modified = false;
        for ( let details of toImport ) {
            if ( typeof details === 'string' ) {
                details = { url: details };
            }
            const { url } = details;
            pendingMetadataKeys.push(pendingImportedMetadataKey(url));
            const sourceIntegrity = normalizeSourceIntegrity(details.sourceIntegrity);
            const maxSourceBytes = Number.isSafeInteger(details.maxSourceBytes) &&
            details.maxSourceBytes > 0 &&
            details.maxSourceBytes <= MAX_PINNED_SOURCE_BYTES
                ? details.maxSourceBytes
                : MAX_PINNED_SOURCE_BYTES;
            const maxSourceFetches =
            Number.isSafeInteger(details.maxSourceFetches) &&
            details.maxSourceFetches > 0 &&
            details.maxSourceFetches <= MAX_FILTER_SOURCE_FETCHES
                ? details.maxSourceFetches
                : MAX_FILTER_SOURCE_FETCHES;
            const requireHTTPSSource = true;
            const verifiedSourceKey = sourceIntegrity &&
            isVerifiedSourceKey(
                details.verifiedSourceKey,
                sourceIntegrity.digest
            )
                ? details.verifiedSourceKey
                : undefined;
            const existing = lists.find(a => a.id === url);
            if ( existing ) {
                if ( details.name && existing.name !== details.name ) {
                    existing.name = details.name;
                    modified = true;
                }
                if ( details.homeURL && existing.homeURL !== details.homeURL ) {
                    existing.homeURL = details.homeURL;
                    modified = true;
                }
                if ( sourceIntegrity &&
                JSON.stringify(existing.sourceIntegrity) !==
                    JSON.stringify(sourceIntegrity) ) {
                    existing.sourceIntegrity = sourceIntegrity;
                    delete existing.compiledIntegrity;
                    modified = true;
                }
                if ( verifiedSourceKey ) {
                    existing.verifiedSourceKey = verifiedSourceKey;
                    modified = true;
                }
                if ( maxSourceBytes && existing.maxSourceBytes !== maxSourceBytes ) {
                    existing.maxSourceBytes = maxSourceBytes;
                    modified = true;
                }
                if ( maxSourceFetches &&
                existing.maxSourceFetches !== maxSourceFetches ) {
                    existing.maxSourceFetches = maxSourceFetches;
                    modified = true;
                }
                if ( requireHTTPSSource && existing.requireHTTPSSource !== true ) {
                    existing.requireHTTPSSource = true;
                    modified = true;
                }
                continue;
            }
            const list = {
            id: url,
            name: details.name ?? url,
            group: 'imported',
            enabled: false,
            homeURL: details.homeURL ?? '',
            expires: 7,
            time: {
                added: Date.now(),
                updated: 0,
            },
            filters: {
                total: 0,
                accepted: 0,
                rejected: 0,
            },
            rules: {
                total: 0,
                plain: 0,
                regex: 0,
            },
            };
            if ( sourceIntegrity ) { list.sourceIntegrity = sourceIntegrity; }
            if ( verifiedSourceKey ) { list.verifiedSourceKey = verifiedSourceKey; }
            if ( maxSourceBytes ) { list.maxSourceBytes = maxSourceBytes; }
            if ( maxSourceFetches ) { list.maxSourceFetches = maxSourceFetches; }
            if ( requireHTTPSSource ) { list.requireHTTPSSource = true; }
        lists.push(list);
        modified = true;
        }
        if ( modified ) {
            await saveImportedListsNow(lists);
        }
        if ( pendingMetadataKeys.length !== 0 ) {
            // Import/restore callers invalidate the corresponding compiled
            // payload before recompiling, so any failed-attempt metadata is
            // stale as well.
            await localRemove(pendingMetadataKeys);
        }
        return true;
    });
}

/******************************************************************************/

export function removeImportedLists(ids) {
    return enqueueImportedMutation(async ( ) => {
        const setOfIds = new Set(Array.isArray(ids) ? ids : [ ids ]);
        const beforeLists = await getImportedLists();
        const afterLists = beforeLists.filter(a => setOfIds.has(a.id) === false);
        if ( afterLists.length === beforeLists.length ) { return false; }
        await saveImportedListsNow(afterLists);
        return true;
    });
}

/******************************************************************************/

export function replaceImportedLists(lists) {
    return enqueueImportedMutation(( ) =>
        saveImportedListsNow(structuredClone(lists))
    );
}

async function cleanupCommittedImportedListUpdatesNow(updates) {
    if ( Array.isArray(updates) === false || updates.length === 0 ) {
        return 0;
    }
    let removed = 0;
    for ( const update of updates ) {
        if ( typeof update?.listid !== 'string' ||
            /^[a-f0-9]{32}$/.test(update.metadataToken) === false ) {
            continue;
        }
        const metadataKey = pendingImportedMetadataKey(update.listid);
        try {
            const pendingMetadata = await localRead(metadataKey);
            if ( pendingMetadata?.metadataToken !== update.metadataToken ) {
                // A newer refresh already replaced this cache entry. Never
                // clear it while committing the older metadata.
                continue;
            }
            await localRemove(metadataKey);
            removed += 1;
        } catch ( reason ) {
            // The committed token on the imported-list record prevents a
            // stale envelope from being staged again after a restart. Cache
            // cleanup is therefore safe to retry and must not roll activation
            // back after the metadata write already succeeded.
            ubolLog(`Unable to clear committed list metadata: ${reason}`);
        }
    }
    return removed;
}

export function cleanupCommittedImportedListUpdates(updates) {
    return enqueueImportedMutation(( ) =>
        cleanupCommittedImportedListUpdatesNow(updates)
    );
}

export function commitImportedListUpdates(updates, options = {}) {
    return enqueueImportedMutation(async ( ) => {
        if ( Array.isArray(updates) === false || updates.length === 0 ) {
            return false;
        }
        const lists = await getImportedLists();
        const byId = new Map(lists.map(list => [ list.id, list ]));
        const committedMetadataUpdates = [];
        const now = Date.now();
        let modified = false;
        for ( const update of updates ) {
            const list = byId.get(update?.listid);
            if ( list === undefined ) { continue; }
            const compiledIntegrity = normalizeSourceIntegrity(
                update?.compiledIntegrity
            );
            if ( compiledIntegrity !== undefined &&
                JSON.stringify(list.compiledIntegrity) !==
                    JSON.stringify(compiledIntegrity) ) {
                list.compiledIntegrity = compiledIntegrity;
                modified = true;
            }

            // Only a freshly fetched/compiled list carries a metadata token.
            // Integrity-only provenance updates must not postpone the list's
            // next scheduled refresh.
            const metadataResult = applyFreshImportedListMetadata(
                list,
                update,
                now
            );
            if ( metadataResult.fresh === false ) { continue; }
            committedMetadataUpdates.push(update);
            if ( metadataResult.modified === false ) {
                // Metadata was saved before a service-worker restart. Avoid
                // advancing time.updated a second time; cleanup below can
                // still retire the pending cache envelope.
                continue;
            }
            modified = true;
        }
        if ( modified ) { await saveImportedListsNow(lists); }
        // Direct activations finalize their sidecars after the durable list
        // metadata write. An outer ruleset transaction can defer this until
        // its own journal is committed. Each cleanup checks its token so it
        // cannot clear a newer refresh.
        if ( options.cleanup !== false ) {
            await cleanupCommittedImportedListUpdatesNow(
                committedMetadataUpdates
            );
        }
        return modified;
    });
}

/******************************************************************************/

export async function updateImportedLists() {
    const lists = await getEnabledImportedLists();
    const now = Date.now();
    const toUpdate = [];
    for ( const list of lists ) {
        const updateTime = list.time.updated + list.expires * MS_PER_DAY;
        if ( updateTime > now ) { continue; }
        toUpdate.push(list.id);
    }
    if ( toUpdate.length === 0 ) { return 0; }
    await localRemove(toUpdate.flatMap(listid => [
        `rulesets.imported.compiled.${listid}`,
        pendingImportedMetadataKey(listid),
    ]));
    ubolLog(`Will update imported filter lists: ${toUpdate.join()}`);
    return toUpdate.length;
}
