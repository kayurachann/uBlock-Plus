/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

const METADATA_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
export const PENDING_IMPORTED_METADATA_PREFIX =
    'rulesets.imported.pendingMetadata.';

export function pendingImportedMetadataKey(listid) {
    return `${PENDING_IMPORTED_METADATA_PREFIX}${listid}`;
}

export function applyFreshImportedListMetadata(list, update, now = Date.now()) {
    const metadataToken = typeof update?.metadataToken === 'string' &&
        METADATA_TOKEN_PATTERN.test(update.metadataToken)
        ? update.metadataToken
        : '';
    if ( metadataToken === '' ) {
        return { fresh: false, modified: false };
    }
    if ( list.compiledMetadataToken === metadataToken ) {
        return { fresh: true, modified: false };
    }
    list.time.updated = now;
    if ( update.title ) { list.name = update.title; }
    if ( update.homeURL ) { list.homeURL = update.homeURL; }
    if ( update.expires ) { list.expires = update.expires; }
    if ( Object.hasOwn(update, 'verifiedSourceKey') ) {
        if ( update.verifiedSourceKey ) {
            list.verifiedSourceKey = update.verifiedSourceKey;
        } else {
            delete list.verifiedSourceKey;
        }
    }
    if ( update.filterStats ) { list.filters = update.filterStats; }
    if ( update.ruleStats ) { list.rules = update.ruleStats; }
    if ( Array.isArray(update.rejections) ) {
        list.rejections = update.rejections;
    }
    list.compiledMetadataToken = metadataToken;
    return { fresh: true, modified: true };
}

/******************************************************************************/
