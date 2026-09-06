/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2022-present Raymond Hill
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

import { browser } from './ext.js';
import { matchesFromHostnames } from './utils.js';

/******************************************************************************/

let reverseMode = false;

/******************************************************************************/

function disableToolbarIcon(tabId) {
    const details = {
        path: {
             '16': '/img/icon_16_off.png',
             '32': '/img/icon_32_off.png',
             '64': '/img/icon_64_off.png',
            '128': '/img/icon_128_off.png',
        }
    };
    if ( tabId !== undefined ) {
        details.tabId = tabId;
    }
    browser.action.setIcon(details);
}

function enableToolbarIcon(tabId) {
    const details = {
        path: {
             '16': '/img/icon_16.png',
             '32': '/img/icon_32.png',
             '64': '/img/icon_64.png',
            '128': '/img/icon_128.png',
        }
    };
    if ( tabId !== undefined ) {
        details.tabId = tabId;
    }
    browser.action.setIcon(details);
}

/******************************************************************************/

export function toggleToolbarIcon(tabId) {
    if ( reverseMode ) {
        enableToolbarIcon(tabId);
    } else {
        disableToolbarIcon(tabId);
    }
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/198
//  Ensure the toolbar icon reflects the no-filtering mode of "trusted sites"

export async function registerToolbarIconToggler(context) {
    const { none, basic, optimal, complete } = context.filteringModeDetails;
    // Other registrars consume this same snapshot after asynchronous reads.
    // Inspect the default without removing it from their filtering scope.
    const reverseModeAfter = none.has('all-urls');
    const toToggle = reverseModeAfter ?
        new Set([ ...basic, ...optimal, ...complete ])
        : none;

    if ( reverseModeAfter !== reverseMode ) {
        if ( reverseModeAfter ) {
            disableToolbarIcon();
        } else {
            enableToolbarIcon();
        }
        reverseMode = reverseModeAfter;
    }

    if ( toToggle.size === 0 ) { return; }

    const directive = {
        id: 'toolbar-icon',
        js: [ '/js/scripting/toolbar-icon.js' ],
        matches: matchesFromHostnames(toToggle),
        runAt: 'document_start',
    };

    context.toAdd.push(directive);
}
