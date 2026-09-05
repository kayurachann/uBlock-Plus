/*******************************************************************************

    uBlock Plus+ - popup state and action policy
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*/

const webProtocols = new Set([ 'http:', 'https:' ]);

export function validFilteringMode(value) {
    return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function preferredFilteringMode(data = {}) {
    for ( const level of [ data.restoreFilteringMode, data.defaultFilteringMode ] ) {
        if ( validFilteringMode(level) && level !== 0 ) { return level; }
    }
    return 1;
}

function isRestrictedWebPage(url) {
    return url.hostname === 'chromewebstore.google.com' ||
        url.hostname === 'chrome.google.com' &&
        /^\/webstore(?:\/|$)/.test(url.pathname);
}

export function popupPageContext(rawURL, extensionURL) {
    const context = {
        actualURL: '', url: '', hostname: '',
        canFilter: false, canInject: false, strictBlock: false,
    };
    try {
        const actual = new URL(rawURL);
        const extension = new URL(extensionURL);
        context.actualURL = actual.href;
        let target = actual;
        // A strict-block interstitial can change the target site's settings,
        // but tools must never be injected into the extension page itself.
        if ( actual.protocol === extension.protocol &&
            actual.host === extension.host &&
            actual.pathname === '/strictblock.html' ) {
            target = new URL(actual.hash.slice(1));
            context.strictBlock = true;
        }
        context.url = target.href;
        context.hostname = webProtocols.has(target.protocol)
            ? target.hostname
            : '';
        context.canFilter = webProtocols.has(target.protocol) &&
            target.hostname !== '' && isRestrictedWebPage(target) === false;
        context.canInject = context.canFilter && context.strictBlock === false;
    } catch {
    }
    return context;
}

export function popupPanelState(data, context, ready) {
    const available = ready === true && context.canFilter &&
        validFilteringMode(data.level);
    const level = available ? data.level : undefined;
    const enabled = available && level > 0;
    let popup;
    if ( available ) {
        if ( enabled === false || data.popupBlockMode === false ||
            data.popupPolicy?.mode === 'allow' ) {
            popup = false;
        } else if ( data.popupBlockMode === true ) {
            popup = true;
        }
    }
    return {
        available,
        level,
        enabled,
        network: available ? enabled : undefined,
        extended: available ? level >= 2 : undefined,
        popup,
        restoreLevel: preferredFilteringMode(data),
    };
}

export function popupPermissionOrigins(hostname) {
    if ( typeof hostname !== 'string' || hostname.includes('*') ) {
        throw new TypeError('Invalid site hostname');
    }
    const url = new URL(`https://${hostname}/`);
    if ( url.hostname !== hostname || url.pathname !== '/' ||
        url.username !== '' || url.password !== '' || url.port !== '' ) {
        throw new TypeError('Invalid site hostname');
    }
    const literal = hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
    return [ `*://${literal ? '' : '*.'}${hostname}/*` ];
}

export function popupReloadRequest(context, currentURL, bypassCache = false) {
    // A popup can remain open while the active tab navigates. Never send its
    // old strict-block destination to an unrelated, newly loaded page.
    if ( context.canFilter === false || currentURL !== context.actualURL ) {
        return;
    }
    return context.strictBlock
        ? { type: 'update', url: context.url }
        : { type: 'reload', bypassCache: bypassCache === true };
}

export async function reloadPopupTab(tabs, tabId, context, bypassCache = false) {
    const tab = await tabs.get(tabId);
    if ( typeof tab.pendingUrl === 'string' && tab.pendingUrl !== '' &&
        tab.pendingUrl !== context.actualURL ) { return false; }
    const request = popupReloadRequest(context, tab.url, bypassCache);
    if ( request === undefined ) { return false; }
    if ( request.type === 'update' ) {
        await tabs.update(tabId, { url: request.url });
    } else {
        await tabs.reload(tabId, { bypassCache: request.bypassCache });
    }
    return true;
}

export function createPopupActionRunner(onBusy, onError) {
    let busy = false;
    return async task => {
        if ( busy ) { return false; }
        busy = true;
        onBusy(true);
        try {
            await task();
            return true;
        } catch ( reason ) {
            onError(reason);
            return false;
        } finally {
            busy = false;
            onBusy(false);
        }
    };
}

export async function launchPopupTool(scripting, tabId, files, close) {
    if ( typeof scripting?.executeScript !== 'function' ) {
        throw new Error('popupToolFailed');
    }
    await scripting.executeScript({ files, target: { tabId } });
    close();
}
