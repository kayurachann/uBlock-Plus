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
    COMPILE_HARD_TIMEOUT_MAX_MS,
    COMPILE_IDLE_TIMEOUT_MS,
    getCompileHardTimeout,
} from '../platform/mv3/extension/js/compile-timeout.js';

import assert from 'node:assert/strict';

const onePinned = [ { sourceIntegrity: { algorithm: 'sha256' } } ];
const sixteenSerial = Array.from({ length: 16 }, ( ) => ({
    maxSourceFetches: 32,
}));

assert.ok(COMPILE_IDLE_TIMEOUT_MS > 30_000);
assert.ok(getCompileHardTimeout(onePinned) > COMPILE_IDLE_TIMEOUT_MS);
assert.ok(getCompileHardTimeout(sixteenSerial) > getCompileHardTimeout(onePinned));
assert.equal(
    getCompileHardTimeout(Array.from({ length: 100 }, ( ) => ({
        maxSourceFetches: 32,
    }))),
    COMPILE_HARD_TIMEOUT_MAX_MS
);
assert.equal(
    getCompileHardTimeout(sixteenSerial) <= COMPILE_HARD_TIMEOUT_MAX_MS,
    true
);

console.log('Compilation timeout tests passed');
