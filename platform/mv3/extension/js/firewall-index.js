/*******************************************************************************
    uBlock Plus+ - bounded dynamic-firewall lookup index
    Copyright (C) 2026-present uBlock Plus+ contributors
    GPL-3.0-or-later; hostname walking follows full uBlock Origin's
    src/js/dynamic-net-filtering.js. No request/result cache is retained.
******************************************************************************/

// Rules are the canonical cells returned by parseFirewall. Copy their scalar
// fields so a caller cannot alter an active snapshot through its draft array.
export function createFirewallIndex(rules) {
    if ( Array.isArray(rules) === false || rules.length > 256 ) {
        throw new Error('At most 256 parsed firewall cells are supported');
    }
    const destinations = new Map();
    const types = new Map();
    for ( const input of rules ) {
        const rule = Object.freeze({
            source: input.source, destination: input.destination,
            type: input.type, action: input.action, raw: input.raw,
        });
        const table = rule.destination === '*' ? types : destinations;
        const key = rule.destination === '*' ? rule.type : rule.destination;
        let sources = table.get(key);
        if ( sources === undefined ) {
            sources = new Map();
            table.set(key, sources);
        }
        if ( sources.has(rule.source) ) {
            throw new Error('Duplicate parsed firewall cell');
        }
        sources.set(rule.source, rule);
    }

    const lookupSource = (sources, source) => {
        if ( sources === undefined ) { return; }
        let scope = source;
        for (;;) {
            const found = sources.get(scope);
            if ( found !== undefined ) { return found; }
            const dot = scope.indexOf('.');
            if ( dot === -1 ) { break; }
            scope = scope.slice(dot + 1);
        }
        return sources.get('*');
    };

    const evaluate = (source, destination, type, thirdParty) => {
        // Destination scope always precedes source scope. A returned noop is
        // terminal just like block/allow; callers decide how to enforce it.
        if ( destinations.size !== 0 ) {
            let scope = destination;
            for (;;) {
                const found = lookupSource(destinations.get(scope), source);
                if ( found !== undefined ) { return found; }
                const dot = scope.indexOf('.');
                if ( dot === -1 ) { break; }
                scope = scope.slice(dot + 1);
            }
        }
        if ( types.size === 0 ) { return; }
        let found;
        if ( thirdParty ) {
            if ( type === 'script' ) {
                found = lookupSource(types.get('3p-script'), source);
            } else if ( type === 'sub_frame' || type === 'object' ) {
                found = lookupSource(types.get('3p-frame'), source);
            }
            if ( found !== undefined ) { return found; }
            found = lookupSource(types.get('3p'), source);
        } else if ( type === 'script' ) {
            found = lookupSource(types.get('1p-script'), source);
        }
        if ( found !== undefined ) { return found; }
        if ( type === 'image' ) {
            found = lookupSource(types.get('image'), source);
            if ( found !== undefined ) { return found; }
        }
        return lookupSource(types.get('*'), source);
    };

    // Neither the private maps nor a mutation method escape this factory.
    return Object.freeze({ ruleCount: rules.length, evaluate });
}
