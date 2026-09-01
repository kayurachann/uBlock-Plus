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

import { browser, i18n, sendMessage } from './ext.js';
import { dom, qs$ } from './dom.js';
import { hashFromIterable } from './dashboard.js';
import { renderFilterLists } from './filter-lists.js';

/******************************************************************************/

function renderAdminRules() {
    const { disabledFeatures: forbid = [] } = self.cachedRulesetData;
    if ( forbid.length === 0 ) { return; }
    dom.body.dataset.forbid = forbid.join(' ');
    if ( forbid.includes('dashboard') ) {
        dom.body.dataset.pane = 'about';
    }
}

/******************************************************************************/

function renderWidgets() {
    const data = self.cachedRulesetData;
    if ( data.firstRun ) {
        dom.cl.add(dom.body, 'firstRun');
    }

    renderDefaultMode();

    qs$('#autoReload input[type="checkbox"]').checked = data.autoReload;

    {
        const input = qs$('#showBlockedCount input[type="checkbox"]');
        if ( data.canShowBlockedCount ) {
            input.checked = data.showBlockedCount;
        } else {
            input.checked = false;
            dom.attr(input, 'disabled', '');
        }
    }

    {
        const input = qs$('#strictBlockMode input[type="checkbox"]');
        const canStrictBlock = data.hasOmnipotence;
        input.checked = canStrictBlock && data.strictBlockMode;
        dom.attr(input, 'disabled', canStrictBlock ? null : '');
    }

    {
        const input = qs$('#popupBlockMode input[type="checkbox"]');
        input.checked = data.popupBlockMode;
    }

    {
        const state = Boolean(data.developerMode) &&
            data.disabledFeatures?.includes('develop') !== true;
        dom.body.dataset.develop = `${state}`;
        dom.prop('#developerMode input[type="checkbox"]', 'checked', state);
    }
}

/******************************************************************************/

function renderDefaultMode() {
    const defaultLevel = self.cachedRulesetData.defaultFilteringMode;
    if ( defaultLevel !== 0 ) {
        qs$(`.filteringModeCard input[type="radio"][value="${defaultLevel}"]`).checked = true;
    } else {
        dom.prop('.filteringModeCard input[type="radio"]', 'checked', false);
    }
}

/******************************************************************************/

const privacyControlDefinitions = new Map([
    [ 'privacyDisableHyperlinkAuditing', [
        { path: [ 'websites', 'hyperlinkAuditingEnabled' ], value: false },
    ] ],
    [ 'privacyDisableNetworkPrediction', [
        { path: [ 'network', 'networkPredictionEnabled' ], value: false },
    ] ],
    [ 'privacyProtectWebRTC', [
        { path: [ 'network', 'webRTCIPHandlingPolicy' ], value: 'disable_non_proxied_udp' },
    ] ],
    [ 'privacyDisableAdApis', [
        { path: [ 'websites', 'adMeasurementEnabled' ], value: false },
        { path: [ 'websites', 'fledgeEnabled' ], value: false },
        { path: [ 'websites', 'topicsEnabled' ], value: false },
    ] ],
]);

function privacySettingFromPath(path) {
    let setting = browser.privacy;
    for ( const prop of path ) {
        setting = setting?.[prop];
    }
    return setting;
}

function canControlPrivacySetting(details) {
    return details?.levelOfControl === 'controllable_by_this_extension' ||
        details?.levelOfControl === 'controlled_by_this_extension';
}

function reportPrivacyError(reason) {
    console.error(reason);
    const status = qs$('#privacyHardening .privacyPermissionStatus');
    if ( status !== null ) {
        dom.text(status, i18n.getMessage('privacySettingUpdateFailed'));
    }
}

async function renderPrivacyControls() {
    if ( browser.privacy instanceof Object === false ) { return; }
    const section = qs$('#privacyHardening');
    if ( section === null ) { return; }
    const hasPermission = await browser.permissions.contains({
        permissions: [ 'privacy' ],
    });
    dom.cl.toggle(section, 'hasPermission', hasPermission);
    if ( hasPermission === false ) { return; }

    for ( const [ id, definitions ] of privacyControlDefinitions ) {
        const input = qs$(`#${id} input[type="checkbox"]`);
        const legend = qs$(`#${id} + legend`);
        const available = definitions
            .map(definition => ({
                definition,
                setting: privacySettingFromPath(definition.path),
            }))
            .filter(entry => entry.setting instanceof Object);
        const details = await Promise.all(available.map(entry =>
            entry.setting.get({}).catch(( ) => undefined)
        ));
        const controllable = available.length !== 0 &&
            details.every(canControlPrivacySetting);
        input.disabled = controllable === false;
        input.checked = available.length !== 0 && details.every((entry, i) =>
            entry?.value === available[i].definition.value
        );
        dom.text(
            legend,
            controllable ? '' : i18n.getMessage('privacySettingNotControllable')
        );
    }
}

async function setPrivacyControl(id, state) {
    const definitions = privacyControlDefinitions.get(id);
    if ( definitions === undefined ) { return; }
    const status = qs$('#privacyHardening .privacyPermissionStatus');
    dom.text(status, '');
    const operations = [];
    for ( const definition of definitions ) {
        const setting = privacySettingFromPath(definition.path);
        if ( setting instanceof Object === false ) { continue; }
        operations.push(state
            ? setting.set({ scope: 'regular', value: definition.value })
            : setting.clear({ scope: 'regular' })
        );
    }
    const results = await Promise.allSettled(operations);
    if ( results.some(result => result.status === 'rejected') ) {
        dom.text(status, i18n.getMessage('privacySettingUpdateFailed'));
    }
    await renderPrivacyControls();
}

dom.on('#grantPrivacyPermission', 'click', async ( ) => {
    const status = qs$('#privacyHardening .privacyPermissionStatus');
    dom.text(status, '');
    const granted = await browser.permissions.request({
        permissions: [ 'privacy' ],
    }).catch(( ) => false);
    if ( granted === false ) {
        dom.text(status, i18n.getMessage('privacyPermissionDenied'));
    }
    await renderPrivacyControls().catch(reportPrivacyError);
});

dom.on('#privacyHardening .privacyControls', 'change', 'input[type="checkbox"]', ev => {
    const id = ev.target.closest('label')?.id;
    if ( id === undefined ) { return; }
    setPrivacyControl(id, ev.target.checked).catch(reportPrivacyError);
});

browser.permissions.onAdded.addListener(permissions => {
    if ( permissions.permissions?.includes('privacy') ) {
        renderPrivacyControls().catch(reportPrivacyError);
    }
});

browser.permissions.onRemoved.addListener(permissions => {
    if ( permissions.permissions?.includes('privacy') ) {
        renderPrivacyControls().catch(reportPrivacyError);
    }
});

/******************************************************************************/

const deviceMemoryGiB = globalThis.navigator?.deviceMemory;

function formatStorageBytes(value) {
    if ( Number.isFinite(value) === false ) {
        return i18n.getMessage('memoryProfileUnavailable');
    }
    const units = [ 'B', 'KiB', 'MiB', 'GiB' ];
    let amount = value;
    let unit = 0;
    while ( amount >= 1024 && unit < units.length - 1 ) {
        amount /= 1024;
        unit += 1;
    }
    const digits = unit === 0 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unit]}`;
}

function memoryProfileName(value) {
    const key = value === 'low-memory'
        ? 'memoryProfileLow'
        : value === 'balanced'
            ? 'memoryProfileBalanced'
            : 'memoryProfileAuto';
    return i18n.getMessage(key);
}

async function renderMemoryProfile(options = {}) {
    const section = qs$('#memoryProfile');
    if ( section === null ) { return; }
    const select = qs$('#memoryProfile select');
    const status = qs$('#memoryProfile .memoryProfileStatus');
    const metrics = qs$('#memoryProfile .memoryProfileMetrics');
    const profile = await sendMessage({
        what: 'getMemoryProfile',
        deviceMemoryGiB,
    });
    if ( profile instanceof Object === false ) { return; }
    select.value = profile.selected;
    dom.text(status, i18n.getMessage(
        'memoryProfileEffective',
        memoryProfileName(profile.effective)
    ));
    const telemetry = await sendMessage({
        what: 'getMemoryTelemetry',
        refresh: options.refresh === true,
        deviceMemoryGiB,
    });
    if ( telemetry instanceof Object === false ) { return; }
    dom.text(metrics, i18n.getMessage('memoryProfileStorageMetrics', [
        formatStorageBytes(telemetry.storage?.local?.bytes),
        formatStorageBytes(telemetry.storage?.session?.bytes),
    ]));
}

function reportMemoryProfileError(reason) {
    console.error(reason);
    dom.text(
        '#memoryProfile .memoryProfileStatus',
        i18n.getMessage('memoryProfileError')
    );
}

dom.on('#memoryProfile select', 'change', async ev => {
    ev.target.disabled = true;
    try {
        const profile = await sendMessage({
            what: 'setMemoryProfile',
            profile: ev.target.value,
            deviceMemoryGiB,
        });
        if ( profile instanceof Object === false ) {
            throw new Error('Memory profile update returned no result');
        }
        await renderMemoryProfile({ refresh: true });
    } catch ( reason ) {
        reportMemoryProfileError(reason);
    } finally {
        ev.target.disabled = false;
    }
});

dom.on('#memoryProfile .memoryProfileRefresh', 'click', ( ) => {
    renderMemoryProfile({ refresh: true }).catch(reportMemoryProfileError);
});

dom.on('#memoryProfile .memoryProfileCleanup', 'click', async ( ) => {
    try {
        const result = await sendMessage({
            what: 'runMemoryCleanup',
            deviceMemoryGiB,
        });
        if ( result instanceof Object === false ||
            result.cleanup instanceof Object === false ) {
            throw new Error('Memory cleanup returned no result');
        }
        await renderMemoryProfile({ refresh: true });
        const cleanupMessage = result?.cleanup?.skippedKeyCleanup
            ? i18n.getMessage('memoryProfileCleanupUnavailable')
            : i18n.getMessage(
                'memoryProfileCleanupDone',
                `${result?.cleanup?.removedLocalKeys ?? 0}`
            );
        dom.text(
            '#memoryProfile .memoryProfileStatus',
            cleanupMessage
        );
    } catch ( reason ) {
        reportMemoryProfileError(reason);
    }
});

/******************************************************************************/

async function onFilteringModeChange(ev) {
    const input = ev.target;
    const newLevel = parseInt(input.value, 10);
    const data = self.cachedRulesetData;

    switch ( newLevel ) {
    case 1: {
        const actualLevel = await sendMessage({
            what: 'setDefaultFilteringMode',
            level: newLevel,
        });
        data.defaultFilteringMode = actualLevel;
        break;
    }
    case 2:
    case 3: {
        const granted = await browser.permissions.request({
            origins: [ '<all_urls>' ],
        });
        if ( granted ) {
            const actualLevel = await sendMessage({
                what: 'setDefaultFilteringMode',
                level: newLevel,
            });
            data.defaultFilteringMode = actualLevel;
            data.hasOmnipotence = true;
        }
        break;
    }
    default:
        break;
    }
    renderWidgets();
}

dom.on('#defaultFilteringMode',
    'change',
    '.filteringModeCard input[type="radio"]',
    ev => { onFilteringModeChange(ev); }
);

/******************************************************************************/

const MAX_BACKUP_FILE_BYTES = 32 * 1024 * 1024;

async function backupSettings() {
    const api = await import('./backup-restore.js');
    const data = await api.backupToObject(self.cachedRulesetData);
    if ( data instanceof Object === false ) { return; }
    const json = JSON.stringify(data, null, 2)  + '\n';
    const a = document.createElement('a');
    a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(json)}`;
    dom.attr(a, 'download', 'my-ublock-plus-settings.json');
    dom.attr(a, 'type', 'application/json');
    a.click();
}

async function restoreSettings() {
    const promise = new Promise((resolve, reject) => {
        const input = qs$('section[data-pane="settings"] input[type="file"]');
        input.onchange = ev => {
            dom.cl.add(dom.body, 'busy');
            input.onchange = null;
            const file = ev.target.files[0];
            if ( file === undefined || file.name === '' ) { return resolve(); }
            if ( file.size > MAX_BACKUP_FILE_BYTES ) {
                return reject(new Error('Backup file exceeds the 32 MiB limit'));
            }
            const fr = new FileReader();
            fr.onerror = ( ) => {
                reject(fr.error || new Error('Unable to read backup file'));
            };
            fr.onload = ( ) => {
                fr.onload = null;
                fr.onerror = null;
                if ( typeof fr.result !== 'string' ) {
                    return reject(new Error('Backup file is not text'));
                }
                let data;
                try {
                    data = JSON.parse(fr.result);
                } catch {
                    return reject(new Error('Backup file is not valid JSON'));
                }
                if ( data instanceof Object === false ) {
                    return reject(new Error('Backup root must be an object'));
                }
                import('./backup-restore.js').then(
                    api => resolve(api.restoreFromObject(data)),
                    reject
                );
            };
            fr.readAsText(file);
        };
        input.oncancel = ( ) => {
            resolve();
        };
        // Reset to empty string, this will ensure a change event is properly
        // triggered if the user pick a file, even if it's the same as the last
        // one picked.
        input.value = '';
        input.click();
    });
    try {
        await promise;
        await renderMemoryProfile({ refresh: true });
    } finally {
        dom.cl.remove(dom.body, 'busy');
    }
}

async function resetSettings() {
    const response = self.confirm(i18n.getMessage('resetToDefaultConfirm'));
    if ( response !== true ) { return; }
    dom.cl.add(dom.body, 'busy');
    try {
        const api = await import('./backup-restore.js');
        await api.restoreFromObject({});
        await renderMemoryProfile({ refresh: true });
    } finally {
        dom.cl.remove(dom.body, 'busy');
    }
}

/******************************************************************************/

function updateSetting(message) {
    sendMessage(message).catch(reason => {
        console.error(reason);
        renderWidgets();
    });
}

dom.on('#autoReload input[type="checkbox"]', 'change', ev => {
    updateSetting({
        what: 'setAutoReload',
        state: ev.target.checked,
    });
});

dom.on('#showBlockedCount input[type="checkbox"]', 'change', ev => {
    updateSetting({
        what: 'setShowBlockedCount',
        state: ev.target.checked,
    });
});

dom.on('#strictBlockMode input[type="checkbox"]', 'change', ev => {
    updateSetting({
        what: 'setStrictBlockMode',
        state: ev.target.checked,
    });
});

dom.on('#popupBlockMode input[type="checkbox"]', 'change', ev => {
    updateSetting({
        what: 'setPopupBlockMode',
        state: ev.target.checked,
    });
});

dom.on('#developerMode input[type="checkbox"]', 'change', ev => {
    const state = ev.target.checked;
    updateSetting({ what: 'setDeveloperMode', state });
    dom.body.dataset.develop = `${state}`;
});

dom.on('section[data-pane="settings"] button:has([data-i18n="backupButton"])', 'click', ( ) => {
    backupSettings().catch(reason => console.error(reason));
});

dom.on('section[data-pane="settings"] button:has([data-i18n="restoreButton"])', 'click', ( ) => {
    restoreSettings().catch(reason => console.error(reason));
});

dom.on('section[data-pane="settings"] button:has([data-i18n="resetToDefaultButton"])', 'click', ( ) => {
    resetSettings().catch(reason => console.error(reason));
});

/******************************************************************************/

function listen() {
    const bc = new self.BroadcastChannel('uBlockPlus');
    bc.onmessage = listen.onmessage;
}

listen.onmessage = ev => {
    const message = ev.data;
    if ( message instanceof Object === false ) { return; }
    const local = self.cachedRulesetData;
    let render = false;
    let renderLists = false;

    if ( message.hasOmnipotence !== undefined ) {
        if ( message.hasOmnipotence !== local.hasOmnipotence ) {
            local.hasOmnipotence = message.hasOmnipotence;
            render = true;
        }
    }

    if ( message.defaultFilteringMode !== undefined ) {
        if ( message.defaultFilteringMode !== local.defaultFilteringMode ) {
            local.defaultFilteringMode = message.defaultFilteringMode;
            render = true;
        }
    }

    if ( message.autoReload !== undefined ) {
        if ( message.autoReload !== local.autoReload ) {
            local.autoReload = message.autoReload;
            render = true;
        }
    }

    if ( message.showBlockedCount !== undefined ) {
        if ( message.showBlockedCount !== local.showBlockedCount ) {
            local.showBlockedCount = message.showBlockedCount;
            render = true;
        }
    }

    if ( message.strictBlockMode !== undefined ) {
        if ( message.strictBlockMode !== local.strictBlockMode ) {
            local.strictBlockMode = message.strictBlockMode;
            render = true;
        }
    }

    if ( message.popupBlockMode !== undefined ) {
        if ( message.popupBlockMode !== local.popupBlockMode ) {
            local.popupBlockMode = message.popupBlockMode;
            render = true;
        }
    }

    if ( message.developerMode !== undefined ) {
        if ( message.developerMode !== local.developerMode ) {
            local.developerMode = message.developerMode;
            render = true;
        }
    }

    if ( message.adminRulesets !== undefined ) {
        if ( hashFromIterable(message.adminRulesets) !== hashFromIterable(local.adminRulesets) ) {
            local.adminRulesets = message.adminRulesets;
            renderLists = true;
        }
    }

    if ( message.enabledRulesets !== undefined ) {
        local.enabledRulesets = message.enabledRulesets;
        renderLists = true;
    }

    if ( render ) {
        renderWidgets();
    }
    if ( renderLists ) {
        renderFilterLists(true);
    }
};

/******************************************************************************/

self.cachedRulesetData = {};

sendMessage({
    what: 'getOptionsPageData',
}).then(async data => {
    if ( !data ) { return; }
    self.cachedRulesetData = data;
    const supports = []
    if ( data.supportsUserScripts ) {
        supports.push('user-scripts');
    }
    if ( data.supportsCompiledFilters ) {
        supports.push('compiled-filters');
    }
    dom.body.dataset.supports = supports.join(' ');
    try {
        renderAdminRules();
        renderWidgets();
        await Promise.all([
            renderPrivacyControls(),
            renderMemoryProfile(),
        ]);
    } catch(reason) {
        console.error(reason);
    } finally {
        dom.cl.remove(dom.body, 'loading');
    }
    listen();
}).catch(reason => {
    console.error(reason);
});

/******************************************************************************/
