/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2025-present Raymond Hill
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

(async ( ) => {

/******************************************************************************/

const uBlockPlusOverlay = self.uBlockPlusOverlay;
if ( uBlockPlusOverlay === undefined ) { return; }
if ( uBlockPlusOverlay.file === '/unpicker-ui.html' ) { return; }

/******************************************************************************/

function onMessage(msg) {
    switch ( msg.what ) {
    case 'startCustomFilters':
        return uBlockPlusOverlay.sendMessage({ what: 'startCustomFilters' });
    case 'terminateCustomFilters':
        return uBlockPlusOverlay.sendMessage({ what: 'terminateCustomFilters' });
    case 'removeCustomFilters':
        return uBlockPlusOverlay.sendMessage({ what: 'removeCustomFilters',
            hostname: uBlockPlusOverlay.url.hostname,
            selectors: [ msg.selector ],
        });
    default:
        break;
    }
}

/******************************************************************************/

await uBlockPlusOverlay.install('/unpicker-ui.html', onMessage);

/******************************************************************************/

})();


void 0;
