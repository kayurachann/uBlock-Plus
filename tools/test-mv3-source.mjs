/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const mv3Root = path.join(root, 'platform', 'mv3');
const extensionRoot = path.join(mv3Root, 'extension');
const expectedProductName = 'uBlock Plus+';

function assert(condition, message) {
    if ( condition ) { return; }
    throw new Error(message);
}

async function readJson(filePath) {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
}

const manifest = await readJson(path.join(mv3Root, 'chromium', 'manifest.json'));
assert(manifest.manifest_version === 3, 'Chromium manifest must use MV3');
assert(
    manifest.background?.service_worker === '/js/background.js',
    'Chromium manifest must use the MV3 module service worker'
);
assert(
    manifest.background?.type === 'module',
    'Chromium service worker must be an ES module'
);
assert(
    manifest.permissions?.includes('declarativeNetRequest'),
    'Chromium manifest must request declarativeNetRequest'
);
assert(
    manifest.permissions?.includes('declarativeNetRequestFeedback'),
    'Sideload builds must expose DNR matched-rule diagnostics'
);
assert(
    manifest.permissions?.includes('userScripts'),
    'Sideload builds must expose supported user-script filters'
);
assert(
    manifest.permissions?.includes('webRequestBlocking') !== true,
    'Public MV3 builds must not request webRequestBlocking'
);
assert(
    manifest.permissions?.includes('privacy') !== true &&
        manifest.optional_permissions?.includes('privacy'),
    'Chrome privacy controls must use an optional permission'
);
assert(
    manifest.name === '__MSG_extName__',
    'The product name must remain localized through extName'
);
assert(
    Number.parseInt(manifest.minimum_chrome_version, 10) >= 130,
    'Chromium 130+ is required for memory-safe storage key enumeration'
);
assert(
    new Set(manifest.permissions).size === manifest.permissions.length,
    'Chromium manifest permissions must not contain duplicates'
);
assert(
    new Set(manifest.optional_permissions).size ===
        manifest.optional_permissions.length,
    'Chromium optional permissions must not contain duplicates'
);
assert(
    manifest.optional_permissions.every(permission =>
        manifest.permissions.includes(permission) === false
    ),
    'Required and optional permissions must not overlap'
);

const localeRoot = path.join(extensionRoot, '_locales');
const localeEntries = await fs.readdir(localeRoot, { withFileTypes: true });
let localeCount = 0;
for ( const entry of localeEntries ) {
    if ( entry.isDirectory() === false ) { continue; }
    const messages = await readJson(
        path.join(localeRoot, entry.name, 'messages.json')
    );
    localeCount += 1;
    assert(
        messages.extName?.message === expectedProductName,
        `Locale ${entry.name} has inconsistent extName branding`
    );
    assert(
        /uBO Lite|uBlock MV3 Community/.test(JSON.stringify(messages)) === false,
        `Locale ${entry.name} contains legacy product branding`
    );
}
assert(localeCount >= 2, 'Expected at least English and Vietnamese locales');

for ( const locale of [ 'en', 'vi' ] ) {
    const messages = await readJson(
        path.join(localeRoot, locale, 'messages.json')
    );
    for ( const key of [
        'privacyHardeningSectionLabel',
        'privacyHardeningDescription',
        'privacySettingUpdateFailed',
        'privacyPermissionButton',
        'privacyDisableHyperlinkAuditing',
        'privacyDisableNetworkPrediction',
        'privacyProtectWebRTC',
        'privacyDisableAdApis',
        'memoryProfileSectionLabel',
        'memoryProfileDescription',
        'memoryProfileLow',
        'memoryProfileCleanupUnavailable',
    ] ) {
        assert(
            typeof messages[key]?.message === 'string' &&
                messages[key].message !== '',
            `Locale ${locale} is missing ${key}`
        );
    }
}

const htmlEntries = await fs.readdir(extensionRoot, { withFileTypes: true });
for ( const entry of htmlEntries ) {
    if ( entry.isFile() === false || entry.name.endsWith('.html') === false ) {
        continue;
    }
    const text = await fs.readFile(path.join(extensionRoot, entry.name), 'utf8');
    assert(
        /<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(text) === false,
        `${entry.name} contains a remotely hosted script`
    );
    assert(
        /uBO Lite|uBlock MV3 Community/.test(text) === false,
        `${entry.name} contains legacy product branding`
    );
}

for ( const relativePath of [
    'platform/mv3/extension/js/settings.js',
    'platform/mv3/extension/js/backup-schema.js',
    'platform/mv3/extension/js/backup-restore.js',
    'platform/mv3/extension/js/background.js',
    'platform/mv3/extension/js/alarms.js',
    'platform/mv3/extension/js/compile-timeout.js',
    'platform/mv3/extension/js/compiled-filters.js',
    'platform/mv3/extension/js/compiled-cache.js',
    'platform/mv3/extension/js/compiled-storage.js',
    'platform/mv3/extension/js/filter-store.js',
    'platform/mv3/extension/js/filter-store-model.js',
    'platform/mv3/extension/js/imported-lists.js',
    'platform/mv3/extension/js/imported-fetch-policy.js',
    'platform/mv3/extension/js/imported-list-metadata.js',
    'platform/mv3/extension/js/memory-manager.js',
    'platform/mv3/extension/js/offscreen-lifecycle.js',
    'platform/mv3/extension/js/offscreen/compile-filters.js',
    'platform/mv3/extension/js/offscreen/fetch-list.js',
    'platform/mv3/extension/js/ruleset-manager.js',
    'platform/mv3/extension/js/verified-source-handoff.js',
    'tools/set-product-name.mjs',
    'tools/test-backup-schema.mjs',
    'tools/validate-mv3.mjs',
] ) {
    execFileSync(process.execPath, [ '--check', path.join(root, relativePath) ], {
        stdio: 'pipe',
    });
}

for ( const [ relativePath, stagedDependency ] of [
    [ 'tools/make-mv3.ps1', "'js/imported-fetch-policy.js'" ],
    [
        'tools/make-mv3.sh',
        'platform/mv3/extension/js/imported-fetch-policy.js',
    ],
] ) {
    const script = await fs.readFile(path.join(root, relativePath), 'utf8');
    const rulesetStageIndex = script.indexOf('Generating rulesets');
    assert(
        rulesetStageIndex !== -1 &&
            script.slice(rulesetStageIndex).includes(stagedDependency),
        `${relativePath} must stage imported-fetch-policy.js for make-rulesets`
    );
}

const background = await fs.readFile(
    path.join(extensionRoot, 'js', 'background.js'),
    'utf8'
);
assert(
    background.includes('rulesets.pendingTransaction') &&
        background.includes('compiledFilters.dirtySources'),
    'Filtering mutations must retain durable recovery journals'
);
assert(
    background.includes('PENDING_COMPILED_ACTIVATION_KEY'),
    'Compiled filtering activation must use a pending journal'
);
assert(
    /case 'runMemoryCleanup':[\s\S]{0,160}enqueueFilteringMutation/.test(
        background
    ),
    'Manual memory cleanup must serialize with filtering activation'
);
assert(
    background.includes("case 'updateRulesetSelection':") &&
        background.includes('request.rulesetIdsToEnable'),
    'Filter Store selection changes must use queued deltas'
);
assert(
    background.includes('return processDueJobs(onMessage);') &&
        background.includes('ubolErr(`processDueJobs/${reason}`)'),
    'Deferred-job failures must not become unhandled rejections'
);

const backupRestore = await fs.readFile(
    path.join(extensionRoot, 'js', 'backup-restore.js'),
    'utf8'
);
const backupPreflightIndex = backupRestore.indexOf(
    'targetConfig = normalizeBackupObject(targetConfig)'
);
const firstBackupMutationIndex = backupRestore.indexOf("what: 'setAutoReload'");
assert(
    backupPreflightIndex !== -1 && firstBackupMutationIndex !== -1 &&
        backupPreflightIndex < firstBackupMutationIndex,
    'Backup restore must validate every field before its first mutation'
);

const filterLists = await fs.readFile(
    path.join(extensionRoot, 'js', 'filter-lists.js'),
    'utf8'
);
assert(
    /beforeunload[\s\S]{0,220}clearTimeout\(timer\)[\s\S]{0,120}apply\(true\)/
        .test(filterLists) &&
        /if \( timer !== undefined \) \{ return; \}/.test(filterLists) === false,
    'Pending list removals must flush during dashboard unload'
);

console.log(`MV3 source checks passed for ${localeCount} locales.`);
