/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

import assert from 'node:assert/strict';

import { normalizeBackupObject } from
    '../platform/mv3/extension/js/backup-schema.js';

const valid = normalizeBackupObject({
    autoReload: true,
    memoryProfile: 'low-memory',
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
assert.notEqual(valid.customFilters[0], undefined);

for ( const invalid of [
    null,
    [],
    { autoReload: 'yes' },
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

console.log('Backup schema preflight tests passed');
