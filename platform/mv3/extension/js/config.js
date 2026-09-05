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
    browser, localWrite,
    sessionRead, sessionRemove, sessionWrite,
    webextFlavor,
} from './ext.js';

/******************************************************************************/

export const rulesetConfig = {
    version: '',
    enabledRulesets: [],
    autoReload: true,
    showBlockedCount: true,
    strictBlockMode: webextFlavor !== 'safari',
    popupBlockMode: true,
    developerMode: false,
    hasBroadHostPermissions: true,
};

export const defaultConfig = Object.assign({}, rulesetConfig);

export const process = {
    firstRun: false,
    wakeupRun: false,
};

let pendingOpPromise = Promise.resolve();

/******************************************************************************/

async function _loadRulesetConfig() {
    // Local storage is authoritative. A failed read must not replace saved
    // settings with defaults; a stale session cache must not resurrect them.
    const bin = await browser.storage.local.get('rulesetConfig');
    const localData = bin.rulesetConfig;
    const sessionData = await sessionRead('rulesetConfig');
    if ( localData ) {
        Object.assign(rulesetConfig, localData);
        process.wakeupRun = sessionData !== undefined &&
            JSON.stringify(sessionData) === JSON.stringify(localData);
        await cacheRulesetConfig(rulesetConfig);
        return;
    }
    await _saveRulesetConfig(structuredClone(rulesetConfig));
    process.firstRun = true;
}

async function cacheRulesetConfig(snapshot) {
    try {
        await sessionWrite('rulesetConfig', snapshot);
    } catch {
        // Cache availability is optional. Wakeup always rechecks local state.
        await sessionRemove('rulesetConfig').catch(( ) => {});
    }
}

async function _saveRulesetConfig(snapshot) {
    await localWrite('rulesetConfig', snapshot);
    await cacheRulesetConfig(snapshot);
}

function enqueueConfigOperation(operation) {
    const result = pendingOpPromise.then(operation);
    pendingOpPromise = result.catch(( ) => {});
    return result;
}

/******************************************************************************/

export function loadRulesetConfig() {
    return enqueueConfigOperation(_loadRulesetConfig);
}

export function saveRulesetConfig() {
    const snapshot = structuredClone(rulesetConfig);
    return enqueueConfigOperation(( ) => _saveRulesetConfig(snapshot));
}
