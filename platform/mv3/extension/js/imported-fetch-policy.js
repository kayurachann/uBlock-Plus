/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export const MAX_IMPORTED_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORTED_SOURCE_FETCHES = 32;

function boundedPositiveInteger(value, maximum) {
    if ( Number.isSafeInteger(value) === false || value <= 0 ) {
        return maximum;
    }
    return Math.min(value, maximum);
}

export function createImportedFetchBudget(asset = {}) {
    return {
        maximumBytes: boundedPositiveInteger(
            asset.maxBytes,
            MAX_IMPORTED_SOURCE_BYTES
        ),
        maximumFetches: boundedPositiveInteger(
            asset.maxFetches,
            MAX_IMPORTED_SOURCE_FETCHES
        ),
        usedBytes: 0,
    };
}

export function isCredentialFreeHTTPS(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.username === '' && url.password === '';
    } catch {
        return false;
    }
}

/******************************************************************************/
