/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2024-present Raymond Hill
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

import {
    sessionRead,
    sessionWrite,
} from './ext.js';

import { webext } from './ext-compat.js';

/******************************************************************************/

export const isSideloaded = (( ) => {
    const { permissions } = webext.runtime.getManifest();
    return permissions?.includes('declarativeNetRequestFeedback') ?? false;
})();

/******************************************************************************/

const CONSOLE_MAX_LINES = 32;
const consoleOutput = [];

sessionRead('console').then(before => {
    if ( Array.isArray(before) === false ) { return; }
    for ( const s of before.reverse() ) {
        consoleOutput.unshift(s);
    }
    consoleTruncate();
});

const consoleTruncate = ( ) => {
    if ( consoleOutput.length <= CONSOLE_MAX_LINES ) { return; }
    consoleOutput.copyWithin(0, -CONSOLE_MAX_LINES);
    consoleOutput.length = CONSOLE_MAX_LINES;
};

const consoleAdd = (...args) => {
    if ( args.length === 0 ) { return; }
    const now = new Date();
    const time = [
        `${now.getUTCMonth()+1}`.padStart(2, '0'),
        `${now.getUTCDate()}`.padStart(2, '0'),
        '.',
        `${now.getUTCHours()}`.padStart(2, '0'),
        `${now.getUTCMinutes()}`.padStart(2, '0'),
    ].join('');
    for ( let i = 0; i < args.length; i++ ) {
        const s = `[${time}]${args[i]}`;
        if ( Boolean(s) === false ) { continue; }
        if ( s === consoleOutput.at(-1) ) { continue; }
        consoleOutput.push(s);
    }
    consoleTruncate();
    sessionWrite('console', getConsoleOutput());
}

export const ublockPlusLog = (...args) => {
    // Do not pollute dev console in stable releases.
    if ( isSideloaded !== true ) { return; }
    console.info('[uBlock Plus+]', ...args);
};

export const ublockPlusErr = (...args) => {
    if ( Array.isArray(args) === false ) { return; }
    if ( globalThis.ServiceWorkerGlobalScope ) {
        consoleAdd(...args);
    }
    // Do not pollute dev console in stable releases.
    if ( isSideloaded !== true ) { return; }
    console.error('[uBlock Plus+]', ...args);
};

export const getConsoleOutput = ( ) => {
    return consoleOutput.slice();
};

/******************************************************************************/

// The unified logger (logger.js) observes onRuleMatchedDebug only while a
// logger window captures a tab. Developer mode keeps no separate matched-rule
// buffer or rule lookups; these exports remain for existing message callers.

export const getMatchedRules = ( ) => Promise.resolve([]);

export const toggleDeveloperMode = ( ) => { };

/******************************************************************************/
