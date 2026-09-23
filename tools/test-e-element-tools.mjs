/*******************************************************************************

    uBlock Plus+ - element picker/zapper/unpicker and content-script regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import * as cssTree from '../src/lib/csstree/css-tree.js';
import { ExtSelectorCompiler } from '../src/js/static-filtering-parser.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'platform/mv3/extension');
const scripting = path.join(extension, 'js/scripting');

// Content scripts end with `void 0;`: drop it to obtain the IIFE's promise.
async function contentScript(name) {
    const source = await fs.readFile(path.join(scripting, name), 'utf8');
    return source.replace(/\nvoid 0;\s*$/, '');
}

/******************************************************************************/

// https://drafts.csswg.org/cssom/#serialize-an-identifier
function cssEscape(value) {
    const string = String(value);
    let result = '';
    for ( let i = 0; i < string.length; i++ ) {
        const code = string.charCodeAt(i);
        if ( code === 0 ) { result += '\uFFFD'; continue; }
        if (
            (code >= 0x01 && code <= 0x1F) || code === 0x7F ||
            (i === 0 && code >= 0x30 && code <= 0x39) ||
            (i === 1 && code >= 0x30 && code <= 0x39 && string.charCodeAt(0) === 0x2D)
        ) {
            result += `\\${code.toString(16)} `;
            continue;
        }
        if ( i === 0 && string.length === 1 && code === 0x2D ) {
            result += `\\${string.charAt(i)}`;
            continue;
        }
        if (
            code >= 0x80 || code === 0x2D || code === 0x5F ||
            (code >= 0x30 && code <= 0x39) ||
            (code >= 0x41 && code <= 0x5A) ||
            (code >= 0x61 && code <= 0x7A)
        ) {
            result += string.charAt(i);
            continue;
        }
        result += `\\${string.charAt(i)}`;
    }
    return result;
}

/*******************************************************************************
 *
 * tool-overlay.js: hostname and authenticated handshake (content-script side)
 *
 * */

const overlaySource = await contentScript('tool-overlay.js');

function loadOverlay({ origin, baseURI }) {
    const navigations = [];
    const posted = [];
    const frame = {
        setAttribute() { },
        removeAttribute() { },
        remove() { },
        contentWindow: {
            set location(value) { navigations.push(String(value)); },
            postMessage(msg, targetOrigin, ports) {
                posted.push({ msg, targetOrigin, ports });
            },
            focus() { },
        },
    };
    const context = vm.createContext({
        URL,
        crypto: globalThis.crypto,
        origin,
        innerWidth: 800,
        innerHeight: 600,
        document: {
            baseURI,
            documentElement: { append() { } },
            createElement() { return frame; },
        },
        chrome: {
            i18n: { getMessage() { return 'realextensionid'; } },
            runtime: {
                getURL(file) { return `chrome-extension://dynamicid${file}`; },
                async sendMessage() { },
            },
        },
        MessageChannel: class {
            constructor() { this.port1 = {}; this.port2 = {}; }
        },
    });
    context.self = context;
    vm.runInContext(overlaySource, context);
    return { overlay: context.uBlockPlusOverlay, frame, navigations, posted };
}

async function handshake(options) {
    const loaded = loadOverlay(options);
    const installed = loaded.overlay.install('/picker-ui.html', ( ) => { });
    loaded.frame.onload();  // Initial about:blank document
    loaded.frame.onload();  // Extension document
    assert.equal(await installed, true);
    return loaded;
}

{
    const spoofed = await handshake({
        origin: 'https://shop.example',
        baseURI: 'https://www.bank.example/',
    });
    assert.equal(spoofed.overlay.url.hostname, 'shop.example',
        'a page-controlled <base href> must not choose the filter hostname');
    assert.equal(spoofed.navigations.length, 1);
    const secret = new URL(spoofed.navigations[0]).hash.slice(1);
    assert.match(secret, /^[0-9a-z]{28}$/, 'the frame fragment carries a 128-bit secret');
    assert.equal(spoofed.navigations[0], `chrome-extension://dynamicid/picker-ui.html#${secret}`);
    assert.equal(spoofed.posted.length, 1);
    const { msg, ports } = spoofed.posted[0];
    assert.equal(msg.what, 'startOverlay');
    assert.equal(msg.secret, secret, 'the handshake proves knowledge of the fragment');
    assert.equal(new URL(msg.url).hostname, 'shop.example');
    assert.equal(ports.length, 1);

    const other = await handshake({ origin: 'https://shop.example', baseURI: 'https://shop.example/' });
    assert.notEqual(other.posted[0].msg.secret, msg.secret, 'each tool frame has its own secret');

    // Opaque-origin documents keep the previous fallback.
    const opaque = loadOverlay({ origin: 'null', baseURI: 'https://fallback.example/page' });
    assert.equal(opaque.overlay.url.hostname, 'fallback.example');
}

/*******************************************************************************
 *
 * tool-overlay-ui.js: authenticated handshake (extension-frame side)
 *
 * */

const uiSource = (await fs.readFile(path.join(extension, 'js/tool-overlay-ui.js'), 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace('export const toolOverlay', 'const toolOverlay') + '\ntoolOverlay;\n';

function loadOverlayUI(hash) {
    const listeners = new Set();
    const parent = { name: 'parent' };
    const context = vm.createContext({
        URL,
        parent,
        location: { hash },
        addEventListener(type, listener, options) {
            assert.equal(type, 'message');
            assert.equal(options?.once, undefined,
                'an invalid message must not consume the handshake listener');
            listeners.add(listener);
        },
        removeEventListener(type, listener) { listeners.delete(listener); },
        qs$() { return { setAttribute() { } }; },
        dom: {
            body: {},
            root: {},
            cl: { add() { }, has() { return false; }, remove() { } },
            on() { },
            off() { },
        },
        async sendMessage() { },
    });
    context.self = context;
    const toolOverlay = vm.runInContext(uiSource, context);
    const started = [];
    toolOverlay.start(msg => { started.push(msg); });
    const post = (data, source = parent, ports = [ { postMessage() { } } ]) => {
        for ( const listener of Array.from(listeners) ) {
            listener({ data, source, ports });
        }
    };
    return { toolOverlay, listeners, started, post, parent };
}

{
    const secret = 'k3yfr4gment0123456789';
    const ui = loadOverlayUI(`#${secret}`);
    const forgedPort = { postMessage() { } };
    ui.post({ what: 'hello' });
    ui.post({ what: 'startOverlay', url: 'https://www.bank.example/' }, ui.parent, [ forgedPort ]);
    ui.post({ what: 'startOverlay', secret: 'guess', url: 'https://www.bank.example/' });
    ui.post({ what: 'startOverlay', secret, url: 'https://www.bank.example/' }, { name: 'other' });
    ui.post({ what: 'startOverlay', secret, url: 'https://www.bank.example/' }, ui.parent, []);
    assert.equal(ui.toolOverlay.port, null, 'forged handshakes are ignored');
    assert.equal(ui.started.length, 0);
    assert.equal(ui.listeners.size, 1, 'forged handshakes do not consume the listener');

    const port = { postMessage() { } };
    ui.post({ what: 'startOverlay', secret, url: 'https://shop.example/', width: 1, height: 1 },
        ui.parent, [ port ]);
    assert.equal(ui.toolOverlay.port, port, 'the content script handshake is accepted');
    assert.equal(ui.toolOverlay.url.hostname, 'shop.example');
    assert.deepEqual(ui.started.map(msg => msg.what), [ 'startTool' ]);
    assert.equal(ui.listeners.size, 0, 'the listener is removed after a valid handshake');

    const noSecret = loadOverlayUI('');
    noSecret.post({ what: 'startOverlay', secret: '', url: 'https://www.bank.example/' });
    assert.equal(noSecret.toolOverlay.port, null, 'a frame without a secret never accepts');
}

/*******************************************************************************
 *
 * css-user.js: hostname used to inject saved custom filters
 *
 * */

const cssUserSource = await contentScript('css-user.js');

async function injectedHostname({ origin, baseURI }) {
    const sent = [];
    const context = vm.createContext({
        URL,
        origin,
        document: { baseURI },
        chrome: { runtime: { async sendMessage(msg) { sent.push(msg); } } },
    });
    context.self = context;
    await vm.runInContext(cssUserSource, context);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].what, 'injectCustomFilters');
    return sent[0].hostname;
}

assert.equal(await injectedHostname({
    origin: 'https://shop.example', baseURI: 'https://www.bank.example/',
}), 'shop.example', 'custom filters are looked up for the document host, not <base href>');
assert.equal(await injectedHostname({
    origin: 'null', baseURI: 'https://fallback.example/',
}), 'fallback.example');

/*******************************************************************************
 *
 * zapper.js: page-level Delete/Backspace
 *
 * */

{
    class Element { }
    class DocumentFragment { }
    const removed = [];
    const elem = new Element();
    Object.assign(elem, {
        shadowRoot: null,
        parentElement: null,
        remove() { removed.push(this); },
    });
    let onToolMessage;
    const keyListeners = [];
    const context = vm.createContext({
        Element,
        DocumentFragment,
        document: {},
        getComputedStyle() { return { zIndex: 'auto', position: 'static' }; },
        addEventListener(type, listener) { keyListeners.push([ type, listener ]); },
        removeEventListener() { },
        uBlockPlusOverlay: {
            file: '',
            highlightedElements: [ elem ],
            async install(file, onmessage) { onToolMessage = onmessage; return true; },
            elementFromPoint() { return null; },
            highlightElementAtPoint() { },
            highlightElements() { },
        },
    });
    context.self = context.window = context;
    await vm.runInContext(await contentScript('zapper.js'), context);
    onToolMessage({ what: 'startTool' });
    const [ [ type, onKeyPressed ] ] = keyListeners;
    assert.equal(type, 'keydown');
    let canceled = 0;
    const ev = {
        key: 'Delete',
        stopPropagation() { canceled += 1; },
        preventDefault() { canceled += 1; },
    };
    assert.doesNotThrow(( ) => onKeyPressed(ev), 'page-level Delete must not throw');
    assert.equal(canceled, 2);
    assert.deepEqual(removed, [ elem ], 'page-level Delete zaps the highlighted element');
}

/*******************************************************************************
 *
 * picker.js: attribute values in candidate selectors
 *
 * */

{
    const attributes = new Map([
        [ 'data-config', '{"slot":"top","path":"a\\b"}' ],
        [ 'data-x', 'x"],html,[x="' ],
        [ 'data-path', 'C:\\ads\\banner' ],
        [ 'title', 'first line\nsecond line' ],
        [ 'srcset', 'a.png 1x' ],
    ]);
    class HTMLElement { }
    const body = new HTMLElement();
    const elem = new HTMLElement();
    Object.assign(elem, {
        localName: 'div',
        id: '',
        classList: { values() { return [].values(); } },
        getAttributeNames() { return Array.from(attributes.keys()); },
        getAttribute(name) { return attributes.get(name); },
        parentNode: body,
        parentElement: body,
        previousSibling: null,
    });
    let onToolMessage;
    const context = vm.createContext({
        CSS: { escape: cssEscape },
        HTMLElement,
        document: { body },
        ProceduralFiltererAPI: class { reset() { } },
        uBlockPlusOverlay: {
            file: '',
            async install(file, onmessage) { onToolMessage = onmessage; return true; },
            elementFromPoint() { return elem; },
            qsa() { return [ elem ]; },
        },
    });
    context.self = context;
    await vm.runInContext(await contentScript('picker.js'), context);
    const details = onToolMessage({ what: 'candidatesAtPoint', mx: 1, my: 1 });
    const parts = new Map(details.partsDB);
    const attributeParts = Array.from(parts)
        .filter(([ address ]) => (address & 0xF) === 3)
        .map(([ , part ]) => part);
    assert.equal(attributeParts.length, attributes.size);

    const compiler = new ExtSelectorCompiler({ nativeCssHas: true });
    const expected = new Map([
        [ 'data-config', [ '=', attributes.get('data-config') ] ],
        [ 'data-x', [ '=', attributes.get('data-x') ] ],
        [ 'data-path', [ '=', attributes.get('data-path') ] ],
        [ 'title', [ '^=', 'first line' ] ],
        [ 'srcset', [ null, null ] ],
    ]);
    for ( const part of attributeParts ) {
        const selector = `div${part}`;
        assert.equal(compiler.compile(selector, {}), true,
            `the picker dialog accepts ${selector}`);
        const errors = [];
        const ast = cssTree.parse(selector, {
            context: 'selectorList',
            onParseError(error) { errors.push(error); },
        });
        assert.deepEqual(errors, [], `${selector} parses`);
        assert.equal(ast.children.size, 1, `${selector} is a single selector`);
        const found = cssTree.findAll(ast, node => node.type === 'AttributeSelector');
        assert.equal(found.length, 1, `${selector} has one attribute condition`);
        const [ attr ] = found;
        const [ matcher, value ] = expected.get(attr.name.name);
        assert.equal(attr.matcher, matcher, `${selector} operator`);
        assert.equal(attr.value?.value ?? null, value,
            `${selector} matches the original attribute value`);
    }
}

/*******************************************************************************
 *
 * css-procedural-api.js: logger reports
 *
 * */

{
    const nodes = Array.from({ length: 8 }, ( ) => ({
        setAttribute() { },
        removeAttribute() { },
    }));
    let matching = 3;
    let clock = 1_000_000;
    const context = vm.createContext({
        document: { querySelectorAll() { return nodes.slice(0, matching); } },
        MutationObserver: class {
            observe() { }
            disconnect() { }
            takeRecords() { return []; }
        },
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() { },
        cssAPI: { insert() { } },
        chrome: { runtime: { async sendMessage() { } } },
        testClock: ( ) => clock,
    });
    context.self = context;
    // Commits read Date.now(): a fixed clock keeps the cooldown deterministic.
    vm.runInContext('Date.now = testClock;', context);
    vm.runInContext(await contentScript('css-procedural-api.js'), context);
    const reports = [];
    context.ublockPlusLogger = (selector, matches, action) => {
        reports.push([ selector, matches, action ]);
    };
    const api = new context.ProceduralFiltererAPI();
    api.addProcedurals([ { selector: '.ad', raw: 'example.com##.ad:has-text(x)', tasks: [] } ]);
    for ( let i = 0; i < 100; i++ ) {
        api.proceduralFilterer.uBlockPlus_commit();
    }
    assert.deepEqual(reports, [ [ 'example.com##.ad:has-text(x)', 3, undefined ] ],
        'an unchanged match set is reported once, not on every DOM commit');
    matching = 5;
    api.proceduralFilterer.uBlockPlus_commit();
    api.proceduralFilterer.uBlockPlus_commit();
    assert.deepEqual(reports.map(a => a[1]), [ 3, 5 ], 'a changed match count is reported');
    matching = 0;
    api.proceduralFilterer.uBlockPlus_commit();
    matching = 5;
    api.proceduralFilterer.uBlockPlus_commit();
    assert.deepEqual(reports.map(a => a[1]), [ 3, 5, 5 ], 'matches reappearing are reported');
    const restarted = [];
    context.ublockPlusLogger = (selector, matches) => { restarted.push(matches); };
    api.proceduralFilterer.uBlockPlus_commit();
    api.proceduralFilterer.uBlockPlus_commit();
    assert.deepEqual(restarted, [ 5 ], 'a new logger session receives the current state');
    // logger-content.js silently drops reports past 32 per second: a dropped
    // report must come back on a later commit rather than never.
    const accepted = [];
    let dropNext = true;
    context.ublockPlusLogger = (selector, matches) => {
        if ( dropNext ) { dropNext = false; return; }
        accepted.push(matches);
    };
    matching = 4;
    api.proceduralFilterer.uBlockPlus_commit();
    clock += 4999;
    api.proceduralFilterer.uBlockPlus_commit();
    assert.deepEqual(accepted, [], 'an unchanged count is not repeated within the cooldown');
    clock += 1;
    api.proceduralFilterer.uBlockPlus_commit();
    api.proceduralFilterer.uBlockPlus_commit();
    assert.deepEqual(accepted, [ 4 ], 'a dropped report is repeated after the cooldown');
    for ( let i = 0; i < 100; i++ ) {
        clock += 100;
        api.proceduralFilterer.uBlockPlus_commit();
    }
    assert.deepEqual(accepted, [ 4, 4, 4 ],
        'an unchanged count is repeated at most once per cooldown');
    context.ublockPlusLogger = ( ) => { throw new Error('logger failure'); };
    matching = 6;
    assert.doesNotThrow(( ) => api.proceduralFilterer.uBlockPlus_commit());
    context.ublockPlusLogger = undefined;
    assert.doesNotThrow(( ) => api.proceduralFilterer.uBlockPlus_commit());
}

/*******************************************************************************
 *
 * picker-ui.html / unpicker-ui.html: labelled, keyboard-operable close control
 *
 * */

{
    const en = JSON.parse(await fs.readFile(
        path.join(extension, '_locales/en/messages.json'), 'utf8'
    ));
    // New strings are staged for the maintainer's locale merge; once merged,
    // the English catalog alone must provide them.
    const pending = {};
    for ( const [ page, script ] of [
        [ 'picker-ui.html', 'picker-ui.js' ],
        [ 'unpicker-ui.html', 'unpicker-ui.js' ],
        [ 'zapper-ui.html', 'zapper-ui.js' ],
    ] ) {
        const html = await fs.readFile(path.join(extension, page), 'utf8');
        for ( const [ , key ] of html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g) ) {
            assert.ok(en[key] !== undefined || pending[key]?.en !== undefined,
                `${page}: missing message ${key}`);
        }
        const quit = /<div id="quit"[^>]*>/.exec(html)?.[0];
        assert.ok(quit, `${page}: close control`);
        if ( page === 'zapper-ui.html' ) { continue; }
        assert.match(quit, /role="button"/, `${page}: close control role`);
        assert.match(quit, /tabindex="0"/, `${page}: close control is focusable`);
        assert.match(quit, /aria-label="pickerQuit"/, `${page}: close control name`);
        const js = await fs.readFile(path.join(extension, 'js', script), 'utf8');
        assert.match(js, /dom\.on\('#quit', 'keydown'/, `${script}: keyboard activation`);
    }
}

console.log('Element tool checks passed: document hostname, authenticated handshake, ' +
    'zapper keys, escaped picker attributes, procedural logger reports, close control.');
