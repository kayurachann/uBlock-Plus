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

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import { browser, runtime } from './ext.js';
import { classifyRuntimeCapabilities } from './runtime-capabilities-core.js';
import { dnr } from './ext-compat.js';

/******************************************************************************/

const permissionGranted = async name => {
    try {
        return await browser.permissions.contains({ permissions: [ name ] });
    } catch {
        return false;
    }
};

const getInstallType = async ( ) => {
    try {
        return (await browser.management.getSelf()).installType;
    } catch {
        return 'unknown';
    }
};

const getAvailableStaticRules = async ( ) => {
    try {
        return await dnr.getAvailableStaticRuleCount();
    } catch {
    }
};

const getUserScriptsUsable = async ( ) => {
    try {
        if ( typeof browser.userScripts?.getScripts !== 'function' ) {
            return false;
        }
        await browser.userScripts.getScripts();
        return true;
    } catch {
        return false;
    }
};

/******************************************************************************/

export async function getRuntimeCapabilities() {
    const manifest = runtime.getManifest();
    const [
        installType,
        webRequestGranted,
        webRequestBlockingGranted,
        availableStaticRules,
        userScriptsUsable,
    ] = await Promise.all([
        getInstallType(),
        permissionGranted('webRequest'),
        permissionGranted('webRequestBlocking'),
        getAvailableStaticRules(),
        getUserScriptsUsable(),
    ]);

    const grantedPermissions = [];
    if ( webRequestGranted ) {
        grantedPermissions.push('webRequest');
    }
    if ( webRequestBlockingGranted ) {
        grantedPermissions.push('webRequestBlocking');
    }

    return classifyRuntimeCapabilities({
        installType,
        manifestPermissions: manifest.permissions,
        optionalPermissions: manifest.optional_permissions,
        grantedPermissions,
        api: {
            declarativeNetRequest:
                typeof dnr.updateDynamicRules === 'function',
            nativeMatchFeedback: typeof dnr.onRuleMatchedDebug?.addListener === 'function',
            offscreen: browser.offscreen instanceof Object,
            tabs: browser.tabs instanceof Object,
            topDomainConditions: Object.values(dnr.RuleConditionKeys || {}).includes('topDomains'),
            userScripts: userScriptsUsable,
            webNavigation: browser.webNavigation instanceof Object,
            webRequest: browser.webRequest?.onBeforeRequest instanceof Object,
        },
        quotas: {
            availableStaticRules,
            enabledStaticRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
            dynamicRules: dnr.MAX_NUMBER_OF_DYNAMIC_RULES,
            unsafeDynamicRules: dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
            sessionRules: dnr.MAX_NUMBER_OF_SESSION_RULES,
            regexRules: dnr.MAX_NUMBER_OF_REGEX_RULES,
        },
    });
}

/******************************************************************************/
