/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2019-present Raymond Hill
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

// Important!
// Isolate from global scope
(async function uBlockPlus_cssSpecific() {

/******************************************************************************/

const specificImports = self.specificImports || [];
self.specificImports = undefined;

/******************************************************************************/

const { isolatedAPI } = self;

const sessionRead = async function(key) {
    try {
        const bin = await chrome.storage.session.get(key);
        return bin?.[key] ?? undefined;
    } catch {
    }
};

const sessionWrite = async function(key, data) {
    try {
        await chrome.storage.session.set({ [key]: data });
    } catch {
    }
};

const localRead = async function(key) {
    try {
        const bin = await chrome.storage.local.get(key);
        return bin?.[key] ?? undefined;
    } catch {
    }
};

const selectorsFromListIndex = (data, ilist) => {
    const list = JSON.parse(`[${data.selectorLists[ilist]}]`);
    const { result } = data;
    for ( const iselector of list ) {
        if ( iselector >= 0 ) {
            result.selectors.add(data.selectors[iselector]);
        } else {
            result.exceptions.add(data.selectors[~iselector]);
        }
    }
};

const selectorsFromHostnames = (haystack, needles, data) => {
    let listref = -1;
    for ( const needle of needles ) {
        listref = isolatedAPI.binarySearch(haystack, needle, listref);
        if ( listref >= 0 ) {
            selectorsFromListIndex(data, data.selectorListRefs[listref]);
        } else {
            listref = ~listref + 1;
        }
    }
};

const selectorsFromRuleset = async (rulesetId, result) => {
    const data = await localRead(`css.specific.${rulesetId}`);
    if ( typeof data !== 'object' || data === null ) { return false; }
    data.result = result;
    const { hostnames, regexes } = data;
    if ( hostnames.length ) {
        selectorsFromHostnames(hostnames, isolatedAPI.contexts.hostnames, data);
        if ( data.hasEntities ) {
            selectorsFromHostnames(hostnames, isolatedAPI.contexts.entities, data);
        }
    }
    for ( let i = 0, n = regexes.length; i < n; i += 3 ) {
        if ( thisHostname.includes(regexes[i+0]) === false ) { continue; }
        if ( typeof regexes[i+1] === 'string' ) {
            regexes[i+1] = new RegExp(regexes[i+1]);
        }
        if ( regexes[i+1].test(thisHostname) === false ) { continue; }
        selectorsFromListIndex(data, regexes[i+2]);
    }
    return true;
};

const fillCache = async function(rulesetIds) {
    const selectors = new Set();
    const exceptions = new Set();
    const result = { selectors, exceptions };
    const [ filteringModeDetails, memoryProfile ] = await Promise.all([
        localRead('filteringModeDetails'),
        sessionRead('memoryProfile.runtime'),
    ]);
    // Without the current Off scopes, applying even valid cached list data
    // could filter a page which the user has explicitly trusted.
    if ( Array.isArray(filteringModeDetails?.none) === false ) { return; }
    if ( filteringModeDetails.none.some(a => typeof a !== 'string') ) { return; }
    const skip = filteringModeDetails.none.some(a => {
        if ( topHostname.endsWith(a) === false ) { return false; }
        const n = a.length;
        return topHostname.length === n || topHostname.at(-n-1) === '.';
    });
    if ( skip ) {
        cacheEntry.s = [];
        cacheEntry.p = [];
        return cacheEntry;
    }
    const modeSnapshot = JSON.stringify(filteringModeDetails);
    // Each storage read deserializes an entire packaged dictionary into this
    // frame. Bound cold-cache work as well as compilation, without dropping
    // any list or applying selectors before later-list exceptions arrive.
    // A missing session profile can occur during startup: use one reader.
    const concurrency = memoryProfile?.importCompileConcurrency === 2 ? 2 : 1;
    for ( let i = 0; i < rulesetIds.length; i += concurrency ) {
        const loaded = await Promise.all(rulesetIds.slice(i, i + concurrency).map(a =>
            selectorsFromRuleset(a, result)
        )).catch(( ) => undefined);
        // An unavailable dictionary may contain exceptions to another list.
        // Leave the page unchanged and the cache empty so a later navigation
        // can retry, rather than publishing a partial filtering result.
        if ( loaded?.every(success => success === true) !== true ) { return; }
    }
    // Loading several dictionaries can span a user changing site modes.
    // Discard that obsolete result before it can repopulate the cleared cache
    // or hide elements on a newly trusted page.
    const currentModes = await localRead('filteringModeDetails');
    if ( JSON.stringify(currentModes) !== modeSnapshot ) { return; }
    for ( const selector of exceptions ) {
        selectors.delete(selector);
    }
    cacheEntry.s = [];
    cacheEntry.p = [];
    for ( const selector of selectors ) {
        if ( selector.startsWith('{') ) {
            cacheEntry.p.push(JSON.parse(selector));
        } else {
            cacheEntry.s.push(selector);
        }
    }
    return cacheEntry;
};

const topHostname = isolatedAPI.contexts.topHostname;
const thisHostname = document.location.hostname || '';
const cachePath = topHostname !== thisHostname ? `${topHostname}/` : '';
const cacheKey = `cache.css.${cachePath}${thisHostname}`;

let cacheEntry = await sessionRead(cacheKey) ?? { t: 0 };
const cacheMiss = cacheEntry.t === 0;
if ( cacheMiss ) {
    cacheEntry = await fillCache(specificImports);
    if ( cacheEntry === undefined ) { return; }
}
const now = Math.round(Date.now() / (5 * 60000));
const since = now - cacheEntry.t;
if ( since > 1 ) {
    cacheEntry.t = now;
    await sessionWrite(cacheKey, cacheEntry);
    if ( cacheMiss ) {
        chrome.runtime.sendMessage({ what: 'noteCSSCacheWrite' }).catch(( ) => { });
    }
}

const { s, p } = cacheEntry;

if ( s.length !== 0 ) {
    self.cssAPI.insert(`${s.join(',\n')}{display:none!important;}`);
}

if ( p.length === 0 ) { return; }

if ( self.ProceduralFiltererAPI === undefined ) {
    self.ProceduralFiltererAPI = chrome.runtime.sendMessage({
        what: 'injectCSSProceduralAPI'
    }).catch(( ) => {
    });
}

await self.ProceduralFiltererAPI;
self.listsProceduralFiltererAPI = new self.ProceduralFiltererAPI();

const declaratives = p.filter(a => a.cssable);
if ( declaratives.length !== 0 ) {
    self.listsProceduralFiltererAPI.addDeclaratives(declaratives);
}
const procedurals = p.filter(a => !a.cssable);
if ( procedurals.length !== 0 ) {
    self.listsProceduralFiltererAPI.addProcedurals(procedurals);
}

/******************************************************************************/

})();

void 0;
