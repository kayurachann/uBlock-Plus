/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2026-present Raymond Hill
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

import { rulesetConfig, saveRulesetConfig } from './config.js';
import { matchesFromHostnames } from './utils.js';

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/632

export async function registerPreventPopup(context) {
    if ( rulesetConfig.popupBlockMode !== true ) { return; }
    // Only collect gesture/intent context here. Closing a popup requires the
    // observer's opener, target, filtering-mode and compiled exception checks.
    const js = [ '/js/scripting/popup-context.js' ];

    const { none, basic, optimal, complete } = context.filteringModeDetails;
    let matches = [];
    const excludeMatches = [ ...none, ...basic ].filter(hn => hn !== 'all-urls');
    if ( complete.has('all-urls') || optimal.has('all-urls') ) {
        matches = [ '*' ];
    } else {
        matches = [ ...complete, ...optimal ];
    }
    if ( matches.length === 0 ) { return; }

    const directive = {
        id: 'prevent-popup',
        js,
        matches: matchesFromHostnames(matches),
        excludeMatches: matchesFromHostnames(excludeMatches),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    context.toAdd.push(directive);
}

/******************************************************************************/

export async function setPopupBlockMode(state, force = false) {
    const newState = Boolean(state);
    if ( force === false ) {
        if ( newState === rulesetConfig.popupBlockMode ) { return; }
    }
    rulesetConfig.popupBlockMode = state;
    await saveRulesetConfig();
}
