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

import {
    localRead, localRemove, localWrite,
    runtime,
    sendMessage,
} from './ext.js';

import { getImportedLists } from './imported-lists.js';
import { normalizeBackupObject } from './backup-schema.js';

/******************************************************************************/

export async function backupToObject(currentConfig) {
    const out = {};
    const manifest = runtime.getManifest();
    out.version = manifest.versionName ?? manifest.version;
    const [
        defaultConfig,
        sandboxFilters,
        memoryProfile,
        filterStoreRepositories,
    ] = await Promise.all([
        sendMessage({ what: 'getDefaultConfig' }),
        sendMessage({ what: 'getSandboxFilters' }).then(a => a?.trim() ?? ''),
        sendMessage({ what: 'getMemoryProfile' }),
        localRead('filterStore.repositories'),
    ]);
    if ( currentConfig.autoReload !== defaultConfig.autoReload ) {
        out.autoReload = currentConfig.autoReload;
    }
    if ( currentConfig.developerMode !== defaultConfig.developerMode ) {
        out.developerMode = currentConfig.developerMode;
    }
    if ( currentConfig.popupBlockMode !== defaultConfig.popupBlockMode ) {
        out.popupBlockMode = currentConfig.popupBlockMode;
    }
    if ( currentConfig.showBlockedCount !== defaultConfig.showBlockedCount ) {
        out.showBlockedCount = currentConfig.showBlockedCount;
    }
    if ( currentConfig.strictBlockMode !== defaultConfig.strictBlockMode ) {
        out.strictBlockMode = currentConfig.strictBlockMode;
    }
    if ( memoryProfile?.selected && memoryProfile.selected !== 'auto' ) {
        out.memoryProfile = memoryProfile.selected;
    }
    if ( Array.isArray(filterStoreRepositories) && filterStoreRepositories.length ) {
        out.filterStoreRepositories = filterStoreRepositories.slice();
    }
    const { enabledRulesets } = currentConfig;
    const customRulesets = [];
    for ( const id of enabledRulesets ) {
        if ( defaultConfig.rulesets.includes(id) ) { continue; }
        customRulesets.push(`+${id}`);
    }
    for ( const id of defaultConfig.rulesets ) {
        if ( enabledRulesets.includes(id) ) { continue; }
        customRulesets.push(`-${id}`);
    }
    if ( customRulesets.length !== 0 ) {
        out.rulesets = customRulesets;
    }
    out.filteringModes = await sendMessage({ what: 'getFilteringModeDetails' });
    const customFilters = await sendMessage({ what: 'getAllCustomFilters' });
    if ( customFilters.length !== 0 ) {
        out.customFilters = customFilters;
    }
    if ( sandboxFilters !== '' ) {
        out.sandboxFilters = sandboxFilters.split('\n');
    }
    const dnrRules = await localRead('userDnrRules');
    if ( typeof dnrRules === 'string' && dnrRules.length !== 0 ) {
        out.dnrRules = dnrRules.split(/\n+/);
    }
    const importedLists = await getImportedLists();
    if ( importedLists.length ) {
        out.importedLists = importedLists.map(list => ({
            url: list.id,
            enabled: list.enabled === true,
            name: list.name,
            homeURL: list.homeURL,
            sourceIntegrity: list.sourceIntegrity,
            maxSourceBytes: list.maxSourceBytes,
            maxSourceFetches: list.maxSourceFetches,
            requireHTTPSSource: list.requireHTTPSSource,
        }));
    }
    return out;
}

/******************************************************************************/

export async function restoreFromObject(targetConfig) {
    // Validate and clone every field before the first mutation. A malformed
    // backup must fail closed instead of partially resetting live settings.
    targetConfig = normalizeBackupObject(targetConfig);
    const defaultConfig = await sendMessage({ what: 'getDefaultConfig' });

    await sendMessage({
        what: 'setAutoReload',
        state: targetConfig.autoReload ?? defaultConfig.autoReload
    });

    await sendMessage({
        what: 'setShowBlockedCount',
        state: targetConfig.showBlockedCount ?? defaultConfig.showBlockedCount
    });

    await sendMessage({
        what: 'setDeveloperMode',
        state: targetConfig.developerMode ?? defaultConfig.developerMode
    });

    await sendMessage({
        what: 'setStrictBlockMode',
        state: targetConfig.strictBlockMode ?? defaultConfig.strictBlockMode
    });

    await sendMessage({
        what: 'setPopupBlockMode',
        state: targetConfig.popupBlockMode ?? defaultConfig.popupBlockMode
    });

    const memoryProfile = [ 'auto', 'balanced', 'low-memory' ]
        .includes(targetConfig.memoryProfile)
        ? targetConfig.memoryProfile
        : 'auto';
    await sendMessage({
        what: 'setMemoryProfile',
        profile: memoryProfile,
    });

    const repositories = [];
    for ( const value of targetConfig.filterStoreRepositories || [] ) {
        if ( repositories.length === 8 ) { break; }
        if ( typeof value !== 'string' ) { continue; }
        let url;
        try {
            url = new URL(value);
        } catch {
            continue;
        }
        if ( url.protocol !== 'https:' || url.username || url.password ) {
            continue;
        }
        if ( repositories.includes(url.href) === false ) {
            repositories.push(url.href);
        }
    }
    if ( repositories.length ) {
        await localWrite('filterStore.repositories', repositories);
    } else {
        await localRemove('filterStore.repositories');
    }

    const enabledRulesets = defaultConfig.rulesets;
    for ( const entry of targetConfig.rulesets || [] ) {
        const id = entry.slice(1);
        if ( entry.startsWith('+') ) {
            if ( enabledRulesets.includes(id) ) { continue; }
            enabledRulesets.push(id);
        } else if ( entry.startsWith('-') ) {
            const i = enabledRulesets.indexOf(id);
            if ( i === -1 ) { continue; }
            enabledRulesets.splice(i, 1);
        }
    }
    const reImport = /^[a-z-]+:\/\//;
    const restoredLists = [];
    for ( const details of targetConfig.importedLists || [] ) {
        if ( restoredLists.length === 32 ) { break; }
        if ( typeof details?.url !== 'string' ) { continue; }
        let url;
        try {
            url = new URL(details.url);
        } catch {
            continue;
        }
        if ( url.protocol !== 'https:' || url.username || url.password ) {
            continue;
        }
        const restored = {
            ...details,
            url: url.href,
            maxSourceBytes: Number.isSafeInteger(details.maxSourceBytes)
                ? details.maxSourceBytes
                : 5 * 1024 * 1024,
            maxSourceFetches: Number.isSafeInteger(details.maxSourceFetches)
                ? details.maxSourceFetches
                : 32,
            requireHTTPSSource: true,
        };
        restoredLists.push(restored);
        const wasExplicitlyEnabled = details.enabled === true ||
            details.enabled === undefined && enabledRulesets.includes(url.href);
        const index = enabledRulesets.indexOf(url.href);
        if ( wasExplicitlyEnabled && index === -1 ) {
            enabledRulesets.push(url.href);
        } else if ( wasExplicitlyEnabled === false && index !== -1 ) {
            enabledRulesets.splice(index, 1);
        }
    }
    // Do not retain imported URLs which have no restored subscription record.
    const restoredIds = new Set(restoredLists.map(list => list.url));
    for ( let i = enabledRulesets.length - 1; i >= 0; i-- ) {
        const id = enabledRulesets[i];
        if ( reImport.test(id) && restoredIds.has(id) === false ) {
            enabledRulesets.splice(i, 1);
        }
    }
    await sendMessage({
        what: 'restoreImportedLists',
        lists: restoredLists,
        enabledRulesets: Array.from(enabledRulesets),
    });

    await sendMessage({
        what: 'setFilteringModeDetails',
        modes: targetConfig.filteringModes ?? defaultConfig.filteringModes,
    });

    await sendMessage({ what: 'removeAllCustomFilters', hostname: '*' });
    const cosmeticFilters = targetConfig.cosmeticFilters;
    if ( Array.isArray(cosmeticFilters) ) {
        const hostnameMap = new Map();
        for ( const line of cosmeticFilters ) {
            const i = line.indexOf('##');
            if ( i === -1 ) { continue; }
            const hostname = line.slice(0, i);
            if ( hostname === '' ) { continue; }
            const selector = line.slice(i+2);
            if ( selector === '' ) { continue; }
            const selectors = hostnameMap.get(hostname) || [];
            if ( selectors.length === 0 ) {
                hostnameMap.set(hostname, selectors)
            }
            selectors.push(selector);
        }
        if ( hostnameMap.size !== 0 ) {
            await sendMessage({ what: 'addManyCustomFilters',
                entries: Array.from(hostnameMap),
            });
        }
    }
    const customFilters = targetConfig.customFilters;
    if ( Array.isArray(customFilters) ) {
        await sendMessage({ what: 'addManyCustomFilters',
            entries: customFilters,
        });
    }

    await sendMessage({
        what: 'setSandboxFilters',
        text: targetConfig.sandboxFilters?.join('\n') ?? '',
    });

    const dnrRules = targetConfig.dnrRules ?? [];
    if ( dnrRules.length !== 0 ) {
        await localWrite('userDnrRules', dnrRules.join('\n'));
    } else {
        await localRemove('userDnrRules');
    }
    await sendMessage({ what: 'updateUserDnrRules' });

}
