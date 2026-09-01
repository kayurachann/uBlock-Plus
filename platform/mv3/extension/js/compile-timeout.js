/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export const COMPILE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
export const COMPILE_HARD_TIMEOUT_MAX_MS = 30 * 60 * 1000;

const COMPILE_HARD_TIMEOUT_BASE_MS = 3 * 60 * 1000;
const COMPILE_LIST_ALLOWANCE_MS = 45 * 1000;
const COMPILE_FETCH_ALLOWANCE_MS = 5 * 1000;
const MAX_FETCHES_PER_LIST = 32;

export function getCompileHardTimeout(lists) {
    if ( Array.isArray(lists) === false ) {
        return COMPILE_HARD_TIMEOUT_BASE_MS;
    }
    let fetchBudget = 0;
    for ( const list of lists ) {
        if ( list?.sourceIntegrity ) {
            fetchBudget += 1;
            continue;
        }
        const configured = Number.isSafeInteger(list?.maxSourceFetches)
            ? list.maxSourceFetches
            : MAX_FETCHES_PER_LIST;
        fetchBudget += Math.max(1, Math.min(configured, MAX_FETCHES_PER_LIST));
    }
    const workloadTimeout = COMPILE_HARD_TIMEOUT_BASE_MS +
        lists.length * COMPILE_LIST_ALLOWANCE_MS +
        fetchBudget * COMPILE_FETCH_ALLOWANCE_MS;
    return Math.min(workloadTimeout, COMPILE_HARD_TIMEOUT_MAX_MS);
}

/******************************************************************************/
