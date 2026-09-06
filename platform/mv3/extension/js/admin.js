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
    adminRead,
    localRead, localRemove, localWrite,
    sessionRead, sessionWrite,
} from './ext.js';

import {
    enableRulesets,
    getEnabledRulesets,
    getRulesetDetails,
    setStrictBlockMode,
} from './ruleset-manager.js';

import {
    getDefaultFilteringMode,
    readFilteringModeDetails,
} from './mode-manager.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import { broadcastMessage } from './utils.js';
import { dnr } from './ext-compat.js';
import { registerContentScripts } from './scripting-manager.js';
import { setPopupBlockMode } from './prevent-popup.js';
import { ublockPlusLog } from './debug.js';

/******************************************************************************/

export async function loadAdminConfig() {
    const [
        popupBlockMode,
        showBlockedCount,
        strictBlockMode,
    ] = await Promise.all([
        adminReadEx('popupBlockMode'),
        adminReadEx('showBlockedCount'),
        adminReadEx('strictBlockMode'),
    ]);
    await applyAdminConfig({ popupBlockMode, showBlockedCount, strictBlockMode });
}

/******************************************************************************/

async function applyAdminConfig(config, apply = false) {
    const toApply = [];
    for ( const [ key, val ] of Object.entries(config) ) {
        if ( typeof val !== typeof rulesetConfig[key] ) { continue; }
        if ( val === rulesetConfig[key] ) { continue; }
        rulesetConfig[key] = val;
        toApply.push(key);
    }
    if ( toApply.length === 0 ) { return; }
    await saveRulesetConfig();
    if ( apply !== true ) { return; }
    while ( toApply.length !== 0 ) {
        const key = toApply.pop();
        switch ( key ) {
        case 'popupBlockMode': {
            const { popupBlockMode } = config;
            await setPopupBlockMode(popupBlockMode, true);
            broadcastMessage({ popupBlockMode });
            break;
        }
        case 'showBlockedCount': {
            if ( typeof dnr.setExtensionActionOptions !== 'function' ) { break; }
            const { showBlockedCount } = config;
            await dnr.setExtensionActionOptions({
                displayActionCountAsBadgeText: showBlockedCount,
            });
            broadcastMessage({ showBlockedCount });
            break;
        }
        case 'strictBlockMode': {
            const { strictBlockMode } = config;
            await setStrictBlockMode(strictBlockMode, true);
            broadcastMessage({ strictBlockMode });
            break;
        }
        default:
            break;
        }
    }
}

/******************************************************************************/

let scheduleAdminMutation = task => Promise.resolve().then(task);
let refreshAdminScripts = registerContentScripts;
let applyAdminRulesets = async rulesets => {
    await enableRulesets(rulesets);
    await refreshAdminScripts();
};

// Inject the worker's complete filtering transaction queue without creating a
// dependency from managed settings back to the worker's startup promise.
export function setAdminMutationScheduler(scheduler, adapters = {}) {
    scheduleAdminMutation = scheduler;
    refreshAdminScripts = adapters.refreshScripts ?? registerContentScripts;
    if ( typeof adapters.applyRulesets === 'function' ) {
        applyAdminRulesets = adapters.applyRulesets;
    }
}

const adminSettings = {
    keys: new Map(),
    timer: undefined,
    change(key, value) {
        this.keys.set(key, value);
        if ( this.timer !== undefined ) { return; }
        this.timer = self.setTimeout(( ) => {
            this.timer = undefined;
            const keys = new Map(this.keys);
            this.keys.clear();
            Promise.resolve().then(( ) => scheduleAdminMutation(( ) =>
                this.process(keys)
            )).catch(reason => {
                ublockPlusLog(`Managed filtering update failed: ${reason}`);
            });
        }, 127);
    },
    async process(keys) {
        if ( keys.has('rulesets') ) {
            ublockPlusLog('admin setting "rulesets" changed');
            await applyAdminRulesets(rulesetConfig.enabledRulesets);
            const results = await Promise.all([
                getAdminRulesets(),
                getEnabledRulesets(),
            ]);
            const [ adminRulesets, enabledRulesets ] = results;
            broadcastMessage({ adminRulesets, enabledRulesets });
        }
        if ( keys.has('defaultFiltering') ) {
            ublockPlusLog('admin setting "defaultFiltering" changed');
            await readFilteringModeDetails(true);
            await refreshAdminScripts();
            const defaultFilteringMode = await getDefaultFilteringMode();
            broadcastMessage({ defaultFilteringMode });
        }
        if ( keys.has('noFiltering') ) {
            ublockPlusLog('admin setting "noFiltering" changed');
            const filteringModeDetails = await readFilteringModeDetails(true);
            await refreshAdminScripts();
            broadcastMessage({ filteringModeDetails });
        }
        if ( keys.has('popupBlockMode') ) {
            ublockPlusLog('admin setting "popupBlockMode" changed');
            const popupBlockMode = keys.get('popupBlockMode');
            await applyAdminConfig({ popupBlockMode }, true);
            await refreshAdminScripts();
        }
        if ( keys.has('showBlockedCount') ) {
            ublockPlusLog('admin setting "showBlockedCount" changed');
            const showBlockedCount = keys.get('showBlockedCount');
            await applyAdminConfig({ showBlockedCount }, true);
        }
        if ( keys.has('strictBlockMode') ) {
            ublockPlusLog('admin setting "strictBlockMode" changed');
            const strictBlockMode = keys.get('strictBlockMode');
            await applyAdminConfig({ strictBlockMode }, true);
        }
    }
};

/******************************************************************************/

export async function getAdminRulesets() {
    const [
        adminList,
        rulesetDetails,
    ] = await Promise.all([
        adminReadEx('rulesets'),
        getRulesetDetails(),
    ]);
    const adminRulesets = new Set(Array.isArray(adminList) && adminList || []);
    if ( adminRulesets.has('-default') ) {
        adminRulesets.delete('-default');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled !== true ) { continue; }
            if ( adminRulesets.has(`+${ruleset.id}`) ) { continue; }
            adminRulesets.add(`-${ruleset.id}`);
        }
    }
    if ( adminRulesets.has('+default') ) {
        adminRulesets.delete('+default');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled !== true ) { continue; }
            if ( adminRulesets.has(`-${ruleset.id}`) ) { continue; }
            adminRulesets.add(`+${ruleset.id}`);
        }
    }
    if ( adminRulesets.has('-*') ) {
        adminRulesets.delete('-*');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled ) { continue; }
            if ( adminRulesets.has(`+${ruleset.id}`) ) { continue; }
            adminRulesets.add(`-${ruleset.id}`);
        }
    }
    return Array.from(adminRulesets);
}

/******************************************************************************/

export async function adminReadEx(key) {
    let cacheValue;
    const session = await sessionRead(`admin.${key}`);
    if ( session ) {
        cacheValue = session.data;
    } else {
        const local = await localRead(`admin.${key}`);
        if ( local ) {
            cacheValue = local.data;
        }
        localRemove(`admin_${key}`); // TODO: remove eventually
    }
    adminRead(key).then(async value => {
        const adminKey = `admin.${key}`;
        await Promise.all([
            sessionWrite(adminKey, { data: value }),
            localWrite(adminKey, { data: value }),
        ]);
        if ( JSON.stringify(value) === JSON.stringify(cacheValue) ) { return; }
        adminSettings.change(key, value);
    });
    return cacheValue;
}

/******************************************************************************/
