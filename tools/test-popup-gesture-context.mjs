/*******************************************************************************

    uBlock Plus+ - trusted popup gesture and form navigation regressions
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

import assert from 'node:assert/strict';
import { createPopupBlocker } from '../platform/mv3/extension/js/popup-blocker.js';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL(
    '../platform/mv3/extension/js/scripting/popup-context.js', import.meta.url
), 'utf8');
let checks = 0;
const equal = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    checks += 1;
};

function collector() {
    const listeners = new Map();
    const tasks = [];
    let onMessage;
    let timestamp = 1000;
    vm.runInNewContext(source, {
        Date: { now: ( ) => timestamp },
        URL,
        URLSearchParams,
        setTimeout: callback => tasks.push(callback),
        self: {
            chrome: { runtime: { onMessage: {
                addListener(listener) { onMessage = listener; },
            } } },
            addEventListener(type, listener) { listeners.set(type, listener); },
        },
    });
    return {
        advance(ms) { timestamp += ms; },
        emit(type, event = {}) {
            listeners.get(type)?.({ type, isTrusted: true, ...event });
        },
        flush() {
            while ( tasks.length !== 0 ) { tasks.shift()(); }
        },
        context() {
            let response;
            onMessage({ what: 'getPopupGestureContext' }, {}, value => {
                response = structuredClone(value);
            });
            return response;
        },
        time() { return timestamp; },
    };
}

const anchor = { localName: 'a', href: 'https://target.example/open' };
const click = (state, target = anchor, options = {}) => {
    state.emit('pointerdown', { target, button: 0, ...options });
    state.emit('click', { target, detail: 1, ...options });
};

{
    const state = collector();
    equal(state.context(), { at: 0, sequence: 0, targetURL: '' });
    click(state);
    const first = state.context();
    equal(first.sequence, 1, 'pointerdown/click is one activation');
    state.advance(200);
    click(state);
    equal(state.context().sequence, 2,
        'Distinct rapid clicks must not share one consumed activation');
    equal(state.context().at, 1200);
    equal(state.context().targetURL, anchor.href);
    state.advance(20);
    state.emit('pointerdown', { target: anchor, button: 1 });
    state.emit('auxclick', { target: anchor, button: 1, detail: 1 });
    equal(state.context().sequence, 3, 'Middle click is one activation');
    state.advance(20);
    state.emit('pointerdown', { target: anchor, button: 2 });
    state.emit('auxclick', { target: anchor, button: 2, detail: 1 });
    equal(state.context().sequence, 4,
        'Context-menu Open Link retains one physical link activation');
    click(state, anchor, { isTrusted: false });
    state.emit('keydown', { target: anchor, key: 'Enter', isTrusted: false });
    equal(state.context().sequence, 4, 'Page-created events cannot grant intent');
}

for ( const key of [ 'Enter', ' ' ] ) {
    const state = collector();
    state.emit('keydown', { target: anchor, key });
    state.emit('keydown', { target: anchor, key, repeat: true });
    state.emit('click', { target: anchor, detail: 0 });
    equal(state.context().sequence, 1, `${key}: keydown/click is one activation`);
    state.advance(50);
    state.emit('keydown', { target: anchor, key });
    state.emit('click', { target: anchor, detail: 0 });
    equal(state.context().sequence, 2, `${key}: repeated physical press is distinct`);
    state.emit('keydown', { target: anchor, key: 'a' });
    equal(state.context().sequence, 2, 'Ordinary typing does not grant popup intent');
}

{
    const state = collector();
    state.emit('click', { target: anchor, detail: 0 });
    equal(state.context().sequence, 1, 'Trusted accessibility click is supported');
    state.emit('click', {
        target: { localName: 'span' }, detail: 0,
        composedPath: ( ) => [ { localName: 'span' }, anchor ],
    });
    equal(state.context().targetURL, anchor.href, 'Shadow/event path retains link intent');
    state.emit('click', {
        target: { localName: 'a', href: `https://target.example/${'x'.repeat(8192)}` },
        detail: 0,
    });
    equal(state.context().targetURL, '', 'Oversized URL cannot become a truncated exact match');
    state.emit('click', {
        target: { localName: 'a', href: { baseVal: anchor.href } }, detail: 0,
    });
    equal(state.context().targetURL, '', 'SVG/non-string href fails open');
}

function formFixture(method = 'get') {
    const form = {
        localName: 'form', method,
        action: 'https://default.example/search?obsolete=1#results',
        acceptCharset: '', ownerDocument: { characterSet: 'UTF-8' },
    };
    const attributes = new Set();
    const submitter = {
        localName: 'button', type: 'submit', form,
        formAction: 'https://override.example/search?old=1#results',
        formMethod: method,
        hasAttribute: name => attributes.has(name),
    };
    return { form, submitter, attributes };
}

function submit(state, fixture, entries = []) {
    state.emit('submit', { target: fixture.form, submitter: fixture.submitter });
    state.emit('formdata', { target: fixture.form, formData: entries });
    state.flush();
}

{
    const state = collector();
    const fixture = formFixture('post');
    fixture.attributes.add('formaction');
    click(state, fixture.submitter);
    equal(state.context().targetURL, fixture.submitter.formAction,
        'Actual submitter formaction overrides form action');
    submit(state, fixture, [ [ 'private-body', 'never-recorded' ] ]);
    equal(state.context().targetURL, fixture.submitter.formAction,
        'POST preserves action query without retaining form body');
    equal(state.context().sequence, 1, 'Submit/formdata do not create another activation');
}

{
    const state = collector();
    const fixture = formFixture();
    fixture.attributes.add('formaction');
    click(state, fixture.submitter);
    equal(state.context().targetURL, '', 'GET waits for browser entry list');
    state.emit('submit', { target: fixture.form, submitter: fixture.submitter });
    const entries = [ [ 'q', 'two words' ], [ 'submit', 'Find' ] ];
    state.emit('formdata', { target: fixture.form, formData: entries });
    entries.push([ 'page-added', 'yes' ]);
    fixture.submitter.formAction = 'https://changed-after-entry-list.example/';
    state.flush();
    equal(state.context().targetURL,
        'https://override.example/search?q=two+words&submit=Find&page-added=yes#results',
        'GET replaces action query and uses actual submitter/page-provided entries');
    equal(state.context().targetURL.includes('changed-after-entry-list'), false,
        'Formdata action mutation cannot invent a different trusted target');
    equal(state.context().sequence, 1);
    const before = state.context();
    state.emit('formdata', { target: fixture.form, formData: [ [ 'forged', 'yes' ] ] });
    state.flush();
    equal(state.context(), before, 'Unpaired FormData event cannot revise navigation');
}

{
    const state = collector();
    const fixture = formFixture('post');
    fixture.attributes.add('formmethod');
    fixture.submitter.formMethod = 'get';
    click(state, fixture.submitter);
    submit(state, fixture, [ [ 'line\nname', 'first\rsecond\nthird\r\nfourth' ],
        [ 'upload', { name: 'report.txt' } ] ]);
    equal(state.context().targetURL,
        'https://default.example/search?line%0D%0Aname=first%0D%0Asecond%0D%0Athird%0D%0Afourth&upload=report.txt#results',
        'GET normalizes newlines and files to names with submitter method override');
}

for ( const scenario of [ 'synthetic', 'programmatic', 'expired', 'wrong-form',
    'oversized', 'too-many', 'legacy-encoding', 'new-gesture', 'unsupported-method' ] ) {
    const state = collector();
    const fixture = formFixture();
    if ( scenario !== 'programmatic' ) { click(state, fixture.submitter); }
    if ( scenario === 'expired' ) { state.advance(5_001); }
    if ( scenario === 'legacy-encoding' ) {
        fixture.form.ownerDocument.characterSet = 'windows-1252';
    }
    if ( scenario === 'unsupported-method' ) { fixture.form.method = 'dialog'; }
    const entries = scenario === 'oversized' ? [ [ 'q', 'x'.repeat(8193) ] ]
        : scenario === 'too-many' ? Array.from({ length: 257 }, ( ) => [ 'q', 'x' ])
            : [ [ 'q', 'search' ] ];
    state.emit('submit', {
        target: fixture.form, submitter: fixture.submitter,
        isTrusted: scenario !== 'synthetic',
    });
    state.emit('formdata', {
        target: scenario === 'wrong-form' ? formFixture().form : fixture.form,
        formData: entries,
    });
    if ( scenario === 'new-gesture' ) { click(state, anchor); }
    state.flush();
    equal(state.context().targetURL, scenario === 'new-gesture' ? anchor.href : '',
        `${scenario}: no guessed or stale exact form navigation`);
    equal(state.context().sequence, scenario === 'programmatic' ? 0
        : scenario === 'new-gesture' ? 2 : 1, `${scenario}: no manufactured activation`);
}

{
    const state = collector();
    const fixture = formFixture('post');
    click(state, { localName: 'input', type: 'text', form: fixture.form });
    equal(state.context().targetURL, '',
        'Clicking a non-submit control does not authorize the form destination');
}

// Exercise the consumed-gesture boundary with the actual observer, so this
// regression cannot pass merely by changing a collector counter convention.
{
    const state = collector();
    const removed = [];
    const opener = { id: 1, url: 'https://source.example/' };
    const tabs = new Map([ [ 1, opener ] ]);
    const blocker = createPopupBlocker({
        tabs: {
            async get(id) { return tabs.get(id); },
            async remove(id) { removed.push(id); },
        },
        now: ( ) => state.time(),
        getFilteringMode: async ( ) => 3,
        getGestureContexts: async ( ) => [ { ...state.context(), frameId: 0 } ],
        getSourceContext: async ( ) => ({
            topURL: opener.url, topContextComplete: true,
            initiatorURL: opener.url, initiatorContextComplete: true,
        }),
    });
    const open = async id => {
        tabs.set(id, { id, openerTabId: 1, url: anchor.href });
        return blocker.onNavigationTarget({
            tabId: id, sourceTabId: 1, sourceFrameId: 0, url: anchor.href,
        });
    };
    state.emit('pointerdown', { target: anchor, button: 0 });
    equal((await open(2)).action, 'allow');
    state.emit('click', { target: anchor, detail: 1 });
    equal((await open(3)).action, 'blocked',
        'Pointerdown/click cannot authorize two windows from one activation');
    state.advance(200);
    click(state);
    equal((await open(4)).action, 'allow',
        'A distinct rapid click authorizes its own window');
    equal(removed, [ 3 ], 'Only the extra window from the reused activation is removed');
}

console.log(`Popup gesture context tests passed (${checks} checks).`);
