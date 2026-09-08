/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import {
    ACTIVE_COMPILED_GENERATION_KEY,
    compiledStorageKey,
} from './compiled-storage.js';

import {
    MAX_POPUP_DIAGNOSTICS,
    MAX_POPUP_POLICIES,
    POPUP_POLICY_MODES,
    appendPopupDiagnostic,
    evaluatePopupCandidate,
    normalizePopupHostname,
    normalizePopupPolicies,
    resolvePopupPolicy,
    validatePopupPolicies,
} from './popup-policy.js';

import {
    evaluateCompiledPopupFilters,
} from './compiled-popup-matcher.js';

const POLICY_STORAGE_KEY = 'popupBlocker.sitePolicies';
const DIAGNOSTIC_STORAGE_KEY = 'popupBlocker.diagnostics';
const TRANSIENT_STORAGE_KEY = 'popupBlocker.transient';
const GESTURE_TTL_MS = 5_000;
const BURST_WINDOW_MS = 2_000;
const CANDIDATE_TTL_MS = 30_000;
const MAX_TRANSIENT_ENTRIES = 256;
const COMPILED_POPUP_REALMS = Object.freeze([ 'sandbox', 'imported' ]);
const PROTECTED_POPUP_PROTOCOLS = new Set([
    'chrome:',
    'chrome-extension:',
    'edge:',
    'moz-extension:',
]);

/******************************************************************************/

function tabURL(tab) {
    return tab?.pendingUrl || tab?.url || '';
}

// Never checkpoint a path, query, fragment, or credential. Diagnostics and
// MV3 recovery only need the scheme and host to reproduce a policy decision.
function checkpointURL(raw) {
    if ( typeof raw !== 'string' || raw === '' ) { return ''; }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return '';
    }
    if ( url.protocol === 'about:' && url.pathname === 'blank' ) {
        return 'about:blank';
    }
    if ( url.protocol === 'http:' || url.protocol === 'https:' ) {
        return `${url.origin}/`;
    }
    if ( url.protocol === 'blob:' ) {
        try {
            const inner = new URL(url.pathname);
            if ( inner.protocol === 'http:' || inner.protocol === 'https:' ) {
                return `${inner.origin}/`;
            }
        } catch {
        }
    }
    return '';
}

function boundedContextURL(raw) {
    return contextURLDetails(raw).url;
}

function contextURLDetails(raw) {
    if ( typeof raw !== 'string' || raw === '' ) {
        return { url: '', complete: false };
    }
    if ( raw.length <= 8192 ) { return { url: raw, complete: true }; }
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return { url: '', complete: false };
    }
    let url = checkpointURL(raw);
    if ( url === '' ) {
        if ( parsed.protocol === 'data:' ) {
            url = 'data:,';
        } else if ( parsed.protocol === 'file:' ) {
            url = 'file:///';
        } else if ( parsed.origin !== 'null' ) {
            url = `${parsed.origin}/`;
        } else {
            url = `${parsed.protocol}${parsed.pathname.slice(0, 256)}`;
        }
    }
    return { url, complete: false };
}

function sameNavigationTarget(a, b) {
    try {
        const left = new URL(a);
        const right = new URL(b);
        left.hash = '';
        right.hash = '';
        return left.href === right.href;
    } catch {
        return false;
    }
}

function boundedMapSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while ( map.size > MAX_TRANSIENT_ENTRIES ) {
        map.delete(map.keys().next().value);
    }
}

function filteringHostname(raw, allowGlobalFallback = false) {
    const hostname = normalizePopupHostname(raw);
    if ( hostname !== '' ) { return hostname; }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return '';
    }
    if ( url.protocol === 'blob:' ) {
        try {
            return normalizePopupHostname(new URL(url.pathname).hostname);
        } catch {
            return '';
        }
    }
    if ( allowGlobalFallback === false ||
        PROTECTED_POPUP_PROTOCOLS.has(url.protocol) ) {
        return '';
    }
    return 'all-urls';
}

function cloneObject(value) {
    return Object.assign(Object.create(null), value);
}

function validTabId(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function validRecentTimestamp(value, timestamp, maximumAge) {
    return Number.isSafeInteger(value) &&
        timestamp - value >= -1_000 &&
        timestamp - value <= maximumAge;
}

/******************************************************************************/

export function createPopupBlocker(dependencies = {}) {
    const {
        tabs,
        getFilteringMode = async ( ) => 3,
        getGestureContexts = async ( ) => [],
        getStockPopupSnapshot = async ( ) => ({ key: '', filters: [] }),
        getSourceContext = async ( ) => undefined,
        getSourceFrameURL = async ( ) => '',
        localRead = async ( ) => undefined,
        localWrite = async ( ) => undefined,
        sessionRead = async ( ) => undefined,
        sessionWrite = async ( ) => undefined,
        supportsNavigationTargetContext = true,
        isEnabled = ( ) => true,
        now = ( ) => Date.now(),
        log = ( ) => undefined,
    } = dependencies;

    const bursts = new Map();
    const candidates = new Map();
    const consumedGestures = new Map();
    let policies = Object.create(null);
    let diagnostics = [];
    let stateLoaded = false;
    let policyMutation = Promise.resolve();
    let diagnosticMutation = Promise.resolve();
    let transientMutation = Promise.resolve();
    let compiledLoadMutation = Promise.resolve();
    let compiledSnapshot = {
        generation: undefined,
        realms: new Map(),
    };

    async function loadCompiledPopupRealmsNow(filteringMode) {
        // The generation pointer is the commit record. Generation-scoped
        // values are immutable, so a worker may safely load them lazily after
        // Chrome wakes it for a popup event without relying on global state.
        const stockSnapshot = filteringMode >= 1
            ? await getStockPopupSnapshot()
            : { key: '', filters: [] };
        const stockFilters = Array.isArray(stockSnapshot?.filters)
            ? stockSnapshot.filters
            : [];
        const materializeRealms = (realmIds, realms) => {
            const out = [ {
                id: 'sandbox',
                filters: realms.get('sandbox') || [],
            } ];
            if ( filteringMode >= 1 ) {
                out.push({ id: 'stock', filters: stockFilters });
            }
            if ( realmIds.includes('imported') ) {
                out.push({
                    id: 'imported',
                    filters: realms.get('imported') || [],
                });
            }
            return out;
        };
        for ( let attempt = 0; attempt < 2; attempt++ ) {
            const generation = await localRead(
                ACTIVE_COMPILED_GENERATION_KEY
            ) || '';
            const realmIds = COMPILED_POPUP_REALMS.slice(
                0,
                filteringMode >= 2 ? 2 : 1
            );
            const currentRealms = compiledSnapshot.generation === generation
                ? compiledSnapshot.realms
                : new Map();
            const missingRealmIds = realmIds.filter(
                id => currentRealms.has(id) === false
            );
            if ( missingRealmIds.length === 0 ) {
                return materializeRealms(realmIds, currentRealms);
            }
            const values = await Promise.all(missingRealmIds.map(id =>
                localRead(compiledStorageKey(
                    generation,
                    `${id}Filters.popupFilters`
                ))
            ));
            const committedGeneration = await localRead(
                ACTIVE_COMPILED_GENERATION_KEY
            ) || '';
            if ( committedGeneration !== generation ) { continue; }
            const realms = new Map(currentRealms);
            for ( let i = 0; i < missingRealmIds.length; i++ ) {
                const value = values[i];
                if ( value?.schemaVersion !== 1 ||
                    Array.isArray(value.filters) === false ) {
                    realms.set(missingRealmIds[i], []);
                    continue;
                }
                realms.set(missingRealmIds[i], value.filters);
            }
            compiledSnapshot = { generation, realms };
            return materializeRealms(realmIds, realms);
        }
        // A compile committed twice while this event was loading. Failing
        // open for this candidate is safer than mixing two generations.
        return [];
    }

    function loadCompiledPopupRealms(filteringMode) {
        const result = compiledLoadMutation.then(
            ( ) => loadCompiledPopupRealmsNow(filteringMode)
        );
        compiledLoadMutation = result.catch(reason => {
            log(`compiled popup filters unavailable: ${reason}`);
        });
        return result;
    }

    function enforceCandidateLifetime(candidate, timestamp) {
        if ( validRecentTimestamp(
            candidate.createdAt,
            timestamp,
            CANDIDATE_TTL_MS
        ) === false ) {
            return { candidateExpired: true, gestureExpired: false };
        }
        if ( candidate.hasRecentUserGesture !== true ) {
            return { candidateExpired: false, gestureExpired: false };
        }
        if ( validRecentTimestamp(
            candidate.gestureAt,
            timestamp,
            GESTURE_TTL_MS
        ) ) {
            return { candidateExpired: false, gestureExpired: false };
        }
        candidate.hasRecentUserGesture = false;
        candidate.gestureAt = 0;
        candidate.gestureTargetURL = '';
        return { candidateExpired: false, gestureExpired: true };
    }

    function pruneTransientState(timestamp) {
        for ( const [ tabId, burst ] of bursts ) {
            if ( timestamp - burst.at <= BURST_WINDOW_MS ) { continue; }
            bursts.delete(tabId);
        }
        for ( const [ tabId, candidate ] of candidates ) {
            if ( timestamp - candidate.createdAt <= CANDIDATE_TTL_MS ) {
                continue;
            }
            candidates.delete(tabId);
        }
        for ( const [ fingerprint, usedAt ] of consumedGestures ) {
            if ( timestamp - usedAt <= GESTURE_TTL_MS ) { continue; }
            consumedGestures.delete(fingerprint);
        }
    }

    function restoreTransient(value) {
        if ( value?.version !== 1 ) { return; }
        const timestamp = now();
        for ( const entry of value.bursts || [] ) {
            if ( Array.isArray(entry) === false || entry.length !== 3 ) {
                continue;
            }
            const [ tabId, at, count ] = entry;
            if ( validTabId(tabId) === false ||
                validRecentTimestamp(at, timestamp, BURST_WINDOW_MS) === false ||
                Number.isSafeInteger(count) === false || count < 1 ) {
                continue;
            }
            boundedMapSet(bursts, tabId, { at, count: Math.min(count, 1000) });
        }
        for ( const entry of value.consumedGestures || [] ) {
            if ( Array.isArray(entry) === false || entry.length !== 2 ) {
                continue;
            }
            const [ fingerprint, usedAt ] = entry;
            if ( typeof fingerprint !== 'string' || fingerprint.length > 160 ||
                validRecentTimestamp(
                    usedAt,
                    timestamp,
                    GESTURE_TTL_MS
                ) === false ) {
                continue;
            }
            boundedMapSet(consumedGestures, fingerprint, usedAt);
        }
        for ( const entry of value.candidates || [] ) {
            if ( entry instanceof Object === false ||
                validTabId(entry.tabId) === false ||
                validTabId(entry.openerTabId) === false ||
                validRecentTimestamp(
                    entry.createdAt,
                    timestamp,
                    CANDIDATE_TTL_MS
                ) === false ) {
                continue;
            }
            // A settled, trusted destination must not lose its protection
            // merely because Chrome evicted the worker during a slow load.
            // Its exact path is intentionally absent from the checkpoint, so
            // we cannot distinguish that load from a later redirect safely.
            if ( entry.trustedDestinationAccepted === true ) { continue; }
            const initiatorURL = checkpointURL(entry.initiatorURL);
            const candidate = {
                tabId: entry.tabId,
                openerTabId: entry.openerTabId,
                targetURL: checkpointURL(entry.targetURL),
                targetURLComplete: false,
                originalOpenerURL: checkpointURL(entry.originalOpenerURL),
                originalOpenerURLComplete: false,
                initiatorURL,
                // Popup filter initiator conditions are hostname-only. The
                // redacted origin therefore preserves all required matching
                // information across a worker restart without retaining a
                // path, query, fragment or credential.
                initiatorContextComplete:
                    entry.initiatorContextComplete === true &&
                    initiatorURL !== '',
                compiledPopupAllowed: entry.compiledPopupAllowed === true,
                sourceFrameId: validTabId(entry.sourceFrameId)
                    ? entry.sourceFrameId
                    : -1,
                sourceIsAuthoritative: entry.sourceIsAuthoritative === true,
                popunderObserved: false,
                gestureTargetURL: checkpointURL(entry.gestureTargetURL),
                createdAt: entry.createdAt,
                gestureResolved: entry.gestureResolved === true,
                gestureContextAvailable:
                    entry.gestureContextAvailable === true,
                hasRecentUserGesture: entry.hasRecentUserGesture === true,
                gestureAt: Number.isSafeInteger(entry.gestureAt)
                    ? entry.gestureAt
                    : 0,
                gestureFingerprint: typeof entry.gestureFingerprint === 'string' &&
                    entry.gestureFingerprint.length <= 160
                    ? entry.gestureFingerprint
                    : '',
                burstCount: Number.isSafeInteger(entry.burstCount)
                    ? Math.max(1, Math.min(entry.burstCount, 1000))
                    : 1,
                lastSignature: typeof entry.lastSignature === 'string' &&
                    entry.lastSignature.length <= 512
                    ? entry.lastSignature
                    : '',
            };
            enforceCandidateLifetime(candidate, timestamp);
            boundedMapSet(candidates, candidate.tabId, candidate);
        }
        pruneTransientState(timestamp);
    }

    const ready = Promise.all([
        localRead(POLICY_STORAGE_KEY),
        sessionRead(DIAGNOSTIC_STORAGE_KEY),
        sessionRead(TRANSIENT_STORAGE_KEY),
    ]).then(([ storedPolicies, storedDiagnostics, storedTransient ]) => {
        policies = normalizePopupPolicies(storedPolicies);
        if ( Array.isArray(storedDiagnostics) ) {
            for ( const entry of storedDiagnostics.slice(-MAX_POPUP_DIAGNOSTICS) ) {
                diagnostics = appendPopupDiagnostic(diagnostics, entry);
            }
        }
        restoreTransient(storedTransient);
        stateLoaded = true;
    }).catch(reason => {
        log(`popup blocker state load failed: ${reason}`);
    });

    function transientSnapshot() {
        return {
            version: 1,
            bursts: Array.from(bursts, ([ tabId, value ]) => [
                tabId,
                value.at,
                value.count,
            ]),
            candidates: Array.from(candidates.values(), candidate => ({
                tabId: candidate.tabId,
                openerTabId: candidate.openerTabId,
                targetURL: checkpointURL(candidate.targetURL),
                targetURLComplete: false,
                originalOpenerURL: checkpointURL(
                    candidate.originalOpenerURL
                ),
                initiatorURL: checkpointURL(candidate.initiatorURL),
                initiatorContextComplete:
                    candidate.initiatorContextComplete === true,
                compiledPopupAllowed:
                    candidate.compiledPopupAllowed === true,
                sourceFrameId: candidate.sourceFrameId,
                sourceIsAuthoritative: candidate.sourceIsAuthoritative === true,
                gestureTargetURL: checkpointURL(
                    candidate.gestureTargetURL
                ),
                createdAt: candidate.createdAt,
                gestureResolved: candidate.gestureResolved === true,
                gestureContextAvailable:
                    candidate.gestureContextAvailable === true,
                hasRecentUserGesture:
                    candidate.hasRecentUserGesture === true,
                gestureAt: candidate.gestureAt,
                gestureFingerprint: candidate.gestureFingerprint || '',
                burstCount: candidate.burstCount,
                lastSignature: candidate.lastSignature,
                trustedDestinationAccepted:
                    candidate.trustedDestinationAccepted === true,
            })),
            consumedGestures: Array.from(consumedGestures),
        };
    }

    function persistTransient() {
        const snapshot = transientSnapshot();
        transientMutation = transientMutation.then(( ) =>
            sessionWrite(TRANSIENT_STORAGE_KEY, snapshot)
        ).catch(reason => {
            log(`popup transient checkpoint failed: ${reason}`);
        });
        return transientMutation;
    }

    function nextBurstCount(tabId, timestamp) {
        const previous = bursts.get(tabId);
        const count = previous !== undefined &&
            timestamp - previous.at <= BURST_WINDOW_MS
            ? previous.count + 1
            : 1;
        boundedMapSet(bursts, tabId, { at: timestamp, count });
        return count;
    }

    function getOrCreateCandidate(
        tabId,
        openerTabId,
        targetURL = '',
        context = {}
    ) {
        let candidate = candidates.get(tabId);
        if ( candidate !== undefined && context.authoritativeSource === true &&
            candidate.openerTabId !== openerTabId ) {
            // Navigation-target provenance is authoritative when the two
            // browser events identify different source tabs. Drop provisional
            // attribution, including its one-shot token, before accepting any
            // source URL or user activation from it.
            const burst = bursts.get(candidate.openerTabId);
            if ( burst?.at === candidate.createdAt &&
                burst.count === candidate.burstCount ) {
                if ( burst.count > 1 ) { burst.count -= 1; }
                else { bursts.delete(candidate.openerTabId); }
            }
            consumedGestures.delete(candidate.gestureFingerprint);
            candidates.delete(tabId);
            candidate = undefined;
        }
        if ( candidate !== undefined ) {
            if ( context.authoritativeSource !== true &&
                candidate.sourceIsAuthoritative === true ) {
                return candidate;
            }
            if ( targetURL !== '' ) {
                const target = contextURLDetails(targetURL);
                const nextTargetURL = target.url;
                if ( candidate.targetURL !== nextTargetURL ) {
                    candidate.compiledPopupAllowed = false;
                    candidate.trustedDestinationAccepted = false;
                }
                candidate.targetURL = nextTargetURL;
                candidate.targetURLComplete = target.complete;
            }
            if ( validTabId(context.sourceFrameId) ) {
                if ( candidate.sourceFrameId !== context.sourceFrameId ) {
                    candidate.gestureResolved = false;
                }
                candidate.sourceFrameId = context.sourceFrameId;
            }
            if ( context.authoritativeSource === true ) {
                candidate.sourceIsAuthoritative = true;
            }
            return candidate;
        }
        const timestamp = now();
        pruneTransientState(timestamp);
        const target = contextURLDetails(targetURL);
        candidate = {
            tabId,
            openerTabId,
            targetURL: target.url,
            targetURLComplete: target.complete,
            originalOpenerURL: '',
            originalOpenerURLComplete: false,
            initiatorURL: '',
            initiatorContextComplete: false,
            compiledPopupAllowed: false,
            sourceFrameId: validTabId(context.sourceFrameId)
                ? context.sourceFrameId
                : -1,
            sourceIsAuthoritative: context.authoritativeSource === true,
            popunderObserved: false,
            gestureTargetURL: '',
            createdAt: timestamp,
            gestureResolved: false,
            gestureContextAvailable: false,
            hasRecentUserGesture: false,
            gestureAt: 0,
            gestureFingerprint: '',
            burstCount: nextBurstCount(openerTabId, timestamp),
            lastSignature: '',
        };
        boundedMapSet(candidates, tabId, candidate);
        return candidate;
    }

    function applySourceContext(candidate, context) {
        if ( context instanceof Object === false ) { return; }
        const top = contextURLDetails(context.topURL);
        if ( candidate.originalOpenerURL === '' && top.url !== '' ) {
            candidate.originalOpenerURL = top.url;
            candidate.originalOpenerURLComplete =
                context.topContextComplete === true && top.complete;
        }
        const initiatorURL = boundedContextURL(context.initiatorURL);
        if ( candidate.initiatorContextComplete !== true &&
            context.initiatorContextComplete === true &&
            initiatorURL !== '' ) {
            candidate.initiatorURL = initiatorURL;
            candidate.initiatorContextComplete = true;
        }
    }

    async function resolveOpenerContext(candidate, openerURL) {
        if ( candidate.originalOpenerURL === '' ) {
            const opener = contextURLDetails(openerURL);
            candidate.originalOpenerURL = opener.url;
            candidate.originalOpenerURLComplete = opener.complete;
        }
        if ( candidate.initiatorContextComplete ) { return; }
        if ( candidate.sourceFrameId === 0 ) {
            candidate.initiatorURL = boundedContextURL(openerURL);
            candidate.initiatorContextComplete =
                candidate.initiatorURL !== '';
            return;
        }
        if ( candidate.sourceFrameId > 0 ) {
            try {
                const frameURL = await getSourceFrameURL(
                    candidate.openerTabId,
                    candidate.sourceFrameId
                );
                candidate.initiatorURL = boundedContextURL(frameURL);
                candidate.initiatorContextComplete =
                    candidate.initiatorURL !== '';
            } catch ( reason ) {
                log(`popup source frame unavailable: ${reason}`);
            }
        }
        if ( candidate.initiatorURL === '' ) {
            // This fallback can be used by rules with no initiator condition.
            // The completeness bit prevents it from broadening a domain-
            // constrained block when the popup actually came from an iframe.
            candidate.initiatorURL = boundedContextURL(openerURL);
        }
    }

    async function resolveGesture(candidate) {
        if ( candidate.gestureResolved ) { return; }
        const timestamp = now();
        let contexts = [];
        try {
            const response = await getGestureContexts(
                candidate.openerTabId,
                candidate.sourceFrameId
            );
            if ( Array.isArray(response) ) { contexts = response; }
        } catch ( reason ) {
            log(`popup gesture context unavailable: ${reason}`);
        }
        if ( candidates.get(candidate.tabId) !== candidate ) { return; }
        // A response from a sibling frame cannot establish that the actual
        // opener frame recorded this activation. On Chromium, tabs.onCreated
        // has no frame id; wait for the navigation-target event before letting
        // the Smart heuristic treat missing activation as negative evidence.
        candidate.gestureContextAvailable = candidate.sourceFrameId >= 0
            ? contexts.some(context =>
                context?.frameId === candidate.sourceFrameId
            )
            : supportsNavigationTargetContext !== true && contexts.length !== 0;
        if ( candidate.hasRecentUserGesture === true ) {
            candidate.gestureResolved = true;
            return;
        }
        const eligible = contexts.filter(context =>
            validTabId(context?.frameId) &&
            Number.isSafeInteger(context?.sequence) &&
            context.sequence > 0 &&
            validRecentTimestamp(context?.at, timestamp, GESTURE_TTL_MS)
        ).sort((a, b) => b.at - a.at);
        for ( const context of eligible ) {
            const fingerprint = [
                candidate.openerTabId,
                context.frameId,
                context.sequence,
                context.at,
            ].join(':');
            if ( consumedGestures.has(fingerprint) ) { continue; }
            candidate.hasRecentUserGesture = true;
            candidate.gestureAt = context.at;
            candidate.gestureFingerprint = fingerprint;
            candidate.gestureTargetURL = boundedContextURL(context.targetURL);
            boundedMapSet(consumedGestures, fingerprint, timestamp);
            break;
        }
        candidate.gestureResolved = true;
    }

    function persistDiagnostic(value) {
        diagnostics = appendPopupDiagnostic(diagnostics, value);
        const snapshot = diagnostics.slice();
        diagnosticMutation = diagnosticMutation.then(( ) =>
            sessionWrite(DIAGNOSTIC_STORAGE_KEY, snapshot)
        ).catch(reason => {
            log(`popup diagnostic write failed: ${reason}`);
        });
        return diagnosticMutation;
    }

    async function filteringModeFromURL(url, allowGlobalFallback = false) {
        const hostname = filteringHostname(url, allowGlobalFallback);
        if ( hostname === '' ) { return 0; }
        try {
            const mode = await getFilteringMode(hostname);
            return Number.isSafeInteger(mode) ? mode : 0;
        } catch ( reason ) {
            log(`popup filtering mode unavailable: ${reason}`);
            return 0;
        }
    }

    async function finalizeDecision(candidate, result, closeTabId, observation) {
        const isCurrent = ( ) => candidates.get(candidate.tabId) === candidate &&
            (observation === undefined || (
                candidate.evaluationId === observation.evaluationId &&
                candidate.targetURL === observation.targetURL
            ));
        if ( isCurrent() === false ) {
            return { action: 'defer', reason: 'popup-context-changed' };
        }
        if ( result.action === 'block' ) {
            // Corpus/storage reads yield to other browser events and user
            // settings changes. Recheck authority immediately before closing,
            // including the current tab URL for an already-navigated popunder.
            if ( isEnabled() !== true ) {
                result = { action: 'allow', reason: 'popup-blocker-disabled' };
            } else {
                let closingTab;
                try {
                    closingTab = await tabs.get(closeTabId);
                } catch {
                }
                const currentURL = tabURL(closingTab);
                if ( closingTab === undefined || closingTab.discarded === true ) {
                    result = { action: 'allow', reason: 'popup-tab-unavailable' };
                } else if ( closeTabId === candidate.tabId &&
                    boundedContextURL(currentURL) !== candidate.targetURL ) {
                    result = { action: 'defer', reason: 'popup-context-changed' };
                } else {
                    const modes = await Promise.all([
                        filteringModeFromURL(candidate.originalOpenerURL),
                        filteringModeFromURL(candidate.targetURL, true),
                        filteringModeFromURL(currentURL, true),
                    ]);
                    if ( modes.some(mode => mode < 1) ) {
                        result = {
                            action: 'allow', reason: 'popup-filtering-disabled',
                        };
                    }
                }
            }
            if ( isCurrent() === false ) {
                return { action: 'defer', reason: 'popup-context-changed' };
            }
            if ( isEnabled() !== true ) {
                result = { action: 'allow', reason: 'popup-blocker-disabled' };
            } else if ( enforceCandidateLifetime(candidate, now()).candidateExpired ) {
                candidates.delete(candidate.tabId);
                await persistTransient();
                return { action: 'allow', reason: 'candidate-expired' };
            }
            if ( result.action === 'block' && result.policy !== undefined ) {
                const { mode, matchedHostname } = resolvePopupPolicy(
                    policies, candidate.originalOpenerURL
                );
                if ( mode !== result.policy ) {
                    result = evaluatePopupCandidate({
                        policy: mode,
                        matchedHostname,
                        openerURL: candidate.originalOpenerURL,
                        targetURL: candidate.targetURL,
                        gestureContextAvailable: candidate.gestureContextAvailable,
                        hasRecentUserGesture: candidate.hasRecentUserGesture,
                        gestureTargetMatches: sameNavigationTarget(
                            candidate.gestureTargetURL, candidate.targetURL
                        ),
                        burstCount: candidate.burstCount,
                    });
                }
            }
        }
        if ( result.action === 'defer' ) {
            await persistTransient();
            return result;
        }
        const signature = [
            result.action,
            result.reason,
            result.targetHostname,
            result.kind,
            result.matchedRealm,
            result.lineNumber,
            closeTabId,
        ].join('|');
        if ( signature === candidate.lastSignature ) { return result; }
        candidate.lastSignature = signature;
        if ( result.action === 'allow' && (
            result.reason === 'trusted-navigation-target' ||
            result.reason === 'recent-user-gesture' ||
            result.reason === 'strict-related-hostname-user-gesture'
        ) ) {
            candidate.trustedDestinationAccepted = true;
        }

        if ( result.action === 'block' ) {
            let action = 'blocked';
            try {
                await tabs.remove(closeTabId);
            } catch ( reason ) {
                action = 'block-failed';
                log(`popup tab ${closeTabId} could not be closed: ${reason}`);
            }
            candidates.delete(candidate.tabId);
            await Promise.all([
                persistTransient(),
                persistDiagnostic({ ...result, action, at: now() }),
            ]);
            return { ...result, action };
        }

        await Promise.all([
            persistTransient(),
            persistDiagnostic({ ...result, at: now() }),
        ]);
        return result;
    }

    async function evaluateCompiledCandidate(candidate, input) {
        if ( supportsNavigationTargetContext !== true ) {
            return { action: 'none' };
        }
        const filteringMode = input.filteringMode;
        if ( filteringMode < 1 ) { return { action: 'none' }; }
        const realms = await loadCompiledPopupRealms(filteringMode);
        const result = evaluateCompiledPopupFilters(realms, {
            kind: input.kind,
            targetURL: input.targetURL,
            targetURLComplete: input.targetURLComplete !== false,
            initiatorURL: input.initiatorURL,
            topURL: input.topURL,
            initiatorContextComplete: input.initiatorContextComplete,
            requireTargetHostnameMatch:
                input.requireTargetHostnameMatch === true,
            filteringMode,
        });
        if ( result?.action === 'defer' ) { return result; }
        if ( result?.action !== 'allow' && result?.action !== 'block' ) {
            return { action: 'none' };
        }
        return {
            ...result,
            openerHostname: normalizePopupHostname(input.initiatorURL),
            targetHostname: normalizePopupHostname(input.targetURL),
        };
    }

    async function evaluateCandidate(candidate, fallbackTab) {
        if ( isEnabled() !== true ) {
            candidates.delete(candidate.tabId);
            await persistTransient();
            return { action: 'allow', reason: 'popup-blocker-disabled' };
        }
        const lifetime = enforceCandidateLifetime(candidate, now());
        if ( lifetime.candidateExpired ) {
            candidates.delete(candidate.tabId);
            await persistTransient();
            return { action: 'allow', reason: 'candidate-expired' };
        }
        const evaluationId = (candidate.evaluationId || 0) + 1;
        candidate.evaluationId = evaluationId;
        let openerTab;
        try {
            openerTab = await tabs.get(candidate.openerTabId);
        } catch {
            candidates.delete(candidate.tabId);
            await persistTransient();
            return { action: 'allow', reason: 'opener-tab-unavailable' };
        }
        if ( openerTab?.discarded === true || fallbackTab?.discarded === true ) {
            candidates.delete(candidate.tabId);
            await persistTransient();
            return { action: 'allow', reason: 'discarded-tab-restore' };
        }
        const openerURL = tabURL(openerTab);
        await resolveOpenerContext(candidate, openerURL);
        const targetURL = candidate.targetURL ||
            boundedContextURL(tabURL(fallbackTab));
        const filteringSiteURL = candidate.originalOpenerURL || openerURL;
        const observation = { evaluationId, targetURL: candidate.targetURL };
        // The current opener tab may already be the popunder landing page.
        // Policy lookup must use the immutable pre-navigation snapshot; its
        // canonical origin also remains parseable when a long path was
        // deliberately discarded.
        const openerHostname = normalizePopupHostname(filteringSiteURL);
        const [ filteringMode, targetFilteringMode ] = await Promise.all([
            filteringModeFromURL(filteringSiteURL),
            filteringModeFromURL(targetURL, true),
        ]);
        if ( filteringMode < 1 || targetFilteringMode < 1 ) {
            candidate.compiledPopupAllowed = false;
            return finalizeDecision(candidate, {
                action: 'allow',
                reason: 'popup-filtering-disabled',
                openerHostname,
                targetHostname: normalizePopupHostname(targetURL),
            }, candidate.tabId, observation);
        }
        const gestureTargetMatches = sameNavigationTarget(
            candidate.gestureTargetURL,
            targetURL
        );
        if ( candidate.hasRecentUserGesture !== true ||
            gestureTargetMatches !== true ) {
            const compiledResult = await evaluateCompiledCandidate(candidate, {
                kind: 'popup',
                targetURL,
                targetURLComplete: candidate.targetURLComplete === true,
                initiatorURL: candidate.initiatorURL || openerURL,
                topURL: filteringSiteURL,
                initiatorContextComplete:
                    candidate.initiatorContextComplete === true,
                filteringMode,
            });
            if ( candidate.evaluationId !== evaluationId ||
                candidate.targetURL !== observation.targetURL ) {
                return { action: 'defer', reason: 'popup-context-changed' };
            }
            if ( compiledResult.action === 'allow' ) {
                candidate.compiledPopupAllowed = true;
            } else if ( compiledResult.action === 'none' ) {
                candidate.compiledPopupAllowed = false;
            }
            if ( compiledResult.action !== 'none' ) {
                return finalizeDecision(
                    candidate,
                    compiledResult,
                    candidate.tabId,
                    observation
                );
            }
        } else {
            // A trusted exact click suppresses popup matching, but deliberately
            // does not suppress the later, independently detected popunder.
            candidate.compiledPopupAllowed = false;
        }
        const { mode, matchedHostname } = resolvePopupPolicy(
            policies,
            openerHostname
        );
        const result = evaluatePopupCandidate({
            policy: mode,
            matchedHostname,
            openerURL: candidate.originalOpenerURL || openerURL,
            targetURL,
            gestureContextAvailable: candidate.gestureContextAvailable,
            hasRecentUserGesture: candidate.hasRecentUserGesture,
            gestureTargetMatches,
            burstCount: candidate.burstCount,
        });
        return finalizeDecision(candidate, result, candidate.tabId, observation);
    }

    async function onTabCreated(tab, capturedOpenerTabPromise) {
        if ( isEnabled() !== true ) { return; }
        if ( validTabId(tab?.id) === false ||
            validTabId(tab?.openerTabId) === false ) {
            return;
        }
        // Start the opener read before storage hydration. tabs.onCreated can
        // be the only provenance event on platforms without
        // onCreatedNavigationTarget, and a popunder may replace this URL in
        // the same task which created the new tab.
        const openerTabPromise = capturedOpenerTabPromise ||
            tabs.get(tab.openerTabId).catch(reason => {
                log(`popup opener snapshot unavailable: ${reason}`);
            });
        await ready;
        if ( stateLoaded !== true ) {
            return { action: 'allow', reason: 'popup-state-unavailable' };
        }
        const candidate = getOrCreateCandidate(
            tab.id,
            tab.openerTabId,
            tabURL(tab)
        );
        const openerTab = await openerTabPromise;
        if ( candidates.get(candidate.tabId) !== candidate ) {
            return { action: 'defer', reason: 'popup-context-changed' };
        }
        if ( openerTab !== undefined &&
            candidate.openerTabId === tab.openerTabId ) {
            await resolveOpenerContext(candidate, tabURL(openerTab));
        }
        await resolveGesture(candidate);
        await persistTransient();
        return evaluateCandidate(candidate, tab);
    }

    async function onNavigationTarget(details, capturedSourceContextPromise) {
        if ( isEnabled() !== true ) { return; }
        if ( validTabId(details?.tabId) === false ||
            validTabId(details?.sourceTabId) === false ) {
            return;
        }
        // Initiate browser frame reads before the first unrelated await. The
        // opener may navigate synchronously after creating a popunder.
        const sourceContextPromise = capturedSourceContextPromise ||
            (async ( ) => getSourceContext(
                details.sourceTabId,
                details.sourceFrameId
            ))().catch(reason => {
                log(`popup source context unavailable: ${reason}`);
            });
        await ready;
        if ( stateLoaded !== true ) {
            return { action: 'allow', reason: 'popup-state-unavailable' };
        }
        const candidate = getOrCreateCandidate(
            details.tabId,
            details.sourceTabId,
            details.url || '',
            { sourceFrameId: details.sourceFrameId, authoritativeSource: true }
        );
        const sourceContext = await sourceContextPromise;
        if ( candidates.get(candidate.tabId) !== candidate ) {
            return { action: 'defer', reason: 'popup-context-changed' };
        }
        applySourceContext(candidate, sourceContext);
        await resolveGesture(candidate);
        await persistTransient();
        return evaluateCandidate(candidate);
    }

    async function evaluatePopunderCandidate(candidate) {
        if ( isEnabled() !== true ) {
            return { action: 'none', reason: 'popup-blocker-disabled' };
        }
        if ( candidate.compiledPopupAllowed === true ) {
            return {
                action: 'none',
                reason: 'compiled-popup-allow-suppresses-popunder',
            };
        }
        if ( candidate.originalOpenerURLComplete !== true ) {
            // The full pre-navigation URL is deliberately not checkpointed.
            // After a worker restart we cannot safely apply a path exception,
            // so fail open instead of turning a broad block into a false hit.
            return { action: 'none', reason: 'popunder-context-incomplete' };
        }
        const evaluationId = (candidate.evaluationId || 0) + 1;
        candidate.evaluationId = evaluationId;
        const observation = { evaluationId, targetURL: candidate.targetURL };
        let targetTab;
        try {
            targetTab = await tabs.get(candidate.tabId);
        } catch {
            return { action: 'none', reason: 'popup-tab-unavailable' };
        }
        if ( targetTab?.discarded === true ) {
            return { action: 'none', reason: 'discarded-tab-restore' };
        }
        const targetURL = candidate.targetURL ||
            boundedContextURL(tabURL(targetTab));
        const [ filteringMode, closingFilteringMode ] = await Promise.all([
            filteringModeFromURL(targetURL),
            filteringModeFromURL(candidate.originalOpenerURL, true),
        ]);
        if ( filteringMode < 1 || closingFilteringMode < 1 ) {
            return { action: 'none', reason: 'popup-filtering-disabled' };
        }
        const commonInput = {
            kind: 'popunder',
            targetURL: candidate.originalOpenerURL,
            targetURLComplete: true,
            initiatorURL: targetURL,
            topURL: targetURL,
            initiatorContextComplete: targetURL !== '',
            filteringMode,
        };
        const popunderResult = await evaluateCompiledCandidate(
            candidate,
            commonInput
        );
        if ( popunderResult.action === 'block' ||
            popunderResult.action === 'defer' ) {
            return finalizeDecision(
                candidate,
                popunderResult,
                candidate.openerTabId,
                observation
            );
        }
        // uBO's original engine retries a hostname-touching ordinary $popup
        // rule against the old opener when no explicit $popunder block won.
        // The matcher accepts only positive hostname evidence here; broad and
        // path-only popup filters are never guessed into popunder decisions.
        const popupFallbackResult = await evaluateCompiledCandidate(
            candidate,
            {
                ...commonInput,
                kind: 'popup',
                requireTargetHostnameMatch: true,
            }
        );
        const result = popupFallbackResult.action === 'none'
            ? popunderResult
            : popupFallbackResult;
        if ( result.action === 'none' ) { return result; }
        return finalizeDecision(
            candidate, result, candidate.openerTabId, observation
        );
    }

    async function onTabUpdated(tabId, changeInfo, tab) {
        await ready;
        if ( stateLoaded !== true ) {
            return { action: 'allow', reason: 'popup-state-unavailable' };
        }
        if ( isEnabled() !== true ) {
            if ( candidates.size !== 0 || bursts.size !== 0 ||
                consumedGestures.size !== 0 ) {
                candidates.clear();
                bursts.clear();
                consumedGestures.clear();
                await persistTransient();
            }
            return { action: 'allow', reason: 'popup-blocker-disabled' };
        }
        let directResult;
        const candidate = candidates.get(tabId);
        if ( candidate !== undefined ) {
            const lifetime = enforceCandidateLifetime(candidate, now());
            if ( lifetime.candidateExpired ) {
                candidates.delete(candidate.tabId);
                await persistTransient();
                directResult = {
                    action: 'allow',
                    reason: 'candidate-expired',
                };
            } else {
                const targetURL = changeInfo?.url || tabURL(tab);
                let targetChanged = false;
                if ( targetURL !== '' ) {
                    const target = contextURLDetails(targetURL);
                    const nextTargetURL = target.url;
                    targetChanged = candidate.targetURL !== nextTargetURL ||
                        candidate.targetURLComplete !== target.complete;
                    if ( candidate.targetURL !== nextTargetURL ) {
                        candidate.compiledPopupAllowed = false;
                        candidate.trustedDestinationAccepted = false;
                    }
                    candidate.targetURL = nextTargetURL;
                    candidate.targetURLComplete = target.complete;
                }
                // Finishing a slow load, changing the title, or starting audio
                // does not create another popup. Keep an accepted destination
                // after its gesture TTL while still inspecting every redirect
                // and unresolved about:blank candidate.
                if ( targetChanged || candidate.lastSignature === '' ) {
                    await resolveGesture(candidate);
                    directResult = await evaluateCandidate(candidate, tab);
                }
            }
        }

        let popunderResult;
        if ( typeof changeInfo?.url === 'string' && changeInfo.url !== '' ) {
            for ( const popupCandidate of Array.from(candidates.values()) ) {
                if ( popupCandidate.openerTabId !== tabId ) { continue; }
                if ( enforceCandidateLifetime(
                    popupCandidate,
                    now()
                ).candidateExpired ) {
                    candidates.delete(popupCandidate.tabId);
                    continue;
                }
                popupCandidate.popunderObserved = true;
                const result = await evaluatePopunderCandidate(
                    popupCandidate
                );
                if ( result.action !== 'none' ) {
                    popunderResult = result;
                }
            }
            await persistTransient();
        }
        return popunderResult || directResult;
    }

    async function onTabRemoved(tabId) {
        await ready;
        if ( stateLoaded !== true ) { return; }
        let modified = candidates.delete(tabId) || bursts.delete(tabId);
        for ( const [ candidateTabId, candidate ] of candidates ) {
            if ( candidate.openerTabId !== tabId ) { continue; }
            candidates.delete(candidateTabId);
            modified = true;
        }
        const prefix = `${tabId}:`;
        for ( const fingerprint of consumedGestures.keys() ) {
            if ( fingerprint.startsWith(prefix) === false ) { continue; }
            consumedGestures.delete(fingerprint);
            modified = true;
        }
        if ( modified ) { await persistTransient(); }
    }

    async function resume() {
        await ready;
        if ( stateLoaded !== true ) { return; }
        if ( isEnabled() !== true ) {
            candidates.clear();
            bursts.clear();
            consumedGestures.clear();
            await persistTransient();
            return;
        }
        for ( const candidate of Array.from(candidates.values()) ) {
            let tab;
            try {
                tab = await tabs.get(candidate.tabId);
            } catch {
                candidates.delete(candidate.tabId);
                continue;
            }
            const currentURL = tabURL(tab);
            if ( currentURL !== '' && currentURL !== 'about:blank' ) {
                candidate.targetURL = boundedContextURL(currentURL);
            }
            await resolveGesture(candidate);
            await evaluateCandidate(candidate, tab);
        }
        await persistTransient();
    }

    async function getPolicies(hostname = '') {
        await ready;
        if ( stateLoaded !== true ) {
            throw new Error('Popup policy state is unavailable');
        }
        const effective = resolvePopupPolicy(policies, hostname);
        return {
            policies: cloneObject(policies),
            effective,
        };
    }

    function setPolicy(hostname, mode) {
        const normalizedHostname = normalizePopupHostname(hostname);
        if ( normalizedHostname === '' ) {
            return Promise.reject(new TypeError('Invalid popup policy hostname'));
        }
        if ( mode !== 'default' && POPUP_POLICY_MODES.includes(mode) === false ) {
            return Promise.reject(new TypeError('Invalid popup policy mode'));
        }
        const result = policyMutation.then(async ( ) => {
            await ready;
            if ( stateLoaded !== true ) {
                throw new Error('Popup policy state is unavailable');
            }
            const replacement = cloneObject(policies);
            if ( mode === 'default' ) {
                delete replacement[normalizedHostname];
            } else {
                replacement[normalizedHostname] = mode;
            }
            if ( Object.keys(replacement).length > MAX_POPUP_POLICIES ) {
                throw new RangeError('Too many popup site policies');
            }
            await localWrite(POLICY_STORAGE_KEY, replacement);
            policies = replacement;
            return getPolicies(normalizedHostname);
        });
        policyMutation = result.catch(( ) => { });
        return result;
    }

    function replacePolicies(value) {
        let normalized;
        try {
            normalized = validatePopupPolicies(value);
        } catch ( reason ) {
            return Promise.reject(reason);
        }
        const result = policyMutation.then(async ( ) => {
            await ready;
            const replacement = cloneObject(normalized);
            await localWrite(POLICY_STORAGE_KEY, replacement);
            policies = replacement;
            return getPolicies();
        });
        policyMutation = result.catch(( ) => { });
        return result;
    }

    async function getDiagnostics() {
        await ready;
        await diagnosticMutation;
        return diagnostics.map(entry => ({ ...entry }));
    }

    async function clearDiagnostics() {
        await ready;
        diagnostics = [];
        diagnosticMutation = diagnosticMutation.then(( ) =>
            sessionWrite(DIAGNOSTIC_STORAGE_KEY, [])
        ).catch(reason => {
            log(`popup diagnostic clear failed: ${reason}`);
        });
        await diagnosticMutation;
        return true;
    }

    return {
        clearDiagnostics,
        getDiagnostics,
        getPolicies,
        onNavigationTarget,
        onTabCreated,
        onTabRemoved,
        onTabUpdated,
        ready,
        replacePolicies,
        resume,
        setPolicy,
    };
}

/******************************************************************************/
