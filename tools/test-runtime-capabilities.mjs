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

import { capabilityDetailsRows, webRequestFirewallStatusText } from '../platform/mv3/extension/js/runtime-capabilities-ui.js';
import assert from 'node:assert/strict';
import { classifyRuntimeCapabilities } from '../platform/mv3/extension/js/runtime-capabilities-core.js';

const standard = classifyRuntimeCapabilities({
    installType: 'development',
    manifestPermissions: [ 'declarativeNetRequest' ],
    api: {
        declarativeNetRequest: true,
        offscreen: true,
        tabs: true,
        userScripts: true,
        webNavigation: true,
    },
    quotas: {
        availableStaticRules: 30000,
        dynamicRules: 30000,
        regexRules: 1000,
    },
});

assert.equal(standard.productEdition, 'power');
assert.equal(standard.activeNetworkEngine, 'dnr');
assert.deepEqual(standard.eligibleNetworkEngines, [ 'dnr' ]);
assert.equal(standard.managedWebRequestEligible, false);
assert.equal(standard.smartPopupObservation, true);
assert.equal(standard.userScripts, true);
assert.equal(standard.quotas.availableStaticRules, 30000);

const managed = classifyRuntimeCapabilities({
    installType: 'admin',
    manifestPermissions: [
        'declarativeNetRequest',
        'webRequest',
        'webRequestBlocking',
    ],
    grantedPermissions: [ 'webRequest', 'webRequestBlocking' ],
    api: {
        declarativeNetRequest: true,
        webRequest: true,
    },
});

assert.equal(managed.managedInstall, true);
assert.equal(managed.managedWebRequestEligible, true);
assert.deepEqual(
    managed.eligibleNetworkEngines,
    [ 'dnr', 'managed-webrequest' ]
);
// Eligibility must never silently switch an unimplemented engine on.
assert.equal(managed.activeNetworkEngine, 'dnr');

for ( const missing of [
    { installType: 'development' },
    { grantedPermissions: [ 'webRequest' ] },
    { api: { webRequest: false } },
] ) {
    const result = classifyRuntimeCapabilities({
        installType: 'admin',
        manifestPermissions: [
            'declarativeNetRequest',
            'webRequest',
            'webRequestBlocking',
        ],
        grantedPermissions: [ 'webRequest', 'webRequestBlocking' ],
        api: { declarativeNetRequest: true, webRequest: true },
        ...missing,
    });
    assert.equal(result.managedWebRequestEligible, false);
}

const unavailable = classifyRuntimeCapabilities({
    installType: 'development',
    manifestPermissions: [],
    api: {},
    quotas: { dynamicRules: -1, regexRules: Number.NaN },
});
assert.equal(unavailable.activeNetworkEngine, 'unavailable');
assert.deepEqual(unavailable.eligibleNetworkEngines, []);
assert.equal(unavailable.userScripts, false);
assert.equal(unavailable.quotas.dynamicRules, undefined);
assert.equal(unavailable.quotas.regexRules, undefined);

const optional = {
    installType: 'development',
    manifestPermissions: [ 'declarativeNetRequest', 'declarativeNetRequestFeedback' ],
    optionalPermissions: [ 'webRequest' ],
    api: { declarativeNetRequest: true, webRequest: true, nativeMatchFeedback: true, topDomainConditions: true },
};
const ungranted = classifyRuntimeCapabilities(optional);
assert.equal(ungranted.networkObservation, false, 'an exposed namespace is not an optional permission grant');
assert.equal(ungranted.networkObservationRequestable, true);
assert.equal(ungranted.topDomainFirewall, true);
assert.equal(ungranted.nativeMatchFeedback, true);
const granted = classifyRuntimeCapabilities({ ...optional, grantedPermissions: [ 'webRequest' ] });
assert.equal(granted.networkObservation, true);
assert.equal(granted.activeNetworkEngine, 'dnr', 'observation never changes the filtering engine');
assert.equal(classifyRuntimeCapabilities({ ...optional, installType: 'normal' }).nativeMatchFeedback, false,
    'having the feedback API cannot grant unpacked-only eligibility to a store installation');
assert.equal(classifyRuntimeCapabilities({ ...optional, installType: 'unknown' }).nativeMatchFeedbackUnconfirmed, true);
assert.equal(classifyRuntimeCapabilities({ ...optional, api: { declarativeNetRequest: true } }).topDomainFirewall, false);
for ( const result of [ standard, managed, granted, unavailable ] ) {
    assert.equal(result.responseBodyFiltering, false);
    assert.equal(result.dnsCnameUncloaking, false);
    assert.equal(result.inlineScriptFirewall, false);
    assert.equal(result.managedWebRequestImplemented, false);
}
assert.match(capabilityDetailsRows(ungranted, 'en')[0][1], /Optional permission not granted/);
assert.match(capabilityDetailsRows(granted, 'vi-VN')[0][1], /chỉ thu thập sau/);
assert.match(capabilityDetailsRows(managed, 'en').at(-1)[1], /Not implemented/);

const experimentalInput = {
    installType: 'development',
    manifestPermissions: [ 'declarativeNetRequest', 'webRequest', 'webRequestBlocking' ],
    grantedPermissions: [ 'webRequest', 'webRequestBlocking' ],
    api: { declarativeNetRequest: true, webRequest: true },
    webRequestFirewall: { implemented: true, declared: true, permissionGranted: true,
        listenerRegistered: true, ready: true, state: 'active', ruleCount: 1 },
};
const experimental = classifyRuntimeCapabilities(experimentalInput);
assert.equal(experimental.managedInstall, false, 'a switch grant is not a policy install');
assert.equal(experimental.managedWebRequestEligible, false);
assert.equal(experimental.managedWebRequestImplemented, false, 'supplement is not the full engine');
assert.equal(experimental.activeNetworkEngine, 'dnr+webrequest-firewall');
assert.equal(experimental.productEdition, 'experimental-webrequest');
assert.equal(experimental.webRequestFirewallActive, true);
assert.match(webRequestFirewallStatusText(experimental, 'vi'), /Đang hoạt động/);
for ( const missing of [
    { grantedPermissions: [ 'webRequest' ] },
    { webRequestFirewall: { ...experimentalInput.webRequestFirewall, ready: false, state: 'suspended' } },
    { webRequestFirewall: { ...experimentalInput.webRequestFirewall, listenerRegistered: false } },
    { webRequestFirewall: { ...experimentalInput.webRequestFirewall, state: 'error' } },
] ) {
    const result = classifyRuntimeCapabilities({ ...experimentalInput, ...missing });
    assert.equal(result.activeNetworkEngine, 'dnr');
    assert.equal(result.webRequestFirewallActive, false);
}
const lostPermission = classifyRuntimeCapabilities({ ...experimentalInput, grantedPermissions: [] });
assert.equal(lostPermission.webRequestFirewall.state, 'permission-required');
assert.equal(lostPermission.webRequestFirewall.ready, false);
assert.match(webRequestFirewallStatusText(lostPermission, 'en'), /Permission required/);
assert.equal(experimentalInput.webRequestFirewall.ready, true, 'capability read must not mutate live state');
assert.match(webRequestFirewallStatusText(standard, 'en'), /separate Experimental/);
assert.match(webRequestFirewallStatusText({ webRequestFirewall: { state: 'error' } }, 'vi'), /chỉ áp dụng DNR/);

console.log('Runtime capability negotiation tests passed.');
