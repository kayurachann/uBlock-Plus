/*******************************************************************************
    uBlock Plus+ - dynamic filtering compiled into disjoint native DNR cells
    Copyright (C) 2026-present uBlock Plus+ contributors
    GPL-3.0-or-later; precedence follows src/js/dynamic-net-filtering.js.
******************************************************************************/

import { createFirewallIndex } from './firewall-index.js';

export const FIREWALL_RULE_BASE = 7000000;
export const FIREWALL_RULE_LIMIT = 4096;
export const FIREWALL_PRIORITY = 1500000;
export const FIREWALL_TYPES = [
    '*', 'image', '1p-script', '3p', '3p-script', '3p-frame',
];
export const FIREWALL_REQUEST_TYPES = [
    'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'webtransport', 'webbundle', 'other',
];

export const within = (host, scope) => scope === '*' || host === scope ||
    host.endsWith(`.${scope}`);

export function firewallHostname(raw) {
    if ( raw === '*' ) { return raw; }
    if ( typeof raw !== 'string' || raw.length > 253 ) {
        throw new Error('Invalid hostname');
    }
    // Native domain conditions match IPv6 using URL.hostname's canonical
    // brackets. A bare address can be accepted by DNR without matching.
    if ( /^\[[0-9a-f:.]+\]$/i.test(raw) ) {
        return new URL(`https://${raw}`).hostname;
    }
    if ( /[\s/@?#%\\:]/.test(raw) ) { throw new Error('Invalid hostname'); }
    const url = new URL(`https://${raw}`);
    if ( url.port || url.username || url.password ) {
        throw new Error('Use a hostname without a port');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if ( host === '' || host.includes(':') ||
        /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host) === false ) {
        throw new Error('Firewall hostnames must be DNS names, IPv4 or bracketed IPv6');
    }
    return host;
}

export function parseFirewall(text) {
    if ( typeof text !== 'string' || text.length > 131072 ) {
        throw new Error('Firewall text exceeds 128 KiB');
    }
    const rules = [];
    const keys = new Set();
    for ( const [ index, line ] of text.split(/\r?\n/).entries() ) {
        const trimmed = line.trim();
        if ( trimmed === '' || /^[!#]/.test(trimmed) ) { continue; }
        try {
            const parts = trimmed.split(/\s+/);
            if ( parts.length !== 4 ) {
                throw new Error('Expected: source destination type action');
            }
            const [ rawSource, rawDestination, type, action ] = parts;
            const source = firewallHostname(rawSource);
            const destination = firewallHostname(rawDestination);
            if ( FIREWALL_TYPES.includes(type) === false ) {
                throw new Error(type === 'inline-script'
                    ? 'inline-script has no equivalent native network decision'
                    : 'Unsupported request type');
            }
            if ( destination !== '*' && type !== '*' ) {
                throw new Error('A destination hostname requires type *');
            }
            if ( [ 'block', 'allow', 'noop' ].includes(action) === false ) {
                throw new Error('Expected block, allow or noop');
            }
            const key = `${source} ${destination} ${type}`;
            if ( keys.has(key) ) { throw new Error('Duplicate firewall cell'); }
            keys.add(key);
            rules.push({ source, destination, type, action, raw: `${key} ${action}` });
            if ( rules.length > 256 ) { throw new Error('At most 256 firewall cells'); }
        } catch ( reason ) {
            throw new Error(`Line ${index + 1}: ${reason.message}`);
        }
    }
    return { rules, text: rules.map(rule => rule.raw).join('\n') };
}

// Destination specificity precedes source specificity, then party/type and *.
// A noop is a terminal decision. It never becomes a DNR allow rule.
export function evaluateFirewall(rules, source, destination, type, thirdParty) {
    const candidates = rules.filter(rule => within(source, rule.source));
    const bySource = (a, b) => (a.source === '*') - (b.source === '*') ||
        b.source.length - a.source.length;
    const destinationRules = candidates.filter(rule =>
        rule.destination !== '*' && within(destination, rule.destination)
    ).sort((a, b) => b.destination.length - a.destination.length || bySource(a, b));
    if ( destinationRules.length ) { return destinationRules[0]; }
    const types = [];
    if ( thirdParty ) {
        if ( type === 'script' ) { types.push('3p-script'); }
        if ( type === 'sub_frame' || type === 'object' ) { types.push('3p-frame'); }
        types.push('3p');
    } else if ( type === 'script' ) {
        types.push('1p-script');
    }
    if ( type === 'image' ) { types.push('image'); }
    types.push('*');
    for ( const kind of types ) {
        const found = candidates.filter(rule =>
            rule.destination === '*' && rule.type === kind
        ).sort(bySource)[0];
        if ( found ) { return found; }
    }
}

// Partition a suffix tree into mutually exclusive domains; this subtraction
// preserves noop holes without suppressing static filtering in those holes.
function cells(hostnames) {
    const hosts = [ ...new Set([ '*', ...hostnames ]) ].sort();
    const children = new Map(hosts.map(host => [ host, [] ]));
    for ( const child of hosts ) {
        if ( child === '*' ) { continue; }
        let parent = child;
        for (;;) {
            const dot = parent.indexOf('.');
            parent = dot === -1 ? '*' : parent.slice(dot + 1);
            if ( children.has(parent) ) { break; }
        }
        children.get(parent).push(child);
    }
    return hosts.map(host => ({ host, excluded: children.get(host) }));
}

export function modeAt(modes, host) {
    for ( const [ name, hosts ] of Object.entries(modes) ) {
        if ( hosts.includes(host) ) { return name; }
        if ( hosts.includes('all-urls') ) { continue; }
        if ( hosts.some(scope => within(host, scope)) ) { return name; }
    }
    return Object.keys(modes).find(key => modes[key].includes('all-urls')) || 'basic';
}

// Native budget failures carry a code so callers can shrink the learned
// party scope instead of leaving the whole firewall inactive.
export const FIREWALL_BUDGET_ERROR = 'ERR_FIREWALL_BUDGET';
const budgetError = message =>
    Object.assign(new Error(message), { code: FIREWALL_BUDGET_ERROR });

// True when a destination hostname falls inside a native rule's request
// domains: within its requestDomains scope and outside its exclusions.
function coversDestination(entry, host) {
    if ( entry.destination !== '*' && within(host, entry.destination) === false ) {
        return false;
    }
    let scope = host;
    for (;;) {
        if ( entry.excluded.has(scope) ) { return false; }
        const dot = scope.indexOf('.');
        if ( dot === -1 ) { return true; }
        scope = scope.slice(dot + 1);
    }
}

export function compileFirewall({ rules, modes, domains = [], domainFromHostname,
    maximum = FIREWALL_RULE_LIMIT }) {
    // A disabled firewall must not scan large existing Site Rules scopes.
    if ( rules.length === 0 ) {
        return { rules: [], provenance: {}, deferredCells: 0 };
    }
    const modeHosts = Object.values(modes).flat().filter(h => h !== 'all-urls');
    const sourceHosts = new Set([ '*', ...rules.map(rule => rule.source), ...modeHosts, ...domains ]);
    const ruleDestinations = rules.map(rule => rule.destination);
    if ( sourceHosts.size * (new Set(ruleDestinations).size + 2) > 32768 ) {
        throw budgetError('Firewall partition budget exceeded; simplify hostname cells');
    }
    const children = new Map(cells(sourceHosts).map(cell => [ cell.host, cell.excluded ]));
    const index = createFirewallIndex(rules);
    const output = [];
    const provenance = {};
    let deferredCells = 0;
    // Walk source scopes parent first. A child scope inherits every native
    // rule of its parent whose winning cell it shares on all destinations
    // and types that rule covers. Otherwise the child is excluded from that
    // whole rule and restates its own decisions, so equal-priority rules stay
    // disjoint. Learned domains then only add their party-dependent cells.
    const visit = (source, parentScopes, inherited) => {
        const enabled = modeAt(modes, source) !== 'none';
        const partyDomain = source === '*' ? '' : domainFromHostname(source);
        // Child destination cells refine every ancestor's cells.
        const partyScopes = partyDomain && parentScopes.includes(partyDomain) === false
            ? [ ...parentScopes, partyDomain ] : parentScopes;
        const destinations = cells([ ...ruleDestinations, ...partyScopes ]);
        const cellIndex = new Map(destinations.map((cell, i) => [ cell.host, i ]));
        const decisions = destinations.map(destination => FIREWALL_REQUEST_TYPES.map(type => {
            if ( enabled === false ) { return; }
            const thirdParty = partyDomain
                ? within(destination.host, partyDomain) === false : true;
            const decision = index.evaluate(source, destination.host, type, thirdParty);
            if ( partyDomain === '' ) {
                const alternative = index.evaluate(source, destination.host, type, false);
                if ( decision?.action !== alternative?.action ) {
                    deferredCells += 1;
                    return;
                }
            }
            if ( decision?.action === 'noop' ) { return; }
            return decision;
        }));
        const covered = destinations.map(( ) => new Set());
        const scope = [];
        for ( const entry of inherited ) {
            // Only the entry's own cell and added party-domain cells can lie
            // inside it; any other rule destination is a cell of its own.
            const matching = [ cellIndex.get(entry.destination) ];
            for ( const host of partyScopes ) {
                if ( host !== entry.destination && coversDestination(entry, host) ) {
                    matching.push(cellIndex.get(host));
                }
            }
            const same = matching.every(i => entry.types.every(t =>
                decisions[i][t]?.raw === entry.raw
            ));
            if ( same === false ) {
                entry.rule.condition.excludedTopDomains ??= [];
                entry.rule.condition.excludedTopDomains.push(source);
                continue;
            }
            for ( const i of matching ) {
                for ( const t of entry.types ) { covered[i].add(t); }
            }
            scope.push(entry);
        }
        destinations.forEach((destination, i) => {
            const groups = new Map();
            decisions[i].forEach((decision, t) => {
                if ( decision === undefined || covered[i].has(t) ) { return; }
                if ( groups.has(decision.raw) === false ) {
                    groups.set(decision.raw, { decision, types: [] });
                }
                groups.get(decision.raw).types.push(t);
            });
            for ( const { decision, types } of groups.values() ) {
                const resourceTypes = types.map(t => FIREWALL_REQUEST_TYPES[t]);
                const condition = { resourceTypes, excludedTabIds: [ -1 ] };
                if ( source !== '*' ) { condition.topDomains = [ source ]; }
                if ( destination.host !== '*' ) {
                    condition.requestDomains = [ destination.host ];
                }
                if ( destination.excluded.length ) {
                    condition.excludedRequestDomains = destination.excluded;
                }
                const id = FIREWALL_RULE_BASE + output.length;
                const rule = { id, priority: FIREWALL_PRIORITY,
                    action: { type: decision.action }, condition };
                output.push(rule);
                provenance[id] = decision.raw;
                if ( output.length > maximum ) {
                    throw budgetError(`Firewall exceeds ${maximum} available native rules; previous rules kept`);
                }
                scope.push({ rule, raw: decision.raw, types,
                    destination: destination.host, excluded: new Set(destination.excluded) });
            }
        });
        for ( const child of children.get(source) ) {
            visit(child, partyScopes, scope);
        }
    };
    visit('*', [], []);
    return { rules: output, provenance, deferredCells };
}
