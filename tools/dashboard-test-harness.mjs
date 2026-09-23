/*******************************************************************************

    uBlock Plus+ - minimal DOM and extension stubs for dashboard page modules
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    Page modules import dom.js, i18n.js and punycode.js, which source
    checkouts only receive at build time. This loads the production modules
    under test from a temporary copy in which those, and the extension APIs,
    are replaced by small deterministic stubs. Elements are registered by the
    exact selector the production code queries; no layout is emulated.

*/

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const extensionJS = path.join(root, 'platform/mv3/extension/js');

/******************************************************************************/

export class FakeElement {
    constructor(tagName = 'div', props = {}) {
        this.tagName = tagName.toUpperCase();
        this.dataset = {};
        this.attributes = new Map();
        this.classes = new Set();
        this.children = [];
        this.queries = new Map();
        this.ancestors = new Map();
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.clicks = 0;
        Object.assign(this, props);
        const classes = this.classes;
        this.classList = {
            add: (...names) => { for ( const name of names ) { classes.add(name); } },
            remove: (...names) => { for ( const name of names ) { classes.delete(name); } },
            toggle: (name, state) => {
                const on = state ?? classes.has(name) === false;
                if ( on ) { classes.add(name); } else { classes.delete(name); }
                return on;
            },
            contains: name => classes.has(name),
        };
    }
    get options() { return this.children; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes.set(name, `${value}`); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    // Descendant lookups and closest() answers are registered per test.
    register(selector, element) {
        const list = this.queries.get(selector) || [];
        list.push(element);
        this.queries.set(selector, list);
        return element;
    }
    querySelector(selector) { return this.queries.get(selector)?.[0] ?? null; }
    querySelectorAll(selector) { return this.queries.get(selector) || []; }
    closest(selector) { return this.ancestors.get(selector) ?? null; }
    matches(selector) { return this.ancestors.get(selector) === this; }
    click() { this.clicks += 1; this.onclick?.(); }
    remove() { this.removed = true; }
}

export class FakeDocument {
    constructor() {
        this.body = new FakeElement('body');
        this.html = new FakeElement('html');
        this.elements = new Map();
        this.computed = new Map();
        this.handlers = [];
        this.firstShown = [];
    }
    register(selector, element = new FakeElement()) {
        const list = this.elements.get(selector) || [];
        list.push(element);
        this.elements.set(selector, list);
        return element;
    }
    // Registers a selector whose matches depend on element state, such as
    // ':checked', and are computed at query time.
    define(selector, resolve) { this.computed.set(selector, resolve); }
    one(selector) { return this.all(selector)[0] ?? null; }
    all(selector) {
        const resolve = this.computed.get(selector);
        if ( resolve !== undefined ) { return resolve(); }
        return this.elements.get(selector) || [];
    }
    querySelector(selector) { return this.one(selector); }
    querySelectorAll(selector) { return this.all(selector); }
    createElement(tagName) { return new FakeElement(tagName); }
    // Runs every handler registered for an exact target, event type and
    // delegated subtarget selector; resolves after all of them settle.
    async trigger(target, type, event = {}, subtarget) {
        const matches = this.handlers.filter(entry =>
            entry.target === target && entry.type === type &&
            entry.subtarget === subtarget
        );
        if ( matches.length === 0 ) {
            throw new Error(`No ${type} handler for ${target} ${subtarget ?? ''}`);
        }
        return Promise.all(matches.map(entry => entry.callback(event)));
    }
}

/******************************************************************************/

const domStub = `
const doc = globalThis.dashboardTestDocument;
const targets = target => {
    if ( typeof target === 'string' ) { return doc.all(target); }
    if ( target === null || target === undefined ) { return []; }
    if ( Array.isArray(target) ) { return target; }
    return [ target ];
};
export const qs$ = (a, b) => typeof a === 'string'
    ? doc.one(a)
    : a === null ? null : a.querySelector(b);
export const qsa$ = (a, b) => typeof a === 'string'
    ? doc.all(a)
    : a === null ? [] : a.querySelectorAll(b);
export const dom = {
    body: doc.body,
    html: doc.html,
    root: doc.html,
    attr(target, name, value) {
        for ( const elem of targets(target) ) {
            if ( value === undefined ) { return elem.getAttribute(name); }
            if ( value === null ) { elem.removeAttribute(name); }
            else { elem.setAttribute(name, value); }
        }
    },
    prop(target, name, value) {
        for ( const elem of targets(target) ) {
            if ( value === undefined ) { return elem[name]; }
            elem[name] = value;
        }
    },
    text(target, text) {
        const elems = targets(target);
        if ( text === undefined ) { return elems[0]?.textContent; }
        for ( const elem of elems ) { elem.textContent = text; }
    },
    create(tagName) { return doc.createElement(tagName); },
    remove(target) { for ( const elem of targets(target) ) { elem.remove(); } },
    on(target, type, subtarget, callback) {
        if ( typeof subtarget === 'function' ) {
            callback = subtarget;
            subtarget = undefined;
        }
        doc.handlers.push({ target, type, subtarget, callback });
    },
    onFirstShown(fn) { doc.firstShown.push(fn); },
    cl: {
        add(target, name) { for ( const elem of targets(target) ) { elem.classList.add(name); } },
        remove(target, ...names) { for ( const elem of targets(target) ) { elem.classList.remove(...names); } },
        toggle(target, name, state) {
            let result;
            for ( const elem of targets(target) ) { result = elem.classList.toggle(name, state); }
            return result;
        },
        has(target, name) { return targets(target).some(elem => elem.classList.contains(name)); },
    },
};
`;

const extStub = `
const ext = globalThis.dashboardTestExtension;
export const browser = ext.browser;
export const runtime = ext.browser.runtime;
export const i18n = ext.browser.i18n;
export const webextFlavor = 'chromium';
export const sendMessage = request => ext.sendMessage(request);
export const localRead = async key => ext.storage.get(key);
export const localWrite = async (key, value) => ext.storage.set(key, value);
export const localRemove = async key => ext.storage.remove(key);
`;

const i18nStub = `
const ext = globalThis.dashboardTestExtension;
export const i18n = { render() {}, getMessage: (...args) => ext.browser.i18n.getMessage(...args) };
export const i18n$ = (...args) => ext.browser.i18n.getMessage(...args);
`;

/******************************************************************************/

// A localized-string stub which makes the key and substitutions observable.
export function testMessage(key, substitutions) {
    if ( substitutions === undefined ) { return `[${key}]`; }
    const values = Array.isArray(substitutions) ? substitutions : [ substitutions ];
    return `[${key}:${values.join('|')}]`;
}

export function createExtension(options = {}) {
    const messages = [];
    const storageValues = new Map(Object.entries(options.storage || {}));
    const storageListeners = [];
    const channels = [];
    const extension = {
        messages,
        channels,
        storageValues,
        dispatch: options.dispatch || (( ) => undefined),
        async sendMessage(request) {
            messages.push(structuredClone(request));
            return extension.dispatch(request);
        },
        storage: {
            get: key => structuredClone(storageValues.get(key)),
            set(key, value) {
                const oldValue = storageValues.get(key);
                storageValues.set(key, structuredClone(value));
                extension.emitStorageChange({ [key]: { oldValue, newValue: value } });
            },
            remove(key) {
                const oldValue = storageValues.get(key);
                storageValues.delete(key);
                extension.emitStorageChange({ [key]: { oldValue } });
            },
        },
        emitStorageChange(changes) {
            for ( const listener of storageListeners ) {
                listener(structuredClone(changes), 'local');
            }
        },
        broadcast(data) {
            for ( const channel of channels ) { channel.onmessage?.({ data }); }
        },
        browser: {
            i18n: {
                getMessage: options.getMessage || testMessage,
                getUILanguage: ( ) => 'en',
            },
            permissions: {
                request: options.requestPermissions || (async ( ) => true),
                contains: async ( ) => false,
                onAdded: { addListener() {} },
                onRemoved: { addListener() {} },
            },
            runtime: {
                getManifest: ( ) => ({ name: 'uBlock Plus+', version: '1.0.0' }),
            },
            storage: {
                local: {
                    onChanged: {
                        addListener: listener => storageListeners.push(listener),
                    },
                },
                onChanged: {
                    addListener: listener => storageListeners.push(listener),
                    removeListener() {},
                },
            },
        },
    };
    return extension;
}

/******************************************************************************/

// Copies production modules to a temporary directory next to the stubs and
// returns an import function for them. `stubs` maps extra module names to
// source text replacing the production module.
export async function stageModules({
    modules, stubs = {}, document, extension,
    location = 'chrome-extension://test/dashboard.html',
}) {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-dashboard-ui-'));
    globalThis.self = globalThis;
    globalThis.window = globalThis;
    globalThis.dashboardTestDocument = document;
    globalThis.dashboardTestExtension = extension;
    globalThis.document = document;
    globalThis.location = new URL(location);
    globalThis.BroadcastChannel = class {
        constructor(name) {
            this.name = name;
            extension.channels.push(this);
        }
        postMessage() {}
        close() {}
    };
    // Observers are listed on the document so that a test can fire them.
    document.mutationObservers ??= [];
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target, options) {
            this.target = target;
            this.options = options;
            document.mutationObservers.push(this);
        }
        disconnect() {
            const at = document.mutationObservers.indexOf(this);
            if ( at !== -1 ) { document.mutationObservers.splice(at, 1); }
        }
    };
    globalThis.IntersectionObserver = class {
        observe() {}
        disconnect() {}
    };
    document.windowListeners ??= [];
    globalThis.addEventListener = (type, callback) => {
        document.windowListeners.push({ type, callback });
    };
    const files = {
        'package.json': '{"type":"module"}',
        'dom.js': domStub,
        'ext.js': extStub,
        'i18n.js': i18nStub,
        'fa-icons.js': 'export const faIconsInit = ( ) => {};',
        ...stubs,
    };
    await Promise.all([
        ...modules.map(name => fs.copyFile(
            path.join(extensionJS, name),
            path.join(staging, name)
        )),
        fs.copyFile(
            path.join(root, 'src/lib/punycode.js'),
            path.join(staging, 'punycode.js')
        ),
        ...Object.entries(files).map(([ name, text ]) =>
            fs.writeFile(path.join(staging, name), text)
        ),
    ]);
    return {
        staging,
        load: name => import(pathToFileURL(path.join(staging, name)).href),
        cleanup: ( ) => fs.rm(staging, { recursive: true, force: true }),
    };
}

// Lets queued promise callbacks and short timers run.
export function settle(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/******************************************************************************/
