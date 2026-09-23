/*******************************************************************************

    uBlock Plus+ - My filters pane: rejected storage requests
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    sendMessage() rejects on background failures. A custom-filter request can
    reject after its storage write committed, so the pane must always unlock,
    render from storage and report the failure.

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
const status = document.register('#operationStatus');
const container = document.register(
    'section[data-pane="filters"] .hostnames',
    new FakeElement('ul')
);
document.register('section[data-pane="filters"]', new FakeElement('section'));
document.register('section[data-pane="filters"] aside#sandboxEditor', new FakeElement('aside'));
document.register('#sandboxEditor .cm-container');

// One stored filter: example.com##.ad
const hostnameNode = new FakeElement('li');
hostnameNode.dataset.ugly = 'example.com';
hostnameNode.ancestors.set('li.hostname', hostnameNode);
hostnameNode.ancestors.set('li.hostname[data-ugly]', hostnameNode);
const selectorNode = new FakeElement('li');
selectorNode.dataset.ugly = '.ad';
hostnameNode.register('li.selector.removed:not([data-ugly=""])', selectorNode);
const removeIcon = new FakeElement('span');
removeIcon.ancestors.set('li.selector', selectorNode);
removeIcon.ancestors.set('li.hostname', hostnameNode);

let failWhat;
let sandboxText = 'example.com##.old';
const extension = createExtension({
    dispatch(request) {
        if ( request.what === failWhat ) {
            throw new Error('Compiled filter flush failed');
        }
        switch ( request.what ) {
        case 'getAllCustomFilters':
            // Nothing to re-render in this harness.
            return null;
        case 'getSandboxFilters':
            return sandboxText;
        case 'setSandboxFilters':
            sandboxText = request.text;
            return;
        }
    },
});

const staged = await stageModules({
    modules: [ 'filter-manager-ui.js', 'dashboard.js' ],
    stubs: {
        'filter-editor.js': `
            export class FilterEditor {
                constructor() {
                    this.content = '';
                    this.lastSavedText = '';
                    globalThis.filterEditorTestInstance = this;
                }
                getContent() { return this.content; }
                contentChanged() { return this.content !== this.lastSavedText; }
                async loadContent(text) { this.content = this.lastSavedText = text; }
                async saveContent() { this.lastSavedText = this.content; }
            }
        `,
    },
    document,
    extension,
});

const { error: consoleError } = console;
console.error = ( ) => {};
try {
    await staged.load('filter-manager-ui.js');
    // The pane, then its sandbox editor, start when first shown.
    for ( const start of document.firstShown ) { await start(); }
    await settle(200);

    failWhat = 'removeCustomFilters';
    await document.trigger(container, 'click', { target: removeIcon },
        'section[data-pane="filters"] .remove');
    await settle(250);
    assert.equal(document.body.classes.has('committing'), false,
        'A rejected removal must not leave the pane committing');
    assert.equal(document.body.classes.has('readonly'), false,
        'A rejected removal must not leave the pane read-only');
    assert.equal(status.textContent, '[customFiltersSaveFailed:Compiled filter flush failed]');
    assert.equal(status.dataset.level, 'error');

    const editor = globalThis.filterEditorTestInstance;
    assert.ok(editor, 'The sandbox editor was created');
    assert.equal(editor.content, 'example.com##.old');
    failWhat = 'setSandboxFilters';
    status.textContent = '';
    editor.content = 'example.com##.new';
    await assert.doesNotReject(editor.saveContent(),
        'A rejected sandbox save must not become an unhandled rejection');
    assert.equal(editor.contentChanged(), true, 'The unsaved draft stays available');
    assert.equal(sandboxText, 'example.com##.old');
    assert.equal(status.textContent, '[customFiltersSaveFailed:Compiled filter flush failed]');
    failWhat = undefined;
    await editor.saveContent();
    assert.equal(editor.contentChanged(), false);
    assert.equal(sandboxText, 'example.com##.new');
} finally {
    console.error = consoleError;
    (await staged.load('dashboard.js')).setOperationStatus('');
    await staged.cleanup();
    delete globalThis.filterEditorTestInstance;
}

console.log('Custom filter pane failure tests passed');
