/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

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

const POLICY_STORAGE_KEY = 'popupBlocker.sitePolicies';
const DIAGNOSTIC_STORAGE_KEY = 'popupBlocker.diagnostics';
const TRANSIENT_STORAGE_KEY = 'popupBlocker.transient';
const GESTURE_TTL_MS = 5_000;
const BURST_WINDOW_MS = 2_000;
const CANDIDATE_TTL_MS = 30_000;
const MAX_TRANSIENT_ENTRIES = 256;

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
    return typeof raw === 'string' && raw.length <= 8192 ? raw : '';
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
        getGestureContexts = async ( ) => [],
        localRead = async ( ) => undefined,
        localWrite = async ( ) => undefined,
        sessionRead = async ( ) => undefined,
        sessionWrite = async ( ) => undefined,
        isEnabled = ( ) => true,
        now = ( ) => Date.now(),
        log = ( ) => undefined,
    } = dependencies;

    const bursts = new Map();
    const candidates = new Map();
    const consumedGestures = new Map();
    let policies = Object.create(null);
    let diagnostics = [];
    let policyMutation = Promise.resolve();
    let diagnosticMutation = Promise.resolve();
    let transientMutation = Promise.resolve();

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
            const candidate = {
                tabId: entry.tabId,
                openerTabId: entry.openerTabId,
                targetURL: checkpointURL(entry.targetURL),
                gestureTargetURL: checkpointURL(entry.gestureTargetURL),
                createdAt: entry.createdAt,
                gestureResolved: entry.gestureResolved === true,
                gestureContextAvailable:
                    entry.gestureContextAvailable === true,
                hasRecentUserGesture: entry.hasRecentUserGesture === true,
                gestureAt: Number.isSafeInteger(entry.gestureAt)
                    ? entry.gestureAt
                    : 0,
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
                burstCount: candidate.burstCount,
                lastSignature: candidate.lastSignature,
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

    function getOrCreateCandidate(tabId, openerTabId, targetURL = '') {
        let candidate = candidates.get(tabId);
        if ( candidate !== undefined ) {
            if ( targetURL !== '' ) {
                candidate.targetURL = boundedContextURL(targetURL);
            }
            return candidate;
        }
        const timestamp = now();
        pruneTransientState(timestamp);
        candidate = {
            tabId,
            openerTabId,
            targetURL: boundedContextURL(targetURL),
            gestureTargetURL: '',
            createdAt: timestamp,
            gestureResolved: false,
            gestureContextAvailable: false,
            hasRecentUserGesture: false,
            gestureAt: 0,
            burstCount: nextBurstCount(openerTabId, timestamp),
            lastSignature: '',
        };
        boundedMapSet(candidates, tabId, candidate);
        return candidate;
    }

    async function resolveGesture(candidate) {
        if ( candidate.gestureResolved ) { return; }
        const timestamp = now();
        let contexts = [];
        try {
            const response = await getGestureContexts(candidate.openerTabId);
            if ( Array.isArray(response) ) { contexts = response; }
        } catch ( reason ) {
            log(`popup gesture context unavailable: ${reason}`);
        }
        candidate.gestureContextAvailable = contexts.length !== 0;
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
        const openerHostname = normalizePopupHostname(openerURL);
        const { mode, matchedHostname } = resolvePopupPolicy(
            policies,
            openerHostname
        );
        const targetURL = candidate.targetURL || checkpointURL(tabURL(fallbackTab));
        const result = evaluatePopupCandidate({
            policy: mode,
            matchedHostname,
            openerURL,
            targetURL,
            gestureContextAvailable: candidate.gestureContextAvailable,
            hasRecentUserGesture: candidate.hasRecentUserGesture,
            gestureTargetMatches: sameNavigationTarget(
                candidate.gestureTargetURL,
                targetURL
            ),
            burstCount: candidate.burstCount,
        });
        if ( result.action === 'defer' ) {
            await persistTransient();
            return result;
        }

        const signature = [
            result.action,
            result.reason,
            result.targetHostname,
        ].join('|');
        if ( signature === candidate.lastSignature ) { return result; }
        candidate.lastSignature = signature;

        if ( result.action === 'block' ) {
            let action = 'blocked';
            try {
                await tabs.remove(candidate.tabId);
            } catch ( reason ) {
                action = 'block-failed';
                log(`popup tab ${candidate.tabId} could not be closed: ${reason}`);
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

    async function onTabCreated(tab) {
        if ( isEnabled() !== true ) { return; }
        if ( validTabId(tab?.id) === false ||
            validTabId(tab?.openerTabId) === false ) {
            return;
        }
        await ready;
        const candidate = getOrCreateCandidate(
            tab.id,
            tab.openerTabId,
            tabURL(tab)
        );
        await resolveGesture(candidate);
        await persistTransient();
        return evaluateCandidate(candidate, tab);
    }

    async function onNavigationTarget(details) {
        if ( isEnabled() !== true ) { return; }
        if ( validTabId(details?.tabId) === false ||
            validTabId(details?.sourceTabId) === false ) {
            return;
        }
        await ready;
        const candidate = getOrCreateCandidate(
            details.tabId,
            details.sourceTabId,
            details.url || ''
        );
        await resolveGesture(candidate);
        await persistTransient();
        return evaluateCandidate(candidate);
    }

    async function onTabUpdated(tabId, changeInfo, tab) {
        await ready;
        const candidate = candidates.get(tabId);
        if ( candidate === undefined ) { return; }
        const lifetime = enforceCandidateLifetime(candidate, now());
        if ( lifetime.candidateExpired ) {
            candidates.delete(candidate.tabId);
            await persistTransient();
            return { action: 'allow', reason: 'candidate-expired' };
        }
        const targetURL = changeInfo?.url || tabURL(tab);
        if ( targetURL !== '' ) {
            candidate.targetURL = boundedContextURL(targetURL);
        }
        await resolveGesture(candidate);
        return evaluateCandidate(candidate, tab);
    }

    async function onTabRemoved(tabId) {
        await ready;
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
