/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import { normalizePowerUISettings } from './power-ui-core.js';
import { parseFirewall } from './firewall-core.js';
import { validatePopupPolicies } from './popup-policy.js';

const MAX_TEXT_CHARS = 20 * 1024 * 1024;
const MAX_FILTER_SOURCE_BYTES = 5 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isObject(value) {
    return typeof value === 'object' && value !== null &&
        Array.isArray(value) === false;
}

function optionalBoolean(value, label) {
    if ( value === undefined ) { return; }
    if ( typeof value !== 'boolean' ) {
        throw new TypeError(`${label} must be a boolean`);
    }
    return value;
}

function optionalString(value, label, maximum = 2048) {
    if ( value === undefined ) { return; }
    if ( typeof value !== 'string' || value.length > maximum ) {
        throw new TypeError(`${label} must be a bounded string`);
    }
    return value;
}

function httpsURL(value, label) {
    if ( typeof value !== 'string' || value.length === 0 ||
        value.length > 2048 ) {
        throw new TypeError(`${label} must be a bounded HTTPS URL`);
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError(`${label} must be a valid HTTPS URL`);
    }
    if ( url.protocol !== 'https:' || url.username || url.password ) {
        throw new TypeError(`${label} must be credential-free HTTPS`);
    }
    return url.href;
}

function stringArray(value, label, options = {}) {
    const maxItems = options.maxItems ?? 100000;
    const maxChars = options.maxChars ?? MAX_TEXT_CHARS;
    if ( Array.isArray(value) === false || value.length > maxItems ) {
        throw new TypeError(`${label} must be an array with at most ${maxItems} items`);
    }
    let totalChars = 0;
    return value.map((entry, index) => {
        if ( typeof entry !== 'string' ) {
            throw new TypeError(`${label}[${index}] must be a string`);
        }
        totalChars += entry.length;
        if ( totalChars > maxChars ) {
            throw new TypeError(`${label} exceeds its text budget`);
        }
        return entry;
    });
}

function normalizeIntegrity(value, label) {
    if ( value === undefined ) { return; }
    if ( isObject(value) === false || value.algorithm !== 'sha256' ||
        typeof value.digest !== 'string' ||
        SHA256_PATTERN.test(value.digest) === false ||
        Number.isSafeInteger(value.bytes) === false || value.bytes < 0 ||
        value.bytes > MAX_FILTER_SOURCE_BYTES ) {
        throw new TypeError(`${label} is invalid`);
    }
    return {
        algorithm: 'sha256',
        digest: value.digest,
        bytes: value.bytes,
    };
}

function normalizeImportedLists(value) {
    if ( value === undefined ) { return; }
    if ( Array.isArray(value) === false || value.length > 32 ) {
        throw new TypeError('importedLists must contain at most 32 entries');
    }
    const seenURLs = new Set();
    return value.map((entry, index) => {
        const label = `importedLists[${index}]`;
        if ( isObject(entry) === false ) {
            throw new TypeError(`${label} must be an object`);
        }
        const url = httpsURL(entry.url, `${label}.url`);
        if ( seenURLs.has(url) ) {
            throw new TypeError('importedLists contains duplicate URLs');
        }
        seenURLs.add(url);
        const out = { url };
        for ( const field of [ 'name', 'homeURL' ] ) {
            const normalized = optionalString(entry[field], `${label}.${field}`);
            if ( normalized !== undefined ) { out[field] = normalized; }
        }
        const enabled = optionalBoolean(entry.enabled, `${label}.enabled`);
        if ( enabled !== undefined ) { out.enabled = enabled; }
        const integrity = normalizeIntegrity(
            entry.sourceIntegrity,
            `${label}.sourceIntegrity`
        );
        if ( integrity ) { out.sourceIntegrity = integrity; }
        for ( const [ field, maximum ] of [
            [ 'maxSourceBytes', MAX_FILTER_SOURCE_BYTES ],
            [ 'maxSourceFetches', 32 ],
        ] ) {
            const number = entry[field];
            if ( number === undefined ) { continue; }
            if ( Number.isSafeInteger(number) === false || number < 1 ||
                number > maximum ) {
                throw new TypeError(`${label}.${field} is invalid`);
            }
            out[field] = number;
        }
        const requireHTTPS = optionalBoolean(
            entry.requireHTTPSSource,
            `${label}.requireHTTPSSource`
        );
        if ( requireHTTPS !== undefined ) {
            out.requireHTTPSSource = requireHTTPS;
        }
        return out;
    });
}

export function normalizeModeHostname(value) {
    if ( typeof value !== 'string' || value === '' || value.length > 253 ) {
        throw new TypeError('Invalid filtering-mode hostname');
    }
    // Preserve literal IPv6 hostnames emitted by URL.hostname in the popup.
    if ( value.startsWith('[') && value.endsWith(']') ) {
        try { return new URL(`http://${value}/`).hostname; }
        catch { throw new TypeError('Invalid filtering-mode IPv6 hostname'); }
    }
    if ( /[%\s/:@*?#\\]/.test(value) ) {
        throw new TypeError('Invalid filtering-mode hostname');
    }
    let hostname;
    try { hostname = new URL(`http://${value}/`).hostname; }
    catch { throw new TypeError('Invalid filtering-mode hostname'); }
    if ( hostname.length > 253 || hostname.split('.').some(label =>
        label.length === 0 || label.length > 63 ||
        /^[^\da-z]|[^\da-z]$|[^\da-z-]/.test(label)
    ) ) {
        throw new TypeError('Invalid filtering-mode hostname');
    }
    return hostname;
}

function normalizeFilteringModes(value) {
    if ( value === undefined ) { return; }
    if ( isObject(value) === false ) {
        throw new TypeError('filteringModes must be an object');
    }
    const out = {};
    let total = 0;
    let defaults = 0;
    const seen = new Set();
    for ( const key of [ 'none', 'basic', 'optimal', 'complete' ] ) {
        const entries = stringArray(value[key], `filteringModes.${key}`, {
            maxItems: 100000,
            maxChars: 4 * 1024 * 1024,
        });
        total += entries.length;
        if ( total > 100000 ) {
            throw new TypeError('filteringModes contains too many hostnames');
        }
        out[key] = entries.map(normalizeModeHostname);
        for ( const hostname of out[key] ) {
            if ( seen.has(hostname) ) {
                throw new TypeError('Duplicate filtering-mode hostname or default');
            }
            seen.add(hostname);
            if ( hostname === 'all-urls' ) { defaults += 1; }
        }
    }
    if ( defaults !== 1 ) {
        throw new TypeError('Filtering modes require exactly one global default');
    }
    return out;
}

function normalizeRestoreLevels(value) {
    if ( value === undefined ) { return; }
    if ( isObject(value) === false || Object.keys(value).length > 100000 ) {
        throw new TypeError('filteringModeRestoreLevels must be a bounded object');
    }
    const entries = [];
    const seen = new Set();
    for ( const [ hostname, level ] of Object.entries(value) ) {
        const normalized = normalizeModeHostname(hostname);
        if ( seen.has(normalized) || Number.isInteger(level) === false ||
            level < 1 || level > 3 ) {
            throw new TypeError('Invalid filteringModeRestoreLevels entry');
        }
        seen.add(normalized);
        entries.push([ normalized, level ]);
    }
    return Object.fromEntries(entries);
}

function normalizeCustomFilters(value) {
    if ( value === undefined ) { return; }
    if ( Array.isArray(value) === false || value.length > 100000 ) {
        throw new TypeError('customFilters must be a bounded array');
    }
    let totalChars = 0;
    return value.map((entry, index) => {
        if ( Array.isArray(entry) === false || entry.length !== 2 ||
            typeof entry[0] !== 'string' || entry[0].length === 0 ||
            entry[0].length > 1024 ) {
            throw new TypeError(`customFilters[${index}] is invalid`);
        }
        const selectors = stringArray(
            entry[1],
            `customFilters[${index}][1]`,
            { maxItems: 100000, maxChars: MAX_TEXT_CHARS }
        );
        totalChars += entry[0].length +
            selectors.reduce((sum, selector) => sum + selector.length, 0);
        if ( totalChars > MAX_TEXT_CHARS ) {
            throw new TypeError('customFilters exceeds its text budget');
        }
        return [ entry[0], selectors ];
    });
}

export function normalizeBackupObject(value) {
    if ( isObject(value) === false ) {
        throw new TypeError('Backup root must be an object');
    }
    const out = {};
    for ( const field of [
        'autoReload',
        'developerMode',
        'popupBlockMode',
        'showBlockedCount',
        'strictBlockMode',
    ] ) {
        const normalized = optionalBoolean(value[field], field);
        if ( normalized !== undefined ) { out[field] = normalized; }
    }
    if ( value.memoryProfile !== undefined ) {
        if ( [ 'auto', 'balanced', 'low-memory' ]
            .includes(value.memoryProfile) === false ) {
            throw new TypeError('memoryProfile is invalid');
        }
        out.memoryProfile = value.memoryProfile;
    }
    if ( value.popupPolicies !== undefined ) {
        out.popupPolicies = validatePopupPolicies(value.popupPolicies);
    }
    if ( value.firewallRules !== undefined ) {
        const lines = stringArray(value.firewallRules, 'firewallRules', {
            maxItems: 1024, maxChars: 131072,
        });
        const { text } = parseFirewall(lines.join('\n'));
        out.firewallRules = text === '' ? [] : text.split('\n');
    }
    if ( value.powerUISettings !== undefined ) {
        out.powerUISettings = normalizePowerUISettings(
            value.powerUISettings,
            { strict: true }
        );
    }
    if ( value.filterStoreRepositories !== undefined ) {
        const repositories = stringArray(
            value.filterStoreRepositories,
            'filterStoreRepositories',
            { maxItems: 8, maxChars: 8 * 2048 }
        ).map((entry, index) =>
            httpsURL(entry, `filterStoreRepositories[${index}]`)
        );
        if ( new Set(repositories).size !== repositories.length ) {
            throw new TypeError('filterStoreRepositories contains duplicates');
        }
        out.filterStoreRepositories = repositories;
    }
    if ( value.rulesets !== undefined ) {
        const rulesets = stringArray(value.rulesets, 'rulesets', {
            maxItems: 256,
            maxChars: 256 * 2048,
        });
        if ( rulesets.some(entry =>
            /^[+-].+/.test(entry) === false
        ) ) {
            throw new TypeError('rulesets entries must begin with + or -');
        }
        out.rulesets = rulesets;
    }
    const importedLists = normalizeImportedLists(value.importedLists);
    if ( importedLists ) {
        const rulesetOverrides = new Map(
            (out.rulesets || []).map(entry => [ entry.slice(1), entry[0] === '+' ])
        );
        let enabledSourceBytes = 0;
        for ( const list of importedLists ) {
            const enabled = list.enabled === true ||
                list.enabled === undefined &&
                    rulesetOverrides.get(list.url) === true;
            if ( enabled === false ) { continue; }
            enabledSourceBytes += list.sourceIntegrity?.bytes ??
                list.maxSourceBytes ?? MAX_FILTER_SOURCE_BYTES;
        }
        if ( enabledSourceBytes > 20 * 1024 * 1024 ) {
            throw new TypeError(
                'Enabled imported lists exceed the 20 MiB source budget'
            );
        }
        out.importedLists = importedLists;
    }
    const filteringModes = normalizeFilteringModes(value.filteringModes);
    if ( filteringModes ) { out.filteringModes = filteringModes; }
    const restoreLevels = normalizeRestoreLevels(value.filteringModeRestoreLevels);
    if ( restoreLevels ) { out.filteringModeRestoreLevels = restoreLevels; }
    if ( value.cosmeticFilters !== undefined ) {
        out.cosmeticFilters = stringArray(
            value.cosmeticFilters,
            'cosmeticFilters'
        );
    }
    const customFilters = normalizeCustomFilters(value.customFilters);
    if ( customFilters ) { out.customFilters = customFilters; }
    if ( value.sandboxFilters !== undefined ) {
        out.sandboxFilters = stringArray(
            value.sandboxFilters,
            'sandboxFilters'
        );
    }
    if ( value.dnrRules !== undefined ) {
        out.dnrRules = stringArray(value.dnrRules, 'dnrRules');
    }
    return out;
}

/******************************************************************************/
