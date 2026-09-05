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
    applyPowerUISettings,
    getPowerUISettings,
    listenForPowerUISettings,
    setPowerUISettings,
} from './power-ui.js';
import { browser, runtime, sendMessage } from './ext.js';
import {
    createPopupActionRunner,
    launchPopupTool,
    popupPageContext,
    popupPanelState,
    popupPermissionOrigins,
    preferredFilteringMode,
    reloadPopupTab,
    validFilteringMode,
} from './popup-panel-core.js';
import { dom, qs$ } from './dom.js';
import { i18n$ } from './i18n.js';
import punycode from './punycode.js';

/******************************************************************************/

const popupPanelData = {};
let currentTab = {};
let pageContext = popupPageContext('', runtime.getURL('/'));
let ready = false;
let errorKey = '';
let initialization;
let initGeneration = 0;
let actionFocus;

const forbidden = name =>
    popupPanelData.disabledFeatures?.includes(name) === true;

function sizePopup() {
    const main = qs$('main');
    // Anchor Chrome's desired popup size in content, not its initial tiny
    // viewport. The inner scroller then fits the height Chrome can provide.
    main.style.height = 'auto';
    main.style.maxHeight = 'none';
    const height = Math.min(600, Math.ceil(main.getBoundingClientRect().height));
    main.style.removeProperty('height');
    main.style.removeProperty('max-height');
    dom.body.style.setProperty('--popup-height', `${height}px`);
}

function setError(key = '') {
    errorKey = key;
    dom.text('#popupError', key === '' ? '' : i18n$(key));
    qs$('#popupError').hidden = key === '';
    qs$('#retryPopup').hidden = key === '';
    sizePopup();
}

function setCapability(name, value, text) {
    const node = qs$(`[data-capability="${name}"]`);
    if ( node === null ) { return; }
    node.dataset.state = value === undefined ? 'unknown' : value ? 'on' : 'off';
    dom.text(qs$(node, 'strong'), text ?? i18n$(
        value === undefined ? 'popupCapabilityUnavailable' :
            value ? 'popupCapabilityActive' : 'popupCapabilityInactive'
    ));
}

function render() {
    const state = popupPanelState(popupPanelData, pageContext, ready);
    dom.body.dataset.forbid = (popupPanelData.disabledFeatures || []).join(' ');
    dom.cl.toggle(dom.root, 'isHTTP', pageContext.canInject);
    dom.cl.toggle(dom.body, 'off', state.enabled === false);
    const power = qs$('#sitePower');
    power.disabled = state.available === false || forbidden('filteringMode');
    dom.attr(power, 'aria-checked', `${state.enabled}`);
    dom.text('#protectionStatus', i18n$(
        state.available === false ? 'popupUnavailable' :
            state.enabled ? 'popupProtectionOn' : 'popupProtectionOff'
    ));
    dom.text('#protectionMode', state.available
        ? i18n$(`filteringMode${state.level}Name`)
        : i18n$('popupCapabilityUnavailable'));
    const mode = qs$('#siteFilteringMode');
    mode.value = `${state.enabled ? state.level : state.restoreLevel}`;
    mode.disabled = state.enabled === false || forbidden('filteringMode');
    const policy = qs$('#popupPolicySelect');
    policy.value = popupPanelData.popupPolicy?.matchedHostname === pageContext.hostname
        ? popupPanelData.popupPolicy.mode
        : 'default';
    policy.disabled = state.enabled === false ||
        popupPanelData.popupBlockMode !== true || forbidden('filteringMode');
    setCapability('network', state.network);
    setCapability('extended', state.extended);
    setCapability('popup', state.popup);
    const count = ready && Number.isSafeInteger(popupPanelData.enabledRulesetCount)
        ? popupPanelData.enabledRulesetCount
        : undefined;
    setCapability('lists', count === undefined ? undefined : count > 0,
        count === undefined ? undefined : `${count}`);
    const recent = popupPanelData.recentPopupBlocks;
    dom.text('#popupActivity', ready && pageContext.canFilter &&
        Number.isSafeInteger(recent) && recent >= 0
        ? i18n$('popupRecentBlocks', [ `${recent}` ])
        : '');
    const hostname = pageContext.hostname;
    const pretty = punycode.toUnicode(hostname);
    // Keep ASCII for Cyrillic domains rather than rendering ambiguous glyphs.
    dom.text('#hostname', /[\u0400-\u04ff]/.test(pretty) ? hostname : pretty);
    dom.attr('#hostname', 'title', hostname);
    dom.text('#version', runtime.getManifest().version);
    for ( const [ id, feature ] of [
        [ 'gotoZapper', 'zapper' ],
        [ 'gotoPicker', 'picker' ],
        [ 'gotoUnpicker', 'picker' ],
    ] ) {
        const canUse = state.enabled && pageContext.canInject &&
            typeof browser.scripting?.executeScript === 'function' &&
            forbidden(feature) === false &&
            (id !== 'gotoUnpicker' || popupPanelData.hasCustomFilters === true);
        qs$(`#${id}`).disabled = canUse === false;
        dom.cl.toggle(`#${id}`, 'enabled', canUse);
    }
    const canInspect = ready && popupPanelData.isSideloaded === true &&
        popupPanelData.developerMode === true && Number.isInteger(currentTab.id);
    dom.cl.toggle('#gotoMatchedRules', 'enabled', canInspect);
    qs$('#gotoMatchedRules').disabled = canInspect === false;
    const canReport = state.available && forbidden('report') === false;
    qs$('#gotoReport').disabled = canReport === false;
    dom.cl.toggle('#gotoReport', 'enabled', canReport);
    qs$('#refresh').disabled = state.available === false;
    for ( const id of [ 'gotoDashboard', 'gotoDashboardFooter', 'gotoMyFilters', 'gotoSiteRules' ] ) {
        const node = qs$(`#${id}`);
        if ( node === null ) { continue; }
        node.disabled = forbidden('dashboard');
        dom.cl.toggle(node, 'enabled', node.disabled === false);
    }
    sizePopup();
}

const runAction = createPopupActionRunner(busy => {
    const main = qs$('main');
    if ( busy ) {
        actionFocus = main.contains(document.activeElement)
            ? document.activeElement
            : undefined;
    }
    dom.cl.toggle(dom.body, 'busy', busy);
    dom.attr(dom.body, 'aria-busy', `${busy}`);
    // Pointer-events alone does not stop activation of a focused button.
    main.inert = busy;
    if ( busy === false ) {
        // Inert moves focus to the body. Restore the initiating control after
        // the mutation so keyboard users can activate it again.
        if ( document.activeElement === document.body &&
            actionFocus?.isConnected && actionFocus.disabled !== true ) {
            actionFocus.focus({ preventScroll: true });
        }
        actionFocus = undefined;
    }
}, reason => {
    const keys = new Set([
        'popupLoadFailed', 'popupActionFailed', 'popupToolFailed',
        'popupPermissionDenied', 'popupPermissionFailed', 'popupReloadFailed',
        'popupParentScope',
    ]);
    setError(keys.has(reason?.message) ? reason.message : 'popupActionFailed');
});

function actionAllowed(ev, feature) {
    return ev.isTrusted === true && ready &&
        (feature === undefined || forbidden(feature) === false);
}

async function fetchPanelData(context) {
    const response = await sendMessage({
        what: 'popupPanelData',
        origin: new URL(context.url).origin,
        hostname: context.hostname,
    });
    if ( response instanceof Object === false ||
        validFilteringMode(response.level) === false ) {
        throw new Error('popupLoadFailed');
    }
    return response;
}

async function reconcileAfterFailure() {
    try {
        Object.assign(popupPanelData, await fetchPanelData(pageContext));
        ready = true;
    } catch {
        ready = false;
    }
    render();
}

async function reloadCurrentPage(bypassCache = false) {
    try {
        const reloaded = await reloadPopupTab(browser.tabs, currentTab.id, pageContext, bypassCache);
        if ( reloaded === false ) { throw new Error('Page changed'); }
        dom.cl.remove(dom.body, 'needReload');
    } catch {
        throw new Error('popupReloadFailed');
    }
}

async function requestSiteAccess(beforeLevel, afterLevel) {
    if ( afterLevel <= 1 || popupPanelData.hasOmnipotence === true ) { return; }
    const requestId = crypto.randomUUID();
    // Start the permission prompt inside the user's activation. Do not await
    // messaging before permissions.request: the browser UI may close us.
    const pending = sendMessage({
        what: 'setPendingFilteringMode',
        requestId,
        tabId: currentTab.id,
        actualURL: pageContext.actualURL,
        url: pageContext.url,
        hostname: pageContext.hostname,
        beforeLevel,
        afterLevel,
    }).catch(( ) => { });
    let granted;
    try {
        granted = await browser.permissions.request({
            origins: popupPermissionOrigins(pageContext.hostname),
        });
    } catch {
        throw new Error('popupPermissionFailed');
    } finally {
        await pending;
        await sendMessage({
            what: 'clearPendingFilteringMode', requestId,
        }).catch(( ) => { });
    }
    if ( granted !== true ) { throw new Error('popupPermissionDenied'); }
}

async function commitFilteringMode(afterLevel) {
    const beforeLevel = popupPanelData.level;
    if ( afterLevel === beforeLevel ) { return; }
    await requestSiteAccess(beforeLevel, afterLevel);
    let actualLevel;
    try {
        actualLevel = await sendMessage({
            what: 'setFilteringMode',
            hostname: pageContext.hostname,
            level: afterLevel,
        });
        if ( validFilteringMode(actualLevel) === false ) {
            throw new Error('popupActionFailed');
        }
    } catch ( reason ) {
        await reconcileAfterFailure();
        if ( ready && popupPanelData.level !== beforeLevel ) {
            dom.cl.add(dom.body, 'needReload');
        }
        throw new Error(reason?.code === 'ERR_FILTERING_MODE_PARENT_SCOPE'
            ? 'popupParentScope'
            : 'popupActionFailed');
    }
    if ( beforeLevel > 0 && actualLevel === 0 ) {
        popupPanelData.restoreFilteringMode = beforeLevel;
    } else if ( actualLevel > 0 ) {
        popupPanelData.restoreFilteringMode = actualLevel;
    }
    popupPanelData.level = actualLevel;
    render();
    if ( actualLevel === beforeLevel ) { return; }
    dom.cl.add(dom.body, 'needReload');
    if ( popupPanelData.autoReload === true ) {
        await reloadCurrentPage();
    }
}

dom.on('#sitePower', 'click', ev => {
    if ( actionAllowed(ev, 'filteringMode') === false ||
        pageContext.canFilter === false ) { return; }
    return runAction(async ( ) => {
        setError();
        await commitFilteringMode(popupPanelData.level === 0
            ? preferredFilteringMode(popupPanelData)
            : 0);
    });
});

dom.on('#siteFilteringMode', 'change', ev => {
    if ( actionAllowed(ev, 'filteringMode') === false ||
        pageContext.canFilter === false || popupPanelData.level === 0 ) { return; }
    const level = Number(ev.target.value);
    if ( validFilteringMode(level) === false || level === 0 ) { return; }
    return runAction(async ( ) => {
        setError();
        try {
            await commitFilteringMode(level);
        } finally {
            render();
        }
    });
});

dom.on('#popupPolicySelect', 'change', ev => {
    if ( actionAllowed(ev, 'filteringMode') === false ||
        pageContext.canFilter === false || popupPanelData.level === 0 ||
        popupPanelData.popupBlockMode !== true ) { return; }
    const mode = ev.target.value;
    return runAction(async ( ) => {
        setError();
        try {
            const response = await sendMessage({
                what: 'setPopupPolicy', hostname: pageContext.hostname, mode,
            });
            if ( response?.effective instanceof Object === false ) {
                throw new Error('popupActionFailed');
            }
            popupPanelData.popupPolicy = response.effective;
        } catch {
            await reconcileAfterFailure();
            throw new Error('popupActionFailed');
        } finally {
            render();
        }
    });
});

dom.on('#refresh', 'click', ev => {
    if ( actionAllowed(ev) === false ) { return; }
    return runAction(async ( ) => {
        setError();
        await reloadCurrentPage(ev.ctrlKey || ev.metaKey || ev.shiftKey);
        self.close();
    });
});

dom.on('#gotoMatchedRules', 'click', ev => {
    if ( actionAllowed(ev) === false ||
        popupPanelData.isSideloaded !== true || popupPanelData.developerMode !== true ) {
        return;
    }
    return runAction(( ) => sendMessage({
        what: 'showMatchedRules', tabId: currentTab.id,
    }));
});

dom.on('#gotoReport', 'click', ev => {
    if ( actionAllowed(ev, 'report') === false || pageContext.canFilter === false ) { return; }
    const reportURL = new URL(runtime.getURL('/report.html'));
    reportURL.searchParams.set('tabid', currentTab.id);
    reportURL.searchParams.set('url', pageContext.url);
    reportURL.searchParams.set('mode', popupPanelData.level);
    return runAction(( ) => sendMessage({
        what: 'gotoURL', url: `${reportURL.pathname}${reportURL.search}`,
    }));
});

async function openDashboard(pane) {
    if ( pane === undefined ) {
        await runtime.openOptionsPage();
    } else {
        await sendMessage({ what: 'gotoURL', url: `/dashboard.html#${pane}` });
    }
}

dom.on('#gotoDashboard, #gotoDashboardFooter, #gotoMyFilters, #gotoSiteRules', 'click', ev => {
    // Options remain a recovery route if the service worker failed to start.
    if ( ev.isTrusted !== true || forbidden('dashboard') ) { return; }
    const pane = { gotoMyFilters: 'filters', gotoSiteRules: 'siteRules' }[ev.currentTarget.id];
    return runAction(( ) => openDashboard(pane));
});

for ( const [ id, feature, name ] of [
    [ 'gotoZapper', 'zapper', 'zapper' ],
    [ 'gotoPicker', 'picker', 'picker' ],
    [ 'gotoUnpicker', 'picker', 'unpicker' ],
] ) {
    dom.on(`#${id}`, 'click', ev => {
        if ( actionAllowed(ev, feature) === false || pageContext.canInject === false ||
            popupPanelData.level === 0 ||
            (id === 'gotoUnpicker' && popupPanelData.hasCustomFilters !== true) ) { return; }
        return runAction(async ( ) => {
            setError();
            const files = [ '/js/scripting/tool-overlay.js', `/js/scripting/${name}.js` ];
            if ( name !== 'zapper' ) { files.unshift('/js/scripting/css-procedural-api.js'); }
            try {
                const tab = await browser.tabs.get(currentTab.id);
                if ( tab.url !== pageContext.actualURL ) { throw new Error('Page changed'); }
                await launchPopupTool(browser.scripting, currentTab.id, files, ( ) => self.close());
            } catch {
                throw new Error('popupToolFailed');
            }
        });
    });
}

async function init(generation) {
    const [ tab ] = await browser.tabs.query({ active: true, currentWindow: true });
    if ( tab instanceof Object === false || Number.isInteger(tab.id) === false || tab.id < 0 ) {
        throw new Error('popupLoadFailed');
    }
    const context = popupPageContext(tab.url, runtime.getURL('/'));
    // Fetch managed UI restrictions even for restricted browser pages.
    const data = context.url !== '' ? await fetchPanelData(context) : {};
    if ( generation !== initGeneration ) { return; }
    currentTab = tab;
    pageContext = context;
    Object.assign(popupPanelData, data);
    ready = context.url !== '';
    render();
}

function initWithTimeout() {
    const generation = ++initGeneration;
    let timer;
    return Promise.race([
        init(generation),
        new Promise((resolve, reject) => {
            timer = self.setTimeout(( ) => {
                initGeneration++;
                reject(new Error('popupLoadFailed'));
            }, 4000);
        }),
    ]).finally(( ) => self.clearTimeout(timer));
}

function tryInit() {
    if ( initialization !== undefined ) { return initialization; }
    initialization = runAction(async ( ) => {
        ready = false;
        setError();
        for ( let attempt = 0; attempt < 3; attempt++ ) {
            try {
                await initWithTimeout();
                return;
            } catch {
                if ( attempt < 2 ) {
                    await new Promise(resolve => self.setTimeout(resolve, 200 * (attempt + 1)));
                }
            }
        }
        ready = false;
        render();
        throw new Error('popupLoadFailed');
    }).finally(( ) => {
        initialization = undefined;
        dom.cl.remove(dom.body, 'loading');
    });
    return initialization;
}

dom.on('#retryPopup', 'click', ev => {
    if ( ev.isTrusted !== true || errorKey === '' ) { return; }
    return tryInit();
});

function renderDetailsToggle(settings) {
    const expanded = settings.popupLayout !== 'compact';
    dom.attr('#toggleDetails', 'aria-expanded', `${expanded}`);
    dom.text('#toggleDetails', i18n$(expanded ? 'popupLess' : 'popupMore'));
    sizePopup();
}

getPowerUISettings().then(renderDetailsToggle).catch(( ) => { });
listenForPowerUISettings(renderDetailsToggle);

dom.on('#toggleDetails', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    return runAction(async ( ) => {
        setError();
        const settings = await getPowerUISettings({ refresh: true });
        const updated = await setPowerUISettings({
            ...settings,
            popupLayout: settings.popupLayout === 'compact' ? 'power' : 'compact',
        });
        applyPowerUISettings(updated);
        renderDetailsToggle(updated);
    });
});

tryInit();
