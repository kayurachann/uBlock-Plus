/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2026-present Raymond Hill
    Modifications Copyright (C) 2026-present uBlock Plus+ contributors

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
    ACTIVE_COMPILED_GENERATION_KEY,
    COMPILED_LOGICAL_KEYS,
    STAGING_COMPILED_GENERATION_KEY,
    compiledStorageKey,
    newCompiledGeneration,
} from './compiled-storage.js';

import {
    COMPILE_IDLE_TIMEOUT_MS,
    getCompileHardTimeout,
} from './compile-timeout.js';

import {
    browser,
    localRead,
    localRemove,
    localWrite,
    runtime,
    supportsUserScripts,
} from './ext.js';

import {
    cleanupFailedCompiledGeneration,
    finalizeFailedOffscreenCompilation,
    setupManagedOffscreenDocument,
} from './offscreen-lifecycle.js';

import {
    closeOffscreenDocument,
    createOffscreenDocument,
    supportsOffscreenDocument,
} from './ext-offscreen.js';

import {
    getAllCustomFilters,
    getSandboxFilters,
} from './filter-manager.js';

import {
    isScriptlet,
    matchesFromHostnames,
} from './utils.js';

import { createCompilerStorageHandler } from './offscreen-storage.js';
import { dnr } from './ext-compat.js';
import { getEnabledImportedLists } from './imported-lists.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { getMemoryProfileConfig } from './memory-manager.js';
import { ublockPlusLog } from './debug.js';

/******************************************************************************/

async function getUserList() {
    const customFilters = await getAllCustomFilters();
    const lines = [];
    for ( const [ hostname, selectors ] of customFilters ) {
        for ( const selector of selectors ) {
            if ( isScriptlet(selector) === false ) { continue; }
            lines.push(`${hostname}##${selector}`);
        }
    }
    const sandboxFilters = await getSandboxFilters();
    if ( sandboxFilters ) {
        lines.push(sandboxFilters);
    }
    return lines.join('\n').trim();
}

/******************************************************************************/

async function parseRawFilters() {
    const generation = newCompiledGeneration();
    await localWrite(STAGING_COMPILED_GENERATION_KEY, generation);
    const offscreenPath =
        `/js/offscreen/compile-filters.html?generation=${generation}`;
    const offscreenURL = runtime.getURL(offscreenPath);
    const {
        promise: offscreenPromise,
        resolve: offscreenResolve,
    } = Promise.withResolvers();
    let setupPromise = Promise.resolve();
    let idleTimeoutId;
    let hardTimeoutId;
    let timedOut = false;
    let lifecycleClosed = false;
    let importedListsPromise;
    let storageHandlerPromise;
    const pendingStorageOperations = new Set();
    const getCompilerLists = ( ) => {
        importedListsPromise ??= getEnabledImportedLists();
        return importedListsPromise;
    };
    const handleStorage = request => {
        storageHandlerPromise ??= getCompilerLists().then(lists =>
            createCompilerStorageHandler({
                generation,
                lists,
                storage: browser.storage.local,
                isCurrent: ( ) => lifecycleClosed === false && timedOut === false,
            })
        );
        return storageHandlerPromise.then(handle => handle(request));
    };
    const {
        promise: timeoutPromise,
        reject: timeoutReject,
    } = Promise.withResolvers();
    const rejectOnTimeout = message => {
        if ( timedOut ) { return; }
        timedOut = true;
        timeoutReject(new Error(message));
    };
    const resetIdleWatchdog = ( ) => {
        if ( timedOut ) { return; }
        if ( idleTimeoutId !== undefined ) {
            self.clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = self.setTimeout(( ) => {
            rejectOnTimeout('Imported filter compilation stopped making progress');
        }, COMPILE_IDLE_TIMEOUT_MS);
    };
    const setHardTimeout = lists => {
        if ( timedOut ) { return; }
        if ( hardTimeoutId !== undefined ) {
            self.clearTimeout(hardTimeoutId);
        }
        hardTimeoutId = self.setTimeout(( ) => {
            rejectOnTimeout('Imported filter compilation exceeded its workload budget');
        }, getCompileHardTimeout(lists));
    };
    const handler = (request, sender, callback) => {
        if ( typeof request !== 'object' ) { return; }
        if ( sender?.url !== offscreenURL ) { return; }
        resetIdleWatchdog();
        switch ( request?.what ) {
        case 'compileFilters:getResourceTypes':
            callback(Object.values(dnr.ResourceType));
            break;
        case 'compileFilters:getUserList':
            getUserList().then(text => {
                if ( text ) { ublockPlusLog(`Compiling user filters`); }
                callback(text);
            });
            return true;
        case 'compileFilters:result':
            offscreenResolve(request);
            break;
        case 'compileFilters:getEnabledImportedLists':
            getCompilerLists().then(result => {
                if ( result?.length ) { ublockPlusLog(`Compiling ${result.length} imported lists`); }
                setHardTimeout(result);
                callback(result);
            });
            return true;
        case 'compileFilters:storage': {
            const pending = handleStorage(request);
            pendingStorageOperations.add(pending);
            pending.then(result => {
                pendingStorageOperations.delete(pending);
                callback(result);
            }, reason => {
                pendingStorageOperations.delete(pending);
                callback({
                    ok: false,
                    error: reason?.message || 'Compiler storage operation failed',
                });
            });
            return true;
        }
        case 'compileFilters:getMemoryProfile':
            getMemoryProfileConfig(request.deviceMemoryGiB).then(result => {
                callback(result);
            });
            return true;
        case 'compileFilters:progress':
        case 'keepAlive':
            break;
        default:
            break;
        }
    };
    let keepStaging = false;
    runtime.onMessage.addListener(handler);
    try {
        resetIdleWatchdog();
        setHardTimeout([]);
        // A service-worker restart can leave the prior offscreen document
        // alive. Closing first gives every compile one unambiguous sender.
        setupPromise = setupManagedOffscreenDocument({
            closeDocument: closeOffscreenDocument,
            createDocument: ( ) => createOffscreenDocument(offscreenPath),
            isCancelled: ( ) => lifecycleClosed || timedOut,
        });
        await Promise.race([ setupPromise, timeoutPromise ]);
        const result = await Promise.race([ offscreenPromise, timeoutPromise ]);
        if ( result?.generation !== generation ) {
            throw new Error('Filter compiler returned a mismatched generation');
        }
        if ( result.errors?.length ) { return result; }
        if ( result.persisted !== true ) {
            throw new Error('Filter compiler did not persist its generation');
        }
        keepStaging = true;
        return result;
    } finally {
        lifecycleClosed = true;
        if ( idleTimeoutId !== undefined ) { self.clearTimeout(idleTimeoutId); }
        if ( hardTimeoutId !== undefined ) { self.clearTimeout(hardTimeoutId); }
        runtime.onMessage.removeListener(handler);
        // Await writes already issued before cleaning up a failed generation;
        // a late storage completion must not recreate abandoned staging data.
        await Promise.allSettled(pendingStorageOperations);
        if ( keepStaging === false ) {
            await finalizeFailedOffscreenCompilation({
                setupPromise,
                closeDocument: closeOffscreenDocument,
                cleanupGeneration: ( ) => cleanupFailedCompiledGeneration({
                    removeGeneration: ( ) => removeCompiledGeneration(generation),
                    removeMarker: ( ) => localRemove(
                        STAGING_COMPILED_GENERATION_KEY
                    ),
                }),
            });
        } else {
            await closeOffscreenDocument().catch(( ) => { });
        }
    }
}

/******************************************************************************/

function prepareUserScripts(id, none, result) {
    const out = [];
    const excludeHostnames = none.has('all-urls') === false
        ? [ ...none ]
        : [];
    const excludeMatches = excludeHostnames.length !== 0
        ? matchesFromHostnames(excludeHostnames)
        : [];
    if ( result?.ISOLATED?.length ) {
        for ( const script of result.ISOLATED ) {
            const directive = {
                id: script.id,
                world: 'USER_SCRIPT',
                allFrames: true,
                js: [ { code: script.code } ],
                runAt: 'document_start',
                matches: matchesFromHostnames(script.hostnames),
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches.slice();
            }
            out.push(directive);
        }
    }
    if ( result?.MAIN?.length ) {
        for ( const script of result.MAIN ) {
            const directive = {
                id: script.id,
                world: 'MAIN',
                allFrames: true,
                js: [ { code: script.code } ],
                runAt: 'document_start',
                matches: matchesFromHostnames(script.hostnames),
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches.slice();
            }
            out.push(directive);
        }
    }
    return out;
}

/******************************************************************************/

async function register(generation) {
    if ( supportsUserScripts() ) {
        let previousScripts;
        try {
            previousScripts = await browser.userScripts.getScripts();
        } catch {
            // Chrome exposes the namespace even when the user-controlled
            // User Scripts toggle is off. In that state there is nothing we
            // can safely replace, so leave any browser-managed state alone.
            return false;
        }

        const { none, basic } = await getFilteringModeDetails();
        const realms = [
            [ 'sandbox', none ],
            [ 'imported', new Set([ ...none, ...basic ]) ],
        ];
        const toAdd = [];
        for ( const [ id, excluded ] of realms ) {
            const stored = await localRead(compiledStorageKey(
                generation,
                `${id}Filters.userScripts`
            )) || {};
            toAdd.push(...prepareUserScripts(id, excluded, stored));
        }

        let unregistered = false;
        try {
            if ( previousScripts.length !== 0 ) {
                await browser.userScripts.unregister();
                unregistered = true;
                ublockPlusLog(`Unregistered userscript ${previousScripts.map(a => a.id).join()}`);
            }
            if ( toAdd.length !== 0 ) {
                await browser.userScripts.register(toAdd);
                ublockPlusLog(`Registered userscript ${toAdd.map(v => v.id)}`);
            }
        } catch ( reason ) {
            if ( unregistered && previousScripts.length !== 0 ) {
                try {
                    // Clear any partially registered replacement before
                    // restoring the last known-good set.
                    await browser.userScripts.unregister();
                    await browser.userScripts.register(previousScripts);
                } catch ( rollbackReason ) {
                    throw new Error(
                        `Unable to register user scripts (${reason}); ` +
                        `rollback also failed (${rollbackReason})`
                    );
                }
            }
            throw reason;
        }
        return { previousScripts };
    }
    return false;
}

/******************************************************************************/

async function restore(previousRegistration) {
    const previousScripts = previousRegistration?.previousScripts;
    if ( Array.isArray(previousScripts) === false ) { return false; }
    const currentScripts = await browser.userScripts.getScripts();
    if ( currentScripts.length !== 0 ) {
        await browser.userScripts.unregister();
    }
    if ( previousScripts.length !== 0 ) {
        await browser.userScripts.register(previousScripts);
    }
    ublockPlusLog(`Restored ${previousScripts.length} previous userscript(s)`);
    return true;
}

/******************************************************************************/

async function update() {
    const [
        hasUserFilters,
        hasImportedLists,
    ] = await Promise.all([
        getUserList().then(a => Boolean(a)),
        getEnabledImportedLists().then(a => Boolean(a.length)),
    ]);

    let result;
    if ( hasUserFilters || hasImportedLists ) {
        result = await parseRawFilters();
        if ( Boolean(result) === false ) {
            throw new Error('Imported filter compilation timed out');
        }
        if ( result.errors?.length ) {
            const summary = result.errors
                .map(entry => `${entry.listid}: ${entry.message}`)
                .join('; ');
            throw new Error(`Imported filter compilation failed: ${summary}`);
        }
        return result;
    }
    return {
        persisted: true,
        generation: newCompiledGeneration(),
        compiledIntegrityUpdates: [],
        importedListUpdates: [],
    };
}

/******************************************************************************/

// This recompiles all sandbox and imported filters.

export async function updateCompiledFilters() {
    if ( supportsOffscreenDocument !== true ) { return false; }
    return enqueue(( ) => update());
}

/******************************************************************************/

// This registers previously compiled external filters, according to current
// filtering mode details.

export async function registerUserScripts(generation) {
    if ( supportsOffscreenDocument !== true ) { return false; }
    const effectiveGeneration = generation === undefined
        ? await getActiveCompiledGeneration()
        : generation;
    return enqueue(( ) => register(effectiveGeneration));
}

/******************************************************************************/

export async function restoreUserScripts(previousRegistration) {
    if ( supportsOffscreenDocument !== true ) { return false; }
    return enqueue(( ) =>
        restore(previousRegistration)
    );
}

/******************************************************************************/

export async function getActiveCompiledGeneration() {
    return await localRead(ACTIVE_COMPILED_GENERATION_KEY) || '';
}

export async function commitCompiledGeneration(generation) {
    await localWrite(ACTIVE_COMPILED_GENERATION_KEY, generation);
}

export async function removeCompiledGeneration(generation) {
    if ( generation === undefined || generation === null ) { return; }
    if ( generation === '' ) {
        await localRemove(COMPILED_LOGICAL_KEYS);
        return;
    }
    await localRemove(COMPILED_LOGICAL_KEYS.map(logicalKey =>
        compiledStorageKey(generation, logicalKey)
    ));
}

/******************************************************************************/

let pendingRegister = Promise.resolve();

function enqueue(task) {
    const result = pendingRegister.then(task);
    // Preserve the failure for the current caller, but keep a failed compile
    // or registration attempt from permanently poisoning later retries.
    pendingRegister = result.catch(( ) => { });
    return result;
}
