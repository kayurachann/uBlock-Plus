/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

export const ACTIVE_COMPILED_GENERATION_KEY =
    'compiledFilters.activeGeneration';
export const PENDING_COMPILED_ACTIVATION_KEY =
    'compiledFilters.pendingActivation';
export const STAGING_COMPILED_GENERATION_KEY =
    'compiledFilters.stagingGeneration';
export const COMPILED_GENERATION_PREFIX = 'compiledFilters.g.';

export const COMPILED_LOGICAL_KEYS = Object.freeze([
    'sandboxFilters.dnrRules',
    'importedFilters.dnrRules',
    'sandboxFilters.userScripts',
    'importedFilters.userScripts',
    'sandboxFilters.popupFilters',
    'importedFilters.popupFilters',
]);

export function newCompiledGeneration() {
    return globalThis.crypto.randomUUID().replaceAll('-', '');
}

export function compiledStorageKey(generation, logicalKey) {
    return generation
        ? `${COMPILED_GENERATION_PREFIX}${generation}.${logicalKey}`
        : logicalKey;
}

export function compiledGenerationPrefix(generation) {
    return `${COMPILED_GENERATION_PREFIX}${generation}.`;
}

/******************************************************************************/
