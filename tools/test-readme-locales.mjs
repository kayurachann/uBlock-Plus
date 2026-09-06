/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import { access, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);

const readmes = new Map([
    [ 'en', 'README.md' ],
    [ 'de', 'docs/README.de.md' ],
    [ 'es', 'docs/README.es.md' ],
    [ 'fr', 'docs/README.fr.md' ],
    [ 'ja', 'docs/README.ja.md' ],
    [ 'ko', 'docs/README.ko.md' ],
    [ 'ru', 'docs/README.ru.md' ],
    [ 'vi', 'docs/README.vi.md' ],
    [ 'zh_CN', 'docs/README.zh_CN.md' ],
    [ 'zh_TW', 'docs/README.zh_TW.md' ],
]);

const languageLabels = new Map([
    [ 'en', 'English' ],
    [ 'de', 'Deutsch' ],
    [ 'es', 'Español' ],
    [ 'fr', 'Français' ],
    [ 'ja', '日本語' ],
    [ 'ko', '한국어' ],
    [ 'ru', 'Русский' ],
    [ 'vi', 'Tiếng Việt' ],
    [ 'zh_CN', '简体中文' ],
    [ 'zh_TW', '繁體中文' ],
]);

const requiredFragments = [
    'uBlock Plus+',
    'Manifest V3',
    'DNR',
    'Filter Store',
    '$popup',
    '$popunder',
    'uBlock-Plus_*.chromium.zip',
    'dist/build/uBlockPlus.chromium',
    'FEATURE-MATRIX.md',
    'ARCHITECTURE.md',
    'COMMUNITY-RESEARCH.md',
    'POWER-RUNTIME.md',
    'THREAT-MODEL.md',
    'PRIVACY.md',
    'ROADMAP.md',
    'npm run lint',
    'npm test',
];

const requiredCaseInsensitiveFragments = [
    'stock',
];

const externalProtocol = /^[a-z][a-z\d+.-]*:/i;

const countOccurrences = (content, value) =>
    content.split(value).length - 1;

function expectedLanguageBar(currentLocale) {
    return [ ...readmes ].map(([ locale, readmePath ]) => {
        const label = languageLabels.get(locale);
        const visibleLabel = locale === currentLocale
            ? `**${label}**`
            : label;
        const link = currentLocale === 'en'
            ? readmePath
            : readmePath === 'README.md'
                ? '../README.md'
                : path.basename(readmePath);
        return `[${visibleLabel}](${link})`;
    }).join(' · ');
}

function assertBalancedMarkup(readmePath, content) {
    assert.equal(
        (content.match(/^```/gm) || []).length % 2,
        0,
        `${readmePath} contains an unclosed code fence`
    );
    for ( const tag of [ 'details', 'div', 'table', 'td', 'tr' ] ) {
        const opening = content.match(new RegExp(`<${tag}\\b`, 'gi')) || [];
        const closing = content.match(new RegExp(`</${tag}\\b`, 'gi')) || [];
        assert.equal(
            opening.length,
            closing.length,
            `${readmePath} has unbalanced <${tag}> markup`
        );
    }
    const ids = [ ...content.matchAll(/\bid="([^"]+)"/g) ]
        .map(match => match[1]);
    assert.equal(
        ids.length,
        new Set(ids).size,
        `${readmePath} contains duplicate HTML ids`
    );
}

function assertIllustrations(readmePath, content) {
    const images = [ ...content.matchAll(/<img\b[^>]*>/gi) ];
    assert.ok(images.length > 0, `${readmePath} has no illustrations`);
    for ( const [ tag ] of images ) {
        assert.match(tag, /\bsrc="[^"]+"/i,
            `${readmePath} has an image without a source`);
        assert.match(tag, /\balt="[^"\s][^"]*"/i,
            `${readmePath} has an image without descriptive alternative text`);
    }
}

async function assertLocalTargets(readmePath, content) {
    const directory = path.dirname(path.join(projectRoot, readmePath));
    const targets = [];
    const markdownTarget = /!?\[[^\]]*\]\(([^)]+)\)/g;
    const htmlTarget = /<(?:img|a)\b[^>]*(?:src|href)="([^"]+)"/gi;
    for ( const expression of [ markdownTarget, htmlTarget ] ) {
        for ( const match of content.matchAll(expression) ) {
            let target = match[1].trim();
            if ( target.startsWith('<') && target.endsWith('>') ) {
                target = target.slice(1, -1);
            }
            target = target.split('#', 1)[0];
            if ( target === '' || target.startsWith('#') ||
                externalProtocol.test(target) ) {
                continue;
            }
            targets.push(target);
        }
    }
    for ( const target of new Set(targets) ) {
        const resolved = path.resolve(directory, decodeURIComponent(target));
        await assert.doesNotReject(
            access(resolved),
            `${readmePath} links to missing local target ${target}`
        );
    }
}

for ( const [ locale, readmePath ] of readmes ) {
    const absolutePath = path.join(projectRoot, readmePath);
    const content = await readFile(absolutePath, 'utf8');
    const languageBar = expectedLanguageBar(locale);

    assert.equal(
        countOccurrences(content, languageBar),
        1,
        `${readmePath} must contain one exact ordered language bar`
    );
    for ( const fragment of requiredFragments ) {
        assert.ok(
            content.includes(fragment),
            `${readmePath} is missing parity marker ${fragment}`
        );
    }
    for ( const fragment of requiredCaseInsensitiveFragments ) {
        assert.ok(
            content.toLowerCase().includes(fragment),
            `${readmePath} is missing parity marker ${fragment}`
        );
    }
    assertIllustrations(readmePath, content);
    assert.equal(
        content.includes('dist/build/uBOLite.'),
        false,
        `${readmePath} contains the retired artifact path`
    );
    assert.equal(
        content.includes('/releases/tag/'),
        false,
        `${readmePath} contains a version-pinned release CTA`
    );
    assert.ok(
        countOccurrences(
            content,
            '](https://github.com/kayurachann/uBlock-Plus/releases)'
        ) >= 2,
        `${readmePath} is missing a dynamic release badge or CTA`
    );
    assert.ok(
        content.includes('](#quick-start)'),
        `${readmePath} is missing the stable quick-start badge target`
    );
    assert.equal(
        countOccurrences(content, '<a id="quick-start"></a>'),
        locale === 'en' ? 0 : 1,
        `${readmePath} must declare its translated quick-start anchor once`
    );
    // Translations may use different layouts or await a documented refresh.
    // Validate their content, navigation and markup without requiring the
    // same number of headings, screenshots or disclosure panels as English.
    assert.equal(
        countOccurrences(content, '> [!IMPORTANT]'),
        1,
        `${readmePath} must preserve the release and MV3 warning`
    );
    assert.equal(
        countOccurrences(content, '> [!NOTE]'),
        1,
        `${readmePath} must preserve the memory-measurement note`
    );
    assertBalancedMarkup(readmePath, content);
    await assertLocalTargets(readmePath, content);
}

const documentationIndex = await readFile(
    path.join(projectRoot, 'docs', 'README.md'),
    'utf8'
);
for ( const readmePath of readmes.values() ) {
    const link = readmePath === 'README.md'
        ? '../README.md'
        : path.basename(readmePath);
    assert.ok(
        documentationIndex.includes(`](${link})`),
        `docs/README.md is missing ${link}`
    );
}
await assertLocalTargets('docs/README.md', documentationIndex);

console.log(`Localized README checks passed (${readmes.size} languages).`);
