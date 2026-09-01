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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mergeLocaleFallbacks } from './merge-mv3-locale-fallbacks.mjs';
import os from 'node:os';
import path from 'node:path';

async function writeCatalog(root, locale, messages) {
    const localeDirectory = path.join(root, '_locales', locale);
    await mkdir(localeDirectory, { recursive: true });
    await writeFile(
        path.join(localeDirectory, 'messages.json'),
        `${JSON.stringify(messages, null, 2)}\n`
    );
}

async function readCatalog(root, locale) {
    return JSON.parse(await readFile(
        path.join(root, '_locales', locale, 'messages.json'),
        'utf8'
    ));
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ubp-i18n-'));

try {
    const english = {
        translated: { message: 'English value' },
        missing: {
            message: 'Fallback $1',
            description: 'Fallback test message',
        },
    };
    await writeCatalog(temporaryRoot, 'en', english);
    await writeCatalog(temporaryRoot, 'de', {
        translated: { message: 'Deutscher Wert' },
        localeOnly: { message: 'Nur lokal' },
    });
    await writeCatalog(temporaryRoot, 'fr', english);

    const first = await mergeLocaleFallbacks(temporaryRoot);
    assert.deepEqual(first, { localesUpdated: 1, messagesAdded: 1 });

    const german = await readCatalog(temporaryRoot, 'de');
    assert.equal(german.translated.message, 'Deutscher Wert');
    assert.deepEqual(german.missing, english.missing);
    assert.equal(german.localeOnly.message, 'Nur lokal');
    assert.deepEqual(await readCatalog(temporaryRoot, 'en'), english);

    const second = await mergeLocaleFallbacks(temporaryRoot);
    assert.deepEqual(second, { localesUpdated: 0, messagesAdded: 0 });
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}

console.log('MV3 locale fallback merge tests passed');
