/*******************************************************************************

    uBlock Plus+ - report page privacy and destination
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    Reports go to a public tracker. docs/PRIVACY.md promises that they carry
    only origins, that the UI confirms before opening GitHub, and that the
    fork's own tracker is used for both searching and filing.

*/

import {
    FakeDocument,
    FakeElement,
    createExtension,
    settle,
    stageModules,
} from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const TRACKER = 'https://github.com/kayurachann/uBlock-Plus/issues';

const document = new FakeDocument();
const urlSelect = document.register('select[name="url"]', new FakeElement('select'));
urlSelect.append(new FakeElement('option'));
Object.defineProperty(urlSelect, 'value', {
    get() { return this.options[0].textContent; },
});
document.register('select[name="type"]', new FakeElement('select', { value: 'ads' }));
document.register('#isNSFW', new FakeElement('input'));
const troubleshooting = document.register('[data-i18n="supportS5H"] + pre', new FakeElement('pre'));

const extension = createExtension();
const confirmations = [];
let confirmed = false;
globalThis.confirm = text => {
    confirmations.push(text);
    return confirmed;
};

const pageURL = 'https://user:pass@mail.example.com/reset?token=abc123#fragment';
// The troubleshooting information resolves only when the test releases it.
let releaseTroubleshooting;
globalThis.reportTestTroubleshootingGate = new Promise(resolve => {
    releaseTroubleshooting = resolve;
});
const staged = await stageModules({
    modules: [ 'report.js' ],
    stubs: {
        'troubleshooting.js': `
            export async function getTroubleshootingInfo() {
                await globalThis.reportTestTroubleshootingGate;
                return [
                    'filtering:',
                    ' default: optimal',
                    'rulesets:',
                    ' +easylist',
                    ' +https://user:secret@lists.example/private.txt?token=abc',
                    'console:',
                    ' Firewall navigation/https://mail.example.com/reset?token=abc123',
                ].join('\\n');
            }
        `,
    },
    document,
    extension,
    location: `chrome-extension://test/report.html?url=${encodeURIComponent(pageURL)}&mode=2&tabid=5`,
});

// Localized text links to the tracker with a real anchor: keyboard users
// can focus it, and Enter activates it with a click event.
const linkSelector = 'a[href^="https://"], [data-url]';
const trackerLink = document.register(linkSelector, new FakeElement('a', { href: TRACKER }));
trackerLink.ancestors.set(linkSelector, trackerLink);
const trackerLabel = new FakeElement('code');
trackerLabel.ancestors.set(linkSelector, trackerLink);

try {
    await staged.load('report.js');
    await settle(10);

    // Bound at once, not after the troubleshooting information loaded.
    assert.equal(troubleshooting.textContent, '', 'Troubleshooting is still loading');
    for ( const target of [ trackerLink, trackerLabel ] ) {
        let prevented = false;
        await document.trigger(linkSelector, 'click', {
            target, preventDefault() { prevented = true; },
        });
        assert.deepEqual(extension.messages.splice(0), [ { what: 'gotoURL', url: TRACKER } ]);
        assert.equal(prevented, true, 'The link opens a tab instead of replacing the form');
    }
    releaseTroubleshooting();
    await settle(10);

    assert.deepEqual(urlSelect.options.map(option => option.textContent),
        [ 'https://mail.example.com/' ],
        'Only the page origin may be offered');
    assert.equal(troubleshooting.textContent, [
        'filtering:',
        ' default: optimal',
        'rulesets:',
        ' +easylist',
        ' +https://lists.example/…',
        'console:',
        ' Firewall navigation/https://mail.example.com/…',
    ].join('\n'), 'Troubleshooting details shown and sent must carry origins only');

    await document.trigger('[data-i18n="supportReportSpecificButton"]', 'click', {
        preventDefault() {},
    });
    await settle(10);
    assert.deepEqual(confirmations, [ '[reportGitHubConfirm]' ]);
    assert.deepEqual(extension.messages, [], 'Declining the warning opens nothing');

    confirmed = true;
    await document.trigger('[data-i18n="supportReportSpecificButton"]', 'click', {
        preventDefault() {},
    });
    await settle(10);
    const [ create ] = extension.messages;
    assert.equal(create.what, 'gotoURL');
    const issue = new URL(create.url);
    assert.equal(`${issue.origin}${issue.pathname}`, `${TRACKER}/new`);
    assert.equal(issue.searchParams.get('title'), 'mail.example.com: ads');
    const body = issue.searchParams.get('body');
    assert.match(body, /^Page: `https:\/\/mail\.example\.com\/`$/m);
    for ( const secret of [ 'token', 'reset', 'pass', 'secret', 'private.txt', 'fragment' ] ) {
        assert.equal(create.url.includes(secret), false, `Report URL leaks "${secret}"`);
    }

    extension.messages.length = 0;
    await document.trigger('[data-i18n="supportFindSpecificButton"]', 'click', {
        preventDefault() {},
    });
    const search = new URL(extension.messages[0].url);
    assert.equal(`${search.origin}${search.pathname}`, TRACKER,
        'Searching and filing must use the same tracker');
    assert.match(search.searchParams.get('q'), /"mail\.example\.com" in:title/);
} finally {
    await staged.cleanup();
}

const reportHTML = await readFile(
    new URL('../platform/mv3/extension/report.html', import.meta.url),
    'utf8'
);
assert.equal(reportHTML.includes('data-i18n="supportS3P1"'), false,
    'The report page must not name the uBlockOrigin/uAssets tracker');
assert.match(reportHTML, /data-i18n="reportIssueTrackerInfo"/);
for ( const locale of [ 'en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'vi', 'zh_CN', 'zh_TW' ] ) {
    const catalog = JSON.parse(await readFile(new URL(
        `../platform/mv3/extension/_locales/${locale}/messages.json`, import.meta.url
    ), 'utf8'));
    const { message } = catalog.reportIssueTrackerInfo;
    const link = message.match(/<a href="([^"]*)">(.*?)<\/a>/);
    assert.equal(link?.[1], TRACKER, `${locale}: the issue tracker must be a keyboard-reachable link`);
    assert.match(link[2], /<code>uBlock Plus\+<\/code>/, `${locale}: the link names the tracker`);
    assert.equal(message.includes('data-url'), false, `${locale}: no pointer-only link`);
}

console.log('Report page privacy tests passed');
