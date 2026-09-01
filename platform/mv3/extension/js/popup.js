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

import { browser, runtime, sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';
import { i18n$ } from './i18n.js';
import punycode from './punycode.js';

/******************************************************************************/

const popupPanelData = {};
const  currentTab = {};
const tabURL = new URL(runtime.getURL('/'));

/******************************************************************************/

function renderAdminRules() {
    const { disabledFeatures: forbid = [] } = popupPanelData;
    if ( forbid.length === 0 ) { return; }
    dom.body.dataset.forbid = forbid.join(' ');
    if ( forbid.includes('filteringMode') ) {
        qs$('#sitePower').disabled = true;
    }
}

/******************************************************************************/

function renderPopupPolicy() {
    const select = qs$('#popupPolicySelect');
    const details = popupPanelData.popupPolicy;
    select.value = details?.matchedHostname === tabURL.hostname
        ? details.mode
        : 'default';
    select.disabled = popupPanelData.popupBlockMode === false;
}

function setCapability(name, enabled, text) {
    const node = qs$(`[data-capability="${name}"]`);
    if ( node === null ) { return; }
    node.dataset.state = enabled ? 'on' : 'off';
    dom.text(qs$(node, 'strong'), text);
}

function renderPowerPanel() {
    const level = Number.isSafeInteger(popupPanelData.level)
        ? popupPanelData.level
        : 0;
    const enabled = level !== 0;
    const power = qs$('#sitePower');
    dom.attr(power, 'aria-checked', `${enabled}`);
    dom.text(
        '#protectionStatus',
        i18n$(enabled ? 'popupProtectionOn' : 'popupProtectionOff')
    );
    dom.text('#protectionMode', i18n$(`filteringMode${level}Name`));
    setCapability(
        'network',
        level >= 1,
        i18n$(level >= 1 ? 'popupCapabilityActive' : 'popupCapabilityInactive')
    );
    setCapability(
        'extended',
        level >= 2,
        i18n$(level >= 2 ? 'popupCapabilityActive' : 'popupCapabilityInactive')
    );
    setCapability(
        'popup',
        popupPanelData.popupBlockMode === true,
        i18n$(popupPanelData.popupBlockMode === true
            ? 'popupCapabilityActive'
            : 'popupCapabilityInactive')
    );
    const rulesetCount = Number.isSafeInteger(popupPanelData.enabledRulesetCount)
        ? popupPanelData.enabledRulesetCount
        : 0;
    setCapability('lists', rulesetCount !== 0, `${rulesetCount}`);
    dom.text('#popupActivity', i18n$('popupRecentBlocks', [
        `${popupPanelData.recentPopupBlocks || 0}`,
    ]));
}

dom.on('#popupPolicySelect', 'change', async ev => {
    if ( ev.isTrusted !== true || tabURL.hostname === '' ) { return; }
    dom.cl.add(dom.body, 'busy');
    try {
        const response = await sendMessage({
            what: 'setPopupPolicy',
            hostname: tabURL.hostname,
            mode: ev.target.value,
        });
        popupPanelData.popupPolicy = response.effective;
    } catch {
    }
    renderPopupPolicy();
    dom.cl.remove(dom.body, 'busy');
});

/******************************************************************************/

async function commitFilteringMode(beforeLevel, afterLevel) {
    if ( tabURL.hostname === '' ) { return; }
    const targetHostname = tabURL.hostname;
    if ( afterLevel > 1 ) {
        if ( beforeLevel <= 1 ) {
            sendMessage({
                what: 'setPendingFilteringMode',
                tabId: currentTab.id,
                url: tabURL.href,
                hostname: targetHostname,
                beforeLevel,
                afterLevel,
            });
        }
        let granted = false;
        try {
            granted = await browser.permissions.request({
                origins: [ `*://*.${targetHostname}/*` ],
            });
        } catch {
        }
        if ( granted !== true ) {
            return;
        }
    }
    const actualLevel = await sendMessage({
        what: 'setFilteringMode',
        hostname: targetHostname,
        level: afterLevel,
    });
    popupPanelData.level = actualLevel;
    renderPowerPanel();
    if ( actualLevel !== beforeLevel && popupPanelData.autoReload ) {
        const justReload = tabURL.href === currentTab.url;
        self.setTimeout(( ) => {
            if ( justReload ) {
                browser.tabs.reload(currentTab.id);
            } else {
                browser.tabs.update(currentTab.id, { url: tabURL.href });
            }
        }, 437);
    } else if ( actualLevel !== beforeLevel ) {
        dom.cl.add(dom.body, 'needReload');
    }
}

dom.on('#sitePower', 'click', async ev => {
    if ( ev.isTrusted !== true || tabURL.hostname === '' ) { return; }
    const beforeLevel = popupPanelData.level;
    const fallback = Math.max(popupPanelData.defaultFilteringMode || 1, 1);
    const afterLevel = beforeLevel === 0 ? fallback : 0;
    dom.cl.add(dom.body, 'busy');
    try {
        await commitFilteringMode(beforeLevel, afterLevel);
    } finally {
        dom.cl.remove(dom.body, 'busy');
    }
});

dom.on('#refresh', 'click', ev => {
    if ( ev.isTrusted !== true || typeof currentTab.id !== 'number' ) { return; }
    browser.tabs.reload(currentTab.id);
    self.close();
});

dom.on('#gotoMatchedRules', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    sendMessage({
        what: 'showMatchedRules',
        tabId: currentTab.id,
    });
});

/******************************************************************************/

dom.on('#gotoReport', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    let url;
    try {
        url = new URL(currentTab.url);
    } catch {
    }
    if ( url === undefined ) { return; }
    const reportURL = new URL(runtime.getURL('/report.html'));
    reportURL.searchParams.set('tabid', currentTab.id);
    reportURL.searchParams.set('url', tabURL.href);
    reportURL.searchParams.set('mode', popupPanelData.level);
    sendMessage({
        what: 'gotoURL',
        url: `${reportURL.pathname}${reportURL.search}`,
    });
});

/******************************************************************************/

dom.on('#gotoDashboard, #gotoDashboardFooter', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    runtime.openOptionsPage();
});

/******************************************************************************/

dom.on('#gotoZapper', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [ '/js/scripting/tool-overlay.js', '/js/scripting/zapper.js' ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

dom.on('#gotoPicker', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/tool-overlay.js',
            '/js/scripting/picker.js',
        ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

dom.on('#gotoUnpicker', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/tool-overlay.js',
            '/js/scripting/unpicker.js',
        ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

async function init() {
    const [ tab ] = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if ( tab instanceof Object === false ) { return true; }
    Object.assign(currentTab, tab);

    let url;
    try {
        const strictBlockURL = runtime.getURL('/strictblock.');
        url = new URL(currentTab.url);
        if ( url.href.startsWith(strictBlockURL) ) {
            url = new URL(url.hash.slice(1));
        }
        tabURL.href = url.href || '';
    } catch {
        return false;
    }

    if ( url !== undefined ) {
        const response = await sendMessage({
            what: 'popupPanelData',
            origin: url.origin,
            hostname: tabURL.hostname,
        });
        if ( response instanceof Object ) {
            Object.assign(popupPanelData, response);
        }
    }

    renderAdminRules();

    renderPopupPolicy();
    renderPowerPanel();

    dom.text('#hostname', punycode.toUnicode(tabURL.hostname));

    dom.cl.toggle('#gotoMatchedRules', 'enabled',
        popupPanelData.isSideloaded === true &&
        popupPanelData.developerMode &&
        typeof currentTab.id === 'number' &&
        isNaN(currentTab.id) === false
    );

    const isHTTP = url.protocol === 'http:' || url.protocol === 'https:';
    dom.cl.toggle(dom.root, 'isHTTP', isHTTP);

    dom.cl.toggle('#gotoUnpicker', 'enabled', popupPanelData.hasCustomFilters);

    return true;
}

async function tryInit() {
    try {
        await init();
    } catch {
        setTimeout(tryInit, 100);
    } finally {
        dom.cl.remove(dom.body, 'loading', 'busy');
    }
}

tryInit();

/******************************************************************************/

