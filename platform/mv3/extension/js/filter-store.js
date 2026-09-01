/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    FILTER_STORE_LIMITS,
    estimateCatalogQuota,
    filterCatalogEntries,
    installationIds,
    parseFilterCatalog,
    sha256Hex,
    verifyCatalogMetadata,
} from './filter-store-model.js';

import {
    createVerifiedSourceKey,
    parseVerifiedSourceKey,
} from './verified-source-handoff.js';

import {
    i18n,
    localKeys,
    localRead,
    localRemove,
    localWrite,
    runtime,
} from './ext.js';

/******************************************************************************/

const CUSTOM_REPOSITORIES_KEY = 'filterStore.repositories';
const BUILTIN_CATALOG_PATH = '/filter-store/catalog.json';
const MAX_CUSTOM_REPOSITORIES = 8;
const MAX_FILTER_SOURCE_FETCHES = 32;
const MAX_APPLY_ENTRIES = 16;
const MAX_APPLY_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 1000;
const MAX_RENDERED_ENTRIES = 120;
const VERIFIED_SOURCE_MAX_AGE = 10 * 60 * 1000;

let catalogs = [];
let entries = [];
let enabledIds = new Set();
let importedDetails = new Map();
let initialized = false;
let working = false;

const strictSendMessage = async message => {
    const response = await runtime.sendMessage(message);
    if ( typeof response?.__ublockPlusError === 'string' ) {
        throw new Error(response.__ublockPlusError);
    }
    return response;
};

const qs = (selector, root = document) => root.querySelector(selector);

function message(id, fallback, substitutions) {
    let out = i18n.getMessage(id, substitutions) || fallback;
    if ( Array.isArray(substitutions) ) {
        substitutions.forEach((value, index) => {
            out = out.replaceAll(`$${index + 1}`, value);
        });
    }
    return out;
}

function makeElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if ( className ) { node.className = className; }
    if ( text !== undefined ) { node.textContent = text; }
    return node;
}

function setStatus(text, level = '') {
    const status = qs('#filterStoreStatus');
    if ( status === null ) { return; }
    status.textContent = text;
    status.dataset.level = level;
}

function entryIsEnabled(entry) {
    if ( installationIds(entry).every(id => enabledIds.has(id)) === false ) {
        return false;
    }
    if ( entry.installation.type !== 'imported' ||
        entry.sourceIntegrity === undefined ) {
        return true;
    }
    const compiled = importedDetails.get(entry.installation.sourceURL)
        ?.compiledIntegrity;
    return compiled?.algorithm === 'sha256' &&
        compiled.digest === entry.sourceIntegrity.digest &&
        compiled.bytes === entry.sourceIntegrity.bytes;
}

/******************************************************************************/

async function fetchBytes(url, maximumBytes, allowExtensionURL = false) {
    const options = {
        cache: 'no-store',
        credentials: 'omit',
        // Reject every redirect so an apparently HTTPS source cannot traverse
        // an unobservable HTTP hop before returning to HTTPS.
        redirect: 'error',
        referrerPolicy: 'no-referrer',
    };
    if ( typeof globalThis.AbortSignal?.timeout === 'function' ) {
        options.signal = globalThis.AbortSignal.timeout(15000);
    }
    const response = await fetch(url, options);
    if ( response.ok === false ) {
        throw new Error(`HTTP ${response.status}`);
    }
    const finalURL = new URL(response.url);
    if ( finalURL.username || finalURL.password ) {
        throw new Error('The response URL contained credentials');
    }
    if ( finalURL.protocol !== 'https:' &&
        (allowExtensionURL === false || finalURL.protocol.endsWith('-extension:') === false) ) {
        throw new Error('The response did not use HTTPS');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if ( Number.isFinite(contentLength) && contentLength > maximumBytes ) {
        throw new Error(`Response is larger than ${maximumBytes} bytes`);
    }
    if ( response.body?.getReader === undefined ) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if ( bytes.byteLength > maximumBytes ) {
            throw new Error(`Response is larger than ${maximumBytes} bytes`);
        }
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if ( done ) { break; }
        total += value.byteLength;
        if ( total > maximumBytes ) {
            await reader.cancel();
            throw new Error(`Response is larger than ${maximumBytes} bytes`);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for ( const chunk of chunks ) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function loadCatalog(url, trustedRepository = false) {
    const allowExtensionURL = trustedRepository && url.startsWith(runtime.getURL(''));
    const bytes = await fetchBytes(
        url,
        FILTER_STORE_LIMITS.catalogBytes,
        allowExtensionURL
    );
    let source;
    try {
        source = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error('Repository did not return valid JSON');
    }
    const catalog = parseFilterCatalog(source, {
        repositoryURL: url,
        trustedRepository,
    });
    if ( catalog.integrity ) {
        if ( await verifyCatalogMetadata(catalog) === false ) {
            throw new Error('Repository metadata hash does not match');
        }
    } else if ( trustedRepository ) {
        throw new Error('Built-in repository has no metadata hash');
    }
    for ( const entry of catalog.entries ) {
        entry.repositoryId = catalog.repository.id;
        entry.repositoryTitle = catalog.repository.title;
        entry.key = `${catalog.repository.id}:${entry.id}`;
    }
    return catalog;
}

async function verifyImportedSource(entry) {
    const integrity = entry.sourceIntegrity;
    if ( integrity === undefined ) { return; }
    const maximum = Math.min(
        FILTER_STORE_LIMITS.sourceBytes,
        integrity.bytes + 1
    );
    const bytes = await fetchBytes(entry.installation.sourceURL, maximum);
    if ( bytes.byteLength !== integrity.bytes ) {
        throw new Error('Filter data size does not match the catalog');
    }
    if ( await sha256Hex(bytes) !== integrity.digest ) {
        throw new Error('Filter data hash does not match the catalog');
    }
    let text;
    try {
        // Preserve a UTF-8 BOM so re-encoding in the offscreen compiler
        // produces the exact bytes covered by the catalog digest.
        text = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        }).decode(bytes);
    } catch {
        throw new Error('Filter data is not valid UTF-8 text');
    }
    if ( /^\s*!#include\b/im.test(text) ) {
        throw new Error(
            'Verified Filter Store sources must be self-contained and ' +
            'cannot use !#include'
        );
    }
    // The digest is not unique across different catalogs or source URLs.
    // Include a nonce so a multi-entry install cannot overwrite another
    // verified handoff created during the same millisecond.
    const cacheKey = createVerifiedSourceKey(integrity.digest);
    await localWrite(cacheKey, {
        createdAt: Date.now(),
        sourceURL: entry.installation.sourceURL,
        digest: integrity.digest,
        bytes: integrity.bytes,
        text,
    });
    return cacheKey;
}

async function cleanupVerifiedSourceHandoffs() {
    const keys = await localKeys() || [];
    const cutoff = Date.now() - VERIFIED_SOURCE_MAX_AGE;
    const stale = keys.filter(key => {
        const parsed = parseVerifiedSourceKey(key);
        if ( parsed === undefined ) {
            return key.startsWith('filterStore.verifiedSource.');
        }
        return parsed.createdAt < cutoff;
    });
    if ( stale.length !== 0 ) { await localRemove(stale); }
}

/******************************************************************************/

function getQuotaLimits() {
    return {
        staticRulesets: self.cachedRulesetData?.maxNumberOfEnabledRulesets ||
            FILTER_STORE_LIMITS.staticRulesets,
    };
}

function projectedEnabledIds(toEnable) {
    const projected = new Set(enabledIds);
    for ( const entry of toEnable ) {
        for ( const id of installationIds(entry) ) {
            projected.add(id);
        }
    }
    return projected;
}

function quotaFor(enabled = enabledIds) {
    return estimateCatalogQuota(entries, enabled, getQuotaLimits());
}

function renderQuota() {
    const quota = quotaFor();
    const values = [
        `${quota.staticRulesets}/${quota.maximum.staticRulesets} ${message(
            'filterStoreStaticSlots', 'static slots'
        )}`,
        `~${quota.dynamicRules}/${quota.maximum.dynamicRules} ${message(
            'filterStoreDynamicRules', 'dynamic rules'
        )}`,
        `~${quota.regexRules}/${quota.maximum.regexRules} ${message(
            'filterStoreRegexRules', 'regex rules'
        )}`,
    ];
    if ( quota.unknownImportedLists ) {
        values.push(message(
            'filterStoreUnknownCosts',
            '$1 imported list(s) have unknown cost',
            [ `${quota.unknownImportedLists}` ]
        ));
    }
    const node = qs('#filterStoreQuota');
    node.textContent = values.join(' · ');
    node.dataset.level = quota.over ? 'error' : quota.near ? 'warning' : '';
}

function renderSelect(selector, values, allLabel) {
    const select = qs(selector);
    const selected = select.value;
    select.replaceChildren();
    const all = makeElement('option', '', allLabel);
    all.value = '';
    select.append(all);
    for ( const [ value, title ] of values ) {
        const option = makeElement('option', '', title);
        option.value = value;
        select.append(option);
    }
    if ( Array.from(select.options).some(a => a.value === selected) ) {
        select.value = selected;
    }
}

function renderFilters() {
    const categories = Array.from(new Set(entries.map(a => a.category)))
        .sort()
        .map(value => [ value, value.replaceAll('-', ' ') ]);
    const languages = Array.from(new Set(entries.flatMap(a => a.languages)))
        .sort()
        .map(value => [
            value,
            value === '*' ? message('filterStoreGlobal', 'Global') : value,
        ]);
    const profileMap = new Map();
    for ( const catalog of catalogs ) {
        for ( const profile of catalog.profiles ) {
            if ( profileMap.has(profile.id) ) { continue; }
            profileMap.set(profile.id, profile.title);
        }
    }
    renderSelect(
        '#filterStoreCategory',
        categories,
        message('filterStoreAllCategories', 'All categories')
    );
    renderSelect(
        '#filterStoreLanguage',
        languages,
        message('filterStoreAllLanguages', 'All languages')
    );
    renderSelect(
        '#filterStoreProfile',
        Array.from(profileMap),
        message('filterStoreAllProfiles', 'All profiles')
    );
}

function costText(entry) {
    const cost = entry.ruleCost;
    if ( entry.installation.type === 'stock' ) {
        return message(
            'filterStoreStaticCost',
            '$1 static slot(s), $2 packaged rule(s)',
            [ `${cost.staticRulesets}`, cost.packagedRules.toLocaleString() ]
        );
    }
    return message(
        'filterStoreDynamicCost',
        'Up to $1 dynamic / $2 regex rules',
        [ cost.dynamicRules.toLocaleString(), cost.regexRules.toLocaleString() ]
    );
}

function makeBadge(text, kind) {
    const badge = makeElement('span', 'filterStoreBadge', text);
    badge.dataset.kind = kind;
    return badge;
}

function makeEntryCard(entry) {
    const enabled = entryIsEnabled(entry);
    const card = makeElement('article', 'filterStoreCard');
    card.dataset.entryKey = entry.key;
    if ( enabled ) { card.dataset.enabled = ''; }

    const heading = makeElement('div', 'filterStoreCardHeading');
    heading.append(makeElement('h4', '', entry.title));
    const badges = makeElement('div', 'filterStoreBadges');
    badges.append(
        makeBadge(
            entry.effectiveTrustTier === 'verified'
                ? message('filterStoreVerified', 'Verified')
                : message('filterStoreCommunity', 'Community'),
            entry.effectiveTrustTier
        ),
        makeBadge(entry.category, 'category'),
        makeBadge(entry.languages.join(', '), 'language')
    );
    if ( entry.sourceIntegrity ) {
        badges.append(makeBadge(
            `SHA-256 ${entry.sourceIntegrity.digest.slice(0, 10)}…`,
            'hash'
        ));
    }
    heading.append(badges);
    card.append(heading, makeElement('p', 'filterStoreDescription', entry.description));

    const metadata = makeElement('p', 'filterStoreMetadata');
    metadata.textContent = `${costText(entry)} · ${entry.license} · ${entry.repositoryTitle}`;
    card.append(metadata);

    const actions = makeElement('div', 'filterStoreActions');
    const homepage = makeElement(
        'a',
        '',
        message('filterStoreHomepage', 'Homepage')
    );
    homepage.href = entry.homepage;
    homepage.target = '_blank';
    homepage.rel = 'noopener noreferrer';
    const toggle = makeElement(
        'button',
        enabled ? '' : 'preferred',
        enabled
            ? message('filterStoreDisable', 'Disable')
            : message('filterStoreEnable', 'Enable')
    );
    toggle.type = 'button';
    toggle.dataset.entryKey = entry.key;
    toggle.disabled = working;
    actions.append(homepage, toggle);
    card.append(actions);
    return card;
}

function currentFilters() {
    return {
        query: qs('#filterStoreSearch').value,
        category: qs('#filterStoreCategory').value,
        language: qs('#filterStoreLanguage').value,
        profile: qs('#filterStoreProfile').value,
    };
}

function renderEntries() {
    const container = qs('#filterStoreEntries');
    const visibleEntries = filterCatalogEntries(entries, currentFilters());
    const fragment = document.createDocumentFragment();
    for ( const entry of visibleEntries.slice(0, MAX_RENDERED_ENTRIES) ) {
        fragment.append(makeEntryCard(entry));
    }
    if ( visibleEntries.length === 0 ) {
        fragment.append(makeElement(
            'p',
            'filterStoreEmpty',
            message('filterStoreNoResults', 'No matching filter lists.')
        ));
    } else if ( visibleEntries.length > MAX_RENDERED_ENTRIES ) {
        fragment.append(makeElement(
            'p',
            'filterStoreEmpty',
            message(
                'filterStoreResultsLimited',
                'Showing the first $1 of $2 results. Refine your search.',
                [ `${MAX_RENDERED_ENTRIES}`, `${visibleEntries.length}` ]
            )
        ));
    }
    container.replaceChildren(fragment);
}

function makeBundleCard(bundle, catalog) {
    const entryMap = new Map(catalog.entries.map(a => [ a.id, a ]));
    const bundleEntries = bundle.entryIds.map(id => entryMap.get(id)).filter(Boolean);
    const allEnabled = bundleEntries.every(entry => entryIsEnabled(entry));
    const card = makeElement('article', 'filterStoreBundle');
    card.append(
        makeElement('strong', '', bundle.title),
        makeElement('span', '', bundle.description)
    );
    const button = makeElement(
        'button',
        'preferred',
        allEnabled
            ? message('filterStoreBundleEnabled', 'Bundle enabled')
            : message('filterStoreEnableBundle', 'Enable bundle')
    );
    button.type = 'button';
    button.dataset.bundleKey = `${catalog.repository.id}:${bundle.id}`;
    button.disabled = working || allEnabled;
    card.append(button);
    return card;
}

function renderBundles() {
    const container = qs('#filterStoreBundles');
    const fragment = document.createDocumentFragment();
    for ( const catalog of catalogs ) {
        for ( const bundle of catalog.bundles ) {
            fragment.append(makeBundleCard(bundle, catalog));
        }
    }
    container.replaceChildren(fragment);
    qs('#filterStoreBundleSection').hidden = container.childElementCount === 0;
}

async function getCustomRepositoryURLs() {
    const value = await localRead(CUSTOM_REPOSITORIES_KEY);
    if ( Array.isArray(value) === false ) { return []; }
    const urls = [];
    for ( const valueURL of value ) {
        try {
            const url = new URL(valueURL);
            if ( url.protocol !== 'https:' || url.username || url.password ) { continue; }
            urls.push(url.href);
        } catch {
        }
    }
    return Array.from(new Set(urls)).slice(0, MAX_CUSTOM_REPOSITORIES);
}

async function renderRepositories() {
    const container = qs('#filterStoreRepositoryList');
    const urls = await getCustomRepositoryURLs();
    const fragment = document.createDocumentFragment();
    for ( const url of urls ) {
        const item = makeElement('li', '');
        const label = makeElement('span', '', url);
        label.title = url;
        const button = makeElement(
            'button',
            '',
            message('filterStoreRemoveRepository', 'Remove')
        );
        button.type = 'button';
        button.dataset.repositoryURL = url;
        button.disabled = working;
        item.append(label, button);
        fragment.append(item);
    }
    container.replaceChildren(fragment);
}

function renderAll() {
    renderFilters();
    renderQuota();
    renderBundles();
    renderEntries();
    renderRepositories();
}

/******************************************************************************/

async function reloadCatalogs() {
    const builtInURL = runtime.getURL(BUILTIN_CATALOG_PATH);
    const loaded = [ await loadCatalog(builtInURL, true) ];
    const repositoryIds = new Set([ loaded[0].repository.id ]);
    const installationOwners = new Set(
        loaded[0].entries.flatMap(installationIds)
    );
    const customURLs = await getCustomRepositoryURLs();
    const results = await Promise.all(customURLs.map(async url => {
        try {
            return { url, catalog: await loadCatalog(url) };
        } catch ( reason ) {
            return { url, reason };
        }
    }));
    for ( const { url, catalog, reason } of results ) {
        try {
            if ( reason ) { throw reason; }
            if ( repositoryIds.has(catalog.repository.id) ) {
                throw new Error(
                    `Duplicate repository id: ${catalog.repository.id}`
                );
            }
            const ownedIds = catalog.entries.flatMap(installationIds);
            const duplicateId = ownedIds.find(id =>
                installationOwners.has(id)
            );
            if ( duplicateId ) {
                throw new Error(
                    `Filter installation is already owned: ${duplicateId}`
                );
            }
            const entryCount = loaded.reduce(
                (total, item) => total + item.entries.length,
                0
            );
            if ( entryCount + catalog.entries.length > MAX_CATALOG_ENTRIES ) {
                throw new Error(
                    `Catalog limit exceeded (${MAX_CATALOG_ENTRIES} entries)`
                );
            }
            repositoryIds.add(catalog.repository.id);
            ownedIds.forEach(id => installationOwners.add(id));
            loaded.push(catalog);
        } catch (reason) {
            console.error(`Filter Store repository ${url}:`, reason);
            setStatus(message(
                'filterStoreRepositoryFailed',
                'Could not load repository: $1',
                [ url ]
            ), 'warning');
        }
    }
    catalogs = loaded;
    entries = loaded.flatMap(a => a.entries);
}

async function refreshEnabled() {
    const [ rulesets = [], imported = [] ] = await Promise.all([
        strictSendMessage({ what: 'getEnabledRulesets' }),
        strictSendMessage({ what: 'getImportedLists' }),
    ]);
    enabledIds = new Set(rulesets);
    importedDetails = new Map(imported.map(list => [ list.id, list ]));
}

function quotaAllows(toEnable) {
    const quota = quotaFor(projectedEnabledIds(toEnable));
    if ( quota.over === false ) { return true; }
    setStatus(message(
        'filterStoreQuotaExceeded',
        'This selection would exceed an MV3 ruleset quota.',
    ), 'error');
    return false;
}

function communityConsent(toEnable) {
    if ( toEnable.some(a => a.effectiveTrustTier === 'community') === false ) {
        return true;
    }
    return self.confirm(message(
        'filterStoreCommunityConfirm',
        'This community repository is not verified by uBlock Plus+. Import its filter data?'
    ));
}

async function applyEntries(toEnable) {
    const missing = toEnable.filter(entry => entryIsEnabled(entry) === false);
    if ( missing.length === 0 ) { return; }
    if ( missing.length > MAX_APPLY_ENTRIES ) {
        throw new Error(
            `At most ${MAX_APPLY_ENTRIES} Filter Store entries can be ` +
            'enabled in one operation'
        );
    }
    if ( quotaAllows(missing) === false || communityConsent(missing) === false ) { return; }

    const verifiedSources = new Map();
    const importedEntries = Array.from(new Map(
        missing
            .filter(entry => entry.installation.type === 'imported')
            .map(entry => [ entry.installation.sourceURL, entry ])
    ).values());
    const pinnedBytes = importedEntries.reduce(
        (total, entry) => total + (entry.sourceIntegrity?.bytes || 0),
        0
    );
    if ( pinnedBytes > MAX_APPLY_SOURCE_BYTES ) {
        throw new Error('Pinned filter sources exceed the 15 MiB batch budget');
    }
    const unpinnedCount = importedEntries.filter(
        entry => entry.sourceIntegrity === undefined
    ).length;
    const unpinnedBudget = unpinnedCount === 0
        ? 0
        : Math.min(
            FILTER_STORE_LIMITS.sourceBytes,
            Math.floor((MAX_APPLY_SOURCE_BYTES - pinnedBytes) / unpinnedCount)
        );
    if ( unpinnedCount !== 0 && unpinnedBudget < 1 ) {
        throw new Error('Community filter sources exceed the batch byte budget');
    }
    let activationResult;
    try {
        for ( const entry of importedEntries ) {
            setStatus(message(
                'filterStoreVerifying',
                'Verifying $1…',
                [ entry.title ]
            ));
            const cacheKey = await verifyImportedSource(entry);
            if ( cacheKey ) { verifiedSources.set(entry.key, cacheKey); }
        }

        const stockRulesetIds = missing
            .filter(entry => entry.installation.type === 'stock')
            .flatMap(entry => entry.installation.rulesetIds);
        if ( importedEntries.length === 0 ) {
            activationResult = await strictSendMessage({
                what: 'updateRulesetSelection',
                enableRulesetIds: stockRulesetIds,
            });
        } else {
            activationResult = await strictSendMessage({
                what: 'importFilterLists',
                rulesetIdsToEnable: stockRulesetIds,
                lists: importedEntries.map(entry => ({
                    url: entry.installation.sourceURL,
                    name: entry.title,
                    homeURL: entry.homepage,
                    sourceIntegrity: entry.sourceIntegrity,
                    verifiedSourceKey: verifiedSources.get(entry.key),
                    maxSourceBytes: entry.sourceIntegrity?.bytes ||
                        unpinnedBudget,
                    maxSourceFetches: MAX_FILTER_SOURCE_FETCHES,
                    requireHTTPSSource: true,
                })),
            });
        }
        await refreshEnabled();
    } catch ( reason ) {
        await refreshEnabled().catch(( ) => { });
        // A service-worker response can be lost after an atomic transaction
        // committed. Trust the refreshed state instead of issuing a stale
        // compensating write from this tab.
        if ( missing.every(entry => entryIsEnabled(entry)) ) {
            return { applied: true, warnings: [] };
        }
        throw reason;
    } finally {
        const cacheKeys = Array.from(verifiedSources.values());
        if ( cacheKeys.length ) { await localRemove(cacheKeys); }
    }
    if ( missing.every(entry => entryIsEnabled(entry)) === false ) {
        throw new Error('Filter Store activation did not reach the requested state');
    }
    return {
        applied: true,
        warnings: activationResult?.warnings || [],
    };
}

async function toggleEntry(entry) {
    if ( entryIsEnabled(entry) ) {
        try {
            await strictSendMessage({
                what: 'updateRulesetSelection',
                disableRulesetIds: installationIds(entry),
            });
            await refreshEnabled();
        } catch ( reason ) {
            await refreshEnabled().catch(( ) => { });
            if ( entryIsEnabled(entry) ) { throw reason; }
        }
        setStatus(message(
            'filterStoreDisabledStatus',
            'Disabled $1.',
            [ entry.title ]
        ));
        return;
    }
    const result = await applyEntries([ entry ]);
    if ( entryIsEnabled(entry) ) {
        if ( result?.warnings?.length ) {
            setStatus(message(
                'filterStoreActivationWarnings',
                'Activated with $1 Chrome-incompatible regex filters skipped.',
                [ `${result.warnings.length}` ]
            ), 'warning');
            return;
        }
        setStatus(message(
            'filterStoreEnabledStatus',
            'Enabled $1.',
            [ entry.title ]
        ));
    }
}

async function withWorkingState(callback) {
    if ( working ) { return; }
    working = true;
    document.querySelectorAll('#filterStore button').forEach(button => {
        button.disabled = true;
    });
    try {
        await callback();
    } catch (reason) {
        console.error(reason);
        setStatus(reason?.message || `${reason}`, 'error');
    } finally {
        working = false;
        renderAll();
    }
}

async function onEntryToggle(ev) {
    const button = ev.target.closest('button[data-entry-key]');
    if ( button === null ) { return; }
    const entry = entries.find(a => a.key === button.dataset.entryKey);
    if ( entry === undefined ) { return; }
    withWorkingState(( ) => toggleEntry(entry));
}

async function onBundleEnable(ev) {
    const button = ev.target.closest('button[data-bundle-key]');
    if ( button === null ) { return; }
    const splitAt = button.dataset.bundleKey.lastIndexOf(':');
    const repositoryId = button.dataset.bundleKey.slice(0, splitAt);
    const bundleId = button.dataset.bundleKey.slice(splitAt + 1);
    const catalog = catalogs.find(a => a.repository.id === repositoryId);
    const bundle = catalog?.bundles.find(a => a.id === bundleId);
    if ( bundle === undefined ) { return; }
    const entryMap = new Map(catalog.entries.map(a => [ a.id, a ]));
    const toEnable = bundle.entryIds.map(id => entryMap.get(id)).filter(Boolean);
    withWorkingState(async ( ) => {
        const applied = await applyEntries(toEnable);
        if ( applied?.applied !== true ) { return; }
        if ( applied.warnings.length ) {
            setStatus(message(
                'filterStoreActivationWarnings',
                'Activated with $1 Chrome-incompatible regex filters skipped.',
                [ `${applied.warnings.length}` ]
            ), 'warning');
            return;
        }
        setStatus(message(
            'filterStoreBundleStatus',
            'Bundle enabled: $1.',
            [ bundle.title ]
        ));
    });
}

async function addRepository() {
    const input = qs('#filterStoreRepositoryURL');
    let url;
    try {
        url = new URL(input.value.trim());
    } catch {
        setStatus(message(
            'filterStoreInvalidRepository',
            'Enter a valid HTTPS catalog URL.'
        ), 'error');
        return;
    }
    if ( url.protocol !== 'https:' || url.username || url.password ) {
        setStatus(message(
            'filterStoreInvalidRepository',
            'Enter a valid HTTPS catalog URL.'
        ), 'error');
        return;
    }
    const urls = await getCustomRepositoryURLs();
    if ( urls.includes(url.href) ) {
        input.value = '';
        return;
    }
    if ( urls.length >= MAX_CUSTOM_REPOSITORIES ) {
        throw new Error(`At most ${MAX_CUSTOM_REPOSITORIES} custom repositories are allowed`);
    }
    const catalog = await loadCatalog(url.href);
    if ( catalogs.some(a => a.repository.id === catalog.repository.id) ) {
        throw new Error(`Duplicate repository id: ${catalog.repository.id}`);
    }
    const installationOwners = new Set(entries.flatMap(installationIds));
    const duplicateInstallation = catalog.entries
        .flatMap(installationIds)
        .find(id => installationOwners.has(id));
    if ( duplicateInstallation ) {
        throw new Error(
            `Filter installation is already owned: ${duplicateInstallation}`
        );
    }
    if ( entries.length + catalog.entries.length > MAX_CATALOG_ENTRIES ) {
        throw new Error(
            `Catalog limit exceeded (${MAX_CATALOG_ENTRIES} entries)`
        );
    }
    urls.push(url.href);
    await localWrite(CUSTOM_REPOSITORIES_KEY, urls);
    input.value = '';
    await reloadCatalogs();
    setStatus(message(
        'filterStoreRepositoryAdded',
        'Repository added.'
    ));
}

async function removeRepository(url) {
    const urls = await getCustomRepositoryURLs();
    await localWrite(CUSTOM_REPOSITORIES_KEY, urls.filter(a => a !== url));
    await reloadCatalogs();
    setStatus(message(
        'filterStoreRepositoryRemoved',
        'Repository removed. Its enabled lists remain available under Imported lists.'
    ));
}

function listen() {
    qs('#filterStoreSearch').addEventListener('input', renderEntries);
    qs('#filterStoreCategory').addEventListener('change', renderEntries);
    qs('#filterStoreLanguage').addEventListener('change', renderEntries);
    qs('#filterStoreProfile').addEventListener('change', renderEntries);
    qs('#filterStoreEntries').addEventListener('click', onEntryToggle);
    qs('#filterStoreBundles').addEventListener('click', onBundleEnable);
    qs('#filterStoreAddRepository').addEventListener('click', ( ) => {
        withWorkingState(addRepository);
    });
    qs('#filterStoreRepositoryList').addEventListener('click', ev => {
        const button = ev.target.closest('button[data-repository-url]');
        if ( button === null ) { return; }
        withWorkingState(( ) => removeRepository(button.dataset.repositoryURL));
    });
    const broadcast = new self.BroadcastChannel('uBOL');
    broadcast.onmessage = ev => {
        if ( Array.isArray(ev.data?.enabledRulesets) === false ) { return; }
        refreshEnabled().then(( ) => {
            renderQuota();
            renderBundles();
            renderEntries();
        }).catch(reason => {
            console.error(reason);
        });
    };
}

export async function initializeFilterStore() {
    if ( initialized ) { return; }
    initialized = true;
    try {
        await Promise.all([
            cleanupVerifiedSourceHandoffs(),
            reloadCatalogs(),
            refreshEnabled(),
        ]);
        renderAll();
        listen();
    } catch (reason) {
        console.error(reason);
        setStatus(reason?.message || `${reason}`, 'error');
    }
}
