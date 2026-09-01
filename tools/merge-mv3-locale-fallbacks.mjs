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

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

function isMessageCatalog(value) {
    return value instanceof Object && Array.isArray(value) === false;
}

async function readCatalog(filePath) {
    const catalog = JSON.parse(await readFile(filePath, 'utf8'));
    if ( isMessageCatalog(catalog) === false ) {
        throw new TypeError(`Invalid locale catalog: ${filePath}`);
    }
    return catalog;
}

export async function mergeLocaleFallbacks(extensionRoot) {
    const localeRoot = path.join(path.resolve(extensionRoot), '_locales');
    const englishPath = path.join(localeRoot, 'en', 'messages.json');
    const english = await readCatalog(englishPath);
    const localeEntries = await readdir(localeRoot, { withFileTypes: true });
    let localesUpdated = 0;
    let messagesAdded = 0;

    for ( const entry of localeEntries.sort((a, b) =>
        a.name.localeCompare(b.name)) ) {
        if ( entry.isDirectory() === false || entry.name === 'en' ) {
            continue;
        }
        const localePath = path.join(localeRoot, entry.name, 'messages.json');
        const localized = await readCatalog(localePath);
        const missingKeys = Object.keys(english).filter(key =>
            Object.hasOwn(localized, key) === false
        );
        if ( missingKeys.length === 0 ) { continue; }

        const merged = {};
        for ( const [ key, fallback ] of Object.entries(english) ) {
            merged[key] = Object.hasOwn(localized, key)
                ? localized[key]
                : fallback;
        }
        for ( const [ key, message ] of Object.entries(localized) ) {
            if ( Object.hasOwn(merged, key) ) { continue; }
            merged[key] = message;
        }

        await writeFile(localePath, `${JSON.stringify(merged, null, 2)}\n`);
        localesUpdated += 1;
        messagesAdded += missingKeys.length;
    }

    return { localesUpdated, messagesAdded };
}

const invokedPath = process.argv[1] === undefined
    ? ''
    : pathToFileURL(path.resolve(process.argv[1])).href;

if ( import.meta.url === invokedPath ) {
    const extensionRoot = process.argv[2];
    if ( extensionRoot === undefined ) {
        throw new TypeError(
            'Usage: node tools/merge-mv3-locale-fallbacks.mjs <extension-root>'
        );
    }
    const result = await mergeLocaleFallbacks(extensionRoot);
    console.log(
        `Added ${result.messagesAdded} English fallback message(s) to ` +
        `${result.localesUpdated} locale catalog(s).`
    );
}
