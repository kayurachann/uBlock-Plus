/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import fs from 'fs/promises';

/******************************************************************************/

// Downloaded filter lists are cached under dist/build/mv3-data so that a
// failed ruleset generation can be retried offline. The cache survives
// builds, so without an age limit a release built weeks later would
// silently ship the old lists. A clean checkout (CI) has no cache and is
// unaffected. `listCacheMaxAgeDays=Infinity` reuses any cached list, for
// rebuilding from a preserved input set.
export const DEFAULT_LIST_CACHE_MAX_AGE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function listCacheMaxAgeDays(args, env = {}) {
    const value = args.get('listCacheMaxAgeDays') ??
        env.UBLOCK_PLUS_LIST_CACHE_MAX_AGE_DAYS;
    if ( value === undefined || value === '' ) {
        return DEFAULT_LIST_CACHE_MAX_AGE_DAYS;
    }
    const days = Number(value);
    if ( Number.isNaN(days) || days < 0 ) {
        throw new Error(`Invalid list cache maximum age: ${value}`);
    }
    return days;
}

// Resolves to { content, fetchedAt } for a cached file younger than the
// limit, or undefined when it must be downloaded again.
export async function readCachedList(filePath, maxAgeDays, now = Date.now()) {
    const stat = await fs.stat(filePath).catch(( ) => { });
    if ( stat?.isFile() !== true ) { return; }
    if ( now - stat.mtimeMs > maxAgeDays * MS_PER_DAY ) { return; }
    const content = await fs.readFile(filePath, { encoding: 'utf8' })
        .catch(( ) => { });
    if ( content === undefined ) { return; }
    return { content, fetchedAt: new Date(stat.mtimeMs).toISOString() };
}

/******************************************************************************/
