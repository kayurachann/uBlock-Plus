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
    browser,
    localKeys,
    localRead,
    localRemove,
    localWrite,
} from './ext.js';

import {
    intersectHostnameIters,
    isScriptlet,
    matchesFromHostnames,
    subtractHostnameIters,
} from './utils.js';

import { ublockPlusErr } from './debug.js';

/******************************************************************************/

const isProcedural = a => a.startsWith('{');
const isCSS = a => isProcedural(a) === false && isScriptlet(a) === false;

/******************************************************************************/

function enqueueStorageOperation(task) {
    const result = pendingStorageOp.then(task);
    pendingStorageOp = result.catch(( ) => {});
    return result;
}

function keysFromStorage() {
    return enqueueStorageOperation(( ) => localKeys());
}

function readFromStorage(key) {
    // A failed read is not an empty filter set: callers must not overwrite an
    // existing set after an unreadable storage snapshot.
    return enqueueStorageOperation(async ( ) => {
        const bin = await browser.storage.local.get(key);
        return bin[key];
    });
}

function writeToStorage(key, value) {
    return enqueueStorageOperation(( ) => localWrite(key, value));
}

function removeFromStorage(key) {
    return enqueueStorageOperation(( ) => localRemove(key));
}

let pendingStorageOp = Promise.resolve();
let pendingFilterMutation = Promise.resolve();

function enqueueFilterMutation(task) {
    // Serialize the entire read/modify/write operation, including duplicate
    // hostnames in a batch import. Serializing individual API calls loses edits.
    const result = pendingFilterMutation.then(task);
    pendingFilterMutation = result.catch(( ) => {});
    return result;
}

/******************************************************************************/

export async function customFiltersFromHostname(hostname) {
    const promises = [];
    let hn = hostname;
    while ( hn !== '' ) {
        promises.push(readFromStorage(`site.${hn}`));
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
    }
    const results = await Promise.all(promises);
    const out = [];
    for ( let i = 0; i < promises.length; i++ ) {
        const selectors = results[i];
        if ( selectors === undefined ) { continue; }
        selectors.forEach(selector => {
            out.push(selector);
        });
    }
    return out.sort();
}

/******************************************************************************/

export async function hasCustomFilters(hostname) {
    const selectors = await customFiltersFromHostname(hostname);
    return selectors?.length ?? 0;
}

/******************************************************************************/

async function getAllCustomFilterKeys() {
    const storageKeys = await keysFromStorage() || [];
    return storageKeys.filter(a => a.startsWith('site.'));
}

/******************************************************************************/

export async function getAllCustomFilters() {
    const collect = async key => {
        const selectors = await readFromStorage(key);
        return [ key.slice(5), selectors ?? [] ];
    };
    const keys = await getAllCustomFilterKeys();
    const promises = keys.map(k => collect(k));
    return Promise.all(promises);
}

/******************************************************************************/

export function startCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        ublockPlusErr(`startCustomFilters/${reason}`);
    })
}

export function terminateCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user-terminate.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        ublockPlusErr(`terminateCustomFilters/${reason}`);
    })
}

/******************************************************************************/

export async function injectCustomFilters(tabId, frameId, hostname) {
    const selectors = await customFiltersFromHostname(hostname);
    if ( selectors.length === 0 ) { return; }
    const promises = [];
    const plainSelectors = selectors.filter(a => isCSS(a));
    if ( plainSelectors.length !== 0 ) {
        promises.push(
            browser.scripting.insertCSS({
                css: `${plainSelectors.join(',\n')}{display:none!important;}`,
                origin: 'USER',
                target: { tabId, frameIds: [ frameId ] },
            }).catch(reason => {
                ublockPlusErr(`injectCustomFilters/insertCSS/${reason}`);
            })
        );
    }
    const proceduralSelectors = selectors.filter(a => isProcedural(a));
    if ( proceduralSelectors.length !== 0 ) {
        promises.push(
            browser.scripting.executeScript({
                files: [
                    '/js/scripting/css-api.js',
                    '/js/scripting/css-procedural-api.js',
                ],
                target: { tabId, frameIds: [ frameId ] },
                injectImmediately: true,
            }).catch(reason => {
                ublockPlusErr(`injectCustomFilters/executeScript/${reason}`);
            })
        );
    }
    await Promise.all(promises);
    return { plainSelectors, proceduralSelectors };
}

/******************************************************************************/

export async function registerCustomFilters(context) {
    const customFilters = new Map(await getAllCustomFilters());
    if ( customFilters.size === 0 ) { return; }

    const { none } = context.filteringModeDetails;
    let hostnames = Array.from(customFilters.keys());
    let excludeHostnames = [];
    if ( none.has('all-urls') ) {
        const { basic, optimal, complete } = context.filteringModeDetails;
        hostnames = intersectHostnameIters(hostnames, [
            ...basic, ...optimal, ...complete
        ]);
    } else if ( none.size !== 0 ) {
        hostnames = [ ...subtractHostnameIters(hostnames, none) ];
        excludeHostnames = Array.from(none);
    }
    hostnames = hostnames.filter(a =>
        customFilters.get(a).some(a => isCSS(a) || isProcedural(a))
    );
    if ( hostnames.length === 0 ) { return; }

    const directive = {
        id: 'css-user',
        js: [ '/js/scripting/css-user.js' ],
        matches: matchesFromHostnames(hostnames),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    if ( excludeHostnames.length !== 0 ) {
        directive.excludeMatches = matchesFromHostnames(excludeHostnames);
    }

    context.toAdd.push(directive);
}

/******************************************************************************/

async function addCustomFiltersNow(hostname, toAdd) {
    if ( hostname === '' ) { return false; }
    const key = `site.${hostname}`;
    const selectors = await readFromStorage(key) || [];
    const countBefore = selectors.length;
    for ( const selector of toAdd ) {
        if ( selectors.includes(selector) ) { continue; }
        selectors.push(selector);
    }
    if ( selectors.length === countBefore ) { return false; }
    selectors.sort();
    await writeToStorage(key, selectors);
    return true;
}

export function addCustomFilters(hostname, toAdd) {
    return enqueueFilterMutation(( ) => addCustomFiltersNow(hostname, toAdd));
}

/******************************************************************************/

async function removeAllCustomFiltersNow(hostname) {
    if ( hostname === '*' ) {
        const keys = await getAllCustomFilterKeys();
        if ( keys.length === 0 ) { return false; }
        await removeFromStorage(keys);
        return true;
    }
    const key = `site.${hostname}`;
    const selectors = await readFromStorage(key) || [];
    await removeFromStorage(key);
    return selectors.length !== 0;
}

export function removeAllCustomFilters(hostname) {
    return enqueueFilterMutation(( ) => removeAllCustomFiltersNow(hostname));
}

async function removeCustomFiltersNow(hostname, selectors) {
    const promises = [];
    let hn = hostname;
    while ( hn !== '' ) {
        promises.push(removeCustomFiltersByKey(`site.${hn}`, selectors));
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
    }
    const results = await Promise.all(promises);
    return results.some(a => a);
}

export function removeCustomFilters(hostname, selectors) {
    return enqueueFilterMutation(( ) => removeCustomFiltersNow(hostname, selectors));
}

async function removeCustomFiltersByKey(key, toRemove) {
    const selectors = await readFromStorage(key);
    if ( selectors === undefined ) { return false; }
    const beforeCount = selectors.length;
    for ( const selector of toRemove ) {
        const i = selectors.indexOf(selector);
        if ( i === -1 ) { continue; }
        selectors.splice(i, 1);
    }
    const afterCount = selectors.length;
    if ( afterCount === beforeCount ) { return false; }
    if ( afterCount !== 0 ) {
        await writeToStorage(key, selectors);
    } else {
        await removeFromStorage(key);
    }
    return true;
}

/******************************************************************************/

export function getSandboxFilters() {
    return localRead('sandboxFilters');
}

export function setSandboxFilters(text = '') {
    text = text.trim();
    return text !== ''
        ? localWrite('sandboxFilters', text)
        : localRemove('sandboxFilters')
}
