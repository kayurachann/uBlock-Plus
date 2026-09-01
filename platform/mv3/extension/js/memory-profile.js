/*******************************************************************************

    uBlock Plus+ - a comprehensive, MV3-compliant content blocker
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

*/

/******************************************************************************/

export const MEMORY_PROFILE_AUTO = 'auto';
export const MEMORY_PROFILE_BALANCED = 'balanced';
export const MEMORY_PROFILE_LOW = 'low-memory';

export const DEFAULT_MEMORY_PROFILE = MEMORY_PROFILE_AUTO;

const profiles = Object.freeze({
    [MEMORY_PROFILE_BALANCED]: Object.freeze({
        importCompileConcurrency: 2,
        cssCacheMaxEntries: 256,
        cssCacheHighWatermark: 288,
        cssCachePruneMinutes: 30,
        retainScriptingMetadata: true,
        telemetryMinIntervalMinutes: 360,
    }),
    [MEMORY_PROFILE_LOW]: Object.freeze({
        importCompileConcurrency: 1,
        cssCacheMaxEntries: 64,
        cssCacheHighWatermark: 72,
        cssCachePruneMinutes: 5,
        retainScriptingMetadata: false,
        telemetryMinIntervalMinutes: 720,
    }),
});

/******************************************************************************/

export function normalizeMemoryProfile(value) {
    if ( value === MEMORY_PROFILE_BALANCED ) { return value; }
    if ( value === MEMORY_PROFILE_LOW ) { return value; }
    return DEFAULT_MEMORY_PROFILE;
}

function normalizeDeviceMemory(value) {
    if ( typeof value !== 'number' ) { return; }
    if ( Number.isFinite(value) === false ) { return; }
    if ( value <= 0 ) { return; }
    return value;
}

export function resolveMemoryProfile(
    selectedProfile,
    deviceMemoryGiB = globalThis.navigator?.deviceMemory
) {
    const selected = normalizeMemoryProfile(selectedProfile);
    const deviceMemory = normalizeDeviceMemory(deviceMemoryGiB);
    const effective = selected === MEMORY_PROFILE_AUTO
        ? deviceMemory !== undefined && deviceMemory <= 4
            ? MEMORY_PROFILE_LOW
            : MEMORY_PROFILE_BALANCED
        : selected;
    return {
        selected,
        effective,
        deviceMemoryGiB: deviceMemory ?? null,
        ...profiles[effective],
    };
}

/******************************************************************************/
