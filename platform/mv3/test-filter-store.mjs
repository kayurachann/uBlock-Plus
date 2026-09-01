/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    estimateCatalogQuota,
    filterCatalogEntries,
    installationIds,
    isEntryEnabled,
    parseFilterCatalog,
    verifyCatalogMetadata,
} from './extension/js/filter-store-model.js';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const readText = path => fs.readFile(new URL(path, root), 'utf8');
const readJSON = async path => JSON.parse(await readText(path));

const rawCatalog = await readJSON('extension/filter-store/catalog.json');
const catalog = parseFilterCatalog(rawCatalog, {
    repositoryURL: 'chrome-extension://test/filter-store/catalog.json',
    trustedRepository: true,
});

assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.repository.id, 'ublock-plus-curated');
assert.ok(catalog.entries.length >= 8);
assert.ok(catalog.profiles.some(a => a.id === 'low-memory'));
assert.ok(catalog.bundles.some(a => a.id === 'low-memory-essentials'));
assert.equal(await verifyCatalogMetadata(catalog), true);

const entryIds = new Set();
for ( const entry of catalog.entries ) {
    assert.equal(entryIds.has(entry.id), false, `duplicate entry ${entry.id}`);
    entryIds.add(entry.id);
    assert.ok(entry.sourceURLs.every(url => url.startsWith('https://')));
    assert.ok(entry.homepage.startsWith('https://'));
    assert.ok(entry.license.length !== 0);
    assert.equal(
        entry.trustTier,
        'community',
        `${entry.id} must not claim verification without governance evidence`
    );
    assert.ok([ 'stock', 'imported' ].includes(entry.installation.type));
    if ( entry.installation.type === 'imported' ) {
        assert.equal(entry.sourceIntegrity.algorithm, 'sha256');
        assert.match(entry.sourceIntegrity.digest, /^[a-f0-9]{64}$/);
        assert.match(
            entry.installation.sourceURL,
            /raw\.githubusercontent\.com\/.+\/[a-f0-9]{40}\//,
            `${entry.id} must use a commit-pinned source`
        );
    }
}

const rulesets = await readJSON('rulesets.json');
const stockIds = new Set(rulesets.map(a => a.id));
for ( const entry of catalog.entries ) {
    if ( entry.installation.type !== 'stock' ) { continue; }
    for ( const id of entry.installation.rulesetIds ) {
        assert.ok(stockIds.has(id), `${entry.id} references missing stock ruleset ${id}`);
    }
}

const noCoin = catalog.entries.find(a => a.id === 'community-nocoin');
assert.deepEqual(installationIds(noCoin), [ noCoin.installation.sourceURL ]);
assert.equal(isEntryEnabled(noCoin, new Set()), false);
assert.equal(isEntryEnabled(noCoin, new Set(installationIds(noCoin))), true);

const lowMemory = filterCatalogEntries(catalog.entries, { profile: 'low-memory' });
assert.ok(lowMemory.length >= 3);
assert.ok(lowMemory.every(a => a.profiles.includes('low-memory')));
assert.deepEqual(
    filterCatalogEntries(catalog.entries, { query: 'cryptocurrency' }).map(a => a.id),
    [ 'community-nocoin' ]
);
assert.ok(filterCatalogEntries(catalog.entries, { language: 'vi' })
    .some(a => a.id === 'ubp-vietnamese'));

const enabled = new Set([
    'ublock-filters',
    'easylist',
    noCoin.installation.sourceURL,
]);
const quota = estimateCatalogQuota(catalog.entries, enabled, {
    staticRulesets: 50,
});
assert.equal(quota.staticRulesets, 2);
assert.equal(quota.dynamicRules, noCoin.ruleCost.dynamicRules);
assert.equal(quota.regexRules, 0);
assert.equal(quota.unknownImportedLists, 0);
assert.equal(quota.over, false);

const remoteCatalog = parseFilterCatalog(rawCatalog, {
    repositoryURL: 'https://example.test/catalog.json',
});
assert.ok(remoteCatalog.entries.every(a => a.effectiveTrustTier === 'community'));

{
    const invalid = structuredClone(rawCatalog);
    invalid.entries[0].sourceURLs[0] = 'http://example.test/list.txt';
    assert.throws(( ) => parseFilterCatalog(invalid), /HTTPS URL/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.bundles[0].entryIds.push('missing-entry');
    assert.throws(( ) => parseFilterCatalog(invalid), /unknown entry/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.updatedAt = 'next Tuesday';
    assert.throws(( ) => parseFilterCatalog(invalid), /RFC 3339/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.entries[0].profiles.push('missing-profile');
    assert.throws(( ) => parseFilterCatalog(invalid), /unknown profile/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.entries[1].installation = structuredClone(
        invalid.entries[0].installation
    );
    invalid.entries[1].ruleCost.staticRulesets =
        invalid.entries[1].installation.rulesetIds.length;
    assert.throws(( ) => parseFilterCatalog(invalid), /both install/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.bundles[0].entryIds = Array.from(
        { length: 17 },
        (_, index) => `entry-${index}`
    );
    assert.throws(( ) => parseFilterCatalog(invalid), /1-16 items/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.entries[0].remoteCode = 'https://example.test/plugin.js';
    assert.throws(( ) => parseFilterCatalog(invalid), /unknown field/);
}

{
    const invalid = structuredClone(rawCatalog);
    invalid.integrity.digest = 'f'.repeat(64);
    const parsed = parseFilterCatalog(invalid, { trustedRepository: true });
    assert.equal(await verifyCatalogMetadata(parsed), false);
}

const dashboard = await readText('extension/dashboard.html');
assert.match(dashboard, /id="filterStore"/);
assert.match(dashboard, /id="filterStoreEntries"/);
assert.match(dashboard, /id="filterStoreRepositoryURL"/);

const controller = await readText('extension/js/filter-store.js');
assert.doesNotMatch(controller, /\.innerHTML\b/);
assert.doesNotMatch(controller, /\beval\s*\(/);
assert.doesNotMatch(controller, /\bimport\s*\(\s*[^'"`]/);
assert.match(controller, /verifiedSourceKey/);
assert.match(controller, /what: 'updateRulesetSelection'/);
assert.match(controller, /rulesetIdsToEnable: stockRulesetIds/);
assert.doesNotMatch(controller, /beforeEnabled/);

const background = await readText('extension/js/background.js');
assert.match(
    background,
    /async function updateRulesetSelection[\s\S]+enqueueFilteringMutation/
);
assert.match(background, /request\.rulesetIdsToEnable/);

const compiler = await readText('extension/js/offscreen/compile-filters.js');
assert.match(compiler, /Pinned filter response failed SHA-256 verification/);
assert.match(compiler, /compiledIntegrityUpdates/);

for ( const locale of [ 'en', 'vi' ] ) {
    const messages = await readJSON(`extension/_locales/${locale}/messages.json`);
    for ( const key of [
        'filterStoreTitle',
        'filterStoreDescription',
        'filterStoreQuotaExceeded',
        'filterStoreCommunityConfirm',
        'filterStoreActivationWarnings',
        'filterStoreRepositories',
        'filterStoreResultsLimited',
    ] ) {
        assert.equal(typeof messages[key]?.message, 'string', `${locale}: ${key}`);
    }
}

console.log(`Filter Store tests passed (${catalog.entries.length} entries)`);
