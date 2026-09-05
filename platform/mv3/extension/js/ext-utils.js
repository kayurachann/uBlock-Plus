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

import {
    browser,
    runtime,
} from './ext.js';

/******************************************************************************/

// https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions#requested_permissions_and_user_prompts
// "Users can grant or revoke host permissions on an ad hoc basis. Therefore,
// most browsers treat host_permissions as optional."

export async function hasBroadHostPermissions() {
    return browser.permissions.getAll().then(permissions =>
        permissions.origins.includes('<all_urls>') ||
        permissions.origins.includes('*://*/*')
    ).catch(( ) => false);
}

/******************************************************************************/

export async function gotoURL(url, type) {
    const pageURL = new URL(url, runtime.getURL('/'));
    const queryURL = new URL(pageURL);
    queryURL.hash = '';
    const tabs = await browser.tabs.query({
        url: queryURL.href,
        windowType: type !== 'popup' ? 'normal' : 'popup'
    });

    if ( Array.isArray(tabs) && tabs.length !== 0 ) {
        const { windowId, id } = tabs[0];
        return Promise.all([
            browser.windows.update(windowId, { focused: true }),
            browser.tabs.update(id, {
                active: true,
                ...(tabs[0].url !== pageURL.href ? { url: pageURL.href } : {}),
            }),
        ]);
    }

    if ( type === 'popup' ) {
        return browser.windows.create({
            type: 'popup',
            url: pageURL.href,
        });
    }

    return browser.tabs.create({
        active: true,
        url: pageURL.href,
    });
}
