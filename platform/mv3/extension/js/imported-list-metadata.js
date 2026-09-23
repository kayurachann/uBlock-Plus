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
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DEFAULT_EXPIRES_DAYS = 7;
const MAX_REFRESH_ERROR_LENGTH = 300;
// A generation normally activates, and commits its refreshed lists, moments
// after the compiler fetched them. Retries of a failed activation happen
// within this delay; past it, a refresh still awaiting its commit is
// suspected of preventing activation.
const PENDING_REFRESH_GRACE_MS = MS_PER_HOUR;
export const PENDING_IMPORTED_METADATA_PREFIX =
    'rulesets.imported.pendingMetadata.';

export function pendingImportedMetadataKey(listid) {
    return `${PENDING_IMPORTED_METADATA_PREFIX}${listid}`;
}

function expiresMs(list) {
    return (list.expires > 0 ? list.expires : DEFAULT_EXPIRES_DAYS) * MS_PER_DAY;
}

// Pinned sources are immutable: a new digest arrives with a new catalog
// entry and invalidates the cache by itself, so a timed refetch can only
// return the same bytes or fail.
export function importedListRefreshTime(list) {
    if ( list?.sourceIntegrity ) { return Number.POSITIVE_INFINITY; }
    const updated = list?.time?.updated;
    if ( Number.isFinite(updated) === false ) {
        return Number.POSITIVE_INFINITY;
    }
    const retryAfter = Number.isFinite(list.time.retryAfter)
        ? list.time.retryAfter
        : 0;
    return Math.max(updated + expiresMs(list), retryAfter);
}

export function isImportedListRefreshDue(list, now = Date.now()) {
    return importedListRefreshTime(list) <= now;
}

// Sidecars written before `fetchedAt` existed have an unknown age.
export function isPendingImportedRefreshStale(pendingMetadata, now = Date.now()) {
    const age = now - pendingMetadata?.fetchedAt;
    return (age >= 0 && age < PENDING_REFRESH_GRACE_MS) === false;
}

// A failed refresh keeps the last complete compilation active. Back off
// exponentially from one hour, bounded by one day and the list's own
// period, so alarm retries and service-worker wakes do not refetch. The
// cause stays on the list until a refresh succeeds, so a list served from
// an ever older cache does not look up to date.
export function applyImportedListRefreshFailure(list, update) {
    const failedAt = update?.failedAt;
    if ( update?.refreshFailed !== true || Number.isFinite(failedAt) === false ) {
        return false;
    }
    // Recovery can commit the same activation twice.
    if ( list.time.refreshFailedAt === failedAt ) { return false; }
    const failures = Math.min((list.time.refreshFailures || 0) + 1, 16);
    list.time.refreshFailures = failures;
    list.time.refreshFailedAt = failedAt;
    list.time.retryAfter = failedAt + Math.min(
        MS_PER_HOUR * 2 ** (failures - 1),
        MS_PER_DAY,
        expiresMs(list)
    );
    list.refreshError = {
        at: failedAt,
        message: typeof update.message === 'string'
            ? update.message.slice(0, MAX_REFRESH_ERROR_LENGTH)
            : '',
    };
    return true;
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
    delete list.time.refreshFailures;
    delete list.time.refreshFailedAt;
    delete list.time.retryAfter;
    delete list.refreshError;
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
