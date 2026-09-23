/* uBlock Plus+ — firewall editor and logger page UI regressions. GPL-3.0-or-later. */
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loggerUIText } from '../platform/mv3/extension/js/logger-ui-text.js';
import { setImmediate as turn } from 'node:timers/promises';

const root = new URL('../platform/mv3/extension/', import.meta.url);
const priorityLocales = [ 'en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'vi', 'zh_CN', 'zh_TW' ];
const catalogs = new Map();
for ( const locale of priorityLocales ) {
    const messages = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, root), 'utf8'));
    catalogs.set(locale, messages);
}
const requested = new Set();
const getMessage = (locale = 'en') => (key, substitutions) => {
    requested.add(key);
    const message = catalogs.get(locale)[key]?.message;
    assert.equal(typeof message, 'string', `${locale}: missing message ${key}`);
    return message.replace(/\$(\d)/g, (_, n) => {
        assert.ok(substitutions?.[n - 1] !== undefined, `${key}: missing substitution $${n}`);
        return substitutions[n - 1];
    });
};
const flush = async ( ) => { for ( let i = 0; i < 6; i++ ) { await turn(); } };

// Minimal DOM: enough structure for the two module pages under test.
class FakeNode {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parent = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this.dataset = {};
        this.options = [];
        this.writes = 0;
        this.text = '';
        this.value = '';
    }
    get textContent() { return this.text; }
    set textContent(value) { this.text = String(value); this.writes += 1; }
    append(...nodes) {
        for ( const node of nodes ) {
            if ( typeof node === 'string' ) { continue; }
            const list = node instanceof FakeFragment ? node.children.splice(0) : [ node ];
            for ( const child of list ) { child.parent = this; this.children.push(child); }
        }
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    addEventListener(type, listener) {
        if ( this.listeners.has(type) === false ) { this.listeners.set(type, []); }
        this.listeners.get(type).push(listener);
    }
    dispatch(type) { for ( const listener of this.listeners.get(type) ?? [] ) { listener({ type, target: this }); } }
    click() { this.dispatch('click'); }
    contains(node) {
        for ( let current = node; current; current = current.parent ) {
            if ( current === this ) { return true; }
        }
        return false;
    }
    find(predicate) {
        if ( predicate(this) ) { return this; }
        for ( const child of this.children ) {
            const found = child.find(predicate);
            if ( found ) { return found; }
        }
    }
}
class FakeFragment extends FakeNode {}
globalThis.self = globalThis;
globalThis.DocumentFragment = FakeFragment;
const messages = [];
let respond = async ( ) => ({});
globalThis.chrome = {
    runtime: {
        getURL: path => `chrome-extension://fixture/${path}`,
        sendMessage: async message => { messages.push(message); return respond(message); },
    },
    i18n: { getMessage: getMessage('en'), getUILanguage: ( ) => 'en' },
};

// Dynamic firewall panel ------------------------------------------------------
const siteRules = new FakeNode('section');
globalThis.document = {
    createElement: tag => new FakeNode(tag),
    querySelector: selector => {
        assert.equal(selector, 'section[data-pane="siteRules"]');
        return siteRules;
    },
};
respond = async message => message.what === 'getFirewallState' ? {
    supported: true, sessionText: '* * 3p-script block', permanentText: '',
    ruleCount: 7, learnedDomains: 5, deferredCells: 0, omittedDomains: 2,
    scopeError: 'native quota rejection', temporary: true, error: '',
} : {};
await import('../platform/mv3/extension/js/firewall-ui.js');
await flush();
const panel = siteRules.children[0];
const status = panel.find(node => node.id === 'firewallStatus');
assert.equal(panel.children[0].textContent, 'Dynamic firewall');
assert.equal(status.textContent, [
    '7 active Chrome rules; 5 domains recognized this session.',
    'Chrome’s rule limit was reached: 1p/3p cells now apply only on the 5 most recently recognized domains.',
    'A newly visited domain could not be added to the 1p/3p scope: native quota rejection',
    'Temporary rules active.',
].join(' '), 'Reduced native party scope is visible in the editor');
const fileInput = panel.find(node => node.tagName === 'INPUT' && node.type === 'file');
for ( const [ file, error ] of [
    [ { size: 200000, text: async ( ) => '' }, 'Maximum file size: 128 KiB' ],
    [ { size: 20, text: async ( ) => 'bad line' }, 'Line 1: Expected: source destination type action' ],
] ) {
    respond = async ( ) => ({ __ublockPlusError: error });
    fileInput.files = [ file ];
    fileInput.value = 'C:\\fakepath\\firewall.txt';
    fileInput.dispatch('change');
    await flush();
    assert.equal(status.textContent, error);
    assert.equal(fileInput.value, '', 'A failed import still lets the same corrected file be chosen again');
}
respond = async ( ) => ({ ruleCount: 3, deferredCells: 1, omittedDomains: 4 });
fileInput.files = [ { size: 30, text: async ( ) => '* * 3p block' } ];
fileInput.value = 'C:\\fakepath\\firewall.txt';
fileInput.dispatch('change');
await flush();
assert.equal(panel.find(node => node.id === 'firewallRules').value, '* * 3p block');
assert.equal(fileInput.value, '');
panel.find(node => node.id === 'firewallValidate').click();
await flush();
assert.equal(status.textContent, 'Validated: 3 proposed Chrome rules. ' +
    '1 cells need page context; no speculative blocking. ' +
    '4 recognized domains would leave the 1p/3p scope to fit Chrome’s rule limit.');
respond = async ( ) => ({ permanentText: '* * * block' });
panel.find(node => node.id === 'firewallRevert').click();
await flush();
assert.equal(status.textContent, 'Permanent rules loaded into the draft; apply to activate.');
const testResult = panel.find(node => node.id === 'firewallTestResult');
for ( const action of [ 'block', 'allow', 'noop', 'no-match', 'off', 'unknown' ] ) {
    respond = async ( ) => ({ action, source: 'example.com', destination: 'ads.net',
        thirdParty: action === 'unknown' ? null : action !== 'allow', rule: null });
    panel.find(node => node.id === 'firewallTestRequest').click();
    await flush();
    assert.ok(testResult.textContent.split('\n')[0].length > 0, `Outcome ${action} is localized`);
}
assert.match(testResult.textContent, /^Mode or domain context is unavailable/);

// Logger page -----------------------------------------------------------------
const html = await readFile(new URL('matched-rules.html', root), 'utf8');
assert.match(html, /<p id="status" role="status" aria-live="polite">/);
assert.match(html, /<p id="counters">/, 'Counters live outside the announced status');
assert.doesNotMatch(html.match(/<p id="counters"[^>]*>/)[0], /aria-live|role=/);
const nodes = new Map();
const node = selector => {
    if ( nodes.has(selector) === false ) { nodes.set(selector, new FakeNode()); }
    return nodes.get(selector);
};
node('#kind').options = [ '', 'network', 'dnr', 'cosmetic', 'dom', 'scriptlet', 'system' ]
    .map(value => Object.assign(new FakeNode('option'), { value }));
const headers = Array.from({ length: 4 }, ( ) => new FakeNode('th'));
const details = Array.from({ length: 6 }, ( ) => new FakeNode('p'));
let selection = null;
const pageListeners = new Map();
globalThis.document = {
    documentElement: {},
    createElement: tag => new FakeNode(tag),
    querySelector: selector => node(selector),
    querySelectorAll: selector => selector === 'thead th' ? headers : details,
    getSelection: ( ) => selection,
};
globalThis.location = { href: 'chrome-extension://fixture/matched-rules.html?tab=5' };
globalThis.window = { addEventListener: (type, listener) => { pageListeners.set(type, listener); } };
let port;
chrome.tabs = { query: async ( ) => [] };
chrome.storage = { local: { get: async ( ) => ({}) }, onChanged: { addListener: ( ) => {} } };
chrome.runtime.connect = ( ) => {
    const listeners = { message: [], disconnect: [] };
    port = {
        onMessage: { addListener: listener => listeners.message.push(listener) },
        onDisconnect: { addListener: listener => listeners.disconnect.push(listener) },
        postMessage: ( ) => {}, disconnect: ( ) => {},
        emit: message => { for ( const listener of listeners.message ) { listener(message); } },
    };
    return port;
};
// Chrome in a language without logger strings shows the English fallback,
// so <html lang> must follow the rendered catalog, not the browser UI.
chrome.i18n.getUILanguage = ( ) => 'th';
await import('../platform/mv3/extension/js/matched-rules.js');
assert.equal(document.documentElement.lang, 'en', 'lang names the language actually rendered');
pageListeners.get('pagehide')();
const entry = id => ({ id, time: 0, kind: 'network', phase: 'requested', source: 'browser.webRequest (observation)',
    detail: 'GET', tabId: 5, frameId: 0, url: `https://example.com/${id}`, type: 'script', requestId: '' });
const snapshot = count => ({ capturing: true, tabId: 5, networkEnabled: true, nativeMatchesEnabled: false,
    limit: 512, discarded: 0, entries: Array.from({ length: count }, (_, i) => entry(i + 1)) });
port.emit(snapshot(1));
assert.equal(node('#status').textContent, 'Capturing.');
assert.equal(node('#counters').textContent,
    'Network observation: attached. Native DNR listener: unavailable. 1/512 records; 0 older records discarded.');
const statusWrites = node('#status').writes;
port.emit(snapshot(2));
assert.equal(node('#status').writes, statusWrites, 'Counter updates are not re-announced');
assert.match(node('#counters').textContent, /2\/512 records/);
const table = node('#matchedEntries');
assert.equal(table.children.length, 2);
assert.equal(table.children[0].children[2].textContent, 'browser.webRequest (observation)\ntab 5, frame 0');
const rows = table.children.slice();
selection = { isCollapsed: false, anchorNode: rows[1].children[3] };
port.emit(snapshot(3));
assert.deepEqual(table.children, rows, 'A selection inside the table survives polling');
selection = { isCollapsed: true, anchorNode: null };
port.emit(snapshot(3));
assert.equal(table.children.length, 3, 'Rows catch up once the selection is released');
port.emit({ ...snapshot(3), capturing: false });
assert.equal(node('#status').textContent, 'Paused.');

// Copy comes from the message catalog for every maintained locale.
for ( const locale of priorityLocales ) {
    const labels = loggerUIText(getMessage(locale));
    const strings = Object.values(labels).flatMap(value =>
        typeof value === 'function' ? [ value(true), value(false), value(1, 2, 3) ]
            : typeof value === 'object' ? Object.values(value) : [ value ]);
    for ( const value of strings ) {
        assert.ok(typeof value === 'string' && value.trim() !== '', `${locale}: empty logger label`);
    }
}
const languageTags = {
    en: 'en', de: 'de', es: 'es', fr: 'fr', ja: 'ja', ko: 'ko', ru: 'ru', vi: 'vi',
    zh_CN: 'zh-CN', zh_TW: 'zh-TW',
};
for ( const locale of priorityLocales ) {
    assert.equal(getMessage(locale)('loggerLanguageTag'), languageTags[locale],
        `${locale}: loggerLanguageTag must name the catalog language`);
}
// Other locales fall back to English logger text and to the English tag; a
// catalog which translates the logger must declare its own tag.
for ( const entry of await readdir(new URL('_locales/', root), { withFileTypes: true }) ) {
    if ( entry.isDirectory() === false ) { continue; }
    const messages = JSON.parse(await readFile(new URL(`_locales/${entry.name}/messages.json`, root), 'utf8'));
    if ( messages.loggerTitle === undefined ) { continue; }
    assert.equal(typeof messages.loggerLanguageTag?.message, 'string',
        `${entry.name}: translated logger strings need loggerLanguageTag`);
}
assert.equal(loggerUIText(getMessage('vi')).start, 'Bắt đầu');
assert.equal(loggerUIText(getMessage('de')).phases.requested, 'Anfrage gestartet');
assert.equal(loggerUIText(getMessage('vi')).phases.blocked, 'đã chặn');
// Every phase a producer records has translated copy.
const recordedPhases = new Set();
const producers = new URL('js/', root);
for ( const file of await readdir(producers, { recursive: true }) ) {
    if ( file.endsWith('.js') === false ) { continue; }
    const source = await readFile(new URL(file.replace(/\\/g, '/'), producers), 'utf8');
    const patterns = [ /\bkind: '[\w-]+', phase: '([\w-]+)'/g ];
    if ( /(?:^|[\\/])logger\.js$/.test(file) ) { patterns.push(/\bnetwork\('([\w-]+)'\)/g); }
    if ( file.endsWith('logger-content.js') ) { patterns.push(/\breport\('([\w-]+)'/g); }
    for ( const pattern of patterns ) {
        for ( const [ , phase ] of source.matchAll(pattern) ) { recordedPhases.add(phase); }
    }
}
for ( const phase of [ 'requested', 'error', 'matched', 'blocked', 'registered', 'css-selector-present' ] ) {
    assert.ok(recordedPhases.has(phase), `phase scan found ${phase}`);
}
const phaseLabels = loggerUIText(getMessage('en')).phases;
for ( const phase of recordedPhases ) {
    assert.ok(Object.hasOwn(phaseLabels, phase), `logger phase ${phase} has no catalog key`);
}
for ( const key of requested ) {
    for ( const locale of priorityLocales ) { getMessage(locale)(key, [ '1', '2', '3' ]); }
}
const sources = [];
for ( const file of [ 'js/firewall-ui.js', 'js/logger-ui-text.js', 'js/matched-rules.js' ] ) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /startsWith\('vi'\)|Đã|Bắt đầu/, `${file} must not hard-code a UI language`);
    sources.push(source);
}
// Keys the flows above did not render, such as the Chrome 145 notice, must
// exist too. DOM ids share the firewall prefix and are skipped.
const ids = new Set(sources.flatMap(source =>
    Array.from(source.matchAll(/(?:\.id = |button\()'(\w+)'/g), match => match[1])));
for ( const [ , key ] of sources.join('\n').matchAll(/'((?:firewall|logger)[A-Z]\w*)'/g) ) {
    if ( ids.has(key) && requested.has(key) === false ) { continue; }
    for ( const locale of priorityLocales ) { getMessage(locale)(key, [ '1', '2', '3' ]); }
}
console.log(`Firewall editor and logger UI: import reset, quiet live region, selection-safe rows and ${requested.size} catalog keys in ${priorityLocales.length} locales passed.`);
