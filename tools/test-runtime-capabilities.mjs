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

console.log('Runtime capability negotiation tests passed.');
