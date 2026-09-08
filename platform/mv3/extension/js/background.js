/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2022-present Raymond Hill
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
    MODE_BASIC,
    MODE_OPTIMAL,
    defaultFilteringModes,
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    getFilteringModeRestoreLevel,
    getFilteringModeRestoreLevels,
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
    setAdminMutationScheduler,
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

import { countSitePopupBlocks, matchesPendingPermission } from './popup-panel-data.js';

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
    finalizeNativeRulesetRecovery,
    getDefaultRulesetsFromEnv,
    getEffectiveUserRules,
    getEnabledRulesets,
    getEnabledRulesetsDetails,
    getRulesetDetails,
    getRulesetRules,
    patchDefaultRulesets,
    recoverStockBadfilters,
    restoreNativeRulesetState,
    setStrictBlockMode,
    snapshotNativeRulesetState,
    updateDynamicAndSessionRules,
    updateSessionRules,
    updateUserRules,
} from './ruleset-manager.js';

import {
    getConsoleOutput,
    getMatchedRules,
    isSideloaded,
    toggleDeveloperMode,
    ublockPlusErr,
    ublockPlusLog,
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
    isLoggerCapturing,
    recordCSSInsertion,
    recordContentDiagnostic,
    recordLoggerEvent,
} from './logger.js';

import {
    popupPageContext,
    reloadPopupTab,
} from './popup-panel-core.js';

import {
    processDueJobs,
    registerJob,
    removeJob,
    resetJobsAlarm,
} from './alarms.js';

import { COMPILED_FILTERS_REVISION } from './compiled-cache.js';
import { POPUP_RUNTIME_ROUTE_CODE } from './compiled-popup-matcher.js';
import { capturePopupFrameContext } from './popup-frame-context.js';
import { createFirewallManager } from './firewall-manager.js';
import { createPopupBlocker } from './popup-blocker.js';
import { createWebRequestFirewall } from './webrequest-firewall.js';
import { dnr } from './ext-compat.js';
import { getRuntimeCapabilities } from './runtime-capabilities.js';
import psl from '../lib/publicsuffixlist.js';
import { setPopupBlockMode } from './prevent-popup.js';
import { toggleToolbarIcon } from './action.js';

/******************************************************************************/

const UBLOCK_PLUS_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();
const canShowBlockedCount = typeof dnr.setExtensionActionOptions === 'function';
const COMPILED_FILTERS_DIRTY_KEY = 'compiledFilters.dirtySources';
const COMPILED_FILTERS_REVISION_KEY = 'compiledFilters.compilerRevision';
const COMPILED_FILTERS_RETRY_JOB = 'retryCompiledFilters';
const COMPILED_FILTER_WARNINGS_KEY = 'compiledFilters.lastWarnings';
const RULESET_TRANSACTION_KEY = 'rulesets.pendingTransaction';
const MAX_ACTIVE_STOCK_POPUP_FILTERS = 4096;
let pendingFilteringMutation = Promise.resolve();
let cssCacheWritesSincePrune = 0;
let stockPopupSnapshotCache = {
    key: undefined,
    promise: undefined,
};

async function getStockPopupSnapshot() {
    const ids = rulesetConfig.enabledRulesets.filter(id =>
        typeof id === 'string' && /^[a-z0-9_-]+$/.test(id)
    ).toSorted();
    const key = ids.join('\n');
    if ( stockPopupSnapshotCache.key === key ) {
        return stockPopupSnapshotCache.promise;
    }
    const promise = (async ( ) => {
        const detailsById = await getRulesetDetails();
        const sources = [];
        let declaredFilterCount = 0;
        for ( const id of ids ) {
            const observer = detailsById.get(id)?.popupObserver;
            if ( typeof observer?.path !== 'string' ||
                observer.schemaVersion !== 1 ||
                Number.isSafeInteger(observer.filters) === false ||
                observer.filters < 1 ||
                observer.path !== `/rulesets/popup/${id}.json` ) {
                continue;
            }
            declaredFilterCount += observer.filters;
            sources.push({ id, observer });
        }
        if ( declaredFilterCount > MAX_ACTIVE_STOCK_POPUP_FILTERS ) {
            ublockPlusErr(
                `Stock popup observer suppressed: ` +
                `${declaredFilterCount}/${MAX_ACTIVE_STOCK_POPUP_FILTERS} ` +
                `active filters`
            );
            return { key, filters: [], suppressed: true };
        }
        const corpora = await Promise.all(sources.map(async source => {
            try {
                const response = await fetch(runtime.getURL(
                    source.observer.path.slice(1)
                ));
                if ( response.ok !== true ) { return; }
                const corpus = await response.json();
                if ( corpus?.schemaVersion !== 1 ||
                    corpus.routeCode !== POPUP_RUNTIME_ROUTE_CODE ||
                    corpus.source?.rulesetId !== source.id ||
                    Array.isArray(corpus.filters) === false ||
                    corpus.filters.length !== source.observer.filters ) {
                    return;
                }
                return corpus.filters;
            } catch ( reason ) {
                ublockPlusErr(`Stock popup corpus ${source.id}/${reason}`);
            }
        }));
        if ( corpora.some(filters => Array.isArray(filters) === false) ) {
            ublockPlusErr('Stock popup observer suppressed: incomplete corpus set');
            return { key, filters: [], suppressed: true };
        }
        return {
            key,
            filters: corpora.flat(),
        };
    })().catch(reason => {
        ublockPlusErr(`Stock popup observer unavailable/${reason}`);
        return { key, filters: [], suppressed: true };
    });
    stockPopupSnapshotCache = { key, promise };
    return promise;
}

async function getPopupGestureContexts(tabId, sourceFrameId = -1) {
    let frames = [ { frameId: 0 } ];
    if ( webextFlavor === 'chromium' &&
        browser.webNavigation?.getAllFrames ) {
        frames = await browser.webNavigation.getAllFrames({ tabId })
            .catch(( ) => frames);
    }
    // The opening frame can occur beyond the enumeration budget on a page
    // with many embeds. Always ask it first, retaining the same 64-message cap.
    const frameIds = new Set();
    if ( Number.isSafeInteger(sourceFrameId) && sourceFrameId >= 0 ) {
        frameIds.add(sourceFrameId);
    }
    for ( const frame of Array.isArray(frames) ? frames : [] ) {
        if ( frameIds.size >= 64 ) { break; }
        if ( Number.isSafeInteger(frame?.frameId) === false ||
            frame.frameId < 0 ) { continue; }
        frameIds.add(frame.frameId);
    }
    const responses = await Promise.all(Array.from(frameIds, async frameId => {
        const response = await browser.tabs.sendMessage(
            tabId,
            { what: 'getPopupGestureContext' },
            { frameId }
        ).catch(( ) => undefined);
        if ( response instanceof Object === false ) { return; }
        return { ...response, frameId };
    }));
    return responses.filter(response => response !== undefined);
}

async function getPopupSourceFrameURL(tabId, frameId) {
    if ( typeof browser.webNavigation?.getFrame !== 'function' ) { return ''; }
    const context = await capturePopupFrameContext(
        details => browser.webNavigation.getFrame(details),
        tabId,
        frameId
    );
    return context.initiatorContextComplete
        ? context.initiatorURL
        : '';
}

async function getPopupSourceContext(tabId, frameId) {
    if ( typeof browser.webNavigation?.getFrame !== 'function' ) { return; }
    return capturePopupFrameContext(
        details => browser.webNavigation.getFrame(details),
        tabId,
        frameId
    );
}

const supportsPopupNavigationTarget = webextFlavor === 'chromium' &&
    typeof browser.webNavigation?.onCreatedNavigationTarget?.addListener ===
        'function';

const popupBlocker = createPopupBlocker({
    tabs: browser.tabs,
    getFilteringMode,
    getGestureContexts: getPopupGestureContexts,
    getStockPopupSnapshot,
    getSourceContext: getPopupSourceContext,
    getSourceFrameURL: getPopupSourceFrameURL,
    localRead,
    localWrite,
    sessionRead,
    sessionWrite,
    supportsNavigationTargetContext: supportsPopupNavigationTarget,
    isEnabled: ( ) => rulesetConfig.popupBlockMode === true,
    log: message => ublockPlusLog(message),
});

function enqueueFilteringMutation(task, suspendWebRequest = true) {
    // Domain learning refines native partitions without changing policy. Keep
    // the synchronous supplement usable while that slower native update runs.
    if ( suspendWebRequest ) { webRequestFirewall.beginMutation(); }
    const result = pendingFilteringMutation.then(task).finally(() => {
        if ( suspendWebRequest ) { return webRequestFirewall.endMutation(); }
    });
    pendingFilteringMutation = result.catch(( ) => { });
    return result;
}

let firewallDomainResolverPromise;
function loadFirewallDomainResolver() {
    return firewallDomainResolverPromise ??= (async () => {
        const response = await fetch(runtime.getURL('firewall-public-suffix.json'));
        if ( response.ok !== true ) { throw new Error('Public Suffix List unavailable'); }
        const { text } = await response.json();
        if ( typeof text !== 'string' || text.includes('BEGIN ICANN DOMAINS') === false ) {
            throw new Error('Invalid packaged Public Suffix List');
        }
        psl.parse(text, hostname => new URL(`https://${hostname}`).hostname);
        return hostname => hostname.startsWith('[') ||
            /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes('.') === false
            ? hostname : psl.getDomain(hostname);
    })().catch(reason => {
        firewallDomainResolverPromise = undefined;
        throw reason;
    });
}

const firewall = createFirewallManager({
    dnr, localRead, localWrite, sessionRead, sessionWrite,
    sessionRemove: key => browser.storage.session.remove(key),
    getModes: () => getFilteringModeDetails(true),
    getTabs: () => browser.tabs.query({}),
    log: ublockPlusErr,
    loadDomainResolver: loadFirewallDomainResolver,
});

const webRequestFirewall = createWebRequestFirewall({
    manifest: runtime.getManifest(),
    permissions: browser.permissions,
    webRequest: browser.webRequest,
    getTabs: () => browser.tabs.query({}),
    getFrames: tabId => browser.webNavigation.getAllFrames({ tabId }),
    record: recordLoggerEvent,
    getSnapshot: async () => {
        const state = firewall.getState();
        return {
            text: state.sessionText,
            error: state.error,
            modes: await getFilteringModeDetails(true),
            domainFromHostname: await loadFirewallDomainResolver(),
        };
    },
});

async function refreshFilteringScripts() {
    // The content registration transaction owns both native and user scripts.
    // Running a separate user registration beside it can overwrite a newer
    // generation with the content transaction's earlier native snapshot.
    // Keep the queue occupied until independent firewall work settles too.
    const results = await Promise.allSettled([
        registerContentScripts(),
        firewall.refresh(),
    ]);
    const errors = results.filter(result => result.status === 'rejected')
        .map(result => result.reason);
    if ( errors.length !== 0 ) {
        throw new AggregateError(errors, errors.map(String).join('; '));
    }
}

setAdminMutationScheduler(task => isFullyInitialized.then(( ) =>
    enqueueFilteringMutation(task)
), { applyRulesets: applyRulesetsNow, refreshScripts: refreshFilteringScripts });

let pendingPermissionRequest;

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

/******************************************************************************/

async function reloadTab(tabId, context) {
    await new Promise(resolve => self.setTimeout(resolve, 437));
    // Check the captured page after the delay/permission queue has elapsed.
    // Await the mutation so permission listeners can report browser failures.
    return reloadPopupTab(browser.tabs, tabId, context);
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
    await refreshFilteringScripts();
    if ( rulesetConfig.autoReload !== true ) { return; }
    const context = popupPageContext(details.actualURL, runtime.getURL('/'));
    if ( context.canFilter === false || context.url !== details.url ||
        context.hostname !== details.hostname ) { return; }
    await reloadTab(details.tabId, context);
}

// When a new host permission is granted through the browser
async function onPermissionGrantedThruBrowser(origins) {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return; }
    await refreshFilteringScripts();
    if ( rulesetConfig.autoReload !== true ) { return; }
    if ( origins.length !== 1 ) { return; }
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if ( typeof tabId !== 'number' || tabId === -1 ) { return; }
    const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [ 0 ] },
        func: ( ) => document.location.href,
    }).catch(( ) => {
    });
    const context = popupPageContext(results?.[0]?.result, runtime.getURL('/'));
    if ( context.canInject === false ) { return; }
    const tabHostname = context.hostname;
    const hostname = hostnameFromMatch(origins[0]);
    if ( tabHostname.endsWith(hostname) === false ) { return; }
    const pos = tabHostname.length - hostname.length;
    if ( pos !== 0 && tabHostname.charAt(pos-1) !== '.' ) { return; }
    await reloadTab(tabId, context);
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
async function onPermissionsAdded(permissions) {
    const details = pendingPermissionRequest;
    pendingPermissionRequest = undefined;
    const { origins = [] } = permissions;
    return matchesPendingPermission(details, hostnamesFromMatches(origins))
        ? onPermissionGrantedThruExtension(details, origins)
        : onPermissionGrantedThruBrowser(origins);
}

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return false; }
    await refreshFilteringScripts();
    return true;
}

async function onPermissionsChanged(op, permissions) {
    await isFullyInitialized;
    return enqueueFilteringMutation(( ) => op === 'removed'
        ? onPermissionsRemoved()
        : onPermissionsAdded(permissions));
}

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
            .catch(reason => ublockPlusErr(`removeCompiledGeneration/${reason}`));
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
            ublockPlusErr(`compiledFilterWarnings/${reason}`);
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
    const compilerRevision = flags.compilerRevision ?? previous?.compilerRevision;
    if ( Number.isSafeInteger(compilerRevision) ) {
        marker.compilerRevision = compilerRevision;
    }
    await localWrite(COMPILED_FILTERS_DIRTY_KEY, marker);
    return { marker, hadPending: previous instanceof Object };
}

async function ensureCompiledFilterRevision() {
    const revision = await localRead(COMPILED_FILTERS_REVISION_KEY);
    if ( revision === COMPILED_FILTERS_REVISION ) { return; }
    await markCompiledFilterSourcesDirty({
        compiled: true,
        contentScripts: true,
        compilerRevision: COMPILED_FILTERS_REVISION,
    });
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
    // A compiler upgrade is complete only after both activated rules and
    // content-script scopes have been refreshed. Failed upgrades keep the
    // durable dirty marker and use the normal restart/alarm retry path.
    if ( marker.compilerRevision === COMPILED_FILTERS_REVISION ) {
        await localWrite(COMPILED_FILTERS_REVISION_KEY, COMPILED_FILTERS_REVISION);
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
            ublockPlusErr(`scheduleCompiledFilterRetry/${retryReason}`);
        });
        throw reason;
    }
}

async function retryDirtyCompiledFilterSourcesNow() {
    try {
        return await flushDirtyCompiledFilterSourcesNow();
    } catch ( reason ) {
        ublockPlusErr(`retryDirtyCompiledFilterSources/${reason}`);
        await scheduleCompiledFilterRetry().catch(retryReason => {
            ublockPlusErr(`scheduleCompiledFilterRetry/${retryReason}`);
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
    const [ previousRulesets, previousImportedLists, previousGeneration, nativeState ] =
        await Promise.all([
            getEnabledRulesets(),
            getImportedLists(),
            getActiveCompiledGeneration(),
            snapshotNativeRulesetState(),
        ]);
    return {
        schemaVersion: 2,
        nativeState,
        previousRulesets,
        previousImportedLists: structuredClone(previousImportedLists),
        previousConfigEnabledRulesets:
            rulesetConfig.enabledRulesets.slice(),
        previousGeneration,
    };
}

async function rollbackRulesetTransaction(transaction) {
    if ( transaction.schemaVersion === 2 ) {
        // Recompiling the old stock corpus can fail a newer native regex check
        // even though its previously installed subset was valid. Restore the
        // durable API snapshot without parsing or weakening any exception.
        await restoreNativeRulesetState(transaction.nativeState);
        await replaceImportedLists(transaction.previousImportedLists || []);
        const pendingActivation = await localRead(PENDING_COMPILED_ACTIVATION_KEY);
        const currentGeneration = await getActiveCompiledGeneration();
        const previousGeneration = typeof transaction.previousGeneration === 'string'
            ? transaction.previousGeneration : '';
        await registerUserScripts(previousGeneration);
        await commitCompiledGeneration(previousGeneration);
        rulesetConfig.enabledRulesets = Array.isArray(transaction.previousConfigEnabledRulesets)
            ? transaction.previousConfigEnabledRulesets.slice()
            : transaction.previousRulesets.slice();
        await saveRulesetConfig();
        await registerContentScripts();
        await finalizeNativeRulesetRecovery();
        await localRemove(PENDING_COMPILED_ACTIVATION_KEY);
        await localRemove(RULESET_TRANSACTION_KEY);
        for ( const generation of new Set([ currentGeneration, pendingActivation?.generation ]) ) {
            if ( typeof generation !== 'string' || generation === previousGeneration ) { continue; }
            await removeCompiledGeneration(generation).catch(reason => {
                ublockPlusErr(`cleanupRolledBackGeneration/${reason}`);
            });
        }
        broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
        return;
    }
    // Journals created before native snapshots retain the guarded legacy path.
    // There is no safe historical native rule set to invent for them.
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
        if ( stockUpdated || importedUpdated || options.forceCompiledActivation === true ) {
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
                ublockPlusErr(`finalizeCompiledActivation/${reason}`);
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
            ublockPlusErr(`cleanupImportedListMetadata/${reason}`);
        });
        recordCompiledFilterWarnings(activationResult.errors || []);
    }

    if ( activationResult &&
        activationResult.previousGeneration !== activationResult.generation ) {
        removeCompiledGeneration(activationResult.previousGeneration)
            .catch(reason => ublockPlusErr(`removeCompiledGeneration/${reason}`));
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

    case 'getLoggerCapture':
        return isLoggerCapturing(sender?.tab?.id);

    case 'recordContentDiagnostic':
        return recordContentDiagnostic(request, sender);

    case 'insertCSS':
        if ( frameId === false ) { return false; }
        // https://bugs.webkit.org/show_bug.cgi?id=262491
        if ( frameId !== 0 && webextFlavor === 'safari' ) { return; }
        return browser.scripting.insertCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).then(() => {
            recordCSSInsertion(request.css, sender);
        }).catch(reason => {
            ublockPlusErr(`insertCSS/${reason}`);
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
            ublockPlusErr(`removeCSS/${reason}`);
        });

    case 'injectCSSProceduralAPI':
        return browser.scripting.executeScript({
            files: [ '/js/scripting/css-procedural-api.js' ],
            target: { tabId, frameIds: [ frameId ] },
            injectImmediately: true,
        }).catch(reason => {
            ublockPlusErr(`executeScript/${reason}`);
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
        sender.origin.toLowerCase() === UBLOCK_PLUS_ORIGIN;
    if ( isTrustedOrigin === false ) { return; }
    if ( [ 'getFirewallState', 'previewFirewallRules', 'applyFirewallRules',
        'testFirewallRequest' ].includes(request.what) ) {
        if ( sender?.id !== runtime.id ||
            sender?.url?.toLowerCase().startsWith(`${UBLOCK_PLUS_ORIGIN}/`) !== true ) {
            return;
        }
    }

    switch ( request.what ) {

    case 'getFirewallState':
        return firewall.getState();

    case 'testFirewallRequest':
        return firewall.testRequest(request);

    case 'previewFirewallRules':
        return enqueueFilteringMutation(() => firewall.preview(request.text));

    case 'applyFirewallRules':
        return enqueueFilteringMutation(() => firewall.apply(request.text, request.permanent));

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
        return enqueueFilteringMutation(async ( ) => {
            await setStrictBlockMode(request.state);
            broadcastMessage({ strictBlockMode: rulesetConfig.strictBlockMode });
        });

    case 'setPopupBlockMode':
        return enqueueFilteringMutation(async ( ) => {
            await setPopupBlockMode(request.state);
            await registerContentScripts();
            broadcastMessage({ popupBlockMode: rulesetConfig.popupBlockMode });
        });

    case 'setDeveloperMode':
        return setDeveloperMode(request.state);

    case 'popupPanelData': {
        const results = await Promise.all([
            hasBroadHostPermissions(),
            getFilteringMode(request.hostname),
            adminReadEx('disabledFeatures'),
            hasCustomFilters(request.hostname),
            popupBlocker.getPolicies(request.hostname),
            popupBlocker.getDiagnostics(),
            getDefaultFilteringMode(),
            getFilteringModeRestoreLevel(request.hostname),
        ]);
        const recentPopupBlocks = countSitePopupBlocks(results[5], request.hostname);
        return {
            hasOmnipotence: results[0],
            level: results[1],
            autoReload: rulesetConfig.autoReload,
            isSideloaded,
            developerMode: rulesetConfig.developerMode,
            disabledFeatures: results[2],
            hasCustomFilters: results[3] > 0,
            popupPolicy: results[4].effective,
            popupBlockMode: rulesetConfig.popupBlockMode,
            recentPopupBlocks,
            defaultFilteringMode: results[6],
            restoreFilteringMode: results[7],
            enabledRulesetCount: rulesetConfig.enabledRulesets.length,
        };
    }

    case 'getFilteringMode': {
        return getFilteringMode(request.hostname);
    }

    case 'gotoURL':
        return gotoURL(request.url, request.type);

    case 'setFilteringMode': {
        return enqueueFilteringMutation(async ( ) => {
            const afterLevel = await setFilteringMode(request.hostname, request.level);
            // Retrying the same mode repairs registrations after a previous
            // post-commit scripting failure.
            await refreshFilteringScripts();
            return afterLevel;
        });
    }

    case 'setPendingFilteringMode':
        pendingPermissionRequest = { ...request, createdAt: Date.now() };
        return;

    case 'clearPendingFilteringMode':
        if ( typeof request.requestId === 'string' &&
            pendingPermissionRequest?.requestId === request.requestId ) {
            pendingPermissionRequest = undefined;
        }
        return;

    case 'getDefaultFilteringMode': {
        return getDefaultFilteringMode();
    }

    case 'setDefaultFilteringMode': {
        return enqueueFilteringMutation(async ( ) => {
            const afterLevel = await setDefaultFilteringMode(request.level);
            await refreshFilteringScripts();
            return afterLevel;
        });
    }

    case 'getFilteringModeDetails':
        return getFilteringModeDetails(true);

    case 'getFilteringModeRestoreLevels':
        return getFilteringModeRestoreLevels();

    case 'setFilteringModeDetails': {
        return enqueueFilteringMutation(async ( ) => {
            await setFilteringModeDetails(request.modes, request.restoreLevels);
            await refreshFilteringScripts();
            const defaultFilteringMode = await getDefaultFilteringMode();
            broadcastMessage({ defaultFilteringMode });
            return getFilteringModeDetails(true);
        });
    }

    case 'excludeFromStrictBlock':
        return enqueueFilteringMutation(( ) =>
            excludeFromStrictBlock(request.hostname, request.permanent)
        );

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
        ublockPlusLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
        await patchDefaultRulesets();
        saveRulesetConfig();
    }

    const {
        stockUpdated,
        importedUpdated,
        enabledRulesets,
        error: rulesetEnableError,
    } = await enableRulesets(rulesetConfig.enabledRulesets);
    if ( stockUpdated || importedUpdated ) {
        rulesetConfig.enabledRulesets = enabledRulesets;
        saveRulesetConfig();
    }

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest#rulesets
    // "The set of enabled static rulesets is persisted across sessions but not across extension updates"
    // "[Dynamic] rules persist across sessions and extension updates"
    // "[Session] rules do not persist across browser sessions"
    if ( rulesetEnableError ) {
        ublockPlusErr(`startSession/ruleset enable/${rulesetEnableError}`);
    }
    // enableRulesets() already rebuilt both dynamic and session namespaces
    // when its stock selection changed. Avoid a second serialized rewrite.
    if ( stockUpdated !== true ) {
        const dnrRefreshResult = isNewVersion
            ? await updateDynamicAndSessionRules()
            : await updateSessionRules();
        if ( dnrRefreshResult?.error ) {
            ublockPlusErr(`startSession/DNR refresh/${dnrRefreshResult.error}`);
        }
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
    const shouldInject = isNewVersion || permissionsUpdated ||
        isSideloaded && rulesetConfig.developerMode;
    // Activate the new shared exception/cancellation generation before a full
    // native registration takes its snapshot. Both paths own stock scriptlets.
    if ( stockUpdated || importedUpdated ) {
        await activateCompiledFilterRules();
    } else if ( shouldInject ) {
        await updateUserRules();
    }
    if ( shouldInject || stockUpdated ) {
        await registerContentScripts();
    } else if ( userScriptsChanged && importedUpdated !== true ) {
        await registerUserScripts();
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

    // Switch to basic filtering if uBlock Plus+ doesn't have broad permissions at
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
    if ( pendingRuleset?.schemaVersion === 2 ) {
        await rollbackRulesetTransaction(pendingRuleset);
    } else {
        await recoverStockBadfilters();
        if ( pendingRuleset instanceof Object ) {
            await rollbackRulesetTransaction(pendingRuleset);
        } else {
            await recoverPendingCompiledActivation();
        }
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
    await ensureCompiledFilterRevision();
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
    await firewall.initialize().catch(reason => {
        webRequestFirewall.fail(reason);
        ublockPlusErr(`Firewall startup/${reason}`);
    });
    await webRequestFirewall.initialize();
    toggleDeveloperMode(rulesetConfig.developerMode);
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/199
// Force a restart of the extension once when an "internal error" occurs

const isFullyInitialized = start().then(( ) => {
    localRemove('goodStart');
    return false;
}).catch(reason => {
    webRequestFirewall.fail(reason);
    ublockPlusErr(reason);
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
        ublockPlusErr(`onMessage/${request.what}/${reason}`);
        callback({
            __ublockPlusError: reason?.message || `${reason}`,
            __ublockPlusErrorCode: reason?.code === 'ERR_FILTERING_MODE_PARENT_SCOPE'
                ? reason.code
                : undefined,
        });
    });
    return true;
});

if ( supportsUserScripts() && runtime.onUserScriptMessage ) {
    browser.userScripts.configureWorld({ messaging: true }).catch(reason => {
        ublockPlusErr(`configureUserScriptWorld/${reason}`);
    });
    runtime.onUserScriptMessage.addListener((request, sender, callback) => {
        if ( typeof request?.what !== 'string' ) { return; }
        onMessage(request, sender).then(callback, reason => {
            ublockPlusErr(`onUserScriptMessage/${request.what}/${reason}`);
            callback({
                __ublockPlusError: reason?.message || `${reason}`,
                __ublockPlusErrorCode: reason?.code === 'ERR_FILTERING_MODE_PARENT_SCOPE'
                    ? reason.code
                    : undefined,
            });
        });
        return true;
    });
}

browser.permissions.onRemoved.addListener((...args) => {
    webRequestFirewall.permissionsChanged();
    isFullyInitialized.then(( ) => {
        return onPermissionsChanged('removed', ...args);
    }).catch(reason => {
        ublockPlusErr(`permissionsRemoved/${reason}`);
    });
});

browser.permissions.onAdded.addListener((...args) => {
    webRequestFirewall.permissionsChanged();
    isFullyInitialized.then(( ) => {
        return onPermissionsChanged('added', ...args);
    }).catch(reason => {
        ublockPlusErr(`permissionsAdded/${reason}`);
    });
});

browser.commands.onCommand.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        return onCommand(...args);
    }).catch(reason => {
        ublockPlusErr(`onCommand/${reason}`);
    });
});

browser.tabs.onCreated.addListener(tab => {
    if ( Number.isSafeInteger(tab?.openerTabId) === false ) { return; }
    // Capture transient provenance immediately, but do not evaluate until the
    // global ruleset configuration and recovery journals are hydrated.
    const openerTabPromise = browser.tabs.get(tab.openerTabId).catch(reason => {
        ublockPlusErr(`popupOpenerSnapshot/${reason}`);
    });
    isFullyInitialized.then(( ) => {
        return popupBlocker.onTabCreated(tab, openerTabPromise);
    }).catch(reason => {
        ublockPlusErr(`popupTabCreated/${reason}`);
    });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ( typeof changeInfo.url === 'string' ) {
        isFullyInitialized.then(() => enqueueFilteringMutation(() =>
            firewall.observe(changeInfo.url), false
        )).catch(reason => ublockPlusErr(`Firewall navigation/${reason}`));
    }
    isFullyInitialized.then(( ) => {
        return popupBlocker.onTabUpdated(tabId, changeInfo, tab);
    }).catch(reason => {
        ublockPlusErr(`popupTabUpdated/${reason}`);
    });
});

browser.webNavigation?.onBeforeNavigate?.addListener(details => {
    webRequestFirewall.observeNavigation(details);
    if ( details.frameId !== 0 ) { return; }
    isFullyInitialized.then(() => enqueueFilteringMutation(() =>
        firewall.observe(details.url), false
    )).catch(reason => ublockPlusErr(`Firewall navigation/${reason}`));
});

browser.webNavigation?.onCommitted?.addListener(details => {
    webRequestFirewall.observeNavigation(details, true);
});

browser.tabs.onRemoved.addListener(tabId => {
    webRequestFirewall.forgetTab(tabId);
    popupBlocker.onTabRemoved(tabId).catch(reason => {
        ublockPlusErr(`popupTabRemoved/${reason}`);
    });
});

if ( supportsPopupNavigationTarget ) {
    browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
        const sourceContextPromise = getPopupSourceContext(
            details.sourceTabId,
            details.sourceFrameId
        ).catch(reason => {
            ublockPlusErr(`popupSourceSnapshot/${reason}`);
        });
        isFullyInitialized.then(( ) => {
            return popupBlocker.onNavigationTarget(
                details,
                sourceContextPromise
            );
        }).catch(reason => {
            ublockPlusErr(`popupNavigationTarget/${reason}`);
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
        ublockPlusErr(`processDueJobs/${reason}`);
    });
});
