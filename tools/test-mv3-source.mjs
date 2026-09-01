/*******************************************************************************

    uBlock MV3 Community
    Copyright (C) 2026-present uBlock MV3 Community contributors

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
const expectedProductName = 'uBlock MV3 Community';

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
}
assert(localeCount >= 2, 'Expected at least English and Vietnamese locales');

for ( const locale of [ 'en', 'vi' ] ) {
    const messages = await readJson(
        path.join(localeRoot, locale, 'messages.json')
    );
    for ( const key of [
        'privacyHardeningSectionLabel',
        'privacyHardeningDescription',
        'privacyPermissionButton',
        'privacyDisableHyperlinkAuditing',
        'privacyDisableNetworkPrediction',
        'privacyProtectWebRTC',
        'privacyDisableAdApis',
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
}

for ( const relativePath of [
    'platform/mv3/extension/js/settings.js',
    'tools/set-product-name.mjs',
    'tools/validate-mv3.mjs',
] ) {
    execFileSync(process.execPath, [ '--check', path.join(root, relativePath) ], {
        stdio: 'pipe',
    });
}

console.log(`MV3 source checks passed for ${localeCount} locales.`);
