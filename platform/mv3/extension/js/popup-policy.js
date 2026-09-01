/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

export const POPUP_POLICY_DEFAULT = 'block';
export const POPUP_POLICY_MODES = Object.freeze([
    'allow',
    'block',
    'strict',
]);

export const MAX_POPUP_POLICIES = 4096;
export const MAX_POPUP_DIAGNOSTICS = 100;

const WEB_PROTOCOLS = new Set([ 'http:', 'https:' ]);

/******************************************************************************/

export function normalizePopupHostname(value) {
    if ( typeof value !== 'string' ) { return ''; }
    const raw = value.trim();
    if ( raw === '' || raw.length > 2048 ) { return ''; }
    let url;
    try {
        url = raw.includes('://')
            ? new URL(raw)
            : new URL(`https://${raw}`);
    } catch {
        return '';
    }
    if ( WEB_PROTOCOLS.has(url.protocol) === false ) { return ''; }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if ( hostname === '' || hostname.length > 253 ) { return ''; }
    return hostname;
}

/******************************************************************************/

export function normalizePopupPolicies(value) {
    const out = Object.create(null);
    if ( typeof value !== 'object' || value === null || Array.isArray(value) ) {
        return out;
    }
    let count = 0;
    for ( const [ rawHostname, mode ] of Object.entries(value) ) {
        if ( POPUP_POLICY_MODES.includes(mode) === false ) { continue; }
        const hostname = normalizePopupHostname(rawHostname);
        if ( hostname === '' || out[hostname] !== undefined ) { continue; }
        out[hostname] = mode;
        count += 1;
        if ( count === MAX_POPUP_POLICIES ) { break; }
    }
    return out;
}

export function validatePopupPolicies(value) {
    if ( typeof value !== 'object' || value === null || Array.isArray(value) ) {
        throw new TypeError('popupPolicies must be an object');
    }
    const entries = Object.entries(value);
    if ( entries.length > MAX_POPUP_POLICIES ) {
        throw new RangeError('popupPolicies contains too many entries');
    }
    const out = Object.create(null);
    for ( const [ rawHostname, mode ] of entries ) {
        const hostname = normalizePopupHostname(rawHostname);
        if ( hostname === '' || POPUP_POLICY_MODES.includes(mode) === false ) {
            throw new TypeError('popupPolicies contains an invalid entry');
        }
        if ( out[hostname] !== undefined ) {
            throw new TypeError('popupPolicies contains duplicate hostnames');
        }
        out[hostname] = mode;
    }
    return out;
}

/******************************************************************************/

export function resolvePopupPolicy(policies, value) {
    const hostname = normalizePopupHostname(value);
    if ( hostname === '' ) {
        return { mode: POPUP_POLICY_DEFAULT, matchedHostname: '' };
    }
    // The MV3 runtime does not package a Public Suffix List. Parent-hostname
    // walking would therefore allow a policy for a public/private suffix such
    // as co.uk or github.io to escape into unrelated registrable domains.
    // Keep site policy scope exact until a trustworthy registrable-domain
    // helper is available in the runtime bundle.
    const mode = policies?.[hostname];
    if ( POPUP_POLICY_MODES.includes(mode) ) {
        return { mode, matchedHostname: hostname };
    }
    return { mode: POPUP_POLICY_DEFAULT, matchedHostname: '' };
}

/******************************************************************************/

function webURLDetails(raw) {
    if ( typeof raw !== 'string' || raw === '' ) {
        return { kind: 'defer', hostname: '', origin: '' };
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return { kind: 'unsupported', hostname: '', origin: '' };
    }
    if ( url.protocol === 'about:' &&
        (url.pathname === 'blank' || url.pathname === 'srcdoc') ) {
        return { kind: 'defer', hostname: '', origin: '' };
    }
    if ( WEB_PROTOCOLS.has(url.protocol) ) {
        return {
            kind: 'web',
            hostname: url.hostname.toLowerCase(),
            origin: url.origin,
        };
    }
    if ( url.protocol === 'blob:' ) {
        try {
            const inner = new URL(url.pathname);
            if ( WEB_PROTOCOLS.has(inner.protocol) ) {
                return {
                    kind: 'web',
                    hostname: inner.hostname.toLowerCase(),
                    origin: inner.origin,
                };
            }
        } catch {
        }
    }
    return { kind: 'unsupported', hostname: '', origin: '' };
}

// This deliberately models only direct hostname lineage. Sibling hostnames
// need a Public Suffix List to establish a shared registrable owner safely;
// treating every shared textual suffix as a site boundary would merge tenants
// on private suffixes such as github.io.
function directHostnameLineage(a, b) {
    if ( a === '' || b === '' ) { return false; }
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function decision(action, reason, details) {
    return {
        action,
        reason,
        policy: details.policy,
        matchedHostname: details.matchedHostname || '',
        openerHostname: details.openerHostname || '',
        targetHostname: details.targetHostname || '',
        directHostnameLineage: details.directHostnameLineage === true,
        hadUserGesture: details.hasRecentUserGesture === true,
        burstCount: Number.isSafeInteger(details.burstCount)
            ? details.burstCount
            : 1,
    };
}

/**
 * Contextual popup policy deliberately complements, rather than replaces,
 * compiled popup filters. The balanced `block` policy preserves a single
 * directly related-hostname automatic window and any window tied to one recent
 * trusted user activation. `strict` requires both a trusted activation and a
 * direct ancestor/descendant hostname relationship.
 */
export function evaluatePopupCandidate(input = {}) {
    const policy = POPUP_POLICY_MODES.includes(input.policy)
        ? input.policy
        : POPUP_POLICY_DEFAULT;
    const common = {
        policy,
        matchedHostname: input.matchedHostname,
        hasRecentUserGesture: input.hasRecentUserGesture,
        burstCount: input.burstCount,
    };
    if ( policy === 'allow' ) {
        return decision('allow', 'site-policy-allow', common);
    }

    const opener = webURLDetails(input.openerURL);
    if ( opener.kind !== 'web' ) {
        return decision('allow', 'unsupported-opener-context', common);
    }
    common.openerHostname = opener.hostname;

    const target = webURLDetails(input.targetURL);
    if ( target.kind === 'defer' ) {
        return decision('defer', 'target-not-committed', common);
    }
    if ( target.kind !== 'web' ) {
        return decision('allow', 'unsupported-target-context', common);
    }
    common.targetHostname = target.hostname;
    common.directHostnameLineage = directHostnameLineage(
        opener.hostname,
        target.hostname
    );

    if ( policy === 'strict' ) {
        if ( input.hasRecentUserGesture !== true ) {
            return decision('block', 'strict-without-user-gesture', common);
        }
        if ( common.directHostnameLineage === false ) {
            return decision('block', 'strict-unrelated-hostname', common);
        }
        return decision(
            'allow',
            'strict-related-hostname-user-gesture',
            common
        );
    }

    // If the opener did not host the context script (for example because the
    // user intentionally selected Basic filtering), fail open in Smart mode.
    // Compiled popup filters still run independently. Strict is explicit and
    // therefore intentionally does not use this safeguard.
    if ( input.gestureContextAvailable === false ) {
        return decision('allow', 'gesture-context-unavailable', common);
    }
    if ( input.hasRecentUserGesture === true &&
        input.gestureTargetMatches === true ) {
        return decision('allow', 'trusted-navigation-target', common);
    }
    if ( input.hasRecentUserGesture === true ) {
        return decision('allow', 'recent-user-gesture', common);
    }
    if ( common.directHostnameLineage && (input.burstCount ?? 1) <= 1 ) {
        return decision('allow', 'single-related-hostname-popup', common);
    }
    if ( common.directHostnameLineage ) {
        return decision('block', 'related-hostname-popup-burst', common);
    }
    return decision('block', 'unrelated-hostname-without-user-gesture', common);
}

/******************************************************************************/

export function appendPopupDiagnostic(
    history,
    value,
    maximum = MAX_POPUP_DIAGNOSTICS
) {
    const out = Array.isArray(history) ? history.slice() : [];
    const entry = {
        at: Number.isSafeInteger(value?.at) ? value.at : 0,
        action: typeof value?.action === 'string' ? value.action : 'unknown',
        reason: typeof value?.reason === 'string' ? value.reason : 'unknown',
        policy: POPUP_POLICY_MODES.includes(value?.policy)
            ? value.policy
            : POPUP_POLICY_DEFAULT,
        openerHostname: normalizePopupHostname(value?.openerHostname),
        targetHostname: normalizePopupHostname(value?.targetHostname),
        hadUserGesture: value?.hadUserGesture === true,
        burstCount: Number.isSafeInteger(value?.burstCount)
            ? Math.max(1, value.burstCount)
            : 1,
    };
    out.push(entry);
    const limit = Number.isSafeInteger(maximum) && maximum > 0
        ? maximum
        : MAX_POPUP_DIAGNOSTICS;
    if ( out.length > limit ) {
        out.splice(0, out.length - limit);
    }
    return out;
}

/******************************************************************************/
