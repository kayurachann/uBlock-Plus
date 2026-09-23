/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import { literalStrFromRegex } from './regex-analyzer.js';

/******************************************************************************/

// Regex hostnames of scriptlet filters are tested in page frames at
// document_start, before any page script runs, against the frame hostname
// and each of its parent domains. Exception regexes are shared with every
// scriptlet source. JavaScript regexps backtrack, so a nested quantifier
// such as /^((.+)+)+x$/ can freeze a page for minutes, and so can a run of
// individually cheap parts such as /^.?.?.?…x$/.
//
// A pattern is therefore accepted only when a static bound on its matching
// steps for one hostname of up to 253 characters stays small. Every part of
// a sequence runs once for each backtracking path reaching it; a part which
// can match in several ways multiplies the paths after it, and so does each
// start position of an unanchored pattern. A quantified character followed
// by a character it cannot match can only stop in one place: it scans, but
// does not branch. Exponential forms are always rejected.
const MAX_REGEX_LENGTH = 256;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_REGEX_COST = 2 ** 18;
// Every regex kept from imported lists runs in each matching frame, so
// their number and total cost are bounded as well.
const MAX_UNTRUSTED_REGEXES = 256;
const MAX_UNTRUSTED_REGEX_COST = 2 ** 20;
// Frame hostnames are printable ASCII: Chrome converts IDNs to punycode.
const HOSTNAME_CHARACTERS = Array.from(
    { length: 0x7E - 0x21 + 1 },
    (_, i) => String.fromCharCode(0x21 + i)
);

const escapeOperands = new Map([
    [ 'x', /^[0-9A-Fa-f]{2}/ ],
    [ 'u', /^[0-9A-Fa-f]{4}/ ],
    [ 'c', /^[A-Za-z]/ ],
    [ '0', /^[0-7]{0,2}/ ],
]);

function hostnameRegexSource(hostname) {
    const pattern = hostname.endsWith('>>') ? hostname.slice(0, -2) : hostname;
    if ( pattern.length < 3 ) { return; }
    if ( pattern.startsWith('/') === false || pattern.endsWith('/') === false ) {
        return;
    }
    return pattern.slice(1, -1);
}

const hostnameCharactersCache = new Map();

function hostnameCharactersOf(source) {
    if ( hostnameCharactersCache.has(source) ) {
        return hostnameCharactersCache.get(source);
    }
    let chars = null;
    try {
        const re = new RegExp(`^(?:${source})$`);
        chars = HOSTNAME_CHARACTERS.map(c => re.test(c));
    } catch {
    }
    hostnameCharactersCache.set(source, chars);
    return chars;
}

// Splits a valid pattern into atoms, assertions, groups, alternations and
// quantifiers. A `single` atom matches one character of a known set. Returns
// undefined for a backreference, which can backtrack exponentially.
function tokenizeRegex(source) {
    const tokens = [];
    const single = source => {
        const chars = hostnameCharactersOf(source);
        return { kind: 'atom', single: chars !== null, source, chars };
    };
    for ( let i = 0; i < source.length; i++ ) {
        const char = source[i];
        if ( char === '\\' ) {
            const next = source[i+1];
            if ( /[1-9k]/.test(next) ) { return; }
            if ( next === 'b' || next === 'B' ) {
                tokens.push({ kind: 'assertion', source: `\\${next}` });
            } else if ( /[dDwWsS]|[^0-9A-Za-z]/.test(next) ) {
                tokens.push(single(`\\${next}`));
            } else {
                // \xHH, \uHHHH, \cX, legacy octal and control escapes are
                // consumed whole but never used to prove a guard.
                const operand = escapeOperands.get(next)?.exec(source.slice(i+2));
                tokens.push({ kind: 'atom', single: false });
                i += operand ? operand[0].length : 0;
            }
            i += 1;
        } else if ( char === '[' ) {
            const start = i;
            for ( i += 1; i < source.length && source[i] !== ']'; i++ ) {
                if ( source[i] === '\\' ) { i += 1; }
            }
            tokens.push(single(source.slice(start, i + 1)));
        } else if ( char === '(' ) {
            let lookaround = false;
            let lookbehind = false;
            if ( source[i+1] === '?' ) {
                const named = /^\?<(?![=!])[^>]*>/.exec(source.slice(i+1));
                if ( named !== null ) {
                    i += named[0].length;
                } else {
                    lookbehind = source[i+2] === '<';
                    lookaround = lookbehind || source[i+2] === '=' || source[i+2] === '!';
                    i += lookbehind ? 3 : 2;
                }
            }
            tokens.push({ kind: 'open', lookaround, lookbehind });
        } else if ( char === ')' ) {
            tokens.push({ kind: 'close' });
        } else if ( char === '|' ) {
            tokens.push({ kind: 'alternation' });
        } else if ( char === '^' || char === '$' ) {
            tokens.push({ kind: 'assertion', source: char });
        } else if ( char === '*' || char === '+' || char === '?' || char === '{' ) {
            let min = char === '+' ? 1 : 0;
            let max = char === '?' ? 1 : Number.POSITIVE_INFINITY;
            if ( char === '{' ) {
                const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
                if ( match === null ) {
                    tokens.push(single('\\{'));
                    continue;
                }
                min = Number(match[1]);
                max = match[2] === undefined
                    ? min
                    : match[3] === '' ? Number.POSITIVE_INFINITY : Number(match[3]);
                i += match[0].length - 1;
            }
            if ( source[i+1] === '?' ) { i += 1; }
            tokens.push({ kind: 'quantifier', min, max });
        } else {
            tokens.push(single(char));
        }
    }
    return tokens;
}

function mayMatchSameCharacter(a, b) {
    if ( a?.single !== true || b?.single !== true ) { return true; }
    return a.chars.some((matches, i) => matches && b.chars[i]);
}

// The quantifier at `at` repeats one character and is followed by a
// mandatory character it cannot match, by `$` or by the end of the pattern.
// Nothing is proven for a part matched backward, inside a lookbehind.
function isGuardedQuantifier(tokens, at, depth, backward) {
    if ( backward ) { return false; }
    const next = tokens[at+1];
    if ( next === undefined ) { return depth === 0; }
    if ( next.kind === 'assertion' ) { return next.source === '$'; }
    if ( next.kind !== 'atom' ) { return false; }
    const after = tokens[at+2];
    if ( after?.kind === 'quantifier' && after.min === 0 ) { return false; }
    return mayMatchSameCharacter(tokens[at-1], next) === false;
}

// Returns { cost, paths } per incoming path for the alternatives starting
// at tokens[state.i], or undefined when the pattern is unsafe.
function alternativesCost(tokens, state, depth, backward) {
    let cost = 0;
    let paths = 0;
    for (;;) {
        const sequence = sequenceCost(tokens, state, depth, backward);
        if ( sequence === undefined ) { return; }
        cost += sequence.cost;
        paths += sequence.paths;
        if ( tokens[state.i]?.kind !== 'alternation' ) { break; }
        state.i += 1;
        state.alternatives += depth === 0 ? 1 : 0;
    }
    return { cost, paths };
}

function sequenceCost(tokens, state, depth, backward) {
    const parts = [];
    while ( state.i < tokens.length ) {
        const token = tokens[state.i];
        if ( token.kind === 'alternation' || token.kind === 'close' ) { break; }
        state.i += 1;
        let part = { cost: 1, paths: 1 };
        if ( token.kind === 'open' ) {
            // Lookbehinds match backward, lookaheads forward.
            const inner = alternativesCost(
                tokens, state, depth + 1,
                token.lookaround ? token.lookbehind : backward
            );
            if ( inner === undefined ) { return; }
            state.i += 1;
            // A lookaround is atomic: what follows never resumes it.
            part = { cost: inner.cost, paths: token.lookaround ? 1 : inner.paths };
        }
        const quantifier = tokens[state.i];
        if ( quantifier?.kind === 'quantifier' ) {
            const { min, max } = quantifier;
            const scan = Math.min(max, MAX_HOSTNAME_LENGTH);
            const choices = Math.min(max - min, MAX_HOSTNAME_LENGTH) + 1;
            if ( token.kind === 'open' ) {
                if ( max <= 1 ) {
                    if ( min === 0 ) {
                        part = { cost: part.cost + 1, paths: part.paths + 1 };
                    }
                } else if ( part.paths > 1 ) {
                    // Repeating a group which can match in several ways can
                    // backtrack exponentially.
                    return;
                } else {
                    part = { cost: scan * part.cost, paths: choices };
                }
            } else if ( choices === 1 ||
                isGuardedQuantifier(tokens, state.i, depth, backward) ) {
                part = { cost: 2 * scan, paths: 1 };
            } else {
                part = { cost: scan, paths: choices };
            }
            state.i += 1;
        }
        parts.push(part);
    }
    if ( backward ) { parts.reverse(); }
    let cost = 0;
    let paths = 1;
    for ( const part of parts ) {
        cost += paths * Math.max(part.cost, 1);
        paths *= part.paths;
        if ( cost > MAX_REGEX_COST ) { return; }
    }
    return { cost, paths };
}

// Returns the estimated worst-case number of matching steps for one
// hostname, or undefined when the pattern is unsafe.
export function hostnameRegexCost(source) {
    if ( source.length > MAX_REGEX_LENGTH ) { return; }
    try {
        new RegExp(source);
    } catch {
        return;
    }
    const tokens = tokenizeRegex(source);
    if ( tokens === undefined ) { return; }
    const state = { i: 0, alternatives: 1 };
    const pattern = alternativesCost(tokens, state, 0, false);
    if ( pattern === undefined ) { return; }
    let total = pattern.cost;
    // A top-level alternative is not covered by a leading ^.
    if ( tokens[0]?.source !== '^' || state.alternatives !== 1 ) {
        // Every start position runs the leading characters, but only those
        // where they all match run the rest. Two such positions are at
        // least `period` characters apart.
        let prefix = 0;
        if ( state.alternatives === 1 ) {
            while ( tokens[prefix]?.single &&
                tokens[prefix+1]?.kind !== 'quantifier' ) {
                prefix += 1;
            }
        }
        let period = 1;
        while ( period < prefix ) {
            let overlaps = true;
            for ( let i = 0; i + period < prefix && overlaps; i++ ) {
                overlaps = mayMatchSameCharacter(tokens[i], tokens[i + period]);
            }
            if ( overlaps ) { break; }
            period += 1;
        }
        const starts = MAX_HOSTNAME_LENGTH + 1;
        const matchingStarts = prefix === 0
            ? starts
            : Math.floor(Math.max(MAX_HOSTNAME_LENGTH - prefix, 0) / period) + 1;
        total = starts * prefix + matchingStarts * (pattern.cost - prefix);
    }
    return total <= MAX_REGEX_COST ? total : undefined;
}

export function isSafeHostnameRegex(source) {
    return hostnameRegexCost(source) !== undefined;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Imported lists are untrusted. An unsafe regex never reaches a page, and
// neither does one past the total budget:
// - a positive scope is dropped, which only narrows what scriptlets do;
// - an exception scope becomes a superset which is cheap to test, a regex
//   for a literal every original match must contain, or `*` when there is
//   none. An exception is never lost; at worst it applies more broadly.
// Returns the rejected patterns so the caller can report them.
export function sanitizeUntrustedScriptletDetails(details) {
    const rejected = new Set();
    if ( details instanceof Map === false ) { return []; }
    let kept = 0;
    let spent = 0;
    const keep = source => {
        const cost = hostnameRegexCost(source);
        if ( cost === undefined ) { return false; }
        if ( kept >= MAX_UNTRUSTED_REGEXES ) { return false; }
        if ( spent + cost > MAX_UNTRUSTED_REGEX_COST ) { return false; }
        kept += 1;
        spent += cost;
        return true;
    };
    const isRejected = hostname => {
        const source = hostnameRegexSource(hostname);
        if ( source === undefined || keep(source) ) { return false; }
        rejected.add(hostname);
        return true;
    };
    for ( const entry of details.values() ) {
        if ( Array.isArray(entry.matches) ) {
            entry.matches = entry.matches.filter(hn => isRejected(hn) === false);
        }
        if ( Array.isArray(entry.excludeMatches) ) {
            entry.excludeMatches = entry.excludeMatches.map(hn => {
                if ( isRejected(hn) === false ) { return hn; }
                const source = hostnameRegexSource(hn);
                const literal = source.length <= MAX_REGEX_LENGTH
                    ? literalStrFromRegex(source)
                    : '';
                // The superset is held to the same budget, so sanitizing
                // sanitized data again keeps it as is.
                const widened = escapeRegex(literal);
                if ( literal === '' || keep(widened) === false ) { return '*'; }
                const suffix = hn.endsWith('>>') ? '>>' : '';
                return `/${widened}/${suffix}`;
            });
        }
    }
    return Array.from(rejected);
}

/******************************************************************************/
