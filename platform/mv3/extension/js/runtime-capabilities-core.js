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

const toSet = value => new Set(Array.isArray(value) ? value : []);

const finiteQuota = value => Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/******************************************************************************/

export function classifyRuntimeCapabilities(input = {}) {
    const manifestPermissions = toSet(input.manifestPermissions);
    const grantedPermissions = toSet(input.grantedPermissions);
    const api = input.api instanceof Object ? input.api : {};
    const quotas = input.quotas instanceof Object ? input.quotas : {};
    const installType = typeof input.installType === 'string'
        ? input.installType
        : 'unknown';

    const dnrDeclared = manifestPermissions.has('declarativeNetRequest');
    const dnrAvailable = dnrDeclared && api.declarativeNetRequest === true;
    const managedInstall = installType === 'admin';
    const policyPermissionsDeclared =
        manifestPermissions.has('webRequest') &&
        manifestPermissions.has('webRequestBlocking');
    const policyPermissionsGranted =
        grantedPermissions.has('webRequest') &&
        grantedPermissions.has('webRequestBlocking');
    const managedWebRequestEligible =
        managedInstall &&
        policyPermissionsDeclared &&
        policyPermissionsGranted &&
        api.webRequest === true;

    const eligibleNetworkEngines = [];
    if ( dnrAvailable ) {
        eligibleNetworkEngines.push('dnr');
    }
    if ( managedWebRequestEligible ) {
        eligibleNetworkEngines.push('managed-webrequest');
    }

    return {
        productEdition: 'power',
        installType,
        managedInstall,
        activeNetworkEngine: dnrAvailable ? 'dnr' : 'unavailable',
        eligibleNetworkEngines,
        managedWebRequestEligible,
        smartPopupObservation:
            api.tabs === true && api.webNavigation === true,
        userScripts: api.userScripts === true,
        offscreenCompilation: api.offscreen === true,
        quotas: {
            availableStaticRules: finiteQuota(quotas.availableStaticRules),
            enabledStaticRulesets: finiteQuota(quotas.enabledStaticRulesets),
            dynamicRules: finiteQuota(quotas.dynamicRules),
            unsafeDynamicRules: finiteQuota(quotas.unsafeDynamicRules),
            sessionRules: finiteQuota(quotas.sessionRules),
            regexRules: finiteQuota(quotas.regexRules),
        },
    };
}

/******************************************************************************/
