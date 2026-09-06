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
    const optionalPermissions = toSet(input.optionalPermissions);
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
    const webRequestFirewall = input.webRequestFirewall instanceof Object
        ? { ...input.webRequestFirewall }
        : { implemented: false, declared: false, ready: false, state: 'not-configured' };
    const blockingPermission = policyPermissionsDeclared &&
        policyPermissionsGranted && api.webRequest === true;
    const webRequestFirewallActive = blockingPermission &&
        webRequestFirewall.implemented === true &&
        webRequestFirewall.listenerRegistered === true &&
        webRequestFirewall.ready === true && webRequestFirewall.state === 'active';
    // A registration can silently succeed without Chrome granting blocking.
    // Never report a stale snapshot as active after a permission loss.
    if ( webRequestFirewall.declared && blockingPermission === false ) {
        webRequestFirewall.ready = false;
        webRequestFirewall.permissionGranted = false;
        webRequestFirewall.state = 'permission-required';
    }
    const managedWebRequestEligible =
        managedInstall &&
        policyPermissionsDeclared &&
        policyPermissionsGranted &&
        api.webRequest === true;
    const observationDeclared = manifestPermissions.has('webRequest') ||
        optionalPermissions.has('webRequest');
    const observationGranted = grantedPermissions.has('webRequest');
    const matchFeedbackAPI = manifestPermissions.has('declarativeNetRequestFeedback') &&
        api.nativeMatchFeedback === true;

    const eligibleNetworkEngines = [];
    if ( dnrAvailable ) {
        eligibleNetworkEngines.push('dnr');
    }
    if ( managedWebRequestEligible ) {
        eligibleNetworkEngines.push('managed-webrequest');
    }
    if ( blockingPermission && webRequestFirewall.implemented === true ) {
        eligibleNetworkEngines.push('webrequest-firewall');
    }

    return {
        productEdition: policyPermissionsDeclared ? 'experimental-webrequest' : 'power',
        installType,
        managedInstall,
        activeNetworkEngine: dnrAvailable
            ? webRequestFirewallActive ? 'dnr+webrequest-firewall' : 'dnr'
            : 'unavailable',
        eligibleNetworkEngines,
        managedWebRequestEligible,
        // Eligibility describes browser policy, not an implemented alternate engine.
        managedWebRequestImplemented: false,
        webRequestBlockingGranted: blockingPermission,
        webRequestFirewallActive: dnrAvailable && webRequestFirewallActive,
        webRequestFirewall,
        networkObservation: observationDeclared && observationGranted && api.webRequest === true,
        networkObservationRequestable: optionalPermissions.has('webRequest'),
        networkObservationPermissionGranted: observationGranted,
        nativeMatchFeedback: matchFeedbackAPI && installType === 'development',
        nativeMatchFeedbackUnconfirmed: matchFeedbackAPI && installType === 'unknown',
        topDomainFirewall: dnrAvailable && api.topDomainConditions === true,
        // These are product implementation limits, not a claim that every
        // browser or policy-installed extension has the same API surface.
        responseBodyFiltering: false,
        dnsCnameUncloaking: false,
        inlineScriptFirewall: false,
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
