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
const legacyProductPattern =
    /u(?:bo|block origin)[\s-]*lite|uBlock MV3 Community/i;

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
    manifest.permissions?.includes('webNavigation'),
    'Context-aware popup blocking requires navigation-target context'
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
        legacyProductPattern.test(JSON.stringify(messages)) === false,
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
        legacyProductPattern.test(text) === false,
        `${entry.name} contains legacy product branding`
    );
}

const productFacingDocs = [
    'README.md',
    'CONTRIBUTING.md',
    'docs/POWER-RUNTIME.md',
    'docs/PRIVACY.md',
    'platform/mv3/README.md',
];
const docsEntries = await fs.readdir(path.join(root, 'docs'));
for ( const entry of docsEntries ) {
    if ( /^README\.[^.]+\.md$/.test(entry) ) {
        productFacingDocs.push(`docs/${entry}`);
    }
}
for ( const relativePath of productFacingDocs ) {
    const text = await fs.readFile(path.join(root, relativePath), 'utf8');
    // Documentation may credit the separate upstream project through its
    // official link. This exception does not apply to our product title or UI.
    const productTitle = text.match(/^# +.*$/m)?.[0] || '';
    const productCopy = text.replace(
        /\[([^\]\r\n]+)\]\(https:\/\/github\.com\/uBlockOrigin\/uBOL-home\)/g,
        (_link, label) => label.replaceAll('uBlock Origin Lite', 'upstream project')
    );
    assert(
        legacyProductPattern.test(productTitle) === false &&
            legacyProductPattern.test(productCopy) === false,
        `${relativePath} contains retired product branding`
    );
}

let storeDescriptions = [];
try {
    storeDescriptions = await fs.readdir(path.join(mv3Root, 'description'));
} catch ( reason ) {
    if ( reason?.code !== 'ENOENT' ) { throw reason; }
}
assert(
    storeDescriptions.length === 0,
    'Sideload-only source must not ship retired store description files'
);

const rulesetCatalog = await fs.readFile(
    path.join(mv3Root, 'rulesets.json'),
    'utf8'
);
assert(
    rulesetCatalog.includes('ubol-tests') === false,
    'Production rulesets must not expose the retired test catalog'
);

const popupHtml = await fs.readFile(
    path.join(extensionRoot, 'popup.html'),
    'utf8'
);
assert(
    popupHtml.includes('id="sitePower"') &&
        popupHtml.includes('role="switch"'),
    'Popup must expose an original-style per-site power switch'
);
assert(
    popupHtml.includes('filteringModeSlider') === false,
    'Popup must not regress to the retired four-level slider UI'
);
assert(
    /<strong\b[^>]*data-i18n="extName"[^>]*>_<\/strong>/.test(popupHtml),
    'Popup product title must use the replaceable i18n placeholder'
);
for ( const id of [ 'gotoZapper', 'gotoPicker', 'gotoUnpicker', 'gotoReport' ] ) {
    assert(
        popupHtml.includes(`<button id="${id}"`),
        `Popup tool ${id} must remain a keyboard-accessible button`
    );
}

const popupCss = await fs.readFile(
    path.join(extensionRoot, 'css', 'popup.css'),
    'utf8'
);
for ( const marker of [
    'max-height: 600px;',
    'overflow-y: auto;',
    'scrollbar-gutter: stable;',
] ) {
    assert(
        popupCss.includes(marker),
        `Popup layout stability rule is missing: ${marker}`
    );
}
assert(
    popupCss.includes('transform: scale(') === false,
    'Popup controls must not use scale transforms which can look like jitter'
);

const dashboardHtml = await fs.readFile(
    path.join(extensionRoot, 'dashboard.html'),
    'utf8'
);
for ( const marker of [
    'data-pane="siteRules"',
    'data-pane="diagnostics"',
    'id="protectionProfiles"',
] ) {
    assert(
        dashboardHtml.includes(marker),
        `Dashboard is missing original-first control ${marker}`
    );
}
assert(
    dashboardHtml.includes('filteringModeSlider') === false,
    'Dashboard must not regress to the retired four-level slider UI'
);
assert(
    dashboardHtml.includes('cm6.bundle.ublock-plus.min.js'),
    'Dashboard must use the fork-owned CodeMirror output filename'
);

for ( const platform of [ 'chromium', 'firefox', 'safari' ] ) {
    const platformManifest = await readJson(
        path.join(mv3Root, platform, 'manifest.json')
    );
    assert(
        legacyProductPattern.test(JSON.stringify(platformManifest)) === false,
        `${platform} manifest contains legacy product branding`
    );
    assert(
        JSON.stringify(platformManifest).includes('raymondhill.net') === false,
        `${platform} manifest must not claim an upstream-owned identity`
    );
}

for ( const relativePath of [
    'js/debug.js',
    'js/filter-manager-ui.js',
    'js/rw-dnr-editor.js',
] ) {
    const text = await fs.readFile(path.join(extensionRoot, relativePath), 'utf8');
    assert(
        legacyProductPattern.test(text) === false &&
            text.includes('[uBOL]') === false &&
            text.includes('my-ubol-') === false,
        `${relativePath} contains a legacy user-facing identifier`
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
    'platform/mv3/extension/js/offscreen-storage.js',
    'platform/mv3/extension/js/filter-store.js',
    'platform/mv3/extension/js/filter-store-model.js',
    'platform/mv3/extension/js/imported-lists.js',
    'platform/mv3/extension/js/imported-fetch-policy.js',
    'platform/mv3/extension/js/imported-list-metadata.js',
    'platform/mv3/extension/js/memory-manager.js',
    'platform/mv3/extension/js/popup-blocker.js',
    'platform/mv3/extension/js/popup-frame-context.js',
    'platform/mv3/extension/js/popup-policy.js',
    'platform/mv3/extension/js/popup.js',
    'platform/mv3/extension/js/power-settings.js',
    'platform/mv3/extension/js/power-ui-core.js',
    'platform/mv3/extension/js/power-ui.js',
    'platform/mv3/extension/js/compiled-popup-matcher.js',
    'platform/mv3/extension/js/scripting/popup-context.js',
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
    [ 'tools/make-mv3.ps1', "'js/compiled-popup-matcher.js'" ],
    [
        'tools/make-mv3.sh',
        'platform/mv3/extension/js/imported-fetch-policy.js',
    ],
    [
        'tools/make-mv3.sh',
        'platform/mv3/extension/js/compiled-popup-matcher.js',
    ],
] ) {
    const script = await fs.readFile(path.join(root, relativePath), 'utf8');
    const rulesetStageIndex = script.indexOf('Generating rulesets');
    assert(
        rulesetStageIndex !== -1 &&
            script.slice(rulesetStageIndex).includes(stagedDependency),
        `${relativePath} must stage ${stagedDependency} for make-rulesets`
    );
}

const unixBuildScript = await fs.readFile(
    path.join(root, 'tools', 'make-mv3.sh'),
    'utf8'
);
assert(
    /\bUBOL_[A-Z_]+/.test(unixBuildScript) === false,
    'Unix build variables must use fork-owned names'
);
const windowsBuildScript = await fs.readFile(
    path.join(root, 'tools', 'make-mv3.ps1'),
    'utf8'
);
assert(
    windowsBuildScript.includes('ubol-mv3-') === false,
    'Windows build temp paths must use fork-owned names'
);

const releaseWorkflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'mv3-chromium.yml'),
    'utf8'
);
assert(
    releaseWorkflow.includes('ConvertFrom-Json).version') &&
        releaseWorkflow.includes('-Version $version') &&
        releaseWorkflow.includes('github.run_number') === false,
    'CI package version must come from package.json'
);

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
        background.includes('ublockPlusErr(`processDueJobs/${reason}`)'),
    'Deferred-job failures must not become unhandled rejections'
);
assert(
    background.includes('if ( stockUpdated !== true )') &&
        background.includes('startSession/ruleset enable/'),
    'Startup must not repeat a stock DNR refresh already done by enableRulesets'
);
const popupListenerStart = background.indexOf(
    'browser.tabs.onCreated.addListener'
);
const popupListenerEnd = background.indexOf(
    'browser.alarms.onAlarm.addListener',
    popupListenerStart
);
const popupListenerBlock = background.slice(
    popupListenerStart,
    popupListenerEnd
);
assert(
    popupListenerStart !== -1 && popupListenerEnd !== -1 &&
        popupListenerBlock.indexOf('const openerTabPromise =') <
            popupListenerBlock.indexOf('isFullyInitialized.then') &&
        popupListenerBlock.indexOf('const sourceContextPromise =') <
            popupListenerBlock.lastIndexOf('isFullyInitialized.then') &&
        popupListenerBlock.includes(
            'popupBlocker.onTabCreated(tab, openerTabPromise)'
        ) &&
        popupListenerBlock.includes('sourceContextPromise'),
    'Popup provenance must be captured before hydration and evaluated after it'
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
