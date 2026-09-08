/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    POPUP_DEFERRED_ROUTE_CODE,
    POPUP_RUNTIME_ROUTE_CODE,
    classifyPopupCondition,
} from './compiled-popup-matcher.js';

// Increment when compiler semantics change; older envelopes must be rebuilt
// from source instead of reusing output which lost exceptions or metadata.
export const COMPILED_FILTERS_REVISION = 3;

function isStats(value, fields) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    return fields.every(field =>
        Number.isSafeInteger(value[field]) && value[field] >= 0
    );
}

function isFilterRejection(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( value.status !== 'rejected' && value.status !== 'deferred' ) {
        return false;
    }
    if ( /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.reasonCode) === false ) {
        return false;
    }
    if ( value.status === 'deferred' &&
        (value.disposition !== 'deferred' ||
        value.classification !== POPUP_DEFERRED_ROUTE_CODE) ) {
        return false;
    }
    return Number.isSafeInteger(value.lineNumber) && value.lineNumber > 0;
}

function isPopupFilter(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( value.schemaVersion !== 1 ) { return false; }
    if ( value.routeCode !== POPUP_RUNTIME_ROUTE_CODE &&
        value.routeCode !== POPUP_DEFERRED_ROUTE_CODE ) {
        return false;
    }
    if ( value.kind !== 'popup' && value.kind !== 'popunder' ) { return false; }
    if ( value.action !== 'allow' && value.action !== 'block' ) { return false; }
    if ( typeof value.important !== 'boolean' ) { return false; }
    if ( typeof value.condition !== 'object' || value.condition === null ) {
        return false;
    }
    const classification = classifyPopupCondition(value.condition);
    if ( value.routeCode === POPUP_RUNTIME_ROUTE_CODE ) {
        if ( classification.supported === false ) { return false; }
    } else if ( classification.supported ) {
        return false;
    }
    return Number.isSafeInteger(value.lineNumber) && value.lineNumber > 0;
}

export function isCompiledListData(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( Array.isArray(value.dnrRules) === false ) { return false; }
    if ( Array.isArray(value.networkUnits) === false ||
        value.networkUnits.every(unit =>
            typeof unit?.key === 'string' &&
            Array.isArray(unit.dnrRules) &&
            unit.dnrRules.every(rule => typeof rule?.action === 'object' &&
                typeof rule?.condition === 'object') &&
            Array.isArray(unit.popupFilters) &&
            unit.popupFilters.every(isPopupFilter)
        ) === false ||
        Array.isArray(value.badfilterKeys) === false ||
        value.badfilterKeys.every(key => typeof key === 'string') === false ) {
        return false;
    }
    if ( value.specificCosmeticDetails instanceof Map === false ) {
        return false;
    }
    if ( value.scriptletDetails instanceof Map === false ) { return false; }
    if ( isStats(value.filterStats, [
        'total', 'accepted', 'rejected',
    ]) === false ) {
        return false;
    }
    if ( value.filterStats.total !==
        value.filterStats.accepted + value.filterStats.rejected ) {
        return false;
    }
    if ( value.filterStats.routed !== undefined &&
        (Number.isSafeInteger(value.filterStats.routed) === false ||
        value.filterStats.routed < 0 ||
        value.filterStats.routed > value.filterStats.total) ) {
        return false;
    }
    if ( value.filterStats.deferred !== undefined &&
        (Number.isSafeInteger(value.filterStats.deferred) === false ||
        value.filterStats.deferred < 0 ||
        value.filterStats.deferred > (value.filterStats.routed ?? 0)) ) {
        return false;
    }
    if ( value.rejections !== undefined &&
        (Array.isArray(value.rejections) === false ||
        value.rejections.every(isFilterRejection) === false) ) {
        return false;
    }
    if ( value.popupFilters !== undefined &&
        (Array.isArray(value.popupFilters) === false ||
        value.popupFilters.every(isPopupFilter) === false) ) {
        return false;
    }
    if ( value.popupFilters !== undefined ) {
        const rejections = Array.isArray(value.rejections)
            ? value.rejections
            : [];
        for ( const filter of value.popupFilters ) {
            if ( filter.routeCode !== POPUP_DEFERRED_ROUTE_CODE ) { continue; }
            const reasonCode = classifyPopupCondition(
                filter.condition
            ).reasonCode;
            if ( rejections.some(rejection =>
                rejection.status === 'deferred' &&
                rejection.classification === POPUP_DEFERRED_ROUTE_CODE &&
                rejection.lineNumber === filter.lineNumber &&
                rejection.reasonCode === reasonCode
            ) === false ) {
                return false;
            }
        }
    }
    return isStats(value.ruleStats, [ 'total', 'plain', 'regex' ]);
}

export async function deserializeCompiledListOr(
    serialized,
    deserialize,
    onInvalid
) {
    let compiled;
    try {
        compiled = deserialize(serialized);
    } catch {
    }
    if ( isCompiledListData(compiled) ) { return compiled; }
    return onInvalid();
}

/******************************************************************************/
