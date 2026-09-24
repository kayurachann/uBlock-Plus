/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

// Build-time only, no import: also used by tools/validate-mv3.mjs.
//
// A regexFilter in a static ruleset which RE2 rejects as a syntax error makes
// Chrome refuse to load the whole unpacked extension, even when the ruleset
// is disabled. Chrome's isRegexSupported() verdicts come from one Chrome
// version, while the package must load in every supported one (130+), so
// every static regex must also be inside a conservative subset of RE2 syntax
// which all of them accept.
//
// re2PortableReason(regex) returns '' for a regex inside that subset, else a
// short reason. It never returns '' for a regex RE2 rejects as a syntax
// error; it may reject some valid RE2, which is then counted as unsupported.
// It does not predict RE2's program size limit (memoryLimitExceeded): Chrome
// skips such a rule silently instead of failing the load.

const MAX_REPEAT = 1000;            // RE2 kMaxRepeat
const MAX_NESTING = 100;            // far below RE2's nesting limit of 1000
const MAX_LENGTH = 4096;

// Letter escapes RE2 accepts inside and outside classes. Escaped ASCII
// punctuation (and `_`) is always a literal.
const letterEscapes = new Set([
    'a', 'f', 't', 'n', 'r', 'v',
    'd', 'D', 's', 'S', 'w', 'W',
]);
// Empty-width assertions, outside classes only.
const assertionEscapes = new Set([ 'b', 'B', 'A', 'z' ]);
// Classes which cannot end a range: RE2 rejects `[a-\d]`, JS accepts it.
const classEscapes = new Set([ 'd', 'D', 's', 'S', 'w', 'W' ]);
const posixClassNames = new Set([
    'alnum', 'alpha', 'ascii', 'blank', 'cntrl', 'digit', 'graph',
    'lower', 'print', 'punct', 'space', 'upper', 'word', 'xdigit',
]);

const reRepeat = /^\{(\d+)(?:,(\d*))?\}/;
const reGroupFlags = /^([ims]*(?:-[ims]+)?)(:|\))/;
const reHexDigits2 = /^[0-9A-Fa-f]{2}$/;

// Parses the escape at `i` (a backslash). Returns [ reason, next index,
// kind ], where kind is 'class' for \d \s \w and their negations, 'assert'
// for an empty-width assertion, else 'char'.
function parseEscape(re, i, inClass) {
    const c = re[i + 1];
    if ( c === undefined ) { return [ 'trailing-backslash' ]; }
    // `\1` is a backreference, `\0` and `\12` octal, `\8` an error: RE2 and
    // JS disagree on all of them.
    if ( c >= '0' && c <= '9' ) { return [ 'backreference-or-octal' ]; }
    if ( c === 'x' ) {
        // `\x{...}` depends on RE2's encoding mode; JS reads it as literals.
        if ( reHexDigits2.test(re.slice(i + 2, i + 4)) === false ) {
            return [ 'bad-hex-escape' ];
        }
        return [ '', i + 4, 'char' ];
    }
    if ( (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ) {
        if ( letterEscapes.has(c) ) {
            return [ '', i + 2, classEscapes.has(c) ? 'class' : 'char' ];
        }
        if ( inClass === false && assertionEscapes.has(c) ) {
            return [ '', i + 2, 'assert' ];
        }
        // \k \p \P \u \c \Q \C \Z \G \e ... and \b in a class
        return [ 'unsupported-escape' ];
    }
    if ( c.charCodeAt(0) > 0x7F ) { return [ 'unsupported-escape' ]; }
    return [ '', i + 2, 'char' ];
}

// Parses the class starting at `i` (an opening bracket), the way RE2 does:
// a `]` right after `[` or `[^` is a literal. Returns [ reason, index of the
// closing bracket ].
function parseClass(re, i) {
    let j = i + 1;
    if ( re[j] === '^' ) { j += 1; }
    if ( re[j] === ']' ) { j += 1; }
    // Whether the previous item can start a range, and whether a `-` just
    // made the next item the end of a range.
    let rangeable = false;
    let rangeEnd = false;
    while ( j < re.length ) {
        const c = re[j];
        if ( c === ']' ) {
            return [ '', j ];
        }
        if ( c === '[' && re[j + 1] === ':' && rangeEnd === false ) {
            // RE2 takes everything up to the next `:]` as a POSIX class
            // name, and rejects an unknown one; without `:]`, `[` is a
            // literal.
            const end = re.indexOf(':]', j + 2);
            if ( end !== -1 ) {
                let name = re.slice(j + 2, end);
                if ( name.startsWith('^') ) { name = name.slice(1); }
                if ( posixClassNames.has(name) === false ) {
                    return [ 'bad-posix-class' ];
                }
                j = end + 2;
                rangeable = false;
                continue;
            }
        }
        let kind = 'char';
        let next = j + 1;
        if ( c === '\\' ) {
            const [ reason, after, escapeKind ] = parseEscape(re, j, true);
            if ( reason !== '' ) { return [ reason ]; }
            kind = escapeKind;
            next = after;
        }
        if ( rangeEnd ) {
            if ( kind !== 'char' ) { return [ 'bad-class-range' ]; }
            rangeEnd = false;
            rangeable = false;
            j = next;
            continue;
        }
        if ( c === '-' && rangeable && re[j + 1] !== ']' && j + 1 < re.length ) {
            rangeEnd = true;
            j = next;
            continue;
        }
        rangeable = kind === 'char';
        j = next;
    }
    return [ 'unterminated-class' ];
}

export function re2PortableReason(re) {
    if ( typeof re !== 'string' || re === '' ) { return 'empty'; }
    if ( re.length > MAX_LENGTH ) { return 'too-long'; }
    // DNR matches ASCII URLs; non-ASCII literals are also read differently
    // depending on RE2's encoding mode.
    if ( /^[\x00-\x7F]*$/.test(re) === false ) { return 'non-ascii'; }
    try {
        new RegExp(re);
    } catch {
        return 'invalid-js-syntax';
    }
    // Counted repetitions: RE2 rejects a count above 1000, and a product
    // of nested counts above 1000 (RepetitionWalker; an unbounded repeat
    // counts its minimum, a zero count does not count). Each open group
    // tracks the largest product found inside it.
    const stack = [ { inner: 1 } ];
    // What a quantifier would apply to: 'atom', 'group' (then groupInner is
    // the product inside it), 'assert', or '' (nothing, or a quantifier).
    let last = '';
    let groupInner = 1;
    for ( let i = 0; i < re.length; ) {
        const c = re[i];
        if ( c === '\\' ) {
            const [ reason, next, kind ] = parseEscape(re, i, false);
            if ( reason !== '' ) { return reason; }
            last = kind === 'assert' ? 'assert' : 'atom';
            i = next;
            continue;
        }
        if ( c === '[' ) {
            const [ reason, end ] = parseClass(re, i);
            if ( reason !== '' ) { return reason; }
            last = 'atom';
            i = end + 1;
            continue;
        }
        if ( c === '(' ) {
            let next = i + 1;
            if ( re[next] === '?' ) {
                const rest = re.slice(next + 1);
                if ( /^<?[=!]/.test(rest) ) { return 'lookaround'; }
                if ( rest.startsWith('>') ) { return 'atomic-group'; }
                // RE2 before 2023 (Chrome up to 152) rejects `(?<name>`
                if ( rest.startsWith('<') ) { return 'named-group'; }
                const match = reGroupFlags.exec(rest);
                if ( match === null ) { return 'unsupported-group'; }
                next += 1 + match[0].length;
                if ( match[2] === ')' ) {
                    // Flags for the rest of the group, e.g. `(?i)`
                    last = '';
                    i = next;
                    continue;
                }
            }
            stack.push({ inner: 1 });
            if ( stack.length - 1 > MAX_NESTING ) { return 'nesting-too-deep'; }
            last = '';
            i = next;
            continue;
        }
        if ( c === ')' ) {
            if ( stack.length === 1 ) { return 'unbalanced'; }
            const group = stack.pop();
            const top = stack[stack.length - 1];
            top.inner = Math.max(top.inner, group.inner);
            last = 'group';
            groupInner = group.inner;
            i += 1;
            continue;
        }
        if ( c === '{' ) {
            const match = reRepeat.exec(re.slice(i));
            if ( match === null ) {
                last = 'atom';          // a literal `{`
                i += 1;
                continue;
            }
            if ( last === '' || last === 'assert' ) { return 'bad-repeat'; }
            const lo = parseInt(match[1], 10);
            const hi = match[2] === undefined || match[2] === ''
                ? lo
                : parseInt(match[2], 10);
            if ( lo > MAX_REPEAT || hi > MAX_REPEAT ) {
                return 'repeat-too-large';
            }
            if ( hi < lo ) { return 'bad-repeat'; }
            const top = stack[stack.length - 1];
            const product = Math.max(hi, 1) *
                (last === 'group' ? groupInner : 1);
            if ( product > MAX_REPEAT ) { return 'nested-repeat-too-large'; }
            top.inner = Math.max(top.inner, product);
            i += match[0].length;
            if ( re[i] === '+' ) { return 'possessive'; }
            if ( re[i] === '?' ) { i += 1; }
            last = '';
            continue;
        }
        if ( c === '*' || c === '+' || c === '?' ) {
            if ( last === '' || last === 'assert' ) { return 'bad-repeat'; }
            i += 1;
            if ( re[i] === '+' ) { return 'possessive'; }
            if ( re[i] === '?' ) { i += 1; }
            last = '';
            continue;
        }
        if ( c === '|' ) {
            last = '';
        } else if ( c === '^' || c === '$' ) {
            last = 'assert';
        } else {
            last = 'atom';
        }
        i += 1;
    }
    if ( stack.length !== 1 ) { return 'unbalanced'; }
    return '';
}
