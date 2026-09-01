/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

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
    MODE_BASIC,
    MODE_OPTIMAL,
    defaultFilteringModes,
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    persistHostPermissions,
    setDefaultFilteringMode,
    setFilteringMode,
    setFilteringModeDetails,
    syncWithBrowserPermissions,
} from './mode-manager.js';

import {
    PENDING_COMPILED_ACTIVATION_KEY,
    STAGING_COMPILED_GENERATION_KEY,
} from './compiled-storage.js';

import {
    addCustomFilters,
    customFiltersFromHostname,
    getAllCustomFilters,
    getSandboxFilters,
    hasCustomFilters,
    injectCustomFilters,
    removeAllCustomFilters,
    removeCustomFilters,
    setSandboxFilters,
    startCustomFilters,
    terminateCustomFilters,
} from './filter-manager.js';

import {
    addImportedLists,
    cleanupCommittedImportedListUpdates,
    commitImportedListUpdates,
    getImportedLists,
    removeImportedLists,
    replaceImportedLists,
    updateImportedLists,
} from './imported-lists.js';

import {
    adminReadEx,
    getAdminRulesets,
    loadAdminConfig,
} from './admin.js';

import {
    broadcastMessage,
    hostnameFromMatch,
    hostnamesFromMatches,
    isScriptlet,
} from './utils.js';

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
    sessionAccessLevel, sessionRead, sessionWrite,
    supportsUserScripts,
    webextFlavor,
} from './ext.js';

import {
    closeOffscreenDocument,
    supportsOffscreenDocument,
} from './ext-offscreen.js';

import {
    commitCompiledGeneration,
    getActiveCompiledGeneration,
    registerUserScripts,
    removeCompiledGeneration,
    restoreUserScripts,
    updateCompiledFilters,
} from './compiled-filters.js';

import {
    defaultConfig,
    loadRulesetConfig,
    process,
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import {
    enableRulesets,
    excludeFromStrictBlock,
    getDefaultRulesetsFromEnv,
    getEffectiveUserRules,
    getEnabledRulesets,
    getEnabledRulesetsDetails,
    getRulesetDetails,
    getRulesetRules,
    patchDefaultRulesets,
    setStrictBlockMode,
    updateDynamicAndSessionRules,
    updateSessionRules,
    updateUserRules,
} from './ruleset-manager.js';

import {
    getConsoleOutput,
    getMatchedRules,
    isSideloaded,
    toggleDeveloperMode,
    ubolErr,
    ubolLog,
} from './debug.js';

import {
    getMemoryProfileConfig,
    getMemoryTelemetry,
    initializeMemoryProfile,
    runMemoryCleanup,
    setMemoryProfile,
} from './memory-manager.js';

import {
    getRegisteredContentScripts,
    pruneCSSCache,
    registerContentScripts,
    releaseScriptingMetadata,
} from './scripting-manager.js';

import {
    gotoURL,
    hasBroadHostPermissions,
} from './ext-utils.js';

import {
    processDueJobs,
    registerJob,
    removeJob,
    resetJobsAlarm,
} from './alarms.js';

import { createPopupBlocker } from './popup-blocker.js';
import { dnr } from './ext-compat.js';
import { getRuntimeCapabilities } from './runtime-capabilities.js';
import { setPopupBlockMode } from './prevent-popup.js';
import { toggleToolbarIcon } from './action.js';

/******************************************************************************/

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();
const canShowBlockedCount = typeof dnr.setExtensionActionOptions === 'function';
const COMPILED_FILTERS_DIRTY_KEY = 'compiledFilters.dirtySources';
const COMPILED_FILTERS_RETRY_JOB = 'retryCompiledFilters';
const COMPILED_FILTER_WARNINGS_KEY = 'compiledFilters.lastWarnings';
const RULESET_TRANSACTION_KEY = 'rulesets.pendingTransaction';
let pendingFilteringMutation = Promise.resolve();
let cssCacheWritesSincePrune = 0;

async function getPopupGestureContexts(tabId) {
    let frames = [ { frameId: 0 } ];
    if ( webextFlavor === 'chromium' &&
        browser.webNavigation?.getAllFrames ) {
        frames = await browser.webNavigation.getAllFrames({ tabId })
            .catch(( ) => frames);
    }
    const responses = await Promise.all(frames.slice(0, 64).map(async frame => {
        const response = await browser.tabs.sendMessage(
            tabId,
            { what: 'getPopupGestureContext' },
            { frameId: frame.frameId }
        ).catch(( ) => undefined);
        if ( response instanceof Object === false ) { return; }
        return { ...response, frameId: frame.frameId };
    }));
    return responses.filter(response => response !== undefined);
}

const popupBlocker = createPopupBlocker({
    tabs: browser.tabs,
    getGestureContexts: getPopupGestureContexts,
    localRead,
    localWrite,
    sessionRead,
    sessionWrite,
    isEnabled: ( ) => rulesetConfig.popupBlockMode === true,
    log: message => ubolLog(message),
});

function enqueueFilteringMutation(task) {
    const result = pendingFilteringMutation.then(task);
    pendingFilteringMutation = result.catch(( ) => { });
    return result;
}

let pendingPermissionRequest;

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

/******************************************************************************/

async function reloadTab(tabId, url = '') {
    return new Promise(resolve => {
        self.setTimeout(( ) => {
            if ( url !== '' ) {
                browser.tabs.update(tabId, { url });
            } else {
                browser.tabs.reload(tabId);
            }
            resolve();
        }, 437);
    });
}

// When a new host permission is granted through the popup panel
async function onPermissionGrantedThruExtension(details, origins) {
    await persistHostPermissions();
    const defaultMode = await getDefaultFilteringMode();
    if ( defaultMode >= MODE_OPTIMAL ) { return; }
    if ( Array.isArray(origins) === false ) { return; }
    const hostnames = hostnamesFromMatches(origins);
    if ( hostnames.includes(details.hostname) === false ) { return; }
    const beforeLevel = await getFilteringMode(details.hostname);
    if ( beforeLevel === details.afterLevel ) { return; }
    const afterLevel = await setFilteringMode(details.hostname, details.afterLevel);
    if ( afterLevel !== details.afterLevel ) { return; }
    await registerContentScripts();
    if ( rulesetConfig.autoReload !== true ) { return; }
    await reloadTab(details.tabId, details.url);
}

// When a new host permission is granted through the browser
async function onPermissionGrantedThruBrowser(origins) {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return; }
    await registerContentScripts();
    if ( rulesetConfig.autoReload !== true ) { return; }
    if ( origins.length !== 1 ) { return; }
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if ( typeof tabId !== 'number' || tabId === -1 ) { return; }
    const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [ 0 ] },
        func: ( ) => document.location.hostname,
    }).catch(( ) => {
    });
    const tabHostname = results?.[0]?.result;
    if ( typeof tabHostname !== 'string' ) { return; }
    const hostname = hostnameFromMatch(origins[0]);
    if ( tabHostname.endsWith(hostname) === false ) { return; }
    const pos = tabHostname.length - hostname.length;
    if ( pos !== 0 && tabHostname.charAt(pos-1) !== '.' ) { return; }
    await reloadTab(tabId);
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
async function onPermissionsAdded(permissions) {
    const details = pendingPermissionRequest;
    pendingPermissionRequest = undefined;
    const { origins = [] } = permissions;
    return details !== undefined
        ? onPermissionGrantedThruExtension(details, origins)
        : onPermissionGrantedThruBrowser(origins);
}

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return false; }
    registerContentScripts();
    return true;
}

async function onPermissionsChanged(op, permissions) {
    await isFullyInitialized;
    const { pending } = onPermissionsChanged;
    await Promise.all(pending);
    const promise = op === 'removed'
        ? onPermissionsRemoved()
        : onPermissionsAdded(permissions);
    pending.push(promise);
}
onPermissionsChanged.pending = [];

/******************************************************************************/

async function activateCompiledFilterRulesNow(options = {}) {
    const compilationResult = await updateCompiledFilters();
    const generation = compilationResult?.generation;
    if ( typeof generation !== 'string' || generation === '' ) {
        throw new Error('Filter compiler did not produce a valid generation');
    }
    const previousGeneration = await getActiveCompiledGeneration();
    const pendingActivation = {
        generation,
        previousGeneration,
        importedListUpdates: [
            ...(compilationResult.importedListUpdates || []),
            ...(compilationResult.compiledIntegrityUpdates || []),
        ],
    };
    await localWrite(PENDING_COMPILED_ACTIVATION_KEY, pendingActivation);
    await localRemove(STAGING_COMPILED_GENERATION_KEY);
    let previousRegistration;
    let result;
    try {
        previousRegistration = await registerUserScripts(generation);
        result = await updateUserRules(generation);
        if ( result?.fatalError ) {
            throw new Error(
                `Unable to activate compiled DNR rules: ${result.fatalError}`
            );
        }
        await commitCompiledGeneration(generation);
        if ( options.deferImportedListFinalization !== true ) {
            await commitImportedListUpdates(
                pendingActivation.importedListUpdates
            );
            await localRemove(PENDING_COMPILED_ACTIVATION_KEY);
            await recordCompiledFilterWarnings(result?.errors || []);
        }
    } catch ( reason ) {
        const rollbackErrors = [];
        try {
            await restoreUserScripts(previousRegistration);
        } catch ( rollbackReason ) {
            rollbackErrors.push(`user scripts: ${rollbackReason}`);
        }
        try {
            const rollbackResult = await updateUserRules(previousGeneration);
            if ( rollbackResult?.fatalError ) {
                rollbackErrors.push(`DNR: ${rollbackResult.fatalError}`);
            }
        } catch ( rollbackReason ) {
            rollbackErrors.push(`DNR: ${rollbackReason}`);
        }
        try {
            await commitCompiledGeneration(previousGeneration);
        } catch ( rollbackReason ) {
            rollbackErrors.push(`generation pointer: ${rollbackReason}`);
        }
        if ( rollbackErrors.length === 0 ) {
            await localRemove(PENDING_COMPILED_ACTIVATION_KEY);
            await removeCompiledGeneration(generation);
        }
        if ( rollbackErrors.length !== 0 ) {
            throw new Error(
                `${reason}; activation rollback failed (${rollbackErrors.join('; ')})`
            );
        }
        throw reason;
    }
    if ( options.retainPreviousGeneration !== true &&
        previousGeneration !== generation ) {
        removeCompiledGeneration(previousGeneration)
            .catch(reason => ubolErr(`removeCompiledGeneration/${reason}`));
    }
    return {
        ...result,
        generation,
        previousGeneration,
        importedListUpdates: pendingActivation.importedListUpdates,
    };
}

async function recordCompiledFilterWarnings(warnings) {
    if ( warnings.length !== 0 ) {
        await localWrite(COMPILED_FILTER_WARNINGS_KEY, {
            count: warnings.length,
            recordedAt: Date.now(),
            messages: warnings.slice(0, 50),
        }).catch(reason => {
            ubolErr(`compiledFilterWarnings/${reason}`);
        });
    } else {
        await localRemove(COMPILED_FILTER_WARNINGS_KEY).catch(( ) => { });
    }
}

function activateCompiledFilterRules(options = {}) {
    return enqueueFilteringMutation(( ) =>
        activateCompiledFilterRulesNow(options)
    );
}

async function markCompiledFilterSourcesDirty(flags) {
    const previous = await localRead(COMPILED_FILTERS_DIRTY_KEY);
    const marker = {
        compiled: flags.compiled === true || previous?.compiled === true,
        contentScripts:
            flags.contentScripts === true || previous?.contentScripts === true,
        updatedAt: Date.now(),
    };
    await localWrite(COMPILED_FILTERS_DIRTY_KEY, marker);
    return { marker, hadPending: previous instanceof Object };
}

async function scheduleCompiledFilterRetry() {
    await registerJob(
        COMPILED_FILTERS_RETRY_JOB,
        Date.now() + 5 * 60 * 1000
    );
}

async function flushDirtyCompiledFilterSourcesNow() {
    const marker = await localRead(COMPILED_FILTERS_DIRTY_KEY);
    if ( marker instanceof Object === false ) { return false; }
    if ( marker.compiled === true ) {
        await activateCompiledFilterRulesNow();
    }
    if ( marker.contentScripts === true ) {
        await registerContentScripts();
    }
    await localRemove(COMPILED_FILTERS_DIRTY_KEY);
    await removeJob(COMPILED_FILTERS_RETRY_JOB);
    return true;
}

async function mutateCompiledFilterSources(flags, mutation) {
    const { hadPending } = await markCompiledFilterSourcesDirty(flags);
    try {
        const result = await mutation();
        if ( result === false && hadPending === false ) {
            await localRemove(COMPILED_FILTERS_DIRTY_KEY);
            return result;
        }
        await flushDirtyCompiledFilterSourcesNow();
        return result;
    } catch ( reason ) {
        await scheduleCompiledFilterRetry().catch(retryReason => {
            ubolErr(`scheduleCompiledFilterRetry/${retryReason}`);
        });
        throw reason;
    }
}

async function retryDirtyCompiledFilterSourcesNow() {
    try {
        return await flushDirtyCompiledFilterSourcesNow();
    } catch ( reason ) {
        ubolErr(`retryDirtyCompiledFilterSources/${reason}`);
        await scheduleCompiledFilterRetry().catch(retryReason => {
            ubolErr(`scheduleCompiledFilterRetry/${retryReason}`);
        });
        return false;
    }
}

/******************************************************************************/

async function recoverPendingCompiledActivation(options = {}) {
    const pending = await localRead(PENDING_COMPILED_ACTIVATION_KEY);
    if ( pending instanceof Object === false ) { return false; }
    const activeGeneration = await getActiveCompiledGeneration();
    const shouldCommit = options.rollback !== true &&
        activeGeneration === pending.generation;
    if ( shouldCommit ) {
        await commitImportedListUpdates(
            pending.importedListUpdates || []
        );
        await localRemove(PENDING_COMPILED_ACTIVATION_KEY);
        await removeCompiledGeneration(pending.previousGeneration);
        return true;
    }
    const previousGeneration = typeof pending.previousGeneration === 'string'
        ? pending.previousGeneration
        : '';
    await registerUserScripts(previousGeneration);
    const result = await updateUserRules(previousGeneration);
    if ( result?.fatalError ) {
        throw new Error(`Unable to recover previous DNR rules: ${result.fatalError}`);
    }
    await commitCompiledGeneration(previousGeneration);
    await localRemove(PENDING_COMPILED_ACTIVATION_KEY);
    await removeCompiledGeneration(pending.generation);
    return true;
}

/******************************************************************************/

async function snapshotRulesetTransaction() {
    const [ previousRulesets, previousImportedLists, previousGeneration ] =
        await Promise.all([
            getEnabledRulesets(),
            getImportedLists(),
            getActiveCompiledGeneration(),
        ]);
    return {
        schemaVersion: 1,
        previousRulesets,
        previousImportedLists: structuredClone(previousImportedLists),
        previousConfigEnabledRulesets:
            rulesetConfig.enabledRulesets.slice(),
        previousGeneration,
    };
}

async function rollbackRulesetTransaction(transaction) {
    await replaceImportedLists(transaction.previousImportedLists || []);

    const pendingActivation = await localRead(PENDING_COMPILED_ACTIVATION_KEY);
    if ( pendingActivation instanceof Object ) {
        await recoverPendingCompiledActivation({ rollback: true });
    }
    const currentGeneration = await getActiveCompiledGeneration();
    const previousGeneration = typeof transaction.previousGeneration === 'string'
        ? transaction.previousGeneration
        : '';
    if ( currentGeneration !== previousGeneration ) {
        await registerUserScripts(previousGeneration);
        const dnrResult = await updateUserRules(previousGeneration);
        if ( dnrResult?.fatalError ) {
            throw new Error(`DNR rollback failed: ${dnrResult.fatalError}`);
        }
        await commitCompiledGeneration(previousGeneration);
        await removeCompiledGeneration(currentGeneration);
    }

    const rulesetResult = await enableRulesets(
        transaction.previousRulesets || []
    );
    if ( rulesetResult.error ) {
        throw new Error(`Static ruleset rollback failed: ${rulesetResult.error}`);
    }
    rulesetConfig.enabledRulesets = Array.isArray(
        transaction.previousConfigEnabledRulesets
    )
        ? transaction.previousConfigEnabledRulesets.slice()
        : transaction.previousRulesets.slice();
    await saveRulesetConfig();
    await registerContentScripts();
    await localRemove(RULESET_TRANSACTION_KEY);
    broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
}

async function applyRulesetsNow(rulesets, options = {}) {
    const transaction = await snapshotRulesetTransaction();
    await localWrite(RULESET_TRANSACTION_KEY, transaction);
    let activationResult;
    let transactionCommitted = false;
    let stockUpdated = false;
    let importedUpdated = false;
    try {
        if ( typeof options.beforeApply === 'function' ) {
            await options.beforeApply();
        }
        const result = await enableRulesets(rulesets);
        if ( result.error ) {
            throw new Error(`Unable to update static rulesets: ${result.error}`);
        }
        stockUpdated = result.stockUpdated ?? false;
        importedUpdated = result.importedUpdated ?? false;
        if ( stockUpdated || importedUpdated ) {
            rulesetConfig.enabledRulesets = result.enabledRulesets;
            await saveRulesetConfig();
        }
        if ( importedUpdated || options.forceCompiledActivation === true ) {
            activationResult = await activateCompiledFilterRulesNow({
                deferImportedListFinalization: true,
                retainPreviousGeneration: true,
            });
        }
        if ( stockUpdated ) {
            await registerContentScripts();
        }
        if ( typeof options.afterApply === 'function' ) {
            await options.afterApply();
        }
        if ( activationResult ) {
            await commitImportedListUpdates(
                activationResult.importedListUpdates || [],
                { cleanup: false }
            );
        }
        // This is the outer transaction's commit point. If the worker stops
        // after this remove, the remaining activation journal is completed
        // (not rolled back) by recoverPendingCompiledActivation().
        await localRemove(RULESET_TRANSACTION_KEY);
        transactionCommitted = true;
        if ( activationResult ) {
            await localRemove(PENDING_COMPILED_ACTIVATION_KEY).catch(reason => {
                ubolErr(`finalizeCompiledActivation/${reason}`);
            });
        }
    } catch ( reason ) {
        if ( transactionCommitted ) { throw reason; }
        const rollbackErrors = [];
        try {
            await rollbackRulesetTransaction(transaction);
        } catch ( rollbackReason ) {
            rollbackErrors.push(`ruleset state: ${rollbackReason}`);
        }
        if ( rollbackErrors.length !== 0 ) {
            throw new Error(
                `${reason}; ruleset rollback failed (${rollbackErrors.join('; ')})`
            );
        }
        throw reason;
    }

    if ( activationResult ) {
        cleanupCommittedImportedListUpdates(
            activationResult.importedListUpdates || []
        ).catch(reason => {
            ubolErr(`cleanupImportedListMetadata/${reason}`);
        });
        recordCompiledFilterWarnings(activationResult.errors || []);
    }

    if ( activationResult &&
        activationResult.previousGeneration !== activationResult.generation ) {
        removeCompiledGeneration(activationResult.previousGeneration)
            .catch(reason => ubolErr(`removeCompiledGeneration/${reason}`));
    }
    broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
    return {
        stockUpdated,
        importedUpdated,
        warnings: activationResult?.errors || [],
    };
}

function applyRulesets(rulesets, options = {}) {
    return enqueueFilteringMutation(( ) =>
        applyRulesetsNow(rulesets, options)
    );
}

/******************************************************************************/

async function updateRulesetSelection(enableIds = [], disableIds = []) {
    if ( Array.isArray(enableIds) === false ||
        Array.isArray(disableIds) === false ||
        enableIds.length + disableIds.length > 128 ) {
        throw new Error('Invalid ruleset selection delta');
    }
    const normalizedEnable = new Set();
    const normalizedDisable = new Set();
    for ( const [ values, target ] of [
        [ enableIds, normalizedEnable ],
        [ disableIds, normalizedDisable ],
    ] ) {
        for ( const id of values ) {
            if ( typeof id !== 'string' || id === '' ) {
                throw new Error('Ruleset selection ids must be non-empty strings');
            }
            target.add(id);
        }
    }
    return enqueueFilteringMutation(async ( ) => {
        const current = await getEnabledRulesets();
        const next = new Set(current);
        for ( const id of normalizedDisable ) { next.delete(id); }
        for ( const id of normalizedEnable ) { next.add(id); }
        return applyRulesetsNow(Array.from(next));
    });
}

/******************************************************************************/

async function importFilterLists(lists, rulesetIdsToEnable) {
    if ( Array.isArray(lists) === false || lists.length === 0 ||
        lists.length > 16 ) {
        throw new Error('A Filter Store batch must contain 1-16 lists');
    }
    const urls = new Set();
    const normalizedLists = [];
    for ( const list of lists ) {
        let url;
        try {
            url = new URL(list?.url);
        } catch {
            throw new Error('Filter Store imports require HTTPS URLs');
        }
        if ( url.protocol !== 'https:' || url.username || url.password ) {
            throw new Error(
                'Filter Store imports require credential-free HTTPS URLs'
            );
        }
        if ( urls.has(url.href) ) {
            throw new Error(`Duplicate Filter Store source: ${url.href}`);
        }
        urls.add(url.href);
        normalizedLists.push({ ...list, url: url.href });
    }
    return enqueueFilteringMutation(async ( ) => {
        // Imports are additive. Merge with the current set only after entering
        // the global mutation queue so concurrent installs cannot overwrite
        // one another with stale UI snapshots.
        const rulesets = await getEnabledRulesets();
        if ( Array.isArray(rulesetIdsToEnable) ) {
            if ( rulesetIdsToEnable.length > 128 ) {
                throw new Error('Too many rulesets in Filter Store batch');
            }
            for ( const id of rulesetIdsToEnable ) {
                if ( typeof id !== 'string' || id === '' ) {
                    throw new Error('Invalid Filter Store ruleset id');
                }
                if ( /^[a-z-]+:\/\//.test(id) && urls.has(id) === false ) {
                    throw new Error('Filter Store batch contains an unrelated URL');
                }
                if ( rulesets.includes(id) === false ) { rulesets.push(id); }
            }
        }
        for ( const url of urls ) {
            if ( rulesets.includes(url) === false ) { rulesets.push(url); }
        }
        const result = await applyRulesetsNow(rulesets, {
            forceCompiledActivation: true,
            beforeApply: async ( ) => {
                await addImportedLists(normalizedLists);
                await localRemove(
                    Array.from(urls, url =>
                        `rulesets.imported.compiled.${url}`
                    )
                );
            },
        });
        return result;
    });
}

/******************************************************************************/

async function restoreImportedListState(lists, enabledRulesets) {
    if ( Array.isArray(lists) === false || lists.length > 32 ) {
        throw new Error('A backup may restore at most 32 imported lists');
    }
    const normalized = [];
    const targetIds = new Set();
    for ( const details of lists ) {
        let url;
        try {
            url = new URL(details?.url);
        } catch {
            throw new Error('Backup contains an invalid imported-list URL');
        }
        if ( url.protocol !== 'https:' || url.username || url.password ) {
            throw new Error('Restored filter lists must use HTTPS without credentials');
        }
        if ( targetIds.has(url.href) ) {
            throw new Error(`Backup contains duplicate filter list ${url.href}`);
        }
        targetIds.add(url.href);
        const maxSourceBytes = Number.isSafeInteger(details.maxSourceBytes) &&
            details.maxSourceBytes > 0 &&
            details.maxSourceBytes <= 5 * 1024 * 1024
            ? details.maxSourceBytes
            : 5 * 1024 * 1024;
        const maxSourceFetches = Number.isSafeInteger(details.maxSourceFetches) &&
            details.maxSourceFetches > 0 && details.maxSourceFetches <= 32
            ? details.maxSourceFetches
            : 32;
        const sourceIntegrity = details.sourceIntegrity;
        if ( sourceIntegrity !== undefined && (
            sourceIntegrity?.algorithm !== 'sha256' ||
            /^[a-f0-9]{64}$/.test(sourceIntegrity.digest) === false ||
            Number.isSafeInteger(sourceIntegrity.bytes) === false ||
            sourceIntegrity.bytes < 0 ||
            sourceIntegrity.bytes > 5 * 1024 * 1024
        ) ) {
            throw new Error(`Backup has invalid integrity for ${url.href}`);
        }
        normalized.push({
            url: url.href,
            name: typeof details.name === 'string'
                ? details.name.slice(0, 200)
                : url.href,
            homeURL: typeof details.homeURL === 'string' &&
                /^https:\/\//i.test(details.homeURL)
                ? details.homeURL
                : '',
            sourceIntegrity,
            maxSourceBytes,
            maxSourceFetches,
            requireHTTPSSource: true,
        });
    }

    const desiredRulesets = Array.isArray(enabledRulesets)
        ? enabledRulesets.filter(id =>
            /^[a-z-]+:\/\//.test(id) === false || targetIds.has(id)
        )
        : [];
    let sourceBudget = 0;
    for ( const list of normalized ) {
        if ( desiredRulesets.includes(list.url) === false ) { continue; }
        sourceBudget += list.sourceIntegrity?.bytes ?? list.maxSourceBytes;
    }
    if ( sourceBudget > 20 * 1024 * 1024 ) {
        throw new Error('Restored enabled lists exceed the 20 MiB source budget');
    }

    const existing = await getImportedLists();
    const toRemove = existing
        .map(list => list.id)
        .filter(id => targetIds.has(id) === false);
    await applyRulesets(desiredRulesets, {
        forceCompiledActivation: desiredRulesets.some(id => targetIds.has(id)),
        beforeApply: async ( ) => {
            await addImportedLists(normalized);
            const cacheKeys = normalized.map(list =>
                `rulesets.imported.compiled.${list.url}`
            );
            if ( cacheKeys.length !== 0 ) { await localRemove(cacheKeys); }
        },
        afterApply: async ( ) => {
            if ( toRemove.length !== 0 ) {
                await removeImportedLists(toRemove);
            }
        },
    });
    return true;
}

/******************************************************************************/

async function setDeveloperMode(state) {
    rulesetConfig.developerMode = state === true;
    toggleDeveloperMode(rulesetConfig.developerMode);
    broadcastMessage({ developerMode: rulesetConfig.developerMode });
    await saveRulesetConfig();
    return rulesetConfig.developerMode;
}

/******************************************************************************/

async function onMessage(request, sender) {

    const tabId = sender?.tab?.id ?? false;
    const frameId = tabId && (sender?.frameId ?? false);

    // Does not require extension to be fully initialized

    // Does not require a trusted origin.

    switch ( request.what ) {

    case 'insertCSS':
        if ( frameId === false ) { return false; }
        // https://bugs.webkit.org/show_bug.cgi?id=262491
        if ( frameId !== 0 && webextFlavor === 'safari' ) { return; }
        return browser.scripting.insertCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            ubolErr(`insertCSS/${reason}`);
        });

    case 'removeCSS':
        if ( frameId === false ) { return false; }
        // https://bugs.webkit.org/show_bug.cgi?id=262491
        if ( frameId !== 0 && webextFlavor === 'safari' ) { return; }
        return browser.scripting.removeCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            ubolErr(`removeCSS/${reason}`);
        });

    case 'injectCSSProceduralAPI':
        return browser.scripting.executeScript({
            files: [ '/js/scripting/css-procedural-api.js' ],
            target: { tabId, frameIds: [ frameId ] },
            injectImmediately: true,
        }).catch(reason => {
            ubolErr(`executeScript/${reason}`);
        });

    default:
        break;
    }

    // Requires extension to be fully initialized

    await isFullyInitialized;

    // Does not require a trusted origin.

    switch ( request.what ) {

    case 'toggleToolbarIcon': {
        if ( tabId ) {
            toggleToolbarIcon(tabId);
        }
        return;
    }

    case 'startCustomFilters':
        if ( frameId === false ) { return; }
        return startCustomFilters(tabId, frameId);

    case 'terminateCustomFilters':
        if ( frameId === false ) { return; }
        return terminateCustomFilters(tabId, frameId);

    case 'injectCustomFilters':
        if ( frameId === false ) { return; }
        return injectCustomFilters(tabId, frameId, request.hostname);

    case 'noteCSSCacheWrite':
        cssCacheWritesSincePrune += 1;
        if ( cssCacheWritesSincePrune < 8 ) { return; }
        cssCacheWritesSincePrune = 0;
        return pruneCSSCache();

    default:
        break;
    }

    // Requires a trusted origin.

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
    //   Firefox API does not set `sender.origin`
    const isTrustedOrigin = sender?.origin === undefined ||
        sender.origin.toLowerCase() === UBOL_ORIGIN;
    if ( isTrustedOrigin === false ) { return; }

    switch ( request.what ) {

    case 'applyRulesets': {
        return applyRulesets(request.enabledRulesets, {
            afterApply: request.toRemove
                ? ( ) => removeImportedLists(request.toRemove)
                : undefined,
        });
    }

    case 'updateRulesetSelection':
        return updateRulesetSelection(
            request.enableRulesetIds,
            request.disableRulesetIds
        );

    case 'getDefaultConfig': {
        const rulesets = await getDefaultRulesetsFromEnv();
        return {
            autoReload: defaultConfig.autoReload,
            developerMode: defaultConfig.developerMode,
            showBlockedCount: defaultConfig.showBlockedCount,
            strictBlockMode: defaultConfig.strictBlockMode,
            popupBlockMode: defaultConfig.popupBlockMode,
            rulesets,
            filteringModes: Object.assign(defaultFilteringModes),
        };
    }

    case 'getCurrentConfig':
        return rulesetConfig;

    case 'getRuntimeCapabilities':
        return getRuntimeCapabilities();

    case 'getMemoryProfile':
        return getMemoryProfileConfig(request.deviceMemoryGiB);

    case 'setMemoryProfile': {
        const profile = await setMemoryProfile(
            request.profile,
            request.deviceMemoryGiB
        );
        if ( profile.retainScriptingMetadata === false ) {
            releaseScriptingMetadata();
        }
        await pruneCSSCache({ force: true });
        return profile;
    }

    case 'getMemoryTelemetry':
        return getMemoryTelemetry({
            refresh: request.refresh === true,
            deviceMemoryGiB: request.deviceMemoryGiB,
        });

    case 'getPopupPolicies':
        return popupBlocker.getPolicies(request.hostname);

    case 'setPopupPolicy':
        return popupBlocker.setPolicy(request.hostname, request.mode);

    case 'replacePopupPolicies':
        return popupBlocker.replacePolicies(request.policies);

    case 'getPopupDiagnostics':
        return popupBlocker.getDiagnostics();

    case 'clearPopupDiagnostics':
        return popupBlocker.clearDiagnostics();

    case 'runMemoryCleanup':
        return enqueueFilteringMutation(async ( ) => {
            await pruneCSSCache({ force: true });
            return runMemoryCleanup({
                deviceMemoryGiB: request.deviceMemoryGiB,
            });
        });

    case 'getOptionsPageData': {
        const [
            hasOmnipotence,
            defaultFilteringMode,
            rulesetDetails,
            enabledRulesets,
            adminRulesets,
            disabledFeatures,
        ] = await Promise.all([
            hasBroadHostPermissions(),
            getDefaultFilteringMode(),
            getRulesetDetails(),
            getEnabledRulesets(),
            getAdminRulesets(),
            adminReadEx('disabledFeatures'),
        ]);
        process.firstRun = false;
        return {
            hasOmnipotence,
            defaultFilteringMode,
            enabledRulesets,
            adminRulesets,
            maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
            rulesetDetails: Array.from(rulesetDetails.values()),
            autoReload: rulesetConfig.autoReload,
            showBlockedCount: rulesetConfig.showBlockedCount,
            canShowBlockedCount,
            strictBlockMode: rulesetConfig.strictBlockMode,
            popupBlockMode: rulesetConfig.popupBlockMode,
            firstRun: process.firstRun,
            isSideloaded,
            developerMode: rulesetConfig.developerMode,
            disabledFeatures,
            supportsCompiledFilters: supportsOffscreenDocument,
            supportsUserScripts: supportsUserScripts(),
        };
    }

    case 'getEnabledRulesets':
        return getEnabledRulesets();

    case 'getRulesetDetails': {
        const rulesetDetails = await getRulesetDetails();
        return Array.from(rulesetDetails.values());
    }

    case 'getEnabledRulesetsDetails':
        return getEnabledRulesetsDetails();

    case 'getRulesetRules':
        return getRulesetRules(request.id);

    case 'hasBroadHostPermissions':
        return hasBroadHostPermissions();

    case 'setAutoReload':
        rulesetConfig.autoReload = request.state && true || false;
        await saveRulesetConfig();
        broadcastMessage({ autoReload: rulesetConfig.autoReload });
        return;

    case 'setShowBlockedCount':
        rulesetConfig.showBlockedCount = request.state && true || false;
        if ( canShowBlockedCount ) {
            dnr.setExtensionActionOptions({
                displayActionCountAsBadgeText: rulesetConfig.showBlockedCount,
            });
        }
        await saveRulesetConfig();
        broadcastMessage({ showBlockedCount: rulesetConfig.showBlockedCount });
        return;

    case 'setStrictBlockMode':
        await setStrictBlockMode(request.state);
        broadcastMessage({ strictBlockMode: rulesetConfig.strictBlockMode });
        return;

    case 'setPopupBlockMode':
        await setPopupBlockMode(request.state);
        await registerContentScripts();
        broadcastMessage({ popupBlockMode: rulesetConfig.popupBlockMode });
        return;

    case 'setDeveloperMode':
        return setDeveloperMode(request.state);

    case 'popupPanelData': {
        const results = await Promise.all([
            hasBroadHostPermissions(),
            getFilteringMode(request.hostname),
            adminReadEx('disabledFeatures'),
            hasCustomFilters(request.hostname),
            popupBlocker.getPolicies(request.hostname),
        ]);
        return {
            hasOmnipotence: results[0],
            level: results[1],
            autoReload: rulesetConfig.autoReload,
            isSideloaded,
            developerMode: rulesetConfig.developerMode,
            disabledFeatures: results[2],
            hasCustomFilters: results[3],
            popupPolicy: results[4].effective,
            popupBlockMode: rulesetConfig.popupBlockMode,
        };
    }

    case 'getFilteringMode': {
        return getFilteringMode(request.hostname);
    }

    case 'gotoURL':
        return gotoURL(request.url, request.type);

    case 'setFilteringMode': {
        return enqueueFilteringMutation(async ( ) => {
            const beforeLevel = await getFilteringMode(request.hostname);
            if ( request.level === beforeLevel ) { return beforeLevel; }
            const afterLevel = await setFilteringMode(request.hostname, request.level);
            await Promise.all([ registerContentScripts(), registerUserScripts() ]);
            return afterLevel;
        });
    }

    case 'setPendingFilteringMode':
        pendingPermissionRequest = request;
        return;

    case 'getDefaultFilteringMode': {
        return getDefaultFilteringMode();
    }

    case 'setDefaultFilteringMode': {
        return enqueueFilteringMutation(async ( ) => {
            const beforeLevel = await getDefaultFilteringMode();
            const afterLevel = await setDefaultFilteringMode(request.level);
            if ( afterLevel !== beforeLevel ) {
                await Promise.all([ registerContentScripts(), registerUserScripts() ]);
            }
            return afterLevel;
        });
    }

    case 'getFilteringModeDetails':
        return getFilteringModeDetails(true);

    case 'setFilteringModeDetails': {
        return enqueueFilteringMutation(async ( ) => {
            await setFilteringModeDetails(request.modes);
            await Promise.all([ registerContentScripts(), registerUserScripts() ]);
            const defaultFilteringMode = await getDefaultFilteringMode();
            broadcastMessage({ defaultFilteringMode });
            return getFilteringModeDetails(true);
        });
    }

    case 'excludeFromStrictBlock':
        return excludeFromStrictBlock(request.hostname, request.permanent);

    case 'getMatchedRules':
        return getMatchedRules(request.tabId);

    case 'showMatchedRules':
        browser.windows.create({
            type: 'popup',
            url: `/matched-rules.html?tab=${request.tabId}`,
        });
        return;

    case 'getAllDynamicRules':
        return dnr.getDynamicRules();

    case 'getAllSessionRules':
        return dnr.getSessionRules();

    case 'getEffectiveUserRules':
        return getEffectiveUserRules();

    case 'updateUserDnrRules':
        return enqueueFilteringMutation(( ) => updateUserRules());

    case 'getAllCustomFilters':
        return getAllCustomFilters();

    case 'addCustomFilters': {
        return enqueueFilteringMutation(async ( ) => {
            const hasScriptletFilters = request.selectors.some(a => isScriptlet(a));
            const hasPlainFilters = request.selectors.some(a => isScriptlet(a) === false);
            return mutateCompiledFilterSources({
                compiled: hasScriptletFilters,
                contentScripts: hasPlainFilters,
            }, ( ) => addCustomFilters(
                request.hostname,
                request.selectors
            ));
        });
    }

    case 'addManyCustomFilters': {
        return enqueueFilteringMutation(async ( ) => {
            let hasScriptletFilters = false;
            let hasPlainFilters = false;
            const validEntries = [];
            for ( const [ hostname, selectors ] of request.entries ) {
                if ( typeof hostname !== 'string' ) { continue; }
                if ( hostname === '' ) { continue; }
                if ( Array.isArray(selectors) === false ) { continue; }
                if ( selectors.length === 0 ) { continue; }
                hasScriptletFilters ||= selectors.some(a => isScriptlet(a));
                hasPlainFilters ||= selectors.some(a => isScriptlet(a) === false);
                validEntries.push([ hostname, selectors ]);
            }
            return mutateCompiledFilterSources({
                compiled: hasScriptletFilters,
                contentScripts: hasPlainFilters,
            }, async ( ) => {
                const results = await Promise.all(validEntries.map(
                    ([ hostname, selectors ]) =>
                        addCustomFilters(hostname, selectors)
                ));
                return results.some(Boolean);
            });
        });
    }

    case 'removeCustomFilters': {
        return enqueueFilteringMutation(async ( ) => {
            const { selectors } = request;
            const hasScriptletFilters = selectors.some(a => isScriptlet(a));
            const hasPlainFilters = selectors.some(a => isScriptlet(a) === false);
            return mutateCompiledFilterSources({
                compiled: hasScriptletFilters,
                contentScripts: hasPlainFilters,
            }, ( ) => removeCustomFilters(request.hostname, selectors));
        });
    }

    case 'removeAllCustomFilters': {
        return enqueueFilteringMutation(async ( ) => {
            return mutateCompiledFilterSources({
                compiled: true,
                contentScripts: true,
            }, ( ) => removeAllCustomFilters(request.hostname));
        });
    }

    case 'getSandboxFilters':
        return getSandboxFilters();

    case 'setSandboxFilters': {
        return enqueueFilteringMutation(async ( ) => {
            await mutateCompiledFilterSources({ compiled: true }, ( ) =>
                setSandboxFilters(request.text)
            );
        });
    }

    case 'customFiltersFromHostname':
        return customFiltersFromHostname(request.hostname);

    case 'getRegisteredContentScripts':
        return getRegisteredContentScripts();

    case 'getConsoleOutput':
        return getConsoleOutput();

    case 'importFilterList': {
        return importFilterLists([ {
            url: request.url,
            name: request.name,
            homeURL: request.homeURL,
            sourceIntegrity: request.sourceIntegrity,
            verifiedSourceKey: request.verifiedSourceKey,
            maxSourceBytes: request.maxSourceBytes,
            maxSourceFetches: request.maxSourceFetches,
            requireHTTPSSource: request.requireHTTPSSource,
        } ]);
    }

    case 'importFilterLists': {
        return importFilterLists(
            request.lists,
            request.rulesetIdsToEnable
        );
    }

    case 'restoreImportedLists': {
        return restoreImportedListState(
            request.lists,
            request.enabledRulesets
        );
    }

    case 'getImportedLists': {
        return getImportedLists();
    }

    case 'updateImportedLists': {
        return enqueueFilteringMutation(async ( ) => {
            return mutateCompiledFilterSources({ compiled: true }, async ( ) => {
                const count = await updateImportedLists();
                return count === 0 ? false : count;
            });
        });
    }

    case COMPILED_FILTERS_RETRY_JOB:
        return enqueueFilteringMutation(retryDirtyCompiledFilterSourcesNow);

    case 'pruneCSSCache': {
        return pruneCSSCache();
    }

    // This is used to ensure we are not suspended while busy fetching filter
    // lists from remote servers.
    case 'keepAlive':
        return;

    default:
        break;
    }
}

/******************************************************************************/

function onCommand(command, tab) {
    switch ( command ) {
    case 'enter-zapper-mode': {
        if ( browser.scripting === undefined ) { return; }
        browser.scripting.executeScript({
            files: [ '/js/scripting/tool-overlay.js', '/js/scripting/zapper.js' ],
            target: { tabId: tab.id },
        });
        break;
    }
    case 'enter-picker-mode': {
        if ( browser.scripting === undefined ) { return; }
        browser.scripting.executeScript({
            files: [
                '/js/scripting/css-procedural-api.js',
                '/js/scripting/tool-overlay.js',
                '/js/scripting/picker.js',
            ],
            target: { tabId: tab.id },
        });
        break;
    }
    default:
        break;
    }
}

/******************************************************************************/

async function startSession() {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;

    // Admin settings override user settings
    await loadAdminConfig();

    // The default rulesets may have changed, find out new ruleset to enable,
    // obsolete ruleset to remove.
    if ( isNewVersion ) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
        await patchDefaultRulesets();
        saveRulesetConfig();
    }

    const {
        stockUpdated,
        importedUpdated,
        enabledRulesets,
    } = await enableRulesets(rulesetConfig.enabledRulesets);
    if ( stockUpdated || importedUpdated ) {
        rulesetConfig.enabledRulesets = enabledRulesets;
        saveRulesetConfig();
    }

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest#rulesets
    // "The set of enabled static rulesets is persisted across sessions but not across extension updates"
    // "[Dynamic] rules persist across sessions and extension updates"
    // "[Session] rules do not persist across browser sessions"
    if ( isNewVersion ) {
        updateDynamicAndSessionRules();
    } else {
        updateSessionRules();
    }

    // Permissions may have been removed while the extension was disabled
    const permissionsUpdated = await syncWithBrowserPermissions();

    // Toggling "user scripts" permission doesn't cause a permissions change
    // event.
    const userScriptsChanged = supportsUserScripts() !== rulesetConfig.userScripts;
    if ( userScriptsChanged ) {
        rulesetConfig.userScripts = !rulesetConfig.userScripts;
        saveRulesetConfig();
    }

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/RegisteredContentScript#persistacrosssessions
    // "When an extension updates, content scripts are cleared"
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts#extension_updates
    // "User scripts are cleared when an extension updates"
    const promises = [];
    const shouldInject = isNewVersion || permissionsUpdated ||
        isSideloaded && rulesetConfig.developerMode;
    if ( shouldInject || stockUpdated ) {
        promises.push(registerContentScripts());
    }
    if ( importedUpdated ) {
        promises.push(activateCompiledFilterRules());
    } else if ( shouldInject ) {
        promises.push(registerUserScripts(), updateUserRules());
    } else if ( userScriptsChanged ) {
        promises.push(registerUserScripts());
    }
    if ( promises.length ) {
        await Promise.all(promises);
    }

    // Cosmetic filtering-related content scripts cache fitlering data in
    // session storage.
    sessionAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
    //   Firefox API does not support `dnr.setExtensionActionOptions`
    if ( canShowBlockedCount ) {
        dnr.setExtensionActionOptions({
            displayActionCountAsBadgeText: rulesetConfig.showBlockedCount,
        });
    }

    // Switch to basic filtering if uBOL doesn't have broad permissions at
    // install time.
    if ( process.firstRun ) {
        const enableOptimal = await hasBroadHostPermissions();
        if ( enableOptimal === false ) {
            const afterLevel = await setDefaultFilteringMode(MODE_BASIC);
            if ( afterLevel === MODE_BASIC ) {
                await registerContentScripts();
                process.firstRun = false;
            }
        }
    }

    // Required to ensure up to date properties are available when needed
    adminReadEx('disabledFeatures').then(items => {
        if ( Array.isArray(items) === false ) { return; }
        if ( items.includes('develop') ) {
            if ( rulesetConfig.developerMode ) {
                setDeveloperMode(false);
            }
        }
    });
}

/******************************************************************************/

async function start() {
    const [ , memoryProfile ] = await Promise.all([
        loadRulesetConfig(),
        initializeMemoryProfile(),
    ]);

    const pendingRuleset = await localRead(RULESET_TRANSACTION_KEY);
    if ( pendingRuleset instanceof Object ) {
        await rollbackRulesetTransaction(pendingRuleset);
    } else {
        await recoverPendingCompiledActivation();
    }
    // A service-worker termination during offscreen compilation can leave an
    // offscreen document and generation alive. Stop it, delete its four
    // deterministic generation keys, then clear the stale marker.
    await closeOffscreenDocument().catch(( ) => { });
    const staleGeneration = await localRead(STAGING_COMPILED_GENERATION_KEY);
    if ( typeof staleGeneration === 'string' ) {
        await removeCompiledGeneration(staleGeneration);
    }
    await localRemove(STAGING_COMPILED_GENERATION_KEY);
    await retryDirtyCompiledFilterSourcesNow();

    if ( process.wakeupRun === false ) {
        await startSession();
        if ( memoryProfile.retainScriptingMetadata === false ) {
            releaseScriptingMetadata();
        }
        await runMemoryCleanup();
    }

    const scripts = await getRegisteredContentScripts();
    if ( scripts.length === 0 ) {
        await registerContentScripts();
    }

    await popupBlocker.resume();
    toggleDeveloperMode(rulesetConfig.developerMode);
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/199
// Force a restart of the extension once when an "internal error" occurs

const isFullyInitialized = start().then(( ) => {
    localRemove('goodStart');
    return false;
}).catch(reason => {
    ubolErr(reason);
    if ( process.wakeupRun ) { return; }
    return localRead('goodStart').then(goodStart => {
        if ( goodStart === false ) {
            localRemove('goodStart');
            return false;
        }
        return localWrite('goodStart', false).then(( ) => true);
    });
}).then(restart => {
    if ( restart !== true ) { return; }
    runtime.reload();
});

runtime.onMessage.addListener((request, sender, callback) => {
    if ( typeof request?.what !== 'string' ) { return; }
    if ( request.what.includes(':') ) { return; }
    onMessage(request, sender).then(callback, reason => {
        ubolErr(`onMessage/${request.what}/${reason}`);
        callback({ __ublockPlusError: reason?.message || `${reason}` });
    });
    return true;
});

if ( supportsUserScripts() && runtime.onUserScriptMessage ) {
    browser.userScripts.configureWorld({ messaging: true }).catch(reason => {
        ubolErr(`configureUserScriptWorld/${reason}`);
    });
    runtime.onUserScriptMessage.addListener((request, sender, callback) => {
        if ( typeof request?.what !== 'string' ) { return; }
        onMessage(request, sender).then(callback, reason => {
            ubolErr(`onUserScriptMessage/${request.what}/${reason}`);
            callback({ __ublockPlusError: reason?.message || `${reason}` });
        });
        return true;
    });
}

browser.permissions.onRemoved.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        return onPermissionsChanged('removed', ...args);
    }).catch(reason => {
        ubolErr(`permissionsRemoved/${reason}`);
    });
});

browser.permissions.onAdded.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        return onPermissionsChanged('added', ...args);
    }).catch(reason => {
        ubolErr(`permissionsAdded/${reason}`);
    });
});

browser.commands.onCommand.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        return onCommand(...args);
    }).catch(reason => {
        ubolErr(`onCommand/${reason}`);
    });
});

browser.tabs.onCreated.addListener(tab => {
    if ( Number.isSafeInteger(tab?.openerTabId) === false ) { return; }
    isFullyInitialized.then(( ) => {
        return popupBlocker.onTabCreated(tab);
    }).catch(reason => {
        ubolErr(`popupTabCreated/${reason}`);
    });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    isFullyInitialized.then(( ) => {
        return popupBlocker.onTabUpdated(tabId, changeInfo, tab);
    }).catch(reason => {
        ubolErr(`popupTabUpdated/${reason}`);
    });
});

browser.tabs.onRemoved.addListener(tabId => {
    popupBlocker.onTabRemoved(tabId).catch(reason => {
        ubolErr(`popupTabRemoved/${reason}`);
    });
});

if ( webextFlavor === 'chromium' &&
    browser.webNavigation?.onCreatedNavigationTarget ) {
    browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
        isFullyInitialized.then(( ) => {
            return popupBlocker.onNavigationTarget(details);
        }).catch(reason => {
            ubolErr(`popupNavigationTarget/${reason}`);
        });
    });
}

browser.alarms.onAlarm.addListener(alarm => {
    if ( alarm.name !== 'deferredJobs' ) { return; }
    isFullyInitialized.then(( ) => {
        if ( process.wakeupRun === false && process.firstAlarm !== true ) {
            process.firstAlarm = true;
            return resetJobsAlarm();
        }
        return processDueJobs(onMessage);
    }).catch(reason => {
        // Failed jobs remain durably leased for retry; consume the rejection
        // here so the service worker does not report an unhandled promise.
        ubolErr(`processDueJobs/${reason}`);
    });
});
