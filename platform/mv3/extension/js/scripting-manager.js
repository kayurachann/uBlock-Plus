/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

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

import * as ut from './utils.js';

import {
    browser,
    localKeys, localRemove, localWrite,
    sessionKeys, sessionRead, sessionRemove,
    webextFlavor,
} from './ext.js';

import { registerJob, removeJob } from './alarms.js';

import { fetchJSON } from './fetch.js';
import { getEnabledRulesetsDetails } from './ruleset-manager.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { getMemoryProfileConfig } from './memory-manager.js';
import { registerCustomFilters } from './filter-manager.js';
import { registerPreventPopup } from './prevent-popup.js';
import { registerToolbarIconToggler } from './action.js';
import { ubolLog } from './debug.js';

/******************************************************************************/

const resourceDetailPromises = new Map();

export function releaseScriptingMetadata() {
    resourceDetailPromises.clear();
}

function getScriptletDetails() {
    let promise = resourceDetailPromises.get('scriptlet');
    if ( promise !== undefined ) { return promise; }
    promise = fetchJSON('/rulesets/scriptlet-details').then(
        entries => new Map(entries)
    );
    resourceDetailPromises.set('scriptlet', promise);
    return promise;
}

function getGenericDetails() {
    let promise = resourceDetailPromises.get('generic');
    if ( promise !== undefined ) { return promise; }
    promise = fetchJSON('/rulesets/generic-details').then(
        entries => new Map(entries)
    );
    resourceDetailPromises.set('generic', promise);
    return promise;
}

/******************************************************************************/

const normalizeMatches = matches => {
    if ( matches.length <= 1 ) { return; }
    if ( matches.includes('<all_urls>') === false ) {
        if ( matches.includes('*://*/*') === false ) { return; }
    }
    matches.length = 0;
    matches.push('<all_urls>');
};

/******************************************************************************/

async function resetCSSCache() {
    const keys = await sessionKeys() || [];
    return sessionRemove(keys.filter(a => a.startsWith('cache.css.')));
}

/******************************************************************************/

function registerGeneric(context, genericDetails) {
    const { filteringModeDetails, rulesetsDetails } = context;

    const excludedByFilter = [];
    const includedByFilter = [];
    const js = [];
    for ( const details of rulesetsDetails ) {
        const hostnames = genericDetails.get(details.id);
        if ( hostnames ) {
            if ( hostnames.unhide ) {
                excludedByFilter.push(...hostnames.unhide);
            }
            if ( hostnames.hide ) {
                includedByFilter.push(...hostnames.hide);
            }
        }
        const count = details.css?.generic || 0;
        if ( count === 0 ) { continue; }
        js.push(`/rulesets/scripting/generic/${details.id}.js`);
    }

    if ( js.length === 0 ) { return; }

    js.unshift('/js/scripting/css-api.js', '/js/scripting/isolated-api.js');
    js.push('/js/scripting/css-generic.js');

    const { none, basic, optimal, complete } = filteringModeDetails;
    const includedByMode = [ ...complete ];
    const excludedByMode = [ ...none, ...basic, ...optimal ];

    if ( complete.has('all-urls') === false ) {
        const matches = [
            ...ut.matchesFromHostnames(
                ut.subtractHostnameIters(includedByMode, excludedByFilter)
            ),
            ...ut.matchesFromHostnames(
                ut.intersectHostnameIters(includedByMode, includedByFilter)
            ),
        ];
        if ( matches.length === 0 ) { return; }
        const directive = {
            id: 'css-generic-some',
            js,
            allFrames: true,
            matches,
            runAt: 'document_idle',
        };
        context.toAdd.push(directive);
        return;
    }

    const excludeMatches = [
        ...ut.matchesFromHostnames(excludedByMode),
        ...ut.matchesFromHostnames(excludedByFilter),
    ];
    const directiveAll = {
        id: 'css-generic-all',
        js,
        allFrames: true,
        matches: [ '<all_urls>' ],
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directiveAll.excludeMatches = excludeMatches;
    }
    context.toAdd.push(directiveAll);

    const matches = [
        ...ut.matchesFromHostnames(
            ut.subtractHostnameIters(includedByFilter, excludedByMode)
        ),
    ];
    if ( matches.length === 0 ) { return; }
    const directiveSome = {
        id: 'css-generic-some',
        js,
        allFrames: true,
        matches,
        runAt: 'document_idle',
    };
    context.toAdd.push(directiveSome);
}

/******************************************************************************/

async function registerCosmetic(context) {
    const {
        filteringModeDetails,
        memoryProfile,
        rulesetsDetails,
    } = context;

    {
        const keys = await localKeys();
        localRemove(keys.filter(a => a.startsWith('css.specific.')));
        // TODO: remove after a few versions after 2026.516.1652
        localRemove(keys.filter(a => a.startsWith('css.procedural.')));
    }

    const rulesetIds = [];
    for ( const rulesetDetails of rulesetsDetails ) {
        const count = rulesetDetails.css?.specific ?? 0;
        if ( count === 0 ) { continue; }
        rulesetIds.push(rulesetDetails.id);
    }
    if ( rulesetIds.length === 0 ) { return; }

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    const concurrency = memoryProfile.importCompileConcurrency;
    for ( let i = 0; i < rulesetIds.length; i += concurrency ) {
        const batch = rulesetIds.slice(i, i + concurrency);
        await Promise.all(batch.map(id =>
            fetchJSON(`/rulesets/scripting/specific/${id}`).then(data => {
                return localWrite(`css.specific.${id}`, data);
            })
        ));
    }

    normalizeMatches(matches);

    const js = rulesetIds.map(id => `/rulesets/scripting/specific/${id}.js`);
    js.unshift('/js/scripting/css-api.js', '/js/scripting/isolated-api.js');
    if ( webextFlavor === 'safari' ) {
        js.push('/js/scripting/css-procedural-api.js');
    }
    js.push('/js/scripting/css-specific.js');

    const excludeMatches = [];
    if ( none.has('all-urls') === false && basic.has('all-urls') === false ) {
        const toExclude = [
            ...ut.matchesFromHostnames(none),
            ...ut.matchesFromHostnames(basic),
        ];
        for ( const hn of toExclude ) {
            excludeMatches.push(hn);
        }
    }

    const directive = {
        id: 'css-specific',
        js,
        matches,
        allFrames: true,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    // register
    context.toAdd.push(directive);
}

/******************************************************************************/

function registerScriptlet(context, scriptletDetails) {
    const { filteringModeDetails, rulesetsDetails } = context;

    const hasBroadHostPermission =
        filteringModeDetails.optimal.has('all-urls') ||
        filteringModeDetails.complete.has('all-urls');

    const permissionRevokedMatches = [
        ...ut.matchesFromHostnames(filteringModeDetails.none),
        ...ut.matchesFromHostnames(filteringModeDetails.basic),
    ];
    const permissionGrantedHostnames = [
        ...filteringModeDetails.optimal,
        ...filteringModeDetails.complete,
    ];

    for ( const rulesetId of rulesetsDetails.map(v => v.id) ) {
        const worlds = scriptletDetails.get(rulesetId);
        if ( worlds === undefined ) { continue; }
        for ( const world of Object.keys(worlds) ) {
            const id = `${rulesetId}.${world.toLowerCase()}`;

            const matches = [];
            const excludeMatches = [];
            const hostnames = worlds[world];
            let targetHostnames = [];
            if ( hasBroadHostPermission ) {
                excludeMatches.push(...permissionRevokedMatches);
                targetHostnames = hostnames;
            } else if ( permissionGrantedHostnames.length !== 0 ) {
                if ( hostnames.includes('*') ) {
                    targetHostnames = permissionGrantedHostnames;
                } else {
                    targetHostnames = ut.intersectHostnameIters(
                        hostnames,
                        permissionGrantedHostnames
                    );
                }
            }
            if ( targetHostnames.length === 0 ) { continue; }
            matches.push(...ut.matchesFromHostnames(targetHostnames));
            normalizeMatches(matches);

            const directive = {
                id,
                js: [ `/rulesets/scripting/scriptlet/${world.toLowerCase()}/${rulesetId}.js` ],
                matches,
                allFrames: true,
                matchOriginAsFallback: true,
                runAt: 'document_start',
                world,
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches;
            }

            // register
            context.toAdd.push(directive);
        }
    }
}

/******************************************************************************/

// Issue: Safari appears to completely ignore excludeMatches
// https://github.com/radiolondra/ExcludeMatches-Test

export async function registerContentScripts() {
    if ( browser.scripting === undefined ) { return false; }
    return enqueueContentScriptOperation(( ) =>
        registerContentScripts.register()
    );
}
registerContentScripts.pendingOp = Promise.resolve();

function enqueueContentScriptOperation(task) {
    const result = registerContentScripts.pendingOp.then(task);
    registerContentScripts.pendingOp = result.catch(( ) => { });
    return result;
}

async function replaceRegisteredContentScripts(toAdd) {
    const previousScripts = await browser.scripting.getRegisteredContentScripts();
    let replacementStarted = false;
    try {
        if ( previousScripts.length !== 0 ) {
            await browser.scripting.unregisterContentScripts();
            replacementStarted = true;
            ubolLog(`Unregistered all content (css/js)`);
        }
        if ( toAdd.length !== 0 ) {
            replacementStarted = true;
            await browser.scripting.registerContentScripts(toAdd);
            ubolLog(`Registered ${toAdd.map(v => v.id)} content (css/js)`);
        }
    } catch ( reason ) {
        if ( replacementStarted ) {
            try {
                await browser.scripting.unregisterContentScripts();
                if ( previousScripts.length !== 0 ) {
                    await browser.scripting.registerContentScripts(previousScripts);
                }
            } catch ( rollbackReason ) {
                throw new Error(
                    `Unable to register content scripts (${reason}); ` +
                    `rollback also failed (${rollbackReason})`
                );
            }
        }
        throw reason;
    }
    return { previousScripts };
}

async function restoreRegisteredContentScripts(snapshot) {
    if ( Array.isArray(snapshot?.previousScripts) === false ) { return false; }
    const currentScripts = await browser.scripting.getRegisteredContentScripts();
    if ( currentScripts.length !== 0 ) {
        await browser.scripting.unregisterContentScripts();
    }
    if ( snapshot.previousScripts.length !== 0 ) {
        await browser.scripting.registerContentScripts(snapshot.previousScripts);
    }
    return true;
}

export async function restoreContentScripts(snapshot) {
    if ( browser.scripting === undefined ) { return false; }
    return enqueueContentScriptOperation(( ) =>
        restoreRegisteredContentScripts(snapshot)
    );
}

registerContentScripts.register = async function register() {
    const [
        filteringModeDetails,
        rulesetsDetails,
        memoryProfile,
    ] = await Promise.all([
        getFilteringModeDetails(),
        getEnabledRulesetsDetails(true),
        getMemoryProfileConfig(),
    ]);
    const toAdd = [];
    const context = {
        filteringModeDetails,
        memoryProfile,
        rulesetsDetails,
        toAdd,
    };

    if ( memoryProfile.retainScriptingMetadata ) {
        const [ scriptletDetails, genericDetails ] = await Promise.all([
            getScriptletDetails(),
            getGenericDetails(),
        ]);
        registerScriptlet(context, scriptletDetails);
        registerGeneric(context, genericDetails);
    } else {
        registerScriptlet(context, await getScriptletDetails());
        resourceDetailPromises.delete('scriptlet');
        registerGeneric(context, await getGenericDetails());
        resourceDetailPromises.delete('generic');
    }

    await Promise.all([
        registerCosmetic(context),
        registerCustomFilters(context),
        registerPreventPopup(context),
        registerToolbarIconToggler(context),
    ]);

    const previousRegistration = await replaceRegisteredContentScripts(toAdd);

    const pruneMinutes = memoryProfile.cssCachePruneMinutes;
    try {
        await Promise.all([
            resetCSSCache(),
            pruneMinutes !== 0
                ? registerJob(
                    'pruneCSSCache',
                    Date.now() + pruneMinutes * 60 * 1000
                )
                : removeJob('pruneCSSCache'),
        ]);
    } catch ( reason ) {
        try {
            await restoreRegisteredContentScripts(previousRegistration);
        } catch ( rollbackReason ) {
            throw new Error(
                `Content-script cache reset failed (${reason}); ` +
                `registration rollback also failed (${rollbackReason})`
            );
        }
        throw reason;
    }

    return previousRegistration;
};

/******************************************************************************/

export async function getRegisteredContentScripts() {
    const scripts = await browser.scripting.getRegisteredContentScripts();
    return scripts.map(a => a.id);
}

/******************************************************************************/

let pendingCSSCachePrune;

async function pruneCSSCacheNow(options = {}) {
    const memoryProfile = await getMemoryProfileConfig();
    const pruneMinutes = memoryProfile.cssCachePruneMinutes;
    if ( pruneMinutes !== 0 ) {
        await registerJob(
            'pruneCSSCache',
            Date.now() + pruneMinutes * 60 * 1000
        );
    } else {
        await removeJob('pruneCSSCache');
    }
    const maxEntries = memoryProfile.cssCacheMaxEntries;
    const highWatermark = memoryProfile.cssCacheHighWatermark;
    const keys = await sessionKeys() || [];
    const cacheKeys = keys.filter(a => a.startsWith('cache.css.'));
    if ( maxEntries === 0 ) {
        return sessionRemove(cacheKeys);
    }
    if (
        options.force !== true &&
        cacheKeys.length < highWatermark
    ) { return; }
    if ( cacheKeys.length <= maxEntries ) { return; }

    // Read only a small batch at once and retain timestamps, not the cached
    // selector arrays themselves, while computing the least-recently-used set.
    const entries = [];
    const concurrency = memoryProfile.importCompileConcurrency === 1 ? 1 : 8;
    for ( let i = 0; i < cacheKeys.length; i += concurrency ) {
        const batch = cacheKeys.slice(i, i + concurrency);
        const batchEntries = await Promise.all(batch.map(async key => {
            const entry = await sessionRead(key) || {};
            return { key, t: entry.t ?? 0 };
        }));
        entries.push(...batchEntries);
    }
    entries.sort((a, b) => b.t - a.t);
    return sessionRemove(entries.slice(maxEntries).map(a => a.key));
}

export function pruneCSSCache(options = {}) {
    if ( pendingCSSCachePrune ) { return pendingCSSCachePrune; }
    const result = pruneCSSCacheNow(options);
    pendingCSSCachePrune = result.finally(( ) => {
        pendingCSSCachePrune = undefined;
    });
    return pendingCSSCachePrune;
}

/******************************************************************************/
