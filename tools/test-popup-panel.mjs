/*******************************************************************************

    uBlock Plus+ - popup behavior regressions
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*/

import {
    createPopupActionRunner,
    launchPopupTool,
    popupPageContext,
    popupPanelState,
    popupPermissionOrigins,
    popupReloadRequest,
    preferredFilteringMode,
    reloadPopupTab,
    validFilteringMode,
} from '../platform/mv3/extension/js/popup-panel-core.js';
import assert from 'node:assert/strict';

const extensionURL = 'chrome-extension://test-extension/';
const page = popupPageContext('https://example.com/article', extensionURL);
assert.equal(page.canFilter, true);
assert.equal(page.canInject, true);
assert.equal(page.hostname, 'example.com');

for ( const url of [
    'chrome://settings/',
    'edge://extensions/',
    'about:blank',
    'file:///tmp/page.html',
    'chrome-extension://test-extension/dashboard.html',
    'https://chromewebstore.google.com/detail/extension',
    'https://chrome.google.com/webstore/detail/extension',
    'https://chrome.google.com/webstore',
    'invalid URL',
] ) {
    const context = popupPageContext(url, extensionURL);
    assert.equal(context.canFilter, false, url);
    assert.equal(context.canInject, false, url);
    const state = popupPanelState({ level: 3, popupBlockMode: true }, context, true);
    assert.equal(state.available, false, url);
    assert.equal(state.network, undefined, url);
    assert.equal(state.extended, undefined, url);
    assert.equal(state.popup, undefined, url);
}
assert.equal(popupPageContext('https://chrome.google.com/webstore-other', extensionURL).canFilter, true);
assert.equal(popupPageContext('https://chromewebstore.google.com.example.com/', extensionURL).canFilter, true);

const blockedURL = `${extensionURL}strictblock.html#https://example.com/article`;
const blocked = popupPageContext(blockedURL, extensionURL);
assert.equal(blocked.canFilter, true);
assert.equal(blocked.canInject, false);
assert.equal(blocked.hostname, 'example.com');
assert.equal(blocked.strictBlock, true);
for ( const url of [
    `${extensionURL}strictblock.html#javascript:alert(1)`,
    `${extensionURL}strictblock.html#chrome://settings/`,
    'chrome-extension://other-extension/strictblock.html#https://example.com/',
    `${extensionURL}strictblock.html.evil#https://example.com/`,
] ) {
    assert.equal(popupPageContext(url, extensionURL).canFilter, false, url);
}

const enabledData = { level: 3, popupBlockMode: true, popupPolicy: { mode: 'block' } };
assert.deepEqual(popupPanelState(enabledData, page, false), {
    available: false, level: undefined, enabled: false,
    network: undefined, extended: undefined, popup: undefined, restoreLevel: 1,
});
for ( const level of [ undefined, -1, 4, 1.5, '3', null, NaN ] ) {
    assert.equal(validFilteringMode(level), false);
    assert.equal(popupPanelState({ ...enabledData, level }, page, true).available, false);
}
for ( const level of [ 0, 1, 2, 3 ] ) {
    const state = popupPanelState({ ...enabledData, level }, page, true);
    assert.equal(state.available, true);
    assert.equal(state.network, level > 0);
    assert.equal(state.extended, level > 1);
    assert.equal(state.popup, level > 0);
}
assert.equal(popupPanelState({ ...enabledData, popupBlockMode: false }, page, true).popup, false);
assert.equal(popupPanelState({ ...enabledData, popupPolicy: { mode: 'allow' } }, page, true).popup, false);
assert.equal(popupPanelState({ level: 3 }, page, true).popup, undefined);
assert.equal(preferredFilteringMode({ restoreFilteringMode: 3, defaultFilteringMode: 2 }), 3);
assert.equal(preferredFilteringMode({ restoreFilteringMode: 1, defaultFilteringMode: 3 }), 1);
assert.equal(preferredFilteringMode({ restoreFilteringMode: 0, defaultFilteringMode: 2 }), 2);
assert.equal(preferredFilteringMode({ restoreFilteringMode: 99, defaultFilteringMode: 0 }), 1);

assert.deepEqual(popupPermissionOrigins('example.com'), [ '*://*.example.com/*' ]);
assert.deepEqual(popupPermissionOrigins('127.0.0.1'), [ '*://127.0.0.1/*' ]);
assert.deepEqual(popupPermissionOrigins('[::1]'), [ '*://[::1]/*' ]);
assert.deepEqual(popupPermissionOrigins('xn--bcher-kva.example'), [ '*://*.xn--bcher-kva.example/*' ]);
for ( const hostname of [ '', 'example.com/path', 'example.com:443', 'user@example.com', '*.example.com' ] ) {
    assert.throws(( ) => popupPermissionOrigins(hostname), undefined, hostname);
}

assert.deepEqual(popupReloadRequest(page, page.actualURL), { type: 'reload', bypassCache: false });
assert.deepEqual(popupReloadRequest(page, page.actualURL, true), { type: 'reload', bypassCache: true });
assert.deepEqual(popupReloadRequest(blocked, blockedURL), {
    type: 'update', url: 'https://example.com/article',
});
assert.equal(popupReloadRequest(blocked, 'https://new-site.example/'), undefined);
assert.equal(popupReloadRequest(popupPageContext('chrome://settings/', extensionURL), 'chrome://settings/'), undefined);

// Deferred permission handling must inspect the tab when the queue/delay ends,
// not navigate using the URL captured when the permission prompt opened.
let reloadTabState = { url: blocked.actualURL };
const reloadCalls = [];
let finishReload;
const reloadTabs = {
    async get(tabId) {
        assert.equal(tabId, 9);
        return { ...reloadTabState };
    },
    async reload(tabId, options) {
        reloadCalls.push({ type: 'reload', tabId, ...options });
    },
    async update(tabId, options) {
        reloadCalls.push({ type: 'update', tabId, ...options });
        await new Promise(resolve => { finishReload = resolve; });
    },
};
reloadTabState = { url: 'https://new-site.example/' };
assert.equal(await reloadPopupTab(reloadTabs, 9, blocked), false);
assert.deepEqual(reloadCalls, [], 'A delayed permission grant cannot navigate a different page');
reloadTabState = { url: blocked.actualURL, pendingUrl: 'https://new-site.example/' };
assert.equal(await reloadPopupTab(reloadTabs, 9, blocked), false);
assert.deepEqual(reloadCalls, [], 'An in-progress navigation must also prevent stale redirects');
reloadTabState = { url: blocked.actualURL };
let reloadSettled = false;
const deferredReload = reloadPopupTab(reloadTabs, 9, blocked).then(result => {
    reloadSettled = true;
    return result;
});
await Promise.resolve();
assert.deepEqual(reloadCalls, [ {
    type: 'update', tabId: 9, url: 'https://example.com/article',
} ]);
assert.equal(reloadSettled, false, 'Wait for the browser update before reporting success');
finishReload();
assert.equal(await deferredReload, true);
reloadTabState = { url: page.actualURL };
assert.equal(await reloadPopupTab(reloadTabs, 9, page, true), true);
assert.deepEqual(reloadCalls.at(-1), { type: 'reload', tabId: 9, bypassCache: true });
await assert.rejects(reloadPopupTab({
    ...reloadTabs,
    async reload() { throw new Error('Browser refused reload'); },
}, 9, page), /Browser refused reload/);
reloadTabState = { url: blocked.actualURL };
await assert.rejects(reloadPopupTab({
    ...reloadTabs,
    async update() { throw new Error('Browser refused navigation'); },
}, 9, blocked), /Browser refused navigation/);
await assert.rejects(reloadPopupTab({
    async get() { throw new Error('Tab closed'); },
}, 9, blocked), /Tab closed/);

const busyEvents = [];
const errors = [];
const run = createPopupActionRunner(value => busyEvents.push(value), error => errors.push(error.message));
let finish;
let duplicateRuns = 0;
const first = run(( ) => new Promise(resolve => { finish = resolve; }));
assert.equal(await run(( ) => { duplicateRuns++; }), false);
assert.equal(duplicateRuns, 0, 'Keyboard activation while busy must not send a second mutation');
assert.deepEqual(busyEvents, [ true ]);
finish();
assert.equal(await first, true);
assert.deepEqual(busyEvents, [ true, false ]);
assert.equal(await run(( ) => { throw new Error('mutation failed'); }), false);
assert.deepEqual(errors, [ 'mutation failed' ]);
assert.equal(await run(( ) => { duplicateRuns++; }), true, 'An error must release the operation lock');
assert.equal(duplicateRuns, 1);

let completeInjection;
let popupClosed = false;
const launch = launchPopupTool({
    executeScript: request => {
        assert.equal(request.target.tabId, 7);
        assert.deepEqual(request.files, [ '/picker.js' ]);
        return new Promise(resolve => { completeInjection = resolve; });
    },
}, 7, [ '/picker.js' ], ( ) => { popupClosed = true; });
assert.equal(popupClosed, false, 'Keep errors visible until injection succeeds');
completeInjection();
await launch;
assert.equal(popupClosed, true);
popupClosed = false;
await assert.rejects(launchPopupTool({
    executeScript: ( ) => Promise.reject(new Error('Cannot access this page')),
}, 7, [ '/picker.js' ], ( ) => { popupClosed = true; }));
assert.equal(popupClosed, false, 'An injection rejection must retain the popup');
await assert.rejects(launchPopupTool(undefined, 7, [], ( ) => { popupClosed = true; }));
assert.equal(popupClosed, false);

// Exercise the actual extension message adapter, including its typed error
// boundary. A failed mutation must reject, not appear to be returned data.
const previousSelf = globalThis.self;
let messageReply;
const sentMessages = [];
globalThis.self = {
    chrome: {
        runtime: {
            getURL: ( ) => extensionURL,
            async sendMessage(request) {
                sentMessages.push(request);
                return messageReply;
            },
        },
    },
};
try {
    const { sendMessage } = await import('../platform/mv3/extension/js/ext.js');
    const request = { what: 'setFilteringMode', hostname: 'child.example.com', level: 2 };
    messageReply = {
        __ublockPlusError: 'Cannot override inherited filtering scope',
        __ublockPlusErrorCode: 'ERR_FILTERING_MODE_PARENT_SCOPE',
        internalDetails: { secret: 'must not be copied into an Error' },
    };
    await assert.rejects(sendMessage(request), error => {
        assert.equal(error.message, 'Cannot override inherited filtering scope');
        assert.equal(error.code, 'ERR_FILTERING_MODE_PARENT_SCOPE');
        assert.equal(error.internalDetails, undefined);
        return true;
    });
    assert.deepEqual(sentMessages, [ request ], 'A failed mutation must not be retried automatically');
    let visibleError;
    const runMessageAction = createPopupActionRunner(( ) => { }, error => { visibleError = error; });
    assert.equal(await runMessageAction(( ) => sendMessage(request)), false);
    assert.equal(visibleError.code, 'ERR_FILTERING_MODE_PARENT_SCOPE', 'The UI action boundary must retain the typed failure');
    messageReply = { __ublockPlusError: 'Legacy error', __ublockPlusErrorCode: 'UNRECOGNIZED' };
    await assert.rejects(sendMessage(request), error => {
        assert.equal(error.message, 'Legacy error');
        assert.equal(error.code, undefined, 'Only recognized public codes cross the boundary');
        return true;
    });
    messageReply = 2;
    assert.equal(await sendMessage(request), 2);
} finally {
    if ( previousSelf === undefined ) {
        delete globalThis.self;
    } else {
        globalThis.self = previousSelf;
    }
}

console.log('Popup panel behavior tests passed');
