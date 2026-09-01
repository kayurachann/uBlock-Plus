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
    applyFreshImportedListMetadata,
    pendingImportedMetadataKey,
} from '../platform/mv3/extension/js/imported-list-metadata.js';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const token = 'a'.repeat(32);
assert.equal(
    pendingImportedMetadataKey('https://filters.example/list.txt'),
    'rulesets.imported.pendingMetadata.https://filters.example/list.txt'
);
const list = {
    time: { updated: 123 },
    name: 'Old name',
    expires: 7,
};

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        compiledIntegrity: {
            algorithm: 'sha256',
            digest: 'b'.repeat(64),
            bytes: 10,
        },
    }, 456),
    { fresh: false, modified: false }
);
assert.equal(list.time.updated, 123);

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        metadataToken: token,
        title: 'Fresh name',
        expires: 2,
    }, 456),
    { fresh: true, modified: true }
);
assert.equal(list.time.updated, 456);
assert.equal(list.name, 'Fresh name');
assert.equal(list.compiledMetadataToken, token);

assert.deepEqual(
    applyFreshImportedListMetadata(list, {
        metadataToken: token,
        title: 'Must not be applied twice',
    }, 789),
    { fresh: true, modified: false }
);
assert.equal(list.time.updated, 456);
assert.equal(list.name, 'Fresh name');

const importedListsSource = await fs.readFile(new URL(
    '../platform/mv3/extension/js/imported-lists.js',
    import.meta.url
), 'utf8');
assert.match(
    importedListsSource,
    /export function cleanupCommittedImportedListUpdates\(updates\)/
);
assert.match(
    importedListsSource,
    /commitImportedListUpdates\(updates, options = \{\}\)/
);
assert.match(importedListsSource, /options\.cleanup !== false/);

console.log('Imported-list metadata tests passed');
