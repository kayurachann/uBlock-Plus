/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

import { COMPILED_LOGICAL_KEYS, compiledStorageKey } from './compiled-storage.js';
import { isVerifiedSourceKey } from './verified-source-handoff.js';
import { pendingImportedMetadataKey } from './imported-list-metadata.js';

// Chromium offscreen documents expose runtime only. Storage is performed by
// the service worker, with an acknowledgement before the compiler can report
// a persisted generation. Missing responses and rejected writes are failures.
export function createCompilerStorageClient(runtime, generation) {
    const send = async (operation, data) => {
        const response = await runtime.sendMessage({
            what: 'compileFilters:storage',
            generation,
            operation,
            ...data,
        });
        if ( response?.ok !== true ) {
            throw new Error(response?.error || 'Compiler storage request failed');
        }
        return response.value;
    };
    return {
        get: keys => send('get', { keys }),
        set: values => send('set', { values }),
        remove: keys => send('remove', { keys }),
    };
}

// This handler is attached only to the current compiler's exact document URL.
// Keep its storage authority limited to that generation, enabled-list caches,
// and one-shot verified sources; active settings and other generations cannot
// be read or overwritten through this channel.
export function createCompilerStorageHandler({
    generation, lists, storage, isCurrent = ( ) => true,
}) {
    const readable = new Set();
    const writable = new Set(COMPILED_LOGICAL_KEYS.map(key =>
        compiledStorageKey(generation, key)
    ));
    const removable = new Set(writable);
    for ( const list of lists ) {
        if ( list?.enabled !== true ) { continue; }
        for ( const key of [
            `rulesets.imported.compiled.${list.id}`,
            pendingImportedMetadataKey(list.id),
        ] ) {
            readable.add(key);
            writable.add(key);
            removable.add(key);
        }
        if ( isVerifiedSourceKey(list.verifiedSourceKey,
            list.sourceIntegrity?.digest) ) {
            readable.add(list.verifiedSourceKey);
            removable.add(list.verifiedSourceKey);
        }
    }
    return async request => {
        if ( /^[a-f0-9]{32}$/.test(generation) === false ||
            request.generation !== generation || isCurrent() === false ) {
            throw new Error('Compiler storage generation is no longer active');
        }
        const { operation } = request;
        if ( [ 'get', 'set', 'remove' ].includes(operation) === false ) {
            throw new Error('Invalid compiler storage operation');
        }
        if ( operation === 'set' && (
            request.values === null || typeof request.values !== 'object' ||
            Array.isArray(request.values)
        ) ) {
            throw new Error('Invalid compiler storage values');
        }
        const keys = operation === 'set'
            ? Object.keys(request.values)
            : typeof request.keys === 'string' ? [ request.keys ] : request.keys;
        const permitted = operation === 'get' ? readable
            : operation === 'set' ? writable : removable;
        if ( Array.isArray(keys) === false ||
            keys.some(key => typeof key !== 'string' || permitted.has(key) === false) ) {
            throw new Error('Compiler storage key is outside its staging scope');
        }
        const value = operation === 'set'
            ? await storage.set(request.values)
            : await storage[operation](keys);
        return { ok: true, value };
    };
}
