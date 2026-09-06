/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2024-present Raymond Hill
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
    dnr,
    normalizeDNRRules,
    webext,
} from './ext-compat.js';

import {
    sessionRead,
    sessionWrite,
} from './ext.js';

/******************************************************************************/

const isModern = dnr.onRuleMatchedDebug instanceof Object;

export const isSideloaded = (( ) => {
    const { permissions } = webext.runtime.getManifest();
    return permissions?.includes('declarativeNetRequestFeedback') ?? false;
})();

/******************************************************************************/

const CONSOLE_MAX_LINES = 32;
const consoleOutput = [];

sessionRead('console').then(before => {
    if ( Array.isArray(before) === false ) { return; }
    for ( const s of before.reverse() ) {
        consoleOutput.unshift(s);
    }
    consoleTruncate();
});

const consoleTruncate = ( ) => {
    if ( consoleOutput.length <= CONSOLE_MAX_LINES ) { return; }
    consoleOutput.copyWithin(0, -CONSOLE_MAX_LINES);
    consoleOutput.length = CONSOLE_MAX_LINES;
};

const consoleAdd = (...args) => {
    if ( args.length === 0 ) { return; }
    const now = new Date();
    const time = [
        `${now.getUTCMonth()+1}`.padStart(2, '0'),
        `${now.getUTCDate()}`.padStart(2, '0'),
        '.',
        `${now.getUTCHours()}`.padStart(2, '0'),
        `${now.getUTCMinutes()}`.padStart(2, '0'),
    ].join('');
    for ( let i = 0; i < args.length; i++ ) {
        const s = `[${time}]${args[i]}`;
        if ( Boolean(s) === false ) { continue; }
        if ( s === consoleOutput.at(-1) ) { continue; }
        consoleOutput.push(s);
    }
    consoleTruncate();
    sessionWrite('console', getConsoleOutput());
}

export const ublockPlusLog = (...args) => {
    // Do not pollute dev console in stable releases.
    if ( isSideloaded !== true ) { return; }
    console.info('[uBlock Plus+]', ...args);
};

export const ublockPlusErr = (...args) => {
    if ( Array.isArray(args) === false ) { return; }
    if ( globalThis.ServiceWorkerGlobalScope ) {
        consoleAdd(...args);
    }
    // Do not pollute dev console in stable releases.
    if ( isSideloaded !== true ) { return; }
    console.error('[uBlock Plus+]', ...args);
};

export const getConsoleOutput = ( ) => {
    return consoleOutput.slice();
};

/******************************************************************************/

const rulesets = new Map();
const bufferSize = isSideloaded ? 256 : 1;
const matchedRules = new Array(bufferSize);
matchedRules.fill(null);
let writePtr = 0;
let logGeneration = 0;
let pendingRuntimeLookups = 0;
const MAX_PENDING_RUNTIME_LOOKUPS = 32;

const matchReference = ruleInfo => ({
    request: ruleInfo.request,
    rule: { id: `${ruleInfo.rule.rulesetId}/${ruleInfo.rule.ruleId}` },
});

const pruneLongLists = list => {
    if ( list.length <= 11 ) { return list; }
    return [ ...list.slice(0, 5), '...', ...list.slice(-5) ];
};

const getRuleset = async (rulesetId, ruleId) => {
    if ( rulesets.has(rulesetId) ) { 
        return rulesets.get(rulesetId);
    }
    let rules;
    const isDynamic = rulesetId === dnr.DYNAMIC_RULESET_ID;
    const isSession = rulesetId === dnr.SESSION_RULESET_ID;
    if ( isDynamic || isSession ) {
        const method = isDynamic ? 'getDynamicRules' : 'getSessionRules';
        try {
            rules = normalizeDNRRules(
                await dnr[method]({ ruleIds: [ ruleId ] }), [ ruleId ]
            );
        } catch {
        }
    } else {
        const response = await fetch(`/rulesets/main/${rulesetId}.json`).catch(( ) => undefined);
        if ( response === undefined ) { return; }
        rules = await response.json().catch(( ) =>
            undefined
        ).then(rules =>
            normalizeDNRRules(rules)
        );
    }
    if ( Array.isArray(rules) === false ) { return; }
    const ruleset = new Map();
    for ( const rule of rules ) {
        const condition = rule.condition;
        if ( condition ) {
            if ( condition.requestDomains ) {
                condition.requestDomains = pruneLongLists(condition.requestDomains);
            }
            if ( condition.initiatorDomains ) {
                condition.initiatorDomains = pruneLongLists(condition.initiatorDomains);
            }
        }
        const ruleId = rule.id;
        rule.id = `${rulesetId}/${ruleId}`;
        ruleset.set(ruleId, rule);
    }
    // Runtime IDs can be reused after a list update. Only packaged rulesets
    // remain immutable for the lifetime of this service worker.
    if ( isDynamic === false && isSession === false ) {
        rulesets.set(rulesetId, ruleset);
    }
    return ruleset;
};

const getRuleDetails = async ruleInfo => {
    const { rulesetId, ruleId } = ruleInfo.rule;
    const ruleset = await getRuleset(rulesetId, ruleId);
    // Keep the browser's match reference when a rule was removed or its
    // details could not be read. Missing details must not erase the event.
    return {
        request: ruleInfo.request,
        rule: ruleset?.get(ruleId) ?? { id: `${rulesetId}/${ruleId}` },
    };
};

/******************************************************************************/

export const getMatchedRules = (( ) => {
    if ( isSideloaded !== true ) {
        return ( ) => Promise.resolve([]);
    }

    if ( isModern ) {
        return async tabId => {
            const generation = logGeneration;
            const promises = [];
            for ( let i = 0; i < bufferSize; i++ ) {
                const j = (writePtr + i) % bufferSize;
                const ruleInfo = matchedRules[j];
                if ( ruleInfo === null ) { continue; }
                if ( ruleInfo.request.tabId !== -1 ) {
                    if ( ruleInfo.request.tabId !== tabId ) { continue; }
                }
                promises.unshift(ruleInfo.details ??= getRuleDetails(ruleInfo));
            }
            const entries = await Promise.all(promises);
            return generation === logGeneration ? entries : [];
        };
    }

    return async tabId => {
        const generation = logGeneration;
        if ( typeof dnr.getMatchedRules !== 'function' ) { return []; }
        const matchedRules = await dnr.getMatchedRules({ tabId });
        if ( matchedRules instanceof Object === false ) { return []; }
        const promises = [];
        for ( const { tabId, rule } of matchedRules.rulesMatchedInfo ) {
            promises.push(getRuleDetails({ request: { tabId }, rule }));
        }
        const entries = await Promise.all(promises);
        return generation === logGeneration ? entries : [];
    };
})();

/******************************************************************************/

const matchedRuleListener = ruleInfo => {
    // Resolve mutable rules at event delivery, not when the log is opened.
    // Retained history then keeps its resolved details across ID reuse. The
    // browser does not provide an atomic rule-body snapshot with the event.
    const { rulesetId } = ruleInfo.rule;
    const isRuntime = rulesetId === dnr.DYNAMIC_RULESET_ID ||
        rulesetId === dnr.SESSION_RULESET_ID;
    let details;
    if ( isRuntime ) {
        details = matchReference(ruleInfo);
        // The ring limits retained history, not unresolved API work. Never
        // queue overflow for a later lookup: its ID could have been reused.
        if ( pendingRuntimeLookups < MAX_PENDING_RUNTIME_LOOKUPS ) {
            pendingRuntimeLookups += 1;
            details = getRuleDetails(ruleInfo).catch(( ) =>
                matchReference(ruleInfo)
            ).finally(( ) => {
                pendingRuntimeLookups -= 1;
            });
        }
    }
    matchedRules[writePtr] = {
        ...ruleInfo,
        details,
    };
    writePtr = (writePtr + 1) % bufferSize;
};

export const toggleDeveloperMode = state => {
    if ( isSideloaded !== true ) { return; }
    if ( isModern === false ) { return; } 
    if ( state ) {
        dnr.onRuleMatchedDebug.addListener(matchedRuleListener);
    } else {
        logGeneration += 1;
        dnr.onRuleMatchedDebug.removeListener(matchedRuleListener);
        rulesets.clear();
        matchedRules.fill(null);
        writePtr = 0;
    }
};

/******************************************************************************/
