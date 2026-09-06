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
    SCRIPTLET_EXCEPTION_SLOT,
    SCRIPTLET_WARNINGS_KEY,
    bindScriptletExceptions,
} from './scriptlet-exceptions.js';

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
    intersectHostnameIters,
    isScriptlet,
    matchesFromHostnames,
} from './utils.js';

import {
    prepareNativeStockScriptlets,
    removeNativeStockScriptlets,
    restoreNativeStockScriptlets,
    sharedScriptletContext,
    stockScriptletSources,
} from './scriptlet-registration.js';

import { createCompilerStorageHandler } from './offscreen-storage.js';
import { dnr } from './ext-compat.js';
import { getEnabledImportedLists } from './imported-lists.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { getMemoryProfileConfig } from './memory-manager.js';
import { recordLoggerEvent } from './logger.js';
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
        case 'compileFilters:getEnabledStockRulesets':
            dnr.getEnabledRulesets().then(callback);
            return true;
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

function prepareUserScripts(id, modes, result) {
    const out = [];
    const included = [ ...modes.optimal, ...modes.complete ];
    const excluded = [ ...modes.none ];
    if ( id === 'sandbox' ) {
        included.push(...modes.basic);
    } else {
        excluded.push(...modes.basic);
    }
    const includeEverywhere = included.includes('all-urls');
    const excludeHostnames = excluded.filter(hn => hn !== 'all-urls');
    const excludeMatches = excludeHostnames.length !== 0
        ? matchesFromHostnames(excludeHostnames)
        : [];
    const matchesFor = hostnames => {
        const targets = typeof hostnames === 'string' ? [ hostnames ] : hostnames;
        // Either the filter scope or the enabled site can be more specific.
        // Keep their intersection; a global disabled-mode marker is not an
        // instruction to remove all explicit child exclusions.
        const scoped = includeEverywhere ? targets : [
            ...intersectHostnameIters(targets, included),
            ...intersectHostnameIters(included, targets),
        ];
        return matchesFromHostnames(new Set(scoped));
    };
    if ( result?.ISOLATED?.length ) {
        for ( const script of result.ISOLATED ) {
            const matches = matchesFor(script.hostnames);
            if ( matches.length === 0 ) { continue; }
            const directive = {
                id: script.id,
                world: 'USER_SCRIPT',
                allFrames: true,
                js: [ { code: script.code } ],
                runAt: 'document_start',
                matches,
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches.slice();
            }
            out.push(directive);
        }
    }
    if ( result?.MAIN?.length ) {
        for ( const script of result.MAIN ) {
            const matches = matchesFor(script.hostnames);
            if ( matches.length === 0 ) { continue; }
            const directive = {
                id: script.id,
                world: 'MAIN',
                allFrames: true,
                js: [ { code: script.code } ],
                runAt: 'document_start',
                matches,
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
    const modes = await getFilteringModeDetails();
    const shared = await sharedScriptletContext(generation, modes);
    let legacyDeferred = shared.schema !== 1 && (generation !== '' ||
        Boolean(await getUserList()) || (await getEnabledImportedLists()).length !== 0);
    const legacyWarning = 'Scriptlet execution is temporarily deferred because the active ' +
        'compiled generation predates shared exceptions. Network rules and cached sources ' +
        'are retained; the normal compiler retry will restore scriptlets after rebuilding.';
    const fallback = async ( ) => {
        if ( legacyDeferred ) {
            for ( const { id } of shared.stock ) { shared.nativeExclusions.set(id, [ '*' ]); }
        }
        const affected = Array.from(shared.nativeExclusions)
            .filter(([, hostnames]) => hostnames.length !== 0).map(([ id ]) => id);
        const warnings = legacyDeferred ? [ legacyWarning ] : affected.length ? [
            'Allow User Scripts is unavailable. Scriptlet exceptions are preserved by ' +
            'suspending affected packaged scriptlet files on their exception scopes; ' +
            'unrelated scriptlets in the same files may also be skipped. Enable ' +
            'Allow User Scripts and reload the extension for exact exceptions.',
        ] : [];
        await localWrite(SCRIPTLET_WARNINGS_KEY, warnings);
        const nativeStockScriptlets = prepareNativeStockScriptlets(shared, modes);
        const previousNativeScripts = await removeNativeStockScriptlets();
        try {
            if ( nativeStockScriptlets.length && browser.scripting ) {
                await browser.scripting.registerContentScripts(nativeStockScriptlets);
            }
        } catch ( reason ) {
            await removeNativeStockScriptlets();
            await restoreNativeStockScriptlets(previousNativeScripts);
            throw reason;
        }
        if ( warnings.length ) {
            recordLoggerEvent({ kind: 'scriptlet', phase: 'exception-applied',
                source: 'stock', detail: warnings[0] });
        }
        return { previousNativeScripts, stockScriptlets: false,
            nativeScriptletExclusions: shared.nativeExclusions,
            nativeStockScriptlets, warnings };
    };
    if ( supportsUserScripts() ) {
        let previousScripts;
        try {
            previousScripts = await browser.userScripts.getScripts();
        } catch {
            // Chrome exposes the namespace even when the user-controlled
            // User Scripts toggle is off. In that state there is nothing we
            // can safely replace, so leave any browser-managed state alone.
            return fallback();
        }

        const toAdd = [];
        for ( const id of [ 'sandbox', 'imported', 'stock' ] ) {
            const stored = id === 'stock' ? await stockScriptletSources(shared)
                : await localRead(compiledStorageKey(
                    generation,
                    `${id}Filters.userScripts`
                )) || {};
            for ( const scripts of Object.values(stored) ) {
                for ( const script of scripts ) {
                    if ( script.id.endsWith('-scriptlets') === false ) { continue; }
                    if ( script.code.includes(SCRIPTLET_EXCEPTION_SLOT) === false ) {
                        legacyDeferred = true;
                        continue;
                    }
                    script.code = bindScriptletExceptions(script.code, shared.payload);
                }
            }
            toAdd.push(...prepareUserScripts(id, modes, stored));
        }
        if ( legacyDeferred ) {
            for ( let i = toAdd.length - 1; i >= 0; i-- ) {
                if ( toAdd[i].id.endsWith('-scriptlets') ) { toAdd.splice(i, 1); }
            }
        }

        const nativeStockScriptlets = legacyDeferred ? []
            : prepareNativeStockScriptlets(shared, modes, true);
        let replacementStarted = false;
        const previousNativeScripts = await removeNativeStockScriptlets();
        try {
            // Configure on every successful API probe: toggling Allow User
            // Scripts does not emit a permissions event in Chromium.
            await browser.userScripts.configureWorld({ messaging: true });
            if ( previousScripts.length !== 0 ) {
                await browser.userScripts.unregister();
                replacementStarted = true;
                ublockPlusLog(`Unregistered userscript ${previousScripts.map(a => a.id).join()}`);
            }
            if ( toAdd.length !== 0 ) {
                replacementStarted = true;
                await browser.userScripts.register(toAdd);
                ublockPlusLog(`Registered userscript ${toAdd.map(v => v.id)}`);
            }
            if ( nativeStockScriptlets.length && browser.scripting ) {
                await browser.scripting.registerContentScripts(nativeStockScriptlets);
            }
        } catch ( reason ) {
            if ( replacementStarted ) {
                try {
                    // Clear any partially registered replacement before
                    // restoring the last known-good set.
                    await browser.userScripts.unregister();
                    if ( previousScripts.length !== 0 ) {
                        await browser.userScripts.register(previousScripts);
                    }
                } catch ( rollbackReason ) {
                    throw new Error(
                        `Unable to register user scripts (${reason}); ` +
                        `rollback also failed (${rollbackReason})`
                    );
                }
            }
            await restoreNativeStockScriptlets(previousNativeScripts);
            throw reason;
        }
        const originDeferred = Array.from(shared.nativeExclusions.values()).some(hns => hns.length);
        const warnings = legacyDeferred ? [ legacyWarning ] : originDeferred ? [
            'Shared scriptlet exceptions apply exactly in matching web frames. In ' +
            'about:blank, srcdoc, data and blob frames, Chrome cannot bind dynamic ' +
            'user-script data at document_start; affected packaged files are ' +
            'conservatively skipped on exception scopes to preserve fail-open behavior.',
        ] : [];
        await localWrite(SCRIPTLET_WARNINGS_KEY, warnings).catch(reason => {
            ublockPlusLog(`Unable to clear scriptlet warnings: ${reason}`);
        });
        for ( const [ prefix, source ] of [
            [ 'stock-', 'stock' ], [ 'imported-', 'imported' ], [ 'sandbox-', 'personal' ],
        ] ) {
            const count = toAdd.filter(script => script.id.startsWith(prefix) &&
                script.id.endsWith('-scriptlets')).length;
            recordLoggerEvent({ kind: 'scriptlet', phase: 'registered', source,
                detail: `${count} scriptlet program(s) registered with shared exceptions; execution/effect is not inferred.` });
        }
        return { previousScripts, previousNativeScripts, stockScriptlets: true,
            nativeStockScriptlets, nativeScriptletExclusions: shared.nativeExclusions };
    }
    return fallback();
}

/******************************************************************************/

async function restore(previousRegistration) {
    const previousScripts = previousRegistration?.previousScripts;
    if ( Array.isArray(previousScripts) === false ) {
        await restoreNativeStockScriptlets(previousRegistration?.previousNativeScripts);
        return false;
    }
    const currentScripts = await browser.userScripts.getScripts();
    if ( currentScripts.length !== 0 ) {
        await browser.userScripts.unregister();
    }
    if ( previousScripts.length !== 0 ) {
        await browser.userScripts.register(previousScripts);
    }
    await restoreNativeStockScriptlets(previousRegistration?.previousNativeScripts);
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
    const generation = newCompiledGeneration();
    await localWrite(STAGING_COMPILED_GENERATION_KEY, generation);
    await localWrite(compiledStorageKey(generation, 'scriptletExceptions.schema'), 1);
    return {
        persisted: true,
        generation,
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
    return enqueue(async ( ) => register(generation === undefined
        ? await getActiveCompiledGeneration()
        : generation));
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
