/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export const VERIFIED_SOURCE_PREFIX = 'filterStore.verifiedSource.';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = new RegExp(
    '^filterStore\\.verifiedSource\\.(\\d{13})\\.' +
    '([a-f0-9]{32})\\.([a-f0-9]{64})$'
);

export function createVerifiedSourceKey(digest, options = {}) {
    if ( typeof digest !== 'string' || DIGEST_PATTERN.test(digest) === false ) {
        throw new TypeError('Verified source digest must be lowercase SHA-256');
    }
    const createdAt = options.createdAt ?? Date.now();
    if ( Number.isSafeInteger(createdAt) === false ||
        /^\d{13}$/.test(`${createdAt}`) === false ) {
        throw new TypeError('Verified source timestamp is invalid');
    }
    const randomUUID = options.randomUUID ??
        globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if ( typeof randomUUID !== 'function' ) {
        throw new TypeError('crypto.randomUUID is unavailable');
    }
    const uuid = randomUUID();
    if ( typeof uuid !== 'string' ) {
        throw new TypeError('Verified source nonce is invalid');
    }
    const nonce = uuid.replaceAll('-', '').toLowerCase();
    if ( NONCE_PATTERN.test(nonce) === false ) {
        throw new TypeError('Verified source nonce is invalid');
    }
    return `${VERIFIED_SOURCE_PREFIX}${createdAt}.${nonce}.${digest}`;
}

export function parseVerifiedSourceKey(value) {
    if ( typeof value !== 'string' ) { return; }
    const match = KEY_PATTERN.exec(value);
    if ( match === null ) { return; }
    return {
        createdAt: Number(match[1]),
        nonce: match[2],
        digest: match[3],
    };
}

export function isVerifiedSourceKey(value, expectedDigest) {
    const parsed = parseVerifiedSourceKey(value);
    if ( parsed === undefined ) { return false; }
    return expectedDigest === undefined || parsed.digest === expectedDigest;
}

/******************************************************************************/
