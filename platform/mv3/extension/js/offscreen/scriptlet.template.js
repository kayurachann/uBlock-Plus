/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2014-present Raymond Hill
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

// ruleset: $rulesetId$

// Important!
// Isolate from global scope

// Start of local scope
(function uBlockPlus_scriptlets() {

/******************************************************************************/

self.$scriptletCode$

/******************************************************************************/

const scriptletGlobals = {}; // eslint-disable-line

const $hasHostnames$ = self.$hasHostnames$;
const $hasEntities$ = self.$hasEntities$;
const $hasAncestors$ = self.$hasAncestors$;
const $hasRegexes$ = self.$hasRegexes$;
const sharedExceptions = /* $scriptletExceptionData$ */ null;

/******************************************************************************/

const entries = (( ) => {
    const docloc = document.location;
    const origins = [ docloc.origin ];
    if ( docloc.ancestorOrigins ) {
        origins.push(...docloc.ancestorOrigins);
    }
    return origins.map((origin, i) => {
        let hn2;
        try { hn2 = new URL(origin).hostname; }
        catch { return; }
        if ( hn2.length === 0 ) { return; }
        const hns = [ hn2 ];
        for ( let pos = 0; ; ) {
            pos = hn2.indexOf('.', pos) + 1;
            if ( pos === 0 ) { break; }
            hns.push(hn2.slice(pos));
        }
        hns.push('*');
        const ens = [];
        if ( $hasEntities$ ) {
            for ( let hn of hns ) {
                for (;;) {
                    const pos = hn.lastIndexOf('.');
                    if ( pos === -1 ) { break; }
                    hn = hn.slice(0, pos);
                    ens.push(`${hn}.*`);
                }
            }
            ens.sort((a, b) => {
                const d = b.length - a.length;
                if ( d !== 0 ) { return d; }
                return a > b ? -1 : 1;
            });
        }
        return { hns, ens, i };
    }).filter(a => a);
})();
if ( entries.length === 0 ) { return; }

// The worker binds this JSON before registration, so exceptions are available
// synchronously at document_start in both worlds. No page-owned event bridge,
// remote executable code, or asynchronous race with the page is involved.
const isSharedException = (() => {
    if ( sharedExceptions === null ) { return () => false; }
    const current = entries[0].hns[0];
    const domainMatches = (hn, hostname) => hn === '*' || hn === 'all-urls' ||
        hn === hostname || hostname.endsWith(`.${hn}`);
    const advanced = sharedExceptions.advanced;
    const advancedEnabled = advanced.included.some(hn => domainMatches(hn, current)) &&
        advanced.excluded.some(hn => domainMatches(hn, current)) === false;
    const hostnameMatches = pattern => {
        const ancestor = pattern.endsWith('>>');
        if ( ancestor ) { pattern = pattern.slice(0, -2); }
        const candidates = ancestor ? entries.slice(1) : entries.slice(0, 1);
        return candidates.some(entry => {
            if ( pattern.startsWith('/') && pattern.endsWith('/') ) {
                try {
                    const re = new RegExp(pattern.slice(1, -1));
                    return entry.hns.some(hn => re.test(hn));
                } catch { return true; }
            }
            if ( pattern.endsWith('.*') ) {
                const entity = pattern.slice(0, -2);
                return entry.hns.some(hn => hn.startsWith(`${entity}.`));
            }
            // Unsupported path predicates defer execution, preserving an
            // exception instead of guessing that it does not match.
            if ( pattern.includes('/') ) { return true; }
            return domainMatches(pattern, entry.hns[0]);
        });
    };
    const exceptions = sharedExceptions.exceptions.filter(entry =>
        (entry.source === 'sandbox' || advancedEnabled) &&
        entry.hostnames.some(hostnameMatches)
    );
    const broad = exceptions.some(entry => entry.args.length === 0);
    const exact = new Set(exceptions.map(entry => JSON.stringify(entry.args)));
    return args => broad || exact.has(JSON.stringify(args));
})();

const todo = new Set();

if ( $hasHostnames$ ) {
    const $scriptletHostnames$ = self.$scriptletHostnames$;
    const collectArglistRefIndices = (out, hn, r) => {
        let l = 0, i = 0, d = 0;
        let candidate = '';
        while ( l < r ) {
            i = l + r >>> 1;
            candidate = $scriptletHostnames$[i];
            d = hn.length - candidate.length;
            if ( d === 0 ) {
                if ( hn === candidate ) {
                    out.add(i); break;
                }
                d = hn < candidate ? -1 : 1;
            }
            if ( d < 0 ) {
                r = i;
            } else {
                l = i + 1;
            }
        }
        return i + 1;
    };
    const indicesFromHostname = (out, hnDetails, suffix = '') => {
        if ( hnDetails.hns.length === 0 ) { return; }
        let r = $scriptletHostnames$.length;
        for ( const hn of hnDetails.hns ) {
            r = collectArglistRefIndices(out, `${hn}${suffix}`, r);
        }
        if ( $hasEntities$ ) {
            let r = $scriptletHostnames$.length;
            for ( const en of hnDetails.ens ) {
                r = collectArglistRefIndices(out, `${en}${suffix}`, r);
            }
        }
    };
    const todoIndices = new Set();
    indicesFromHostname(todoIndices, entries[0]);
    if ( $hasAncestors$ ) {
        for ( const entry of entries ) {
            if ( entry.i === 0 ) { continue; }
            indicesFromHostname(todoIndices, entry, '>>');
        }
    }
    // Collect arglist references
    if ( todoIndices.size ) {
        const $scriptletArglistRefs$ = self.$scriptletArglistRefs$;
        const arglistRefs = $scriptletArglistRefs$.split(';');
        for ( const i of todoIndices ) {
            for ( const ref of JSON.parse(`[${arglistRefs[i]}]`) ) {
                todo.add(ref);
            }
        }
    }
}

if ( $hasRegexes$ ) {
    const $scriptletFromRegexes$ = self.$scriptletFromRegexes$;
    const { hns } = entries[0];
    for ( let i = 0, n = $scriptletFromRegexes$.length; i < n; i += 3 ) {
        const needle = $scriptletFromRegexes$[i+0];
        let regex;
        for ( const hn of hns ) {
            if ( hn.includes(needle) === false ) { continue; }
            if ( regex === undefined ) {
                regex = new RegExp($scriptletFromRegexes$[i+1]);
            }
            if ( regex.test(hn) === false ) { continue; }
            for ( const ref of JSON.parse(`[${$scriptletFromRegexes$[i+2]}]`) ) {
                todo.add(ref);
            }
        }
    }
}

// Execute scriptlets
if ( todo.size && todo.has(0) === false ) {
    const $scriptletFunctions$ = self.$scriptletFunctions$;
    const $scriptletArgs$ = self.$scriptletArgs$;
    const $scriptletArglists$ = self.$scriptletArglists$;
    const arglists = $scriptletArglists$.split(';');
    const args = $scriptletArgs$;
    const tokens = self.$scriptletTokens$;
    for ( const ref of todo ) {
        if ( ref < 0 ) { continue; }
        if ( todo.has(~ref) ) { continue; }
        const arglist = JSON.parse(`[${arglists[ref]}]`);
        const fn = $scriptletFunctions$[arglist[0]];
        const values = arglist.slice(1).map(a => args[a]);
        if ( isSharedException([ tokens[arglist[0]], ...values ]) ) { continue; }
        try { fn(...values); }
        catch { }
    }
}

/******************************************************************************/

// End of local scope
})();

void 0;
