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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const localeRoot = new URL(
    '../platform/mv3/extension/_locales/',
    import.meta.url
);

const priorityLocales = [
    'en',
    'de',
    'es',
    'fr',
    'ja',
    'ko',
    'ru',
    'vi',
    'zh_CN',
    'zh_TW',
];
const powerKeyPattern = /^(?:filterStore|memoryProfile|enablePopupBlock|popupPolicy|privacy)/;
const legitimateEnglishCognates = new Set([
    'de:filterStoreCommunity',
    'es:filterStoreGlobal',
    'fr:filterStoreGlobal',
    'fr:popupPolicyStrict',
]);
const popupCompiledRuleMarkers = new Map([
    [ 'en', /filter-list rules still close immediately/i ],
    [ 'de', /Filterlistenregeln schließen weiterhin sofort/i ],
    [ 'es', /listas de filtros[\s\S]*cierran[\s\S]*de inmediato/i ],
    [ 'fr', /listes de filtres[\s\S]*ferment[\s\S]*immédiatement/i ],
    [ 'ja', /フィルターリスト[\s\S]*直ちに閉じ/ ],
    [ 'ko', /필터 목록[\s\S]*즉시 닫/ ],
    [ 'ru', /списка фильтров[\s\S]*закрывается сразу/i ],
    [ 'vi', /danh sách bộ lọc[\s\S]*đóng ngay/i ],
    [ 'zh_CN', /过滤器列表[\s\S]*立即关闭/ ],
    [ 'zh_TW', /篩選器清單[\s\S]*立即關閉/ ],
]);

async function readJSON(url) {
    return JSON.parse(await readFile(url, 'utf8'));
}

function substitutionTokens(message) {
    return Array.from(message.matchAll(/\$\d+/g), match => match[0]).sort();
}

const localeMessages = new Map();
for ( const locale of priorityLocales ) {
    localeMessages.set(
        locale,
        await readJSON(new URL(`${locale}/messages.json`, localeRoot))
    );
}

const english = localeMessages.get('en');
const englishKeys = Object.keys(english).sort();
const powerKeys = englishKeys.filter(key => powerKeyPattern.test(key));

assert(powerKeys.length >= 74, 'Expected the complete Power feature locale surface');

for ( const locale of priorityLocales ) {
    const messages = localeMessages.get(locale);
    assert.deepEqual(
        Object.keys(messages).sort(),
        englishKeys,
        `${locale} must keep key parity with the default locale`
    );
    for ( const key of powerKeys ) {
        const message = messages[key]?.message;
        assert.equal(
            typeof message,
            'string',
            `${locale}: ${key} must contain a string message`
        );
        assert.notEqual(message.trim(), '', `${locale}: ${key} must not be empty`);
        assert.deepEqual(
            substitutionTokens(message),
            substitutionTokens(english[key].message),
            `${locale}: ${key} must preserve substitution placeholders`
        );
        if (
            locale !== 'en' &&
            legitimateEnglishCognates.has(`${locale}:${key}`) === false
        ) {
            assert.notEqual(
                message,
                english[key].message,
                `${locale}: ${key} unexpectedly falls back to English`
            );
        }
    }
    assert.match(
        messages.popupPolicyDescription.message,
        popupCompiledRuleMarkers.get(locale),
        `${locale}: popup policy must disclose compiled-rule precedence`
    );
}

const dashboard = await readFile(
    new URL('../platform/mv3/extension/dashboard.html', import.meta.url),
    'utf8'
);
for ( const key of [
    'memoryProfileSelectLabel',
    'filterStoreCategoryLabel',
    'filterStoreLanguageLabel',
    'filterStoreProfileLabel',
] ) {
    assert.match(
        dashboard,
        new RegExp(`aria-label=["']${key}["']`),
        `dashboard must localize the ${key} accessible label`
    );
}

console.log(
    `Power locale tests passed (${powerKeys.length} keys, ` +
    `${priorityLocales.length} locales)`
);
