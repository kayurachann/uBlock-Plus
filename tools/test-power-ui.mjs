/*******************************************************************************

    uBlock Plus+ - Power UI schema tests
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import {
    POWER_PROFILES,
    POWER_UI_DEFAULTS,
    matchingPowerProfile,
    normalizePowerUISettings,
} from '../platform/mv3/extension/js/power-ui-core.js';
import assert from 'node:assert/strict';

assert.deepEqual(normalizePowerUISettings(), POWER_UI_DEFAULTS);

const customUI = normalizePowerUISettings({
    theme: 'dark',
    accent: 'violet',
    density: 'compact',
    popupLayout: 'power',
}, { strict: true });
assert.equal(customUI.theme, 'dark');
assert.equal(customUI.density, 'compact');

for ( const invalid of [
    [],
    'dark',
    { theme: 'midnight' },
    { accent: '#fff' },
    { density: 'tiny' },
    { popupLayout: 'firewall' },
] ) {
    assert.throws(( ) => normalizePowerUISettings(invalid, { strict: true }));
}

for ( const [ name, profile ] of Object.entries(POWER_PROFILES) ) {
    assert.equal(matchingPowerProfile(profile), name);
}
assert.equal(matchingPowerProfile({
    ...POWER_PROFILES.balanced,
    autoReload: false,
}), 'custom');

console.log('Power UI schema tests passed');
