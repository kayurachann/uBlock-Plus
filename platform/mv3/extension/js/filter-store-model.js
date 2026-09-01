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

export const FILTER_STORE_SCHEMA_VERSION = 1;

export const FILTER_STORE_LIMITS = Object.freeze({
    catalogBytes: 512 * 1024,
    catalogEntries: 500,
    sourceBytes: 5 * 1024 * 1024,
    staticRulesets: 50,
    dynamicRules: 30000,
    regexRules: 1000,
});

const TRUST_TIERS = new Set([ 'verified', 'community' ]);
const INSTALLATION_TYPES = new Set([ 'stock', 'imported' ]);
const COST_CONFIDENCE = new Set([ 'measured', 'upper-bound', 'estimated' ]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const LANGUAGE_PATTERN = /^(?:\*|[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isObject(value) {
    return typeof value === 'object' && value !== null &&
        Array.isArray(value) === false;
}

function assertKnownKeys(value, allowed, label) {
    const allowedKeys = new Set(allowed);
    for ( const key of Object.keys(value) ) {
        if ( allowedKeys.has(key) ) { continue; }
        throw new TypeError(`${label} contains unknown field ${key}`);
    }
}

function asString(value, label, maxLength = 300) {
    if ( typeof value !== 'string' ) {
        throw new TypeError(`${label} must be a string`);
    }
    const out = value.trim();
    if ( out === '' || out.length > maxLength ) {
        throw new TypeError(`${label} has an invalid length`);
    }
    return out;
}

function asId(value, label) {
    const out = asString(value, label, 64);
    if ( ID_PATTERN.test(out) === false ) {
        throw new TypeError(`${label} must be a lowercase stable id`);
    }
    return out;
}

function asHttpsURL(value, label) {
    const out = asString(value, label, 2048);
    let parsed;
    try {
        parsed = new URL(out);
    } catch {
        throw new TypeError(`${label} must be a valid URL`);
    }
    if ( parsed.protocol !== 'https:' || parsed.username || parsed.password ) {
        throw new TypeError(`${label} must be an HTTPS URL without credentials`);
    }
    return parsed.href;
}

function asStringArray(value, label, options = {}) {
    const {
        maxItems = 32,
        item = asString,
    } = options;
    if ( Array.isArray(value) === false || value.length === 0 ||
        value.length > maxItems ) {
        throw new TypeError(`${label} must contain 1-${maxItems} items`);
    }
    const out = value.map((entry, index) =>
        item(entry, `${label}[${index}]`)
    );
    if ( new Set(out).size !== out.length ) {
        throw new TypeError(`${label} must not contain duplicates`);
    }
    return out;
}

function asCount(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    if ( Number.isSafeInteger(value) === false || value < 0 || value > maximum ) {
        throw new TypeError(`${label} must be a non-negative integer`);
    }
    return value;
}

function normalizeSourceIntegrity(value, label) {
    if ( value === undefined ) { return; }
    if ( isObject(value) === false ) {
        throw new TypeError(`${label} must be an object`);
    }
    assertKnownKeys(value, [ 'algorithm', 'digest', 'bytes' ], label);
    if ( value.algorithm !== 'sha256' ||
        SHA256_PATTERN.test(value.digest) === false ) {
        throw new TypeError(`${label} must contain a lowercase SHA-256 digest`);
    }
    return {
        algorithm: 'sha256',
        digest: value.digest,
        bytes: asCount(value.bytes, `${label}.bytes`, FILTER_STORE_LIMITS.sourceBytes),
    };
}

function normalizeRuleCost(value, label) {
    if ( isObject(value) === false ) {
        throw new TypeError(`${label} must be an object`);
    }
    assertKnownKeys(value, [
        'staticRulesets',
        'packagedRules',
        'dynamicRules',
        'regexRules',
        'cosmeticFilters',
        'confidence',
    ], label);
    if ( COST_CONFIDENCE.has(value.confidence) === false ) {
        throw new TypeError(`${label}.confidence is invalid`);
    }
    return {
        staticRulesets: asCount(value.staticRulesets, `${label}.staticRulesets`, 100),
        packagedRules: asCount(value.packagedRules, `${label}.packagedRules`, 1000000),
        dynamicRules: asCount(value.dynamicRules, `${label}.dynamicRules`, 1000000),
        regexRules: asCount(value.regexRules, `${label}.regexRules`, 100000),
        cosmeticFilters: asCount(value.cosmeticFilters, `${label}.cosmeticFilters`, 1000000),
        confidence: value.confidence,
    };
}

function normalizeInstallation(value, entry, label) {
    if ( isObject(value) === false || INSTALLATION_TYPES.has(value.type) === false ) {
        throw new TypeError(`${label}.type is invalid`);
    }
    assertKnownKeys(
        value,
        value.type === 'stock'
            ? [ 'type', 'rulesetIds' ]
            : [ 'type', 'sourceURL' ],
        label
    );
    if ( value.type === 'stock' ) {
        return {
            type: 'stock',
            rulesetIds: asStringArray(value.rulesetIds, `${label}.rulesetIds`, {
                maxItems: 8,
                item: asId,
            }),
        };
    }
    const sourceURL = asHttpsURL(value.sourceURL, `${label}.sourceURL`);
    if ( entry.sourceURLs.includes(sourceURL) === false ) {
        throw new TypeError(`${label}.sourceURL must be listed in sourceURLs`);
    }
    return { type: 'imported', sourceURL };
}

function normalizeEntry(value, index, trustedRepository) {
    const label = `entries[${index}]`;
    if ( isObject(value) === false ) {
        throw new TypeError(`${label} must be an object`);
    }
    assertKnownKeys(value, [
        'id',
        'title',
        'description',
        'category',
        'languages',
        'sourceURLs',
        'homepage',
        'license',
        'trustTier',
        'profiles',
        'installation',
        'sourceIntegrity',
        'ruleCost',
    ], label);
    const languages = asStringArray(value.languages, `${label}.languages`, {
        maxItems: 16,
        item: (entry, itemLabel) => {
            const out = asString(entry, itemLabel, 16);
            if ( LANGUAGE_PATTERN.test(out) === false ) {
                throw new TypeError(`${itemLabel} is not a supported language tag`);
            }
            return out;
        },
    });
    const sourceURLs = asStringArray(value.sourceURLs, `${label}.sourceURLs`, {
        maxItems: 4,
        item: asHttpsURL,
    });
    const trustTier = asString(value.trustTier, `${label}.trustTier`, 16);
    if ( TRUST_TIERS.has(trustTier) === false ) {
        throw new TypeError(`${label}.trustTier is invalid`);
    }
    const profiles = asStringArray(value.profiles, `${label}.profiles`, {
        maxItems: 8,
        item: asId,
    });
    const entry = {
        id: asId(value.id, `${label}.id`),
        title: asString(value.title, `${label}.title`, 120),
        description: asString(value.description, `${label}.description`, 500),
        category: asId(value.category, `${label}.category`),
        languages,
        sourceURLs,
        homepage: asHttpsURL(value.homepage, `${label}.homepage`),
        license: asString(value.license, `${label}.license`, 80),
        trustTier,
        effectiveTrustTier: trustedRepository ? trustTier : 'community',
        profiles,
        ruleCost: normalizeRuleCost(value.ruleCost, `${label}.ruleCost`),
    };
    entry.installation = normalizeInstallation(
        value.installation,
        entry,
        `${label}.installation`
    );
    entry.sourceIntegrity = normalizeSourceIntegrity(
        value.sourceIntegrity,
        `${label}.sourceIntegrity`
    );
    if ( entry.installation.type === 'imported' &&
        entry.trustTier === 'verified' &&
        entry.sourceIntegrity === undefined ) {
        throw new TypeError(`${label} needs sourceIntegrity at the verified tier`);
    }
    if ( entry.installation.type === 'stock' &&
        entry.ruleCost.staticRulesets !== entry.installation.rulesetIds.length ) {
        throw new TypeError(`${label}.ruleCost.staticRulesets does not match rulesetIds`);
    }
    return entry;
}

function normalizeProfile(value, index) {
    const label = `profiles[${index}]`;
    if ( isObject(value) === false ) {
        throw new TypeError(`${label} must be an object`);
    }
    assertKnownKeys(
        value,
        [ 'id', 'title', 'description', 'entryIds' ],
        label
    );
    return {
        id: asId(value.id, `${label}.id`),
        title: asString(value.title, `${label}.title`, 80),
        description: asString(value.description, `${label}.description`, 300),
        entryIds: asStringArray(value.entryIds, `${label}.entryIds`, {
            maxItems: 100,
            item: asId,
        }),
    };
}

function normalizeBundle(value, index) {
    const label = `bundles[${index}]`;
    if ( isObject(value) === false ) {
        throw new TypeError(`${label} must be an object`);
    }
    assertKnownKeys(
        value,
        [ 'id', 'title', 'description', 'entryIds' ],
        label
    );
    return {
        id: asId(value.id, `${label}.id`),
        title: asString(value.title, `${label}.title`, 80),
        description: asString(value.description, `${label}.description`, 300),
        entryIds: asStringArray(value.entryIds, `${label}.entryIds`, {
            maxItems: 16,
            item: asId,
        }),
    };
}

function assertUnique(items, label) {
    const ids = items.map(a => a.id);
    if ( new Set(ids).size !== ids.length ) {
        throw new TypeError(`${label} contains duplicate ids`);
    }
}

function assertReferences(items, entryIds, label) {
    for ( const item of items ) {
        for ( const entryId of item.entryIds ) {
            if ( entryIds.has(entryId) ) { continue; }
            throw new TypeError(`${label} ${item.id} references unknown entry ${entryId}`);
        }
    }
}

function assertInstallationOwnership(entries) {
    const owners = new Map();
    for ( const entry of entries ) {
        const ids = entry.installation.type === 'stock'
            ? entry.installation.rulesetIds
            : [ entry.installation.sourceURL ];
        for ( const id of ids ) {
            const owner = owners.get(id);
            if ( owner !== undefined ) {
                throw new TypeError(
                    `entries ${owner} and ${entry.id} both install ${id}`
                );
            }
            owners.set(id, entry.id);
        }
    }
}

export function parseFilterCatalog(value, options = {}) {
    if ( isObject(value) === false ) {
        throw new TypeError('catalog must be an object');
    }
    assertKnownKeys(value, [
        'schemaVersion',
        'updatedAt',
        'repository',
        'profiles',
        'bundles',
        'entries',
        'integrity',
    ], 'catalog');
    if ( value.schemaVersion !== FILTER_STORE_SCHEMA_VERSION ) {
        throw new TypeError(`unsupported catalog schema ${value.schemaVersion}`);
    }
    if ( isObject(value.repository) === false ) {
        throw new TypeError('repository must be an object');
    }
    assertKnownKeys(
        value.repository,
        [ 'id', 'title', 'homepage' ],
        'repository'
    );
    if ( Array.isArray(value.entries) === false || value.entries.length === 0 ||
        value.entries.length > FILTER_STORE_LIMITS.catalogEntries ) {
        throw new TypeError('catalog has an invalid number of entries');
    }
    const trustedRepository = options.trustedRepository === true;
    const entries = value.entries.map((entry, index) =>
        normalizeEntry(entry, index, trustedRepository)
    );
    const profileValues = value.profiles || [];
    const bundleValues = value.bundles || [];
    if ( Array.isArray(profileValues) === false || profileValues.length > 32 ) {
        throw new TypeError('catalog has too many profiles');
    }
    if ( Array.isArray(bundleValues) === false || bundleValues.length > 32 ) {
        throw new TypeError('catalog has too many bundles');
    }
    const profiles = profileValues.map(normalizeProfile);
    const bundles = bundleValues.map(normalizeBundle);
    assertUnique(entries, 'entries');
    assertInstallationOwnership(entries);
    assertUnique(profiles, 'profiles');
    assertUnique(bundles, 'bundles');
    const entryIds = new Set(entries.map(a => a.id));
    assertReferences(profiles, entryIds, 'profile');
    assertReferences(bundles, entryIds, 'bundle');
    const profileIds = new Set(profiles.map(a => a.id));
    for ( const entry of entries ) {
        for ( const profileId of entry.profiles ) {
            if ( profileIds.has(profileId) ) { continue; }
            throw new TypeError(
                `entry ${entry.id} references unknown profile ${profileId}`
            );
        }
    }
    const integrity = value.integrity;
    if ( integrity !== undefined ) {
        if ( isObject(integrity) === false || integrity.algorithm !== 'sha256' ||
            SHA256_PATTERN.test(integrity.digest) === false ) {
            throw new TypeError('catalog integrity must be a lowercase SHA-256 digest');
        }
        assertKnownKeys(integrity, [ 'algorithm', 'digest' ], 'integrity');
    }
    const updatedAt = asString(value.updatedAt, 'updatedAt', 40);
    if ( /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(updatedAt) === false ||
        Number.isNaN(Date.parse(updatedAt)) ) {
        throw new TypeError('updatedAt must be an RFC 3339 UTC timestamp');
    }
    return {
        schemaVersion: value.schemaVersion,
        updatedAt,
        repository: {
            id: asId(value.repository.id, 'repository.id'),
            title: asString(value.repository.title, 'repository.title', 100),
            homepage: asHttpsURL(value.repository.homepage, 'repository.homepage'),
        },
        profiles,
        bundles,
        entries,
        integrity: integrity && {
            algorithm: 'sha256',
            digest: integrity.digest,
        },
        repositoryURL: options.repositoryURL || '',
        trustedRepository,
    };
}

function stableObject(value) {
    if ( Array.isArray(value) ) {
        return value.map(stableObject);
    }
    if ( isObject(value) === false ) { return value; }
    const out = {};
    for ( const key of Object.keys(value).sort() ) {
        if ( key === 'integrity' || key === 'effectiveTrustTier' ||
            key === 'repositoryURL' || key === 'trustedRepository' ) {
            continue;
        }
        if ( value[key] === undefined ) { continue; }
        out[key] = stableObject(value[key]);
    }
    return out;
}

export function canonicalCatalogMetadata(catalog) {
    return JSON.stringify(stableObject(catalog));
}

export async function sha256Hex(value) {
    const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

export async function verifyCatalogMetadata(catalog) {
    if ( catalog.integrity === undefined ) { return false; }
    const digest = await sha256Hex(canonicalCatalogMetadata(catalog));
    return digest === catalog.integrity.digest;
}

export function installationIds(entry) {
    return entry.installation.type === 'stock'
        ? entry.installation.rulesetIds.slice()
        : [ entry.installation.sourceURL ];
}

export function isEntryEnabled(entry, enabledIds) {
    const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
    return installationIds(entry).every(id => enabled.has(id));
}

export function filterCatalogEntries(entries, filters = {}) {
    const query = `${filters.query || ''}`.trim().toLocaleLowerCase();
    return entries.filter(entry => {
        if ( filters.category && entry.category !== filters.category ) {
            return false;
        }
        if ( filters.language && entry.languages.includes('*') === false &&
            entry.languages.includes(filters.language) === false ) {
            return false;
        }
        if ( filters.profile && entry.profiles.includes(filters.profile) === false ) {
            return false;
        }
        if ( query === '' ) { return true; }
        const haystack = [
            entry.title,
            entry.description,
            entry.category,
            entry.languages.join(' '),
            entry.license,
        ].join(' ').toLocaleLowerCase();
        return haystack.includes(query);
    });
}

export function estimateCatalogQuota(entries, enabledIds, limits = {}) {
    const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
    const maximum = { ...FILTER_STORE_LIMITS, ...limits };
    const importedByURL = new Map();
    for ( const entry of entries ) {
        if ( entry.installation.type !== 'imported' ) { continue; }
        importedByURL.set(entry.installation.sourceURL, entry);
    }
    let dynamicRules = 0;
    let regexRules = 0;
    let unknownImportedLists = 0;
    for ( const id of enabled ) {
        if ( id.startsWith('https://') === false ) { continue; }
        const entry = importedByURL.get(id);
        if ( entry === undefined ) {
            unknownImportedLists += 1;
            continue;
        }
        dynamicRules += entry.ruleCost.dynamicRules;
        regexRules += entry.ruleCost.regexRules;
    }
    const staticRulesets = Array.from(enabled)
        .filter(id => id.startsWith('https://') === false).length;
    return {
        staticRulesets,
        dynamicRules,
        regexRules,
        unknownImportedLists,
        maximum,
        over: staticRulesets > maximum.staticRulesets ||
            dynamicRules > maximum.dynamicRules ||
            regexRules > maximum.regexRules,
        near: staticRulesets >= maximum.staticRulesets * 0.9 ||
            dynamicRules >= maximum.dynamicRules * 0.9 ||
            regexRules >= maximum.regexRules * 0.9,
    };
}
