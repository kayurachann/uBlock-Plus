/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2022-present Raymond Hill
    Modifications Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    broadcastMessage,
    hostnamesFromMatches,
    isDescendantHostnameOfIter,
} from './utils.js';

import {
    browser,
    localRead, localRemove, localWrite,
    sessionWrite,
} from './ext.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import { adminReadEx } from './admin.js';
import { filteringModesToDNR } from './ruleset-manager.js';
import { hasBroadHostPermissions } from './ext-utils.js';


/******************************************************************************/

// 0:       no filtering
// 1:    basic filtering
// 2:  optimal filtering
// 3: complete filtering

export const     MODE_NONE = 0;
export const    MODE_BASIC = 1;
export const  MODE_OPTIMAL = 2;
export const MODE_COMPLETE = 3;

export const defaultFilteringModes = {
    none: [],
    basic: [],
    optimal: [ 'all-urls' ],
    complete: [],
};

const MODE_KEY = 'filteringModeDetails';
const RESTORE_KEY = 'filteringModeRestoreLevels';
const TRANSACTION_KEY = 'filteringModeTransaction';
let pendingModeMutation = Promise.resolve();
let loadingModes;
let recoveryNeeded = false;
let restoreLevels = {};

function enqueueModeMutation(task) {
    const result = pendingModeMutation.then(task);
    pendingModeMutation = result.catch(( ) => { });
    return result;
}

/******************************************************************************/

const pruneDescendantHostnamesFromSet = (hostname, hnSet) => {
    for ( const hn of hnSet ) {
        if ( hn.endsWith(hostname) === false ) { continue; }
        if ( hn === hostname ) { continue; }
        if ( hn.at(-hostname.length-1) !== '.' ) { continue; }
        hnSet.delete(hn);
    }
};

const serializeModeDetails = details => {
    return {
        none: Array.from(details.none),
        basic: Array.from(details.basic),
        optimal: Array.from(details.optimal),
        complete: Array.from(details.complete),
    };
};

const unserializeModeDetails = details => {
    return {
        none: new Set(details.none),
        basic: new Set(details.basic ?? details.network),
        optimal: new Set(details.optimal ?? details.extendedSpecific),
        complete: new Set(details.complete ?? details.extendedGeneric),
    };
};

/******************************************************************************/

function lookupFilteringMode(filteringModes, hostname) {
    const { none, basic, optimal, complete } = filteringModes;
    if ( hostname === 'all-urls' ) {
        if ( filteringModes.none.has('all-urls') ) { return MODE_NONE; }
        if ( filteringModes.basic.has('all-urls') ) { return MODE_BASIC; }
        if ( filteringModes.optimal.has('all-urls') ) { return MODE_OPTIMAL; }
        if ( filteringModes.complete.has('all-urls') ) { return MODE_COMPLETE; }
        return MODE_BASIC;
    }
    if ( none.has(hostname) ) { return MODE_NONE; }
    if ( none.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, none) ) { return MODE_NONE; }
    }
    if ( basic.has(hostname) ) { return MODE_BASIC; }
    if ( basic.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, basic) ) { return MODE_BASIC; }
    }
    if ( optimal.has(hostname) ) { return MODE_OPTIMAL; }
    if ( optimal.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, optimal) ) { return MODE_OPTIMAL; }
    }
    if ( complete.has(hostname) ) { return MODE_COMPLETE; }
    if ( complete.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, complete) ) { return MODE_COMPLETE; }
    }
    return lookupFilteringMode(filteringModes, 'all-urls');
}

/******************************************************************************/

function applyFilteringMode(filteringModes, hostname, afterLevel) {
    const defaultLevel = lookupFilteringMode(filteringModes, 'all-urls');
    if ( hostname === 'all-urls' ) {
        if ( afterLevel === defaultLevel ) { return afterLevel; }
        switch ( afterLevel ) {
        case MODE_NONE:
            filteringModes.none.clear();
            filteringModes.none.add('all-urls');
            break;
        case MODE_BASIC:
            filteringModes.basic.clear();
            filteringModes.basic.add('all-urls');
            break;
        case MODE_OPTIMAL:
            filteringModes.optimal.clear();
            filteringModes.optimal.add('all-urls');
            break;
        case MODE_COMPLETE:
            filteringModes.complete.clear();
            filteringModes.complete.add('all-urls');
            break;
        }
        switch ( defaultLevel ) {
        case MODE_NONE:
            filteringModes.none.delete('all-urls');
            break;
        case MODE_BASIC:
            filteringModes.basic.delete('all-urls');
            break;
        case MODE_OPTIMAL:
            filteringModes.optimal.delete('all-urls');
            break;
        case MODE_COMPLETE:
            filteringModes.complete.delete('all-urls');
            break;
        }
        return lookupFilteringMode(filteringModes, 'all-urls');
    }
    const beforeLevel = lookupFilteringMode(filteringModes, hostname);
    if ( afterLevel === beforeLevel ) { return afterLevel; }
    const { none, basic, optimal, complete } = filteringModes;
    // DNR trusted-site and cosmetic/scriptlet registration scopes do not all
    // support positive child exceptions. Never remove an inherited parent to
    // emulate one: that changes sibling sites. A child can still turn off or
    // return to the parent's level; other levels require editing the parent.
    const scopes = [ none, basic, optimal, complete ];
    if ( afterLevel === MODE_NONE && defaultLevel === MODE_NONE &&
        scopes.slice(1).some(hostnames =>
            isDescendantHostnameOfIter(hostname, hostnames)
        ) ) {
        const error = new Error('Turn off filtering on the parent site first');
        error.code = 'ERR_FILTERING_MODE_PARENT_SCOPE';
        throw error;
    }
    if ( afterLevel !== MODE_NONE ) {
        for ( const [ level, hostnames ] of scopes.entries() ) {
            if ( level === afterLevel ) { continue; }
            const parents = [ ...hostnames ].filter(hn =>
                hn !== hostname && hn !== 'all-urls'
            );
            if ( isDescendantHostnameOfIter(hostname, parents) === false ) {
                continue;
            }
            const error = new Error(level === MODE_NONE
                ? 'Enable filtering on the trusted parent site first'
                : 'Change filtering on the parent site first');
            error.code = 'ERR_FILTERING_MODE_PARENT_SCOPE';
            throw error;
        }
    }
    scopes[beforeLevel].delete(hostname);
    if ( afterLevel !== defaultLevel ) {
        switch ( afterLevel ) {
        case MODE_NONE:
            if ( isDescendantHostnameOfIter(hostname, none) === false ) {
                filteringModes.none.add(hostname);
                // Preserve independently trusted descendants so turning the
                // parent back on does not enable filtering on those children.
            }
            break;
        case MODE_BASIC:
            if ( isDescendantHostnameOfIter(hostname, basic) === false ) {
                filteringModes.basic.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, basic);
            }
            break;
        case MODE_OPTIMAL:
            if ( isDescendantHostnameOfIter(hostname, optimal) === false ) {
                filteringModes.optimal.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, optimal);
            }
            break;
        case MODE_COMPLETE:
            if ( isDescendantHostnameOfIter(hostname, complete) === false ) {
                filteringModes.complete.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, complete);
            }
            break;
        }
    }
    return lookupFilteringMode(filteringModes, hostname);
}

/******************************************************************************/

async function effectiveModeDetails(details) {
    const [
        adminDefaultFiltering,
        adminNoFiltering,
    ] = await Promise.all([
        adminReadEx('defaultFiltering'),
        adminReadEx('noFiltering'),
    ]);
    const userModes = unserializeModeDetails(details);
    if ( adminDefaultFiltering !== undefined ) {
        const modefromName = {
            none: MODE_NONE,
            basic: MODE_BASIC,
            optimal: MODE_OPTIMAL,
            complete: MODE_COMPLETE,
        };
        const adminDefaultFilteringMode = modefromName[adminDefaultFiltering];
        if ( adminDefaultFilteringMode !== undefined ) {
            applyFilteringMode(userModes, 'all-urls', adminDefaultFilteringMode);
        }
    }
    if ( Array.isArray(adminNoFiltering) && adminNoFiltering.length !== 0 ) {
        if ( adminNoFiltering.includes('-*') ) {
            userModes.none.clear();
        }
        for ( const hn of adminNoFiltering ) {
            if ( hn.charAt(0) === '-' ) {
                userModes.none.delete(hn.slice(1));
            } else {
                applyFilteringMode(userModes, hn, 0);
            }
        }
    }
    return userModes;
}

/******************************************************************************/

function normalizeRestoreLevels(value) {
    if ( value === undefined ) { return {}; }
    if ( value === null || typeof value !== 'object' || Array.isArray(value) ) {
        throw new Error('Invalid filtering-mode restore settings');
    }
    return Object.fromEntries(Object.entries(value).filter(([ hostname, level ]) =>
        hostname !== '' && Number.isInteger(level) && level >= 1 && level <= 3
    ));
}

async function readPersistedModes() {
    // Unlike optional settings, failure to read trusted sites must not fall
    // back to the default blocking mode. Session data is only a cache.
    return browser.storage.local.get([ MODE_KEY, RESTORE_KEY, TRANSACTION_KEY ]);
}

async function restoreModeTransaction(transaction) {
    if ( transaction?.version !== 1 ||
        transaction.previousModes instanceof Object === false ) {
        throw new Error('Invalid pending filtering-mode transaction');
    }
    const modes = await effectiveModeDetails(transaction.previousModes);
    const levels = normalizeRestoreLevels(transaction.previousRestoreLevels);
    const errors = [];
    for ( const task of [
        ( ) => filteringModesToDNR(modes),
        ( ) => localWrite(MODE_KEY, transaction.previousModes),
        ( ) => localWrite(RESTORE_KEY, levels),
        ( ) => sessionWrite(MODE_KEY, serializeModeDetails(modes)),
    ] ) {
        try { await task(); }
        catch ( reason ) { errors.push(`${reason}`); }
    }
    if ( errors.length !== 0 ) {
        throw new Error(`Filtering-mode rollback failed: ${errors.join('; ')}`);
    }
    await localRemove(TRANSACTION_KEY);
    restoreLevels = levels;
    readFilteringModeDetails.cache = modes;
    recoveryNeeded = false;
    return modes;
}

async function loadFilteringModes() {
    const stored = await readPersistedModes();
    if ( stored[TRANSACTION_KEY] !== undefined ) {
        recoveryNeeded = true;
        return restoreModeTransaction(stored[TRANSACTION_KEY]);
    }
    const modes = await effectiveModeDetails(
        stored[MODE_KEY] ?? defaultFilteringModes
    );
    const levels = normalizeRestoreLevels(stored[RESTORE_KEY]);
    await filteringModesToDNR(modes);
    await sessionWrite(MODE_KEY, serializeModeDetails(modes));
    restoreLevels = levels;
    readFilteringModeDetails.cache = modes;
    recoveryNeeded = false;
    return modes;
}

export function readFilteringModeDetails(bypassCache = false) {
    if ( bypassCache ) {
        return enqueueModeMutation(( ) => loadFilteringModes());
    }
    if ( readFilteringModeDetails.cache && recoveryNeeded === false ) {
        return Promise.resolve(readFilteringModeDetails.cache);
    }
    if ( loadingModes !== undefined ) { return loadingModes; }
    loadingModes = loadFilteringModes().finally(( ) => {
        loadingModes = undefined;
    });
    return loadingModes;
}

async function writeFilteringModeDetails(
    afterDetails, afterRestore = restoreLevels, restoreHostname
) {
    const stored = await readPersistedModes();
    if ( stored[TRANSACTION_KEY] !== undefined ) {
        throw new Error('Filtering-mode transaction recovery is required');
    }
    const before = {
        version: 1,
        previousModes: stored[MODE_KEY] ?? structuredClone(defaultFilteringModes),
        previousRestoreLevels: normalizeRestoreLevels(stored[RESTORE_KEY]),
    };
    const data = serializeModeDetails(afterDetails);
    const effectiveModes = await effectiveModeDetails(data);
    if ( typeof restoreHostname === 'string' &&
        lookupFilteringMode(effectiveModes, restoreHostname) > MODE_NONE ) {
        afterRestore = { ...afterRestore };
        delete afterRestore[restoreHostname];
    }
    const hasOmnipotence = await hasBroadHostPermissions();
    // An existing journal always means "restore the previous committed mode".
    // Its removal is the commit point, including after a worker restart.
    try { await localWrite(TRANSACTION_KEY, before); }
    catch ( reason ) {
        recoveryNeeded = true;
        throw reason;
    }
    try {
        await filteringModesToDNR(effectiveModes);
        await localWrite(MODE_KEY, data);
        await localWrite(RESTORE_KEY, afterRestore);
        await sessionWrite(MODE_KEY, serializeModeDetails(effectiveModes));
        await localRemove(TRANSACTION_KEY);
    } catch ( reason ) {
        try { await restoreModeTransaction(before); }
        catch ( rollbackReason ) {
            recoveryNeeded = true;
            throw new Error(`${reason}; ${rollbackReason}`);
        }
        throw reason;
    }
    restoreLevels = afterRestore;
    readFilteringModeDetails.cache = effectiveModes;
    recoveryNeeded = false;
    broadcastMessage({
        defaultFilteringMode: lookupFilteringMode(effectiveModes, 'all-urls'),
        hasOmnipotence,
        filteringModeDetails: effectiveModes,
    });
}

/******************************************************************************/

export async function getFilteringModeDetails(serializable = false) {
    const actualDetails = await readFilteringModeDetails();
    const out = {
        none: new Set(actualDetails.none),
        basic: new Set(actualDetails.basic),
        optimal: new Set(actualDetails.optimal),
        complete: new Set(actualDetails.complete),
    };
    return serializable ? serializeModeDetails(out) : out;
}

export async function getFilteringModeRestoreLevels() {
    await readFilteringModeDetails();
    return { ...restoreLevels };
}

export async function setFilteringModeDetails(details, restoredLevels) {
    const modes = unserializeModeDetails(serializeModeDetails(details));
    const levels = restoredLevels === undefined
        ? undefined
        : normalizeRestoreLevels(restoredLevels);
    return enqueueModeMutation(async ( ) => {
        await readFilteringModeDetails();
        await writeFilteringModeDetails(modes, levels);
    });
}

/******************************************************************************/

export async function getFilteringMode(hostname) {
    const filteringModes = await getFilteringModeDetails();
    return lookupFilteringMode(filteringModes, hostname);
}

async function setFilteringModeNow(hostname, afterLevel) {
    if ( typeof hostname !== 'string' || hostname === '' ||
        Number.isInteger(afterLevel) === false || afterLevel < 0 || afterLevel > 3 ) {
        throw new Error('Invalid filtering mode or hostname');
    }
    const filteringModes = await getFilteringModeDetails();
    const beforeLevel = lookupFilteringMode(filteringModes, hostname);
    const level = applyFilteringMode(filteringModes, hostname, afterLevel);
    if ( beforeLevel === level ) { return level; }
    const levels = { ...restoreLevels };
    if ( beforeLevel > MODE_NONE && level === MODE_NONE ) {
        Object.defineProperty(levels, hostname, {
            value: beforeLevel, enumerable: true, configurable: true, writable: true,
        });
    }
    await writeFilteringModeDetails(filteringModes, levels, hostname);
    return lookupFilteringMode(readFilteringModeDetails.cache, hostname);
}

export function setFilteringMode(hostname, afterLevel) {
    return enqueueModeMutation(( ) => setFilteringModeNow(hostname, afterLevel));
}

export async function getFilteringModeRestoreLevel(hostname) {
    const modes = await readFilteringModeDetails();
    const current = lookupFilteringMode(modes, hostname);
    if ( current > MODE_NONE ) { return current; }
    const previous = Object.hasOwn(restoreLevels, hostname)
        ? restoreLevels[hostname]
        : undefined;
    return previous ?? Math.max(lookupFilteringMode(modes, 'all-urls'), MODE_BASIC);
}

/******************************************************************************/

export function getDefaultFilteringMode() {
    return getFilteringMode('all-urls');
}

export function setDefaultFilteringMode(afterLevel) {
    return setFilteringMode('all-urls', afterLevel);
}

/******************************************************************************/

export async function persistHostPermissions(iter) {
    if ( iter === undefined ) {
        const permissions = await browser.permissions.getAll();
        iter = hostnamesFromMatches(permissions.origins) || [];
    }
    const hostnames = Array.from(iter);
    return hostnames.length !== 0
        ? localWrite('permissions.hostnames', hostnames)
        : localRemove('permissions.hostnames');
}

/******************************************************************************/

async function syncWithBrowserPermissionsNow() {
    const [
        beforePermissions,
        afterPermissions,
        beforeMode,
    ] = await Promise.all([
        localRead('permissions.hostnames'),
        browser.permissions.getAll(),
        getDefaultFilteringMode(),
    ]);
    const beforeAllowedHostnames = new Set(beforePermissions);
    const afterAllowedHostnames = new Set(hostnamesFromMatches(afterPermissions.origins || []));
    await persistHostPermissions(afterAllowedHostnames);
    const hasBroadHostPermissions = afterAllowedHostnames.has('all-urls');
    const broadHostPermissionsToggled =
        hasBroadHostPermissions !== rulesetConfig.hasBroadHostPermissions;
    let modified = false;
    if ( beforeMode > MODE_BASIC && hasBroadHostPermissions === false ) {
        await setFilteringModeNow('all-urls', MODE_BASIC);
        modified = true;
    } else if ( beforeMode === MODE_BASIC && hasBroadHostPermissions && broadHostPermissionsToggled ) {
        await setFilteringModeNow('all-urls', MODE_OPTIMAL);
        modified = true;
    }
    if ( broadHostPermissionsToggled ) {
        rulesetConfig.hasBroadHostPermissions = hasBroadHostPermissions;
        saveRulesetConfig();
    }
    const afterMode = await getDefaultFilteringMode();
    if ( afterMode > MODE_BASIC ) { return afterMode !== beforeMode; }
    const filteringModes = await getFilteringModeDetails();
    if ( afterAllowedHostnames.has('all-urls') === false ) {
        const { none, basic, optimal, complete } = filteringModes;
        for ( const hn of new Set([ ...optimal, ...complete ]) ) {
            if ( afterAllowedHostnames.has(hn) ) { continue; }
            if ( isDescendantHostnameOfIter(hn, afterAllowedHostnames) ) { continue; }
            applyFilteringMode(filteringModes, hn, afterMode);
            modified = true;
        }
        for ( const hn of afterAllowedHostnames ) {
            if ( beforeAllowedHostnames.has(hn) ) { continue; }
            if ( optimal.has(hn) || complete.has(hn) ) { continue; }
            if ( basic.has(hn) || none.has(hn) ) { continue; }
            applyFilteringMode(filteringModes, hn, MODE_OPTIMAL);
            modified = true;
        }
        if ( modified ) {
            await writeFilteringModeDetails(filteringModes);
        }
    }
    return modified;
}

export function syncWithBrowserPermissions() {
    return enqueueModeMutation(( ) => syncWithBrowserPermissionsNow());
}

/******************************************************************************/
