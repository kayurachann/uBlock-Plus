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
    listenForPowerUISettings,
    setPowerUISettings,
} from './power-ui.js';
import {
    normalizeFilteringModes,
    normalizeModeHostname,
} from './backup-schema.js';
import { capabilityDetailsRows } from './runtime-capabilities-ui.js';
import { setOperationStatus } from './dashboard.js';

let siteRulesLoaded = false;
let siteRulesLoading = false;
let siteRulesSaving = false;
let diagnosticsLoaded = false;
let diagnosticsLoading = false;
let lastCapabilities;
// Only the newest regex-capacity answer is shown: a slow refresh must not
// replace the result of a later 'Check now'.
let regexCapacityRequests = 0;
let regexVerifying = false;
let protectionRefreshTimer;
// Profile whose radio this page last checked to show the live settings. Any
// other checked radio, or none, is a choice the user has not applied yet.
let renderedProfile;

// Text of each Site Rules textarea as last loaded or saved, to tell a user
// draft apart from rules changed elsewhere.
const siteRulesBaseline = new Map();

function message(key, substitutions) {
    return i18n.getMessage(key, substitutions) || key;
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

function renderProtectionProfile(state, { keepChoice = false } = {}) {
    const matched = matchingPowerProfile(state.comparable);
    const checked = qs$('input[name="powerProfile"]:checked')?.value ?? 'custom';
    if ( keepChoice === false || checked === renderedProfile ) {
        const input = qs$(`input[name="powerProfile"][value="${matched}"]`);
        for ( const node of qsa$('input[name="powerProfile"]') ) {
            node.checked = node === input;
        }
        renderedProfile = matched;
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
    if ( profile === undefined ) {
        setOperationStatus(message('protectionProfileSelectRequired'), 'error');
        return;
    }
    const button = qs$('#applyProtectionProfile');
    button.disabled = true;
    setOperationStatus(message('protectionProfileApplying'));
    let before;
    try {
        // Ask while the click is still a user gesture. Chrome resolves at
        // once, without a prompt, when access is already granted.
        if ( profile.defaultFilteringMode > 1 ) {
            const granted = await browser.permissions.request({
                origins: [ '<all_urls>' ],
            }).catch(( ) => false);
            if ( granted !== true ) {
                throw new Error(message('protectionProfilePermissionDenied'));
            }
        }
        // Roll back only once a write may have happened, and only to the
        // live settings: the Settings pane or popup may have changed them
        // since this page rendered the profile.
        const current = await readProtectionState();
        before = { ...current.comparable };
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

// Settings, popup, restore and reset change the same values. Coalesce their
// notifications into one read of the live state. The label always follows
// it; a radio the user checked but has not applied yet stays checked.
function refreshProtectionProfileSoon() {
    self.clearTimeout(protectionRefreshTimer);
    protectionRefreshTimer = self.setTimeout(( ) => {
        readProtectionState().then(state => {
            renderProtectionProfile(state, { keepChoice: true });
        }).catch(reason => {
            console.error(reason);
        });
    }, 50);
}

async function renderAppearanceSettings(settings) {
    settings ??= await getPowerUISettings();
    for ( const select of qsa$('[data-power-ui]') ) {
        select.value = settings[select.dataset.powerUi];
    }
}

dom.on('#appearanceSettings', 'change', '[data-power-ui]', async ev => {
    // Write only the changed preference over the stored ones: the popup
    // layout toggle and backup restore also write this storage entry.
    const key = ev.target.dataset.powerUi;
    try {
        const current = await getPowerUISettings({ refresh: true });
        await setPowerUISettings({ ...current, [key]: ev.target.value });
        setOperationStatus(message('appearanceSettingsSaved'));
    } catch {
        setOperationStatus(message('appearanceSettingsSaveFailed'), 'error');
        renderAppearanceSettings(await getPowerUISettings({ refresh: true }));
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
    // Broadcast mode details carry Sets, message responses carry arrays.
    return Array.from(hostnames || []).join('\n');
}

class SiteRulesError extends Error {
    constructor(key, detail) {
        super(`${key}: ${detail}`);
        this.key = key;
        this.detail = detail;
    }
}

function siteRuleTextareas() {
    return Array.from(qsa$('#filteringSiteRules textarea[data-mode]'));
}

// Apply the rules of the Advanced modes editor and of backups, so that saved
// site rules can always be restored: canonical hostnames (punycode, no
// wildcards or URLs) and exactly one `all-urls` global default.
function modesFromSiteRuleTexts(texts) {
    const modes = {};
    const seen = new Map();
    let defaults = 0;
    for ( const [ mode, text ] of texts ) {
        const hostnames = [];
        for ( const raw of text.split(/\r?\n/) ) {
            const line = raw.trim();
            if ( line === '' || line.startsWith('#') ) { continue; }
            let hostname;
            try {
                hostname = normalizeModeHostname(line.toLowerCase());
            } catch {
                throw new SiteRulesError('siteRulesInvalidHostname', line);
            }
            const seenIn = seen.get(hostname);
            if ( seenIn === mode ) { continue; }
            if ( seenIn !== undefined ) {
                throw new SiteRulesError('siteRulesDuplicateHostname', line);
            }
            seen.set(hostname, mode);
            hostnames.push(hostname);
            if ( hostname === 'all-urls' ) { defaults += 1; }
        }
        modes[mode] = hostnames;
    }
    if ( defaults !== 1 ) {
        throw new SiteRulesError('siteRulesDefaultRequired', 'all-urls');
    }
    try {
        return normalizeFilteringModes(modes);
    } catch ( reason ) {
        // For example, more hostnames than a backup may contain.
        throw new SiteRulesError('siteRulesInvalid', reason.message);
    }
}

function renderFilteringSiteRules(modes) {
    for ( const textarea of siteRuleTextareas() ) {
        const text = textFromHostnames(modes?.[textarea.dataset.mode]);
        textarea.value = text;
        siteRulesBaseline.set(textarea.dataset.mode, text);
    }
}

function siteRulesDirty() {
    return siteRuleTextareas().some(textarea =>
        textarea.value !== (siteRulesBaseline.get(textarea.dataset.mode) ?? '')
    );
}

function sameSiteRules(a, b) {
    return siteRuleTextareas().every(textarea =>
        textFromHostnames(a?.[textarea.dataset.mode]) ===
            textFromHostnames(b?.[textarea.dataset.mode])
    );
}

function siteRulesMatchBaseline(modes) {
    return siteRuleTextareas().every(textarea =>
        textFromHostnames(modes?.[textarea.dataset.mode]) ===
            (siteRulesBaseline.get(textarea.dataset.mode) ?? '')
    );
}

async function refreshFilteringSiteRules() {
    renderFilteringSiteRules(
        await sendMessage({ what: 'getFilteringModeDetails' })
    );
}

// Committed mode changes from the popup, a restore or another editor.
function onFilteringModeDetailsChanged(modes) {
    if ( siteRulesLoaded === false || siteRulesSaving ) { return; }
    if ( siteRulesDirty() ) { return; }
    renderFilteringSiteRules(modes);
}

dom.on('#saveFilteringSiteRules', 'click', async ev => {
    ev.target.disabled = true;
    siteRulesSaving = true;
    try {
        const modes = modesFromSiteRuleTexts(siteRuleTextareas().map(
            textarea => [ textarea.dataset.mode, textarea.value ]
        ));
        // A save replaces every site mode. Do not silently undo a change
        // made elsewhere after this draft was loaded: warn, keep the draft,
        // and let a second Save overwrite deliberately.
        const current = await sendMessage({ what: 'getFilteringModeDetails' });
        // Already stored, e.g. by a save whose response was an error from a
        // later step.
        if ( sameSiteRules(current, modes) ) {
            renderFilteringSiteRules(current);
            setOperationStatus(message('siteRulesSaved'));
            return;
        }
        if ( siteRulesMatchBaseline(current) === false ) {
            for ( const textarea of siteRuleTextareas() ) {
                siteRulesBaseline.set(
                    textarea.dataset.mode,
                    textFromHostnames(current?.[textarea.dataset.mode])
                );
            }
            setOperationStatus(message('siteRulesChangedElsewhere'), 'error');
            return;
        }
        const saved = await sendMessage({
            what: 'setFilteringModeDetails',
            modes,
        });
        renderFilteringSiteRules(saved);
        setOperationStatus(message('siteRulesSaved'));
    } catch ( reason ) {
        if ( reason instanceof SiteRulesError ) {
            setOperationStatus(
                i18n.getMessage(reason.key, [ reason.detail ]) ||
                    message('siteRulesInvalid'),
                'error'
            );
        } else {
            const detail = reason?.message || `${reason}`;
            setOperationStatus(
                i18n.getMessage('siteRulesSaveFailed', [ detail ]) || detail,
                'error'
            );
        }
    } finally {
        siteRulesSaving = false;
        ev.target.disabled = false;
    }
});

// Reload on every visit, but never replace an unsaved draft.
async function loadSiteRules() {
    if ( siteRulesLoading ) { return; }
    siteRulesLoading = true;
    try {
        await Promise.all([
            refreshPopupPolicies(),
            siteRulesDirty() ? undefined : refreshFilteringSiteRules(),
        ]);
        siteRulesLoaded = true;
    } catch {
        setOperationStatus(message('siteRulesLoadFailed'), 'error');
    } finally {
        siteRulesLoading = false;
    }
}

// [ label, value, title?, items? ]: `items` are shown as a list under the
// value, where keyboard, touch and screen-reader users can read them too.
function appendDefinitionList(list, entries) {
    list.replaceChildren();
    for ( const [ label, value, title, items ] of entries ) {
        const term = document.createElement('dt');
        term.textContent = label;
        const definition = document.createElement('dd');
        definition.textContent = value;
        if ( title ) { definition.title = title; }
        if ( Array.isArray(items) && items.length !== 0 ) {
            const itemList = document.createElement('ul');
            itemList.className = 'definitionItems';
            for ( const item of items ) {
                const entry = document.createElement('li');
                const code = document.createElement('code');
                code.textContent = item;
                entry.append(code);
                itemList.append(entry);
            }
            definition.append(itemList);
        }
        list.append(term, definition);
    }
}

function availability(value) {
    return message(value === true ? 'diagnosticsAvailable' : 'diagnosticsUnavailable');
}

function formatQuota(value) {
    return Number.isSafeInteger(value) ? value.toLocaleString() : '—';
}

const countOf = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

// How the strict-block page learns the blocked address, as classified by
// runtime-capabilities-core.js: the browser reports it (webRequest or
// rule-match events), the redirect carries it in the page's own address
// (Firefox), only the start of the navigation is known, or nothing is.
const strictBlockAddressKeys = new Map([
    [ 'webrequest', 'diagnosticsStrictBlockAddressExact' ],
    [ 'rule-match', 'diagnosticsStrictBlockAddressExact' ],
    [ 'regex-substitution', 'diagnosticsStrictBlockAddressFragment' ],
    [ 'navigation-start', 'diagnosticsStrictBlockAddressApproximate' ],
]);

function strictBlockAddressText(source) {
    return message(
        strictBlockAddressKeys.get(source) ??
            'diagnosticsStrictBlockAddressUnavailable'
    );
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
        [ message('diagnosticsStrictBlockAddress'), strictBlockAddressText(capabilities.strictBlockUrlSource) ],
        [ message('diagnosticsStaticRules'), formatQuota(quotas.availableStaticRules) ],
        [ message('diagnosticsDynamicRules'), formatQuota(quotas.dynamicRules) ],
        [ message('diagnosticsSessionRules'), formatQuota(quotas.sessionRules) ],
        [ message('diagnosticsRegexRules'), formatQuota(quotas.regexRules) ],
    ]);
    renderStrictBlockAddressSetup(capabilities);
    renderWebRequestSetup(capabilities);
}

// The optional webRequest permission is the cheapest exact address source
// (main-frame redirects only). Offer it only where this browser can still
// grant it and the page does not already get the address from it.
function renderStrictBlockAddressSetup(capabilities) {
    const setup = qs$('#strictBlockAddressSetup');
    if ( setup === null ) { return; }
    setup.hidden = capabilities.networkObservationRequestable !== true ||
        capabilities.networkObservationPermissionGranted === true ||
        capabilities.strictBlockUrlSource === 'webrequest' ||
        capabilities.strictBlockUrlSource === 'regex-substitution';
}

dom.on('#grantStrictBlockWebRequest', 'click', async ( ) => {
    const button = qs$('#grantStrictBlockWebRequest');
    button.disabled = true;
    try {
        // Ask first, while the click is still a user gesture.
        const granted = await browser.permissions.request({
            permissions: [ 'webRequest' ],
        }).catch(( ) => false);
        if ( granted !== true ) {
            setOperationStatus(message('loggerPermissionRefused'), 'error');
            return;
        }
        setOperationStatus(message('diagnosticsStrictBlockAddressGranted'));
        await refreshDiagnostics();
        // The worker switches to the new source on permissions.onAdded,
        // which can arrive after this page asked: show what it reports
        // once more, without assuming the switch happened.
        if ( lastCapabilities?.strictBlockUrlSource !== 'webrequest' ) {
            await new Promise(resolve => { self.setTimeout(resolve, 1000); });
            await refreshDiagnostics();
        }
    } finally {
        button.disabled = false;
    }
});

/******************************************************************************/

// Regex rule capacity: the report of ruleset-manager.js getRegexCapacity()
// (schema in regex-capacity.js summarizeRegexCapacity). Every number is what
// the browser or the package reports; an unknown one is shown as such.

function regexUsage(used, limit) {
    return message('diagnosticsRegexUsage', [
        formatQuota(used),
        formatQuota(limit),
    ]);
}

// Built-in regex rules this browser skipped at the last 'Check now' for this
// version and browser. Not checked is not zero.
function regexSkippedText(staticPool) {
    if ( staticPool.enabled === 0 ) { return formatQuota(0); }
    const skipped = staticPool.skippedByBrowser;
    if ( Number.isSafeInteger(skipped) === false ) {
        return message('diagnosticsRegexNotChecked');
    }
    if ( Number.isFinite(staticPool.checkedAt) === false ) {
        return formatQuota(skipped);
    }
    return `${formatQuota(skipped)} · ${new Date(staticPool.checkedAt).toLocaleString()}`;
}

function regexCapacityRows(report) {
    const staticPool = report.static ?? {};
    const shared = report.shared ?? {};
    const dynamic = shared.dynamic ?? {};
    const session = shared.session ?? {};
    const samples = Array.isArray(staticPool.skippedSamples)
        ? staticPool.skippedSamples
        : [];
    const sampleLines = samples.map(sample =>
        `${sample.rulesetId}: ${sample.regex}`
    );
    const rows = [
        [ message('diagnosticsRegexStatic'), regexUsage(staticPool.enabled, staticPool.limit) ],
        [ message('diagnosticsRegexVerifiedWith'), typeof staticPool.verifiedWith === 'string' &&
            staticPool.verifiedWith !== ''
            ? staticPool.verifiedWith
            : message('diagnosticsRegexNotVerified') ],
        [ message('diagnosticsRegexRejectedAtBuild'), formatQuota(staticPool.rejectedAtBuild) ],
        [ message('diagnosticsRegexSkipped'), regexSkippedText(staticPool),
            sampleLines.join('\n'), sampleLines ],
        [ message('diagnosticsRegexShared'), regexUsage(shared.used, shared.limit) ],
        [ message('diagnosticsRegexUser'), formatQuota(dynamic.user) ],
        [ message('diagnosticsRegexStrictBlock'), formatQuota(session.strictBlock) ],
    ];
    // Only where they exist, so that the rows add up to the shared usage:
    // built-in regex rules installed as dynamic rules (Firefox, or a list
    // over the built-in limit) and the shared pool's other owners.
    if ( countOf(dynamic.stockFallback) !== 0 ) {
        rows.push([ message('diagnosticsRegexStockFallback'), formatQuota(dynamic.stockFallback) ]);
    }
    const other = countOf(dynamic.other) + countOf(session.other);
    if ( other !== 0 ) {
        rows.push([ message('diagnosticsRegexOther'), formatQuota(other) ]);
    }
    const notEnabled = Array.isArray(report.rulesetsNotEnabled)
        ? report.rulesetsNotEnabled
        : [];
    rows.push(
        [ message('diagnosticsRegexFree'), formatQuota(shared.free) ],
        [ message('diagnosticsRegexDropped'), formatQuota(
            countOf(shared.droppedStrictBlock) + countOf(shared.droppedImported)
        ) ],
        [ message('diagnosticsRulesetsNotEnabled'), notEnabled.length === 0
            ? formatQuota(0)
            : notEnabled.join(', ') ],
    );
    return rows;
}

function renderRegexCapacity(report) {
    const panel = qs$('#regexCapacityPanel');
    const list = qs$('#regexCapacity');
    if ( panel === null || list === null ) { return; }
    // A worker which does not provide the report answers nothing: show no
    // numbers rather than assumed ones.
    if ( report?.schemaVersion !== 1 ) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    appendDefinitionList(list, regexCapacityRows(report));
}

async function loadRegexCapacity({ verifyStatic = false } = {}) {
    // A 'Check now' in progress answers with the newer numbers.
    if ( regexVerifying && verifyStatic === false ) { return; }
    const request = ++regexCapacityRequests;
    const report = await sendMessage(verifyStatic
        ? { what: 'getRegexCapacity', verifyStatic: true }
        : { what: 'getRegexCapacity' }
    );
    if ( request !== regexCapacityRequests ) { return; }
    renderRegexCapacity(report);
}

dom.on('#verifyStaticRegex', 'click', async ( ) => {
    if ( regexVerifying ) { return; }
    const button = qs$('#verifyStaticRegex');
    button.disabled = true;
    regexVerifying = true;
    try {
        await loadRegexCapacity({ verifyStatic: true });
    } catch {
        setOperationStatus(message('diagnosticsLoadFailed'), 'error');
    } finally {
        regexVerifying = false;
        button.disabled = false;
    }
});

function renderWebRequestSetup(capabilities) {
    let panel = qs$('#webRequestSetup');
    if ( panel === null ) {
        panel = document.createElement('div');
        panel.id = 'webRequestSetup';
        panel.className = 'powerPanel';
        qs$('section[data-pane="diagnostics"]').append(panel);
    }
    const experimental = capabilities.productEdition === 'experimental-webrequest';
    const title = document.createElement('h3');
    title.textContent = message('webRequestSetupTitle');
    const description = document.createElement('p');
    description.textContent = message(experimental
        ? 'webRequestSetupExperimental'
        : 'webRequestSetupStandard'
    );
    const limits = document.createElement('p');
    limits.textContent = message('webRequestSetupLimits');
    const guide = document.createElement('a');
    guide.href = 'https://github.com/kayurachann/uBlock-Plus/blob/main/docs/EXPERIMENTAL-WEBREQUEST.md';
    guide.textContent = message('webRequestSetupGuide');
    guide.target = '_blank';
    guide.rel = 'noopener';
    panel.replaceChildren(title, description, limits, guide);
}

const memoryProfileKeys = new Map([
    [ 'auto', 'memoryProfileAuto' ],
    [ 'balanced', 'memoryProfileBalanced' ],
    [ 'low-memory', 'memoryProfileLow' ],
]);

function memoryProfileName(value) {
    const key = memoryProfileKeys.get(value);
    return key !== undefined ? message(key) : value || '—';
}

function renderPerformance(profile) {
    appendDefinitionList(qs$('#performanceDetails'), [
        [ message('performanceSelectedProfile'), memoryProfileName(profile.selected) ],
        [ message('performanceEffectiveProfile'), memoryProfileName(profile.effective) ],
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
            // Its own failure does not hide the other diagnostics.
            loadRegexCapacity().catch(( ) => {
                setOperationStatus(message('diagnosticsLoadFailed'), 'error');
            }),
        ]);
        lastCapabilities = capabilities;
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

const protectionStateKeys = [
    'autoReload',
    'defaultFilteringMode',
    'hasOmnipotence',
    'popupBlockMode',
    'showBlockedCount',
    'strictBlockMode',
];

function listen() {
    const bc = new self.BroadcastChannel('uBlockPlus');
    bc.onmessage = ev => {
        const data = ev.data;
        if ( data instanceof Object === false ) { return; }
        if ( protectionStateKeys.some(key => data[key] !== undefined) ) {
            refreshProtectionProfileSoon();
        }
        if ( data.filteringModeDetails !== undefined ) {
            onFilteringModeDetailsChanged(data.filteringModeDetails);
        }
    };
    // The memory profile is part of every protection profile but is not
    // broadcast; follow its stored value instead.
    browser.storage.local.onChanged.addListener(changes => {
        if ( changes?.memoryProfile === undefined ) { return; }
        refreshProtectionProfileSoon();
    });
    listenForPowerUISettings(settings => {
        renderAppearanceSettings(settings);
    });
}

async function init() {
    listen();
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
