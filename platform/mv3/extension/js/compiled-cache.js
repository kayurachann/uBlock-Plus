/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

function isStats(value, fields) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    return fields.every(field =>
        Number.isSafeInteger(value[field]) && value[field] >= 0
    );
}

export function isCompiledListData(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( Array.isArray(value.dnrRules) === false ) { return false; }
    if ( value.specificCosmeticDetails instanceof Map === false ) {
        return false;
    }
    if ( value.scriptletDetails instanceof Map === false ) { return false; }
    if ( isStats(value.filterStats, [
        'total', 'accepted', 'rejected',
    ]) === false ) {
        return false;
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
