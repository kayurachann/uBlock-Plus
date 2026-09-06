/* uBlock Plus+ - on-demand draft firewall explanation. GPL-3.0-or-later. */
import {
    FIREWALL_REQUEST_TYPES,
    firewallHostname,
    modeAt,
    parseFirewall,
    within,
} from './firewall-core.js';
import { createFirewallIndex } from './firewall-index.js';

export function requestHostname(value) {
    if ( typeof value !== 'string' || value.length > 4096 ) {
        throw new Error('Enter a hostname or an HTTP(S) URL (at most 4096 characters)');
    }
    const input = value.trim();
    if ( input === '' || input === '*' ) { throw new Error('Use a specific hostname'); }
    if ( input.includes('://') ) {
        const url = new URL(input);
        if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) {
            throw new Error('Only HTTP(S) page and resource URLs are supported');
        }
        if ( url.username || url.password ) { throw new Error('Remove credentials from the URL'); }
        return firewallHostname(url.hostname);
    }
    return firewallHostname(input);
}

export function explainFirewallRequest(input, modes, domainFromHostname) {
    const source = requestHostname(input.source);
    const destination = requestHostname(input.destination);
    if ( FIREWALL_REQUEST_TYPES.includes(input.type) === false ) {
        throw new Error('Choose a supported subresource type');
    }
    const parsed = parseFirewall(input.text);
    const result = { source, destination, type: input.type, scope: 'draft',
        action: 'unknown', rule: null, thirdParty: null, mode: null };
    // An unknown trust configuration or party domain must not produce a
    // speculative block. No URL is fetched or written to persistent storage.
    for ( const name of [ 'none', 'basic', 'optimal', 'complete' ] ) {
        if ( Array.isArray(modes?.[name]) === false ||
            modes[name].some(host => typeof host !== 'string') ) {
            return { ...result, reason: 'mode-unavailable' };
        }
    }
    result.mode = modeAt(modes, source);
    if ( result.mode === 'none' ) {
        return { ...result, action: 'off', reason: 'site-off' };
    }
    const domain = domainFromHostname(source);
    if ( typeof domain !== 'string' || domain === '' ) {
        return { ...result, reason: 'party-unavailable' };
    }
    result.thirdParty = within(destination, domain) === false;
    const winner = createFirewallIndex(parsed.rules).evaluate(
        source, destination, input.type, result.thirdParty
    );
    return { ...result, action: winner?.action ?? 'no-match', rule: winner?.raw ?? null,
        reason: winner ? 'matching-cell' : 'no-matching-cell' };
}
