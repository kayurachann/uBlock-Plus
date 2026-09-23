/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

import {
    migrateLegacyImportedLists,
    normalizeBackupObject,
    normalizeModeHostname,
} from '../platform/mv3/extension/js/backup-schema.js';
import assert from 'node:assert/strict';

const valid = normalizeBackupObject({
    autoReload: true,
    memoryProfile: 'low-memory',
    popupPolicies: {
        'example.com': 'strict',
        'trusted.example': 'allow',
    },
    powerUISettings: {
        theme: 'dark',
        accent: 'violet',
        density: 'compact',
        popupLayout: 'power',
    },
    filterStoreRepositories: [ 'https://catalog.example/store.json' ],
    rulesets: [ '+easylist', '-annoyances-cookies' ],
    importedLists: [ {
        url: 'https://filters.example/list.txt',
        enabled: true,
        sourceIntegrity: {
            algorithm: 'sha256',
            digest: 'a'.repeat(64),
            bytes: 123,
        },
    } ],
    filteringModes: {
        none: [],
        basic: [],
        optimal: [ 'all-urls' ],
        complete: [],
    },
    customFilters: [ [ 'example.com', [ '.ad', '##.sponsor' ] ] ],
    sandboxFilters: [ 'example.com##.ad' ],
    dnrRules: [ '||example.test^' ],
});
assert.equal(valid.memoryProfile, 'low-memory');
assert.equal(valid.popupPolicies['example.com'], 'strict');
assert.equal(valid.powerUISettings.theme, 'dark');
assert.notEqual(valid.customFilters[0], undefined);

for ( const invalid of [
    null,
    [],
    { autoReload: 'yes' },
    { popupPolicies: [] },
    { popupPolicies: { 'not a hostname': 'strict' } },
    { popupPolicies: { 'example.com': 'aggressive' } },
    { powerUISettings: { theme: 'midnight' } },
    { filterStoreRepositories: 'https://catalog.example/store.json' },
    { rulesets: [ 'easylist' ] },
    { importedLists: {} },
    { importedLists: [ { url: 42 } ] },
    { importedLists: [ { url: 'http://filters.example/list.txt' } ] },
    { importedLists: [
        { url: 'https://filters.example/list.txt' },
        { url: 'https://FILTERS.example:443/list.txt' },
    ] },
    { filterStoreRepositories: [ 'https://user:pass@example.test/store.json' ] },
    { filteringModes: { none: [], basic: [], optimal: 'all-urls', complete: [] } },
    { customFilters: [ [ 'example.com', '.ad' ] ] },
    { sandboxFilters: 'x' },
    { dnrRules: 'x' },
    { importedLists: Array.from({ length: 5 }, (_, index) => ({
        url: `https://filters.example/${index}.txt`,
        enabled: true,
    })) },
] ) {
    assert.throws(( ) => normalizeBackupObject(invalid));
}

// Normalization returns detached arrays so later restore code cannot observe
// caller-side mutation while its asynchronous transaction is in progress.
const input = { sandboxFilters: [ 'one' ] };
const normalized = normalizeBackupObject(input);
input.sandboxFilters[0] = 'two';
assert.deepEqual(normalized.sandboxFilters, [ 'one' ]);

// The popup stores a page's URL.hostname unchanged. Every such name must
// survive its own backup, including underscores and the trailing-dot form.
for ( const hostname of [
    'foo_bar.example.com', '_dmarc.example.com', 'my_app.intranet.example',
    'example.com.', 'foo-.blogspot.com', 'localhost', '127.0.0.1', '[::1]',
] ) {
    assert.equal(normalizeModeHostname(hostname), hostname);
    assert.deepEqual(normalizeBackupObject({ filteringModes: {
        none: [ hostname ], basic: [], optimal: [ 'all-urls' ], complete: [],
    } }).filteringModes.none, [ hostname ]);
}
assert.equal(normalizeModeHostname('BÜCHER.example'), 'xn--bcher-kva.example');
for ( const hostname of [
    '', '*.example.com', 'https://example.com/', 'example.com/path',
    'user@example.com', 'exa mple.com', 'example..com', '.example.com',
    'example.com..', 'a!b.example', `${'a'.repeat(64)}.example`,
] ) {
    assert.throws(( ) => normalizeModeHostname(hostname), /hostname/, hostname);
}

// Upstream uBO Lite and early uBlock Plus+ backups record imported lists only
// as `+https://…` rulesets entries. None may be silently dropped.
{
    const legacy = normalizeBackupObject({
        rulesets: [
            '+easylist', '-annoyances-cookies',
            '+https://filters.example/one.txt',
            '+https://FILTERS.example:443/two.txt',
            '+http://insecure.example/list.txt',
            '+https://filters.example/explicit.txt',
        ],
        importedLists: [ {
            url: 'https://filters.example/explicit.txt',
            sourceIntegrity: { algorithm: 'sha256', digest: 'b'.repeat(64), bytes: 1024 },
        } ],
    });
    assert.deepEqual(migrateLegacyImportedLists(legacy), {
        importedLists: [
            legacy.importedLists[0],
            { url: 'https://filters.example/one.txt', enabled: true },
            { url: 'https://filters.example/two.txt', enabled: true },
        ],
        disabled: [],
        skipped: [ 'http://insecure.example/list.txt' ],
    });
    // Lists beyond the 20 MiB enabled-source budget are kept, disabled.
    const many = normalizeBackupObject({
        rulesets: Array.from({ length: 6 }, (_, i) => `+https://filters.example/${i}.txt`),
    });
    const migrated = migrateLegacyImportedLists(many);
    assert.deepEqual(migrated.importedLists.map(list => list.enabled),
        [ true, true, true, true, false, false ]);
    assert.deepEqual(migrated.disabled,
        [ 'https://filters.example/4.txt', 'https://filters.example/5.txt' ]);
    assert.doesNotThrow(( ) => normalizeBackupObject({
        rulesets: many.rulesets, importedLists: migrated.importedLists,
    }), 'Migrated lists must satisfy the backup budget');
    // A backup without URL-shaped rulesets is unchanged.
    assert.deepEqual(migrateLegacyImportedLists(valid).importedLists, valid.importedLists);
    assert.deepEqual(migrateLegacyImportedLists({}), {
        importedLists: [], disabled: [], skipped: [],
    });
}

console.log('Backup schema preflight tests passed');
