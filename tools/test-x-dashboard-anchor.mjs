/*******************************************************************************

    uBlock Plus+ - dashboard section links
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    The popup's "Update x.y.z" button and the reopen after an updater restart,
    an install or a restore open dashboard.html#settings/autoUpdate: the
    Settings pane is selected and, once the page shows (body.loading ends),
    the Updates heading is scrolled into view and focused. Plain pane hashes
    and managed locks keep working.

*/

import {
    FakeDocument,
    FakeElement,
    createExtension,
    settle,
    stageModules,
} from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const document = new FakeDocument();
for ( const pane of [ 'settings', 'rulesets', 'filters', 'about' ] ) {
    const button = new FakeElement('button');
    button.dataset.pane = pane;
    document.register('.tabButton[data-pane]', button);
}
const heading = document.register('section[data-pane="settings"] #autoUpdate h3', new FakeElement('h3', {
    scrolls: [],
    focuses: [],
    scrollIntoView(options) { this.scrolls.push(options); },
    focus(options) { this.focuses.push(options); },
}));
// The page starts hidden until Settings rendered.
document.body.classList.add('loading');
const fireMutations = ( ) => {
    for ( const observer of [ ...document.mutationObservers ] ) { observer.callback([]); }
};
const extension = createExtension();
const staged = await stageModules({
    modules: [ 'dashboard.js' ],
    document,
    extension,
    location: 'chrome-extension://test/dashboard.html#settings/autoUpdate',
});
const hashChange = hash => {
    location.hash = hash;
    for ( const { type, callback } of document.windowListeners ) {
        if ( type === 'hashchange' ) { callback(); }
    }
};

try {
    await staged.load('dashboard.js');
    await settle(10);
    assert.equal(document.body.dataset.pane, 'settings');
    assert.deepEqual(heading.scrolls, [], 'A hidden page is not scrolled');
    assert.deepEqual(heading.focuses, [], 'nor its heading focused');
    assert.equal(document.mutationObservers.length, 1);
    assert.equal(document.mutationObservers[0].target, document.body);
    fireMutations();
    assert.deepEqual(heading.focuses, [], 'while it stays hidden');
    document.body.classList.remove('loading');
    fireMutations();
    assert.equal(heading.getAttribute('tabindex'), '-1');
    assert.deepEqual(heading.scrolls, [ { block: 'start' } ], 'The Updates section is scrolled into view once shown');
    assert.deepEqual(heading.focuses, [ { preventScroll: true } ], 'and its heading is focused');
    assert.equal(document.mutationObservers.length, 0, 'The observer is released');

    hashChange('#filters');
    assert.equal(document.body.dataset.pane, 'filters', 'Plain pane hashes keep working');
    assert.equal(heading.scrolls.length, 1);
    hashChange('#settings/unknownSection');
    assert.equal(document.body.dataset.pane, 'settings', 'An unknown section still selects its pane');
    hashChange('#about/autoUpdate"],x');
    assert.equal(document.body.dataset.pane, 'about', 'A malformed section name is ignored');
    assert.equal(heading.scrolls.length, 1);
    hashChange('#settings/autoUpdate');
    assert.equal(heading.focuses.length, 2);

    // Another pane selected while the page is still hidden cancels the
    // pending section reveal.
    document.body.classList.add('loading');
    hashChange('#settings/autoUpdate');
    assert.equal(document.mutationObservers.length, 1);
    hashChange('#filters');
    assert.equal(document.mutationObservers.length, 0, 'A later pane cancels the pending reveal');
    document.body.classList.remove('loading');
    fireMutations();
    assert.equal(heading.focuses.length, 2);

    document.body.dataset.pane = 'about';
    document.body.dataset.forbid = 'dashboard';
    hashChange('#settings/autoUpdate');
    assert.equal(document.body.dataset.pane, 'about', 'A locked pane stays locked');
    assert.equal(heading.focuses.length, 2);
} finally {
    await staged.cleanup();
}

console.log('Dashboard section links: #pane/section selects the pane and focuses the section heading.');
