/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

import {
    createVerifiedSourceKey,
    isVerifiedSourceKey,
    parseVerifiedSourceKey,
} from '../platform/mv3/extension/js/verified-source-handoff.js';

import assert from 'node:assert/strict';

const digest = 'a'.repeat(64);
const nonce = '12345678-1234-4abc-8def-1234567890ab';
const key = createVerifiedSourceKey(digest, {
    createdAt: 1767225600000,
    randomUUID: ( ) => nonce,
});

assert.equal(
    key,
    `filterStore.verifiedSource.1767225600000.` +
        `1234567812344abc8def1234567890ab.${digest}`
);
assert.deepEqual(parseVerifiedSourceKey(key), {
    createdAt: 1767225600000,
    nonce: '1234567812344abc8def1234567890ab',
    digest,
});
assert.equal(isVerifiedSourceKey(key, digest), true);
assert.equal(isVerifiedSourceKey(key, 'b'.repeat(64)), false);

for ( const invalid of [
    undefined,
    '',
    `filterStore.verifiedSource.1767225600000.${digest}`,
    `filterStore.verifiedSource.1767225600000../secrets.${digest}`,
    `filterStore.verifiedSource.1767225600000.${'g'.repeat(32)}.${digest}`,
    `filterStore.verifiedSource.1767225600000.${'a'.repeat(32)}.${digest}/x`,
] ) {
    assert.equal(parseVerifiedSourceKey(invalid), undefined);
    assert.equal(isVerifiedSourceKey(invalid, digest), false);
}

assert.throws(( ) => createVerifiedSourceKey('A'.repeat(64)));
assert.throws(( ) => createVerifiedSourceKey(digest, {
    createdAt: 1,
    randomUUID: ( ) => nonce,
}));

console.log('Verified-source handoff tests passed');
