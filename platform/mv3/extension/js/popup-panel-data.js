/* uBlock Plus+ — bounded, site-specific popup presentation data. GPL-3.0-or-later. */

export function countSitePopupBlocks(diagnostics, hostname) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return 0; }
    if ( Array.isArray(diagnostics) === false ) { return 0; }
    return diagnostics.filter(entry =>
        entry?.action === 'blocked' && entry.openerHostname === hostname
    ).length;
}

export function matchesPendingPermission(details, hostnames, now = Date.now()) {
    if ( typeof details?.requestId !== 'string' || details.requestId === '' ) {
        return false;
    }
    if ( Number.isFinite(details.createdAt) === false ||
        now < details.createdAt || now - details.createdAt > 30000 ) {
        return false;
    }
    return Array.isArray(hostnames) && hostnames.includes(details.hostname);
}
