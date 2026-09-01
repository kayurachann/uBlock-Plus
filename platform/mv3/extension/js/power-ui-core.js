/*******************************************************************************

    uBlock Plus+ - Power UI preferences and protection profiles
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

export const POWER_UI_STORAGE_KEY = 'powerUI.settings';

export const POWER_UI_DEFAULTS = Object.freeze({
    schemaVersion: 1,
    theme: 'auto',
    accent: 'crimson',
    density: 'comfortable',
    popupLayout: 'power',
});

const UI_ENUMS = Object.freeze({
    theme: Object.freeze([ 'auto', 'light', 'dark' ]),
    accent: Object.freeze([ 'crimson', 'blue', 'emerald', 'violet' ]),
    density: Object.freeze([ 'comfortable', 'compact' ]),
    popupLayout: Object.freeze([ 'power', 'compact' ]),
});

export function normalizePowerUISettings(value, options = {}) {
    const strict = options.strict === true;
    if ( value === undefined || value === null ) {
        return { ...POWER_UI_DEFAULTS };
    }
    if ( typeof value !== 'object' || Array.isArray(value) ) {
        if ( strict ) {
            throw new TypeError('powerUISettings must be an object');
        }
        return { ...POWER_UI_DEFAULTS };
    }
    const out = { ...POWER_UI_DEFAULTS };
    for ( const [ key, allowed ] of Object.entries(UI_ENUMS) ) {
        if ( value[key] === undefined ) { continue; }
        if ( allowed.includes(value[key]) === false ) {
            if ( strict ) {
                throw new TypeError(`powerUISettings.${key} is invalid`);
            }
            continue;
        }
        out[key] = value[key];
    }
    return out;
}

export const POWER_PROFILES = Object.freeze({
    baseline: Object.freeze({
        defaultFilteringMode: 1,
        autoReload: true,
        showBlockedCount: true,
        strictBlockMode: false,
        popupBlockMode: true,
        memoryProfile: 'auto',
    }),
    balanced: Object.freeze({
        defaultFilteringMode: 2,
        autoReload: true,
        showBlockedCount: true,
        strictBlockMode: true,
        popupBlockMode: true,
        memoryProfile: 'auto',
    }),
    maximum: Object.freeze({
        defaultFilteringMode: 3,
        autoReload: true,
        showBlockedCount: true,
        strictBlockMode: true,
        popupBlockMode: true,
        memoryProfile: 'balanced',
    }),
    lowMemory: Object.freeze({
        defaultFilteringMode: 2,
        autoReload: true,
        showBlockedCount: false,
        strictBlockMode: true,
        popupBlockMode: true,
        memoryProfile: 'low-memory',
    }),
});

export function matchingPowerProfile(settings) {
    if ( settings instanceof Object === false ) { return 'custom'; }
    for ( const [ name, profile ] of Object.entries(POWER_PROFILES) ) {
        if ( Object.entries(profile).every(([ key, value ]) =>
            settings[key] === value
        ) ) {
            return name;
        }
    }
    return 'custom';
}

/******************************************************************************/
