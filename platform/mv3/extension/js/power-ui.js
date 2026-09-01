/*******************************************************************************

    uBlock Plus+ - Power UI preference persistence
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import {
    POWER_UI_STORAGE_KEY,
    normalizePowerUISettings,
} from './power-ui-core.js';
import { browser, localRead, localWrite } from './ext.js';

let settingsPromise;

export function getPowerUISettings(options = {}) {
    if ( options.refresh === true || settingsPromise === undefined ) {
        settingsPromise = localRead(POWER_UI_STORAGE_KEY).then(value =>
            normalizePowerUISettings(value)
        );
    }
    return settingsPromise;
}

export async function setPowerUISettings(value) {
    const settings = normalizePowerUISettings(value, { strict: true });
    await localWrite(POWER_UI_STORAGE_KEY, settings);
    settingsPromise = Promise.resolve(settings);
    return { ...settings };
}

export function applyPowerUISettings(settings, root = document.documentElement) {
    const normalized = normalizePowerUISettings(settings);
    root.dataset.accent = normalized.accent;
    root.dataset.density = normalized.density;
    root.dataset.popupLayout = normalized.popupLayout;
    return normalized;
}

export function listenForPowerUISettings(callback) {
    const listener = (changes, areaName) => {
        if ( areaName !== 'local' ) { return; }
        const change = changes?.[POWER_UI_STORAGE_KEY];
        if ( change === undefined ) { return; }
        const settings = normalizePowerUISettings(change.newValue);
        settingsPromise = Promise.resolve(settings);
        callback(settings);
    };
    browser.storage?.onChanged?.addListener(listener);
    return ( ) => browser.storage?.onChanged?.removeListener(listener);
}

/******************************************************************************/
