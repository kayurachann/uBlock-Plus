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

import { i18n$ } from './i18n.js';
import { normalizeModeHostname } from './backup-schema.js';
import punycode from './punycode.js';

/******************************************************************************/

function selectParser(scope, modes, node) {
    const parser = perScopeParsers[scope.join('.')];
    if ( parser === undefined ) { return false; }
    return parser(scope, modes, node);
}

const validModes = [
    'none',
    'basic',
    'optimal',
    'complete',
];

const uglyModeNames = {
    [i18n$('filteringMode0Name')]: 'none',
    [i18n$('filteringMode1Name')]: 'basic',
    [i18n$('filteringMode2Name')]: 'optimal',
    [i18n$('filteringMode3Name')]: 'complete',
};

const prettyModeNames = {
    none: i18n$('filteringMode0Name'),
    basic: i18n$('filteringMode1Name'),
    optimal: i18n$('filteringMode2Name'),
    complete: i18n$('filteringMode3Name'),
};

const perScopeParsers = {
    '': function(scope, modes, node) {
        const { key, val } = node;
        switch ( key ) {
        case 'none':
        case 'basic':
        case 'optimal':
        case 'complete':
        case prettyModeNames.none:
        case prettyModeNames.basic:
        case prettyModeNames.optimal:
        case prettyModeNames.complete: {
            const mode = uglyModeNames[key] || key;
            if ( val !== undefined ) { return false; }
            modes[mode] ||= [];
            scope.push(mode);
            break;
        }
        default:
            return false;
        }
        return true;
    },
    none: function(scope, modes, node) {
        return addHostnameToMode(modes, 'none', node)
    },
    basic: function(scope, modes, node) {
        return addHostnameToMode(modes, 'basic', node)
    },
    optimal: function(scope, modes, node) {
        return addHostnameToMode(modes, 'optimal', node)
    },
    complete: function(scope, modes, node) {
        return addHostnameToMode(modes, 'complete', node)
    },
};

const addHostnameToMode = (modes, mode, node) => {
    if ( node.list !== true ) { return node.val === '-'; }
    if ( node.key !== undefined ) { return false; }
    if ( node.val === undefined ) { return false; }
    // The editor inserts an empty list marker after Enter. It is an editing
    // placeholder, just like a bare dash, and does not define a site scope.
    if ( node.val === '' ) { return true; }
    try {
        node.hostname = normalizeModeHostname(node.val);
    } catch {
        return false;
    }
    modes[mode].push(node.hostname);
    return true;
};

/******************************************************************************/

function depthFromIndent(line) {
    const match = /^\s*/.exec(line);
    const count = match[0].length;
    if ( (count & 1) !== 0 ) { return -1; }
    return count / 2;
}

/******************************************************************************/

function nodeFromLine(line) {
    // A list value is a hostname, including bracketed IPv6 literals. Its
    // colons must not be interpreted as keys in the surrounding mode syntax.
    const list = /^\s*- (.*)$/.exec(line);
    if ( list !== null ) { return { list: true, val: list[1].trim() }; }
    const match = reNodeParser.exec(line);
    const out = {};
    if ( match === null ) { return out; }
    if ( match[1] ) {
        out.list = true;
    }
    if ( match[4] ) {
        out.val = match[4].trim();
    } else if ( match[3] ) {
        out.key = match[2];
        out.val = match[3].trim();
        if ( out.val === "''" ) { out.val = '' };
    } else {
        out.key = match[2];
    }
    return out;
}

const reNodeParser = /^\s*(- )?(?:([^:]+):( \S.*)?|(\S.*))$/;

/******************************************************************************/

export function modesFromText(text, justbad = false) {
    const lines = [ ...text.split(/\n\r|\r\n|\n|\r/) ];
    const indices = [];
    for ( let i = 0; i < lines.length; i++ ) {
        const line = lines[i].trimEnd();
        if ( line.trim() === '' || line.trim().startsWith('#') ) { continue; }
        indices.push(i);
    }
    // Parse
    const modes = Object.fromEntries(validModes.map(mode => [ mode, [] ]));
    const bad = [];
    const scope = [];
    const seen = new Map();
    for ( const i of indices ) {
        const line = lines[i];
        const depth = depthFromIndent(line);
        if ( depth < 0 || depth > 1 ) {
            bad.push(i);
            continue;
        }
        scope.length = depth;
        const node = nodeFromLine(line);
        const result = selectParser(scope, modes, node);
        if ( result === false ) {
            bad.push(i);
        } else if ( node.hostname !== undefined ) {
            if ( seen.has(node.hostname) ) {
                bad.push(seen.get(node.hostname), i);
            }
            seen.set(node.hostname, i);
        }
    }
    // Never infer a more restrictive default or discard invalid trusted-site
    // entries. A save replaces the complete mode map, so partial parses must
    // not escape as an actionable replacement.
    if ( seen.has('all-urls') === false ) {
        bad.push(indices[0] ?? 0);
    }
    if ( bad.length !== 0 ) {
        return { bad: Array.from(new Set(bad)).sort((a, b) => a - b) };
    }
    return justbad ? {} : { modes };
}

/******************************************************************************/

export function textFromModes(modes) {
    const out = [];
    for ( const mode of validModes ) {
        const hostnames = modes[mode];
        if ( hostnames === undefined ) { continue; }
        out.push(`${prettyModeNames[mode]}:`);
        for ( const hn of hostnames ) {
            out.push(`  - ${punycode.toUnicode(hn)}`);
        }
    }
    out.push('');
    return out.join('\n');
}
