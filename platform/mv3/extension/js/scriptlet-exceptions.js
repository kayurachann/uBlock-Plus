/* uBlock Plus+ — shared, data-only scriptlet exceptions. GPL-3.0-or-later. */

export const SCRIPTLET_EXCEPTION_SLOT = '/* $scriptletExceptionData$ */ null';
export const SCRIPTLET_WARNINGS_KEY = 'scriptletExceptions.warnings';

export function bindScriptletExceptions(code, payload) {
    if ( typeof code !== 'string' || code.includes(SCRIPTLET_EXCEPTION_SLOT) === false ) {
        throw new Error('Scriptlet code requires recompilation for shared exceptions');
    }
    // Callback replacement prevents $&, quotes, or script text in arguments
    // from becoming replacement syntax. The inserted value is JSON data.
    return code.replace(SCRIPTLET_EXCEPTION_SLOT, () => JSON.stringify(payload));
}

export function collectScriptletExceptions(sources) {
    const entries = [];
    for ( const [ source, exceptions ] of sources ) {
        for ( const entry of exceptions || [] ) {
            if ( Array.isArray(entry.args) === false ||
                entry.args.some(arg => typeof arg !== 'string') ||
                Array.isArray(entry.hostnames) === false ||
                entry.hostnames.some(hn => typeof hn !== 'string') ) {
                throw new Error('Invalid compiled scriptlet exception data');
            }
            entries.push({ source, args: entry.args, hostnames: entry.hostnames });
        }
    }
    return entries;
}

export function scriptletExceptionPayload(exceptions, modes) {
    return {
        exceptions,
        advanced: {
            included: [ ...modes.optimal, ...modes.complete ],
            excluded: [ ...modes.none, ...modes.basic ].filter(hn => hn !== 'all-urls'),
        },
    };
}

// Native registered scripts cannot receive dynamic JSON. When userScripts is
// unavailable, exclude only files with a matching invocation and only the
// exception's host scope. A regex/entity/ancestor needs a wider exclusion to
// preserve the exception; it must never be silently dropped.
export function nativeScriptletExclusions(rulesetId, tokens, exceptions) {
    const tokenSet = new Set(tokens);
    const hostnames = new Set();
    for ( const entry of exceptions ) {
        if ( entry.source === rulesetId ) { continue; }
        if ( entry.args.length !== 0 && tokenSet.has(JSON.stringify(entry.args)) === false ) {
            continue;
        }
        for ( const hostname of entry.hostnames ) {
            if ( hostname === '*' || hostname.includes('/') ||
                hostname.endsWith('.*') || hostname.endsWith('>>') ) {
                return [ '*' ];
            }
            hostnames.add(hostname);
        }
    }
    return Array.from(hostnames);
}
