/*******************************************************************************

    uBlock Plus+ - original-first settings, site rules and diagnostics
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import {
    POWER_PROFILES,
    matchingPowerProfile,
} from './power-ui-core.js';
import { browser, i18n, sendMessage } from './ext.js';
import { dom, qs$, qsa$ } from './dom.js';
import {
    getPowerUISettings,
    setPowerUISettings,
} from './power-ui.js';
import { capabilityDetailsRows } from './runtime-capabilities-ui.js';

let operationTimer;
let profileState;
let siteRulesLoaded = false;
let diagnosticsLoaded = false;
let diagnosticsLoading = false;

function message(key, substitutions) {
    return i18n.getMessage(key, substitutions) || key;
}

function setOperationStatus(text, level = 'info') {
    const node = qs$('#operationStatus');
    if ( node === null ) { return; }
    self.clearTimeout(operationTimer);
    node.dataset.level = level;
    dom.text(node, text);
    if ( text !== '' ) {
        operationTimer = self.setTimeout(( ) => {
            dom.text(node, '');
            delete node.dataset.level;
        }, level === 'error' ? 9000 : 5000);
    }
}

async function readProtectionState() {
    const [ options, memory ] = await Promise.all([
        sendMessage({ what: 'getOptionsPageData' }),
        sendMessage({ what: 'getMemoryProfile' }),
    ]);
    return {
        options,
        memory,
        comparable: {
            defaultFilteringMode: options.defaultFilteringMode,
            autoReload: options.autoReload,
            showBlockedCount: options.showBlockedCount,
            strictBlockMode: options.strictBlockMode,
            popupBlockMode: options.popupBlockMode,
            memoryProfile: memory.selected,
        },
    };
}

function renderProtectionProfile(state) {
    profileState = state;
    const matched = matchingPowerProfile(state.comparable);
    const input = qs$(`input[name="powerProfile"][value="${matched}"]`);
    for ( const node of qsa$('input[name="powerProfile"]') ) {
        node.checked = node === input;
    }
    const label = matched === 'custom'
        ? message('protectionProfileCustomActive')
        : message('protectionProfileActive', [
            message(`protectionProfile${matched[0].toUpperCase()}${matched.slice(1)}`),
        ]);
    dom.text('#protectionProfiles .powerProfileState', label);
}

async function writeProtectionState(state) {
    await sendMessage({
        what: 'setDefaultFilteringMode',
        level: state.defaultFilteringMode,
    });
    await sendMessage({ what: 'setAutoReload', state: state.autoReload });
    await sendMessage({
        what: 'setShowBlockedCount',
        state: state.showBlockedCount,
    });
    await sendMessage({
        what: 'setStrictBlockMode',
        state: state.strictBlockMode,
    });
    await sendMessage({
        what: 'setPopupBlockMode',
        state: state.popupBlockMode,
    });
    await sendMessage({
        what: 'setMemoryProfile',
        profile: state.memoryProfile,
        deviceMemoryGiB: globalThis.navigator?.deviceMemory,
    });
}

async function applyProtectionProfile(name) {
    const profile = POWER_PROFILES[name];
    if ( profile === undefined ) { return; }
    const button = qs$('#applyProtectionProfile');
    button.disabled = true;
    setOperationStatus(message('protectionProfileApplying'));
    let before;
    try {
        if ( profileState === undefined ) {
            renderProtectionProfile(await readProtectionState());
        }
        before = { ...profileState.comparable };
        if (
            profile.defaultFilteringMode > 1 &&
            profileState.options.hasOmnipotence !== true
        ) {
            const granted = await browser.permissions.request({
                origins: [ '<all_urls>' ],
            }).catch(( ) => false);
            if ( granted !== true ) {
                throw new Error(message('protectionProfilePermissionDenied'));
            }
        }
        await writeProtectionState(profile);
        renderProtectionProfile(await readProtectionState());
        setOperationStatus(message('protectionProfileApplied'));
    } catch ( reason ) {
        if ( before !== undefined ) {
            await writeProtectionState(before).catch(( ) => { });
        }
        setOperationStatus(
            reason?.message || message('protectionProfileApplyFailed'),
            'error'
        );
        try {
            renderProtectionProfile(await readProtectionState());
        } catch {
        }
    } finally {
        button.disabled = false;
    }
}

dom.on('#applyProtectionProfile', 'click', ( ) => {
    const selected = qs$('input[name="powerProfile"]:checked')?.value;
    applyProtectionProfile(selected);
});

async function renderAppearanceSettings() {
    const settings = await getPowerUISettings();
    for ( const select of qsa$('[data-power-ui]') ) {
        select.value = settings[select.dataset.powerUi];
    }
}

dom.on('#appearanceSettings', 'change', '[data-power-ui]', async ( ) => {
    const settings = await getPowerUISettings();
    for ( const select of qsa$('[data-power-ui]') ) {
        settings[select.dataset.powerUi] = select.value;
    }
    try {
        await setPowerUISettings(settings);
        setOperationStatus(message('appearanceSettingsSaved'));
    } catch {
        setOperationStatus(message('appearanceSettingsSaveFailed'), 'error');
        renderAppearanceSettings();
    }
});

function createPolicyModeSelect(hostname, currentMode) {
    const select = document.createElement('select');
    select.dataset.hostname = hostname;
    select.setAttribute(
        'aria-label',
        `${message('popupPolicyLabel')}: ${hostname}`
    );
    for ( const mode of [ 'allow', 'block', 'strict' ] ) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = message(mode === 'block'
            ? 'popupPolicySmart'
            : `popupPolicy${mode[0].toUpperCase()}${mode.slice(1)}`
        );
        option.selected = mode === currentMode;
        select.append(option);
    }
    return select;
}

function renderPopupPolicies(details) {
    const tbody = qs$('#popupPolicyRows');
    tbody.replaceChildren();
    const entries = Object.entries(details?.policies || {})
        .sort(([ a ], [ b ]) => a.localeCompare(b));
    for ( const [ hostname, mode ] of entries ) {
        const row = document.createElement('tr');
        const hostCell = document.createElement('td');
        hostCell.textContent = hostname;
        const modeCell = document.createElement('td');
        modeCell.append(createPolicyModeSelect(hostname, mode));
        const actionCell = document.createElement('td');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.removeHostname = hostname;
        remove.textContent = message('popupPolicyRemove');
        actionCell.append(remove);
        row.append(hostCell, modeCell, actionCell);
        tbody.append(row);
    }
    dom.cl.toggle('#popupPolicyEmpty', 'hidden', entries.length !== 0);
}

async function refreshPopupPolicies() {
    renderPopupPolicies(await sendMessage({ what: 'getPopupPolicies' }));
}

dom.on('#popupPolicyForm', 'submit', async ev => {
    ev.preventDefault();
    const hostname = qs$('#popupPolicyHostname').value.trim().toLowerCase();
    const mode = qs$('#popupPolicyMode').value;
    if ( hostname === '' ) { return; }
    try {
        await sendMessage({ what: 'setPopupPolicy', hostname, mode });
        qs$('#popupPolicyHostname').value = '';
        await refreshPopupPolicies();
        setOperationStatus(message('popupPolicySaved'));
    } catch {
        setOperationStatus(message('popupPolicyInvalidHostname'), 'error');
    }
});

dom.on('#popupPolicyRows', 'change', 'select[data-hostname]', async ev => {
    try {
        await sendMessage({
            what: 'setPopupPolicy',
            hostname: ev.target.dataset.hostname,
            mode: ev.target.value,
        });
        setOperationStatus(message('popupPolicySaved'));
    } catch {
        await refreshPopupPolicies();
        setOperationStatus(message('popupPolicySaveFailed'), 'error');
    }
});

dom.on('#popupPolicyRows', 'click', 'button[data-remove-hostname]', async ev => {
    try {
        await sendMessage({
            what: 'setPopupPolicy',
            hostname: ev.target.dataset.removeHostname,
            mode: 'default',
        });
        await refreshPopupPolicies();
        setOperationStatus(message('popupPolicyRemoved'));
    } catch {
        setOperationStatus(message('popupPolicySaveFailed'), 'error');
    }
});

function textFromHostnames(hostnames) {
    return Array.isArray(hostnames) ? hostnames.join('\n') : '';
}

function hostnamesFromText(text) {
    const out = [];
    for ( const raw of text.split(/\r?\n/) ) {
        const hostname = raw.trim().toLowerCase();
        if ( hostname === '' || hostname.startsWith('#') ) { continue; }
        if ( hostname.length > 1024 || /\s/.test(hostname) ) {
            throw new TypeError('invalid hostname');
        }
        if ( out.includes(hostname) === false ) { out.push(hostname); }
        if ( out.length > 100000 ) { throw new RangeError('too many rules'); }
    }
    return out;
}

async function refreshFilteringSiteRules() {
    const modes = await sendMessage({ what: 'getFilteringModeDetails' });
    for ( const textarea of qsa$('#filteringSiteRules textarea[data-mode]') ) {
        textarea.value = textFromHostnames(modes[textarea.dataset.mode]);
    }
}

dom.on('#saveFilteringSiteRules', 'click', async ev => {
    ev.target.disabled = true;
    try {
        const modes = {};
        const seen = new Set();
        for ( const textarea of qsa$('#filteringSiteRules textarea[data-mode]') ) {
            const hostnames = hostnamesFromText(textarea.value);
            for ( const hostname of hostnames ) {
                if ( seen.has(hostname) ) {
                    throw new TypeError('duplicate hostname');
                }
                seen.add(hostname);
            }
            modes[textarea.dataset.mode] = hostnames;
        }
        const saved = await sendMessage({
            what: 'setFilteringModeDetails',
            modes,
        });
        for ( const textarea of qsa$('#filteringSiteRules textarea[data-mode]') ) {
            textarea.value = textFromHostnames(saved[textarea.dataset.mode]);
        }
        setOperationStatus(message('siteRulesSaved'));
    } catch {
        setOperationStatus(message('siteRulesInvalid'), 'error');
    } finally {
        ev.target.disabled = false;
    }
});

async function loadSiteRules() {
    if ( siteRulesLoaded ) { return; }
    siteRulesLoaded = true;
    try {
        await Promise.all([
            refreshPopupPolicies(),
            refreshFilteringSiteRules(),
        ]);
    } catch {
        siteRulesLoaded = false;
        setOperationStatus(message('siteRulesLoadFailed'), 'error');
    }
}

function appendDefinitionList(list, entries) {
    list.replaceChildren();
    for ( const [ label, value ] of entries ) {
        const term = document.createElement('dt');
        term.textContent = label;
        const definition = document.createElement('dd');
        definition.textContent = value;
        list.append(term, definition);
    }
}

function availability(value) {
    return message(value === true ? 'diagnosticsAvailable' : 'diagnosticsUnavailable');
}

function formatQuota(value) {
    return Number.isSafeInteger(value) ? value.toLocaleString() : '—';
}

function renderCapabilities(capabilities) {
    const quotas = capabilities?.quotas || {};
    appendDefinitionList(qs$('#runtimeCapabilities'), [
        [ message('diagnosticsNetworkEngine'), capabilities.activeNetworkEngine || '—' ],
        [ message('diagnosticsInstallType'), capabilities.installType || '—' ],
        [ message('diagnosticsPopupObservation'), availability(capabilities.smartPopupObservation) ],
        [ message('diagnosticsUserScripts'), availability(capabilities.userScripts) ],
        [ message('diagnosticsOffscreenCompiler'), availability(capabilities.offscreenCompilation) ],
        ...capabilityDetailsRows(capabilities, i18n.getUILanguage?.() || navigator.language),
        [ message('diagnosticsStaticRules'), formatQuota(quotas.availableStaticRules) ],
        [ message('diagnosticsDynamicRules'), formatQuota(quotas.dynamicRules) ],
        [ message('diagnosticsSessionRules'), formatQuota(quotas.sessionRules) ],
        [ message('diagnosticsRegexRules'), formatQuota(quotas.regexRules) ],
    ]);
}

function renderPerformance(profile) {
    appendDefinitionList(qs$('#performanceDetails'), [
        [ message('performanceSelectedProfile'), profile.selected || '—' ],
        [ message('performanceEffectiveProfile'), profile.effective || '—' ],
        [ message('performanceDeviceMemory'), profile.deviceMemoryGiB === null
            ? '—'
            : `${profile.deviceMemoryGiB} GiB` ],
        [ message('performanceCompileConcurrency'), `${profile.importCompileConcurrency ?? '—'}` ],
        [ message('performanceCacheEntries'), `${profile.cssCacheMaxEntries ?? '—'}` ],
        [ message('performanceCacheHighWatermark'), `${profile.cssCacheHighWatermark ?? '—'}` ],
        [ message('performancePruneInterval'), profile.cssCachePruneMinutes === undefined
            ? '—'
            : message('performanceMinutes', [ `${profile.cssCachePruneMinutes}` ]) ],
        [ message('performanceRetainMetadata'), availability(profile.retainScriptingMetadata) ],
    ]);
}

function renderPopupDiagnostics(entries) {
    const tbody = qs$('#popupDiagnosticRows');
    tbody.replaceChildren();
    for ( const entry of entries.slice().reverse() ) {
        const row = document.createElement('tr');
        const values = [
            entry.at ? new Date(entry.at).toLocaleString() : '—',
            entry.action,
            entry.openerHostname || '—',
            entry.targetHostname || '—',
            entry.reason,
        ];
        for ( let i = 0; i < values.length; i++ ) {
            const cell = document.createElement('td');
            cell.textContent = values[i] || '—';
            if ( i === 1 ) { cell.dataset.action = entry.action; }
            row.append(cell);
        }
        tbody.append(row);
    }
    dom.cl.toggle('#popupDiagnosticsEmpty', 'hidden', entries.length !== 0);
}

async function refreshDiagnostics() {
    if ( diagnosticsLoading ) { return; }
    diagnosticsLoading = true;
    const button = qs$('#refreshDiagnostics');
    button.disabled = true;
    try {
        const [ capabilities, profile, diagnostics ] = await Promise.all([
            sendMessage({ what: 'getRuntimeCapabilities' }),
            sendMessage({
                what: 'getMemoryProfile',
                deviceMemoryGiB: globalThis.navigator?.deviceMemory,
            }),
            sendMessage({ what: 'getPopupDiagnostics' }),
        ]);
        renderCapabilities(capabilities);
        renderPerformance(profile);
        renderPopupDiagnostics(diagnostics);
        diagnosticsLoaded = true;
    } catch {
        setOperationStatus(message('diagnosticsLoadFailed'), 'error');
    } finally {
        diagnosticsLoading = false;
        button.disabled = false;
    }
}

dom.on('#refreshDiagnostics', 'click', refreshDiagnostics);

dom.on('#clearPopupDiagnostics', 'click', async ( ) => {
    try {
        await sendMessage({ what: 'clearPopupDiagnostics' });
        renderPopupDiagnostics([]);
        setOperationStatus(message('popupDiagnosticsCleared'));
    } catch {
        setOperationStatus(message('popupDiagnosticsClearFailed'), 'error');
    }
});

function loadActivePane() {
    if ( dom.body.dataset.pane === 'siteRules' ) {
        loadSiteRules();
    } else if ( dom.body.dataset.pane === 'diagnostics' &&
        diagnosticsLoaded === false ) {
        refreshDiagnostics();
    }
}

dom.on('#dashboard-nav', 'click', '.tabButton', ( ) => {
    loadActivePane();
});

new MutationObserver(loadActivePane).observe(dom.body, {
    attributes: true,
    attributeFilter: [ 'data-pane' ],
});

async function init() {
    try {
        await Promise.all([
            readProtectionState().then(renderProtectionProfile),
            renderAppearanceSettings(),
        ]);
    } catch {
        setOperationStatus(message('powerSettingsLoadFailed'), 'error');
    }
    loadActivePane();
}

init();

/******************************************************************************/
