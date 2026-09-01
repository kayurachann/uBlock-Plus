/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export const STOCK_POPUP_CORPUS_SCHEMA_VERSION = 1;
export const STOCK_POPUP_DEFERRED_ROUTE_CODE = 'popup-compiler-required';
export const STOCK_POPUP_RUNTIME_ROUTE_CODE = 'popup-observer-runtime';
// src/js/static-net-filtering.js keeps popup and popunder distinct internally,
// but its DNR export type allowlist contains only `popup`. make-rulesets.js can
// therefore preserve an exact popup kind here while explicitly recording that
// stock popunder filters never reached this input corpus.
export const STOCK_POPUP_SOURCE_KIND_PRECISION =
    'stock-dnr-export-popup-only';

// These are fail-open packaging limits, not browser quotas. A list which
// exceeds either limit is left to the existing content-script implementation
// instead of emitting a partial observer corpus which might omit an exception.
export const MAX_STOCK_POPUP_FILTERS = 50_000;
export const MAX_STOCK_POPUP_CORPUS_CODE_UNITS = 16 * 1024 * 1024;

/******************************************************************************/

function isPlainObject(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( Array.isArray(value) ) { return false; }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

// Match JSON serialization before classification. splitDnrRules() removes the
// synthetic `popup` resource type by assigning undefined; retaining that own
// property here would make every otherwise-supported condition look deferred.
function jsonClone(value) {
    if ( Array.isArray(value) ) {
        return value.map(jsonClone);
    }
    if ( isPlainObject(value) ) {
        const out = {};
        for ( const [ key, entry ] of Object.entries(value) ) {
            if ( entry === undefined ) { continue; }
            out[key] = jsonClone(entry);
        }
        return out;
    }
    return value;
}

function sortedReasonCounts(reasons) {
    return Object.fromEntries(Array.from(reasons).sort(([ a ], [ b ]) =>
        a.localeCompare(b)
    ));
}

function positiveRuleId(rule, index) {
    return Number.isSafeInteger(rule?.id) && rule.id > 0
        ? rule.id
        : index + 1;
}

function isImportantBlock(rule) {
    if ( rule?.action?.type !== 'block' ) { return false; }
    if ( rule.__important === true ) { return true; }
    return Number.isSafeInteger(rule.priority) && rule.priority >= 40;
}

function suppressedCorpus(rulesetId, stats, reasonCode) {
    return {
        schemaVersion: STOCK_POPUP_CORPUS_SCHEMA_VERSION,
        routeCode: STOCK_POPUP_RUNTIME_ROUTE_CODE,
        source: {
            type: 'stock-static-ruleset',
            rulesetId,
            kind: 'popup',
            kindPrecision: STOCK_POPUP_SOURCE_KIND_PRECISION,
            omittedKinds: [ 'popunder' ],
            lineNumberSemantics: 'compiled-rule-id',
        },
        stats: {
            ...stats,
            runnable: 0,
            guards: 0,
            important: 0,
            block: 0,
            allow: 0,
            suppressed: true,
            suppressionReason: reasonCode,
        },
        filters: [],
    };
}

/******************************************************************************/

export function makeStockPopupCorpus(
    rulesetId,
    popupRules,
    classifyPopupCondition
) {
    if ( typeof rulesetId !== 'string' || rulesetId === '' ||
        rulesetId.length > 128 ) {
        throw new TypeError('Invalid stock popup ruleset ID');
    }
    if ( Array.isArray(popupRules) === false ) {
        throw new TypeError('Stock popup rules must be an array');
    }
    if ( typeof classifyPopupCondition !== 'function' ) {
        throw new TypeError('A popup condition classifier is required');
    }

    const stats = {
        input: popupRules.length,
        runnable: 0,
        guards: 0,
        deferred: 0,
        discarded: 0,
        important: 0,
        block: 0,
        allow: 0,
        deferredReasons: {},
    };
    if ( popupRules.length > MAX_STOCK_POPUP_FILTERS ) {
        return suppressedCorpus(
            rulesetId,
            stats,
            'stock-popup-filter-limit'
        );
    }

    const filters = [];
    const deferredReasons = new Map();
    let corpusCodeUnits = 0;
    for ( let index = 0; index < popupRules.length; index++ ) {
        const rule = popupRules[index];
        const action = rule?.action?.type;
        if ( action !== 'block' && action !== 'allow' ) {
            stats.discarded += 1;
            continue;
        }
        if ( isPlainObject(rule.condition) === false ) {
            stats.discarded += 1;
            continue;
        }
        const condition = jsonClone(rule.condition);
        const classification = classifyPopupCondition(condition);
        if ( classification?.supported !== true ) {
            const reasonCode = typeof classification?.reasonCode === 'string'
                ? classification.reasonCode
                : 'invalid-popup-condition';
            deferredReasons.set(
                reasonCode,
                (deferredReasons.get(reasonCode) || 0) + 1
            );
            stats.deferred += 1;
            if ( action === 'allow' ) {
                const guard = {
                    schemaVersion: STOCK_POPUP_CORPUS_SCHEMA_VERSION,
                    routeCode: STOCK_POPUP_DEFERRED_ROUTE_CODE,
                    kind: 'popup',
                    action: 'allow',
                    important: false,
                    condition,
                    listid: rulesetId,
                    lineNumber: positiveRuleId(rule, index),
                };
                corpusCodeUnits += JSON.stringify(guard).length;
                if ( corpusCodeUnits >
                    MAX_STOCK_POPUP_CORPUS_CODE_UNITS ) {
                    stats.deferredReasons = sortedReasonCounts(
                        deferredReasons
                    );
                    return suppressedCorpus(
                        rulesetId,
                        stats,
                        'stock-popup-corpus-size-limit'
                    );
                }
                filters.push(guard);
                stats.guards += 1;
            }
            continue;
        }
        const filter = {
            schemaVersion: STOCK_POPUP_CORPUS_SCHEMA_VERSION,
            routeCode: STOCK_POPUP_RUNTIME_ROUTE_CODE,
            kind: 'popup',
            action,
            important: isImportantBlock(rule),
            condition,
            listid: rulesetId,
            lineNumber: positiveRuleId(rule, index),
        };
        corpusCodeUnits += JSON.stringify(filter).length;
        if ( corpusCodeUnits > MAX_STOCK_POPUP_CORPUS_CODE_UNITS ) {
            stats.deferredReasons = sortedReasonCounts(deferredReasons);
            return suppressedCorpus(
                rulesetId,
                stats,
                'stock-popup-corpus-size-limit'
            );
        }
        filters.push(filter);
        stats.runnable += 1;
        stats[action] += 1;
        if ( filter.important ) { stats.important += 1; }
    }
    stats.deferredReasons = sortedReasonCounts(deferredReasons);

    return {
        schemaVersion: STOCK_POPUP_CORPUS_SCHEMA_VERSION,
        routeCode: STOCK_POPUP_RUNTIME_ROUTE_CODE,
        source: {
            type: 'stock-static-ruleset',
            rulesetId,
            kind: 'popup',
            kindPrecision: STOCK_POPUP_SOURCE_KIND_PRECISION,
            omittedKinds: [ 'popunder' ],
            lineNumberSemantics: 'compiled-rule-id',
        },
        stats,
        filters,
    };
}

/******************************************************************************/
