/* uBlock Plus+ — logger privacy, provenance and lifecycle regressions. GPL-3.0-or-later. */
import { exportLoggerEntries, redactLoggerURL } from '../platform/mv3/extension/js/logger-format.js';

import assert from 'node:assert/strict';
import { loggerUIText } from '../platform/mv3/extension/js/logger-ui-text.js';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

const event = ( ) => ({
    listeners: new Set(),
    filters: new Map(),
    addListener(listener, filter) { this.listeners.add(listener); this.filters.set(listener, filter); },
    removeListener(listener) { this.listeners.delete(listener); this.filters.delete(listener); },
    emit(...args) {
        for ( const listener of this.listeners ) {
            const filter = this.filters.get(listener);
            if ( filter?.tabId !== undefined && filter.tabId !== args[0]?.tabId ) { continue; }
            listener(...args);
        }
    },
});
globalThis.self = globalThis;
globalThis.chrome = { runtime: { onConnect: event() }, declarativeNetRequest: {} };
const { LOGGER_LIMIT, createLoggerService } = await import(
    '../platform/mv3/extension/js/logger.js'
);
const flush = async ( ) => { await turn(); await turn(); };
let allowed = false;
let ruleBody = { id: 3, action: { type: 'block' }, condition: { urlFilter: 'before.example' } };
let gate;
let reads = 0;
let peakReads = 0;
const injections = [];
const stops = [];
let staticReads = 0;
const staticRows = Array.from({ length: 140 }, (_, index) => ({
    id: index + 1, action: { type: 'block' },
    condition: { urlFilter: `packaged-${index + 1}.example` },
}));
const api = {
    runtime: {
        id: 'fixture', getURL: path => `chrome-extension://fixture${path}`, onConnect: event(),
        getManifest: ( ) => ({ declarative_net_request: {
            rule_resources: [ { id: 'easylist', path: 'rulesets/main/easylist.json' } ],
        } }),
    },
    permissions: { contains: async ( ) => allowed, onRemoved: event() },
    tabs: {
        get: async id => { if ( id === 404 ) { throw new Error('No such tab'); } return { id }; },
        sendMessage: async (...args) => { stops.push(args); }, onRemoved: event(),
    },
    scripting: { executeScript: async details => { injections.push(details); } },
    webNavigation: { onCommitted: event() },
    webRequest: { onBeforeRequest: event(), onBeforeRedirect: event(), onCompleted: event(), onErrorOccurred: event() },
    declarativeNetRequest: {
        DYNAMIC_RULESET_ID: '_dynamic', SESSION_RULESET_ID: '_session', onRuleMatchedDebug: event(),
        getDynamicRules: async ( ) => {
            reads += 1;
            peakReads = Math.max(peakReads, reads);
            const result = structuredClone([ ruleBody ]);
            if ( gate ) { await gate; }
            reads -= 1;
            return result;
        },
    },
};
const logger = createLoggerService(api, {
    readPackagedRules: async path => {
        assert.equal(path, 'rulesets/main/easylist.json');
        staticReads += 1;
        await turn();
        return staticRows;
    },
});
const connect = (sender = { id: 'fixture', url: api.runtime.getURL('/matched-rules.html?tab=12') }) => {
    const port = {
        name: 'ublock-plus-logger', sender, onMessage: event(), onDisconnect: event(),
        responses: [], disconnected: false,
        postMessage(message) { this.responses.push(structuredClone(message)); },
        disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    };
    api.runtime.onConnect.emit(port);
    return port;
};
const send = async (port, what, tabId = 12) => {
    port.onMessage.emit({ what, tabId });
    await flush();
    return port.responses.at(-1);
};
assert.equal(api.webRequest.onBeforeRequest.listeners.size, 0, 'no observer before explicit capture');
assert.equal(connect({ id: 'fixture', url: 'https://hostile.example/' }).disconnected, true);
assert.equal(connect({ id: 'other-extension', url: api.runtime.getURL('/matched-rules.html') }).disconnected, true);
const first = connect();
assert.equal(first.responses.at(-1).capturing, false, 'opening the logger must not collect');
assert.match((await send(first, 'start', 404)).error, /No such tab/);
let state = await send(first, 'start');
assert.equal(state.capturing, true);
assert.equal(state.networkEnabled, false, 'permission refusal must not prevent other diagnostics');
assert.equal(state.nativeMatchesEnabled, true);
assert.equal(api.webRequest.onBeforeRequest.listeners.size, 0);
assert.deepEqual(injections.at(-1).target, { tabId: 12, allFrames: true });
api.webNavigation.onCommitted.emit({ tabId: 12, frameId: 7 });
await flush();
assert.deepEqual(injections.at(-1).target, { tabId: 12, frameIds: [ 7 ] });
const native = (url = 'https://before.example/') => api.declarativeNetRequest.onRuleMatchedDebug.emit({
    request: { tabId: 12, frameId: 0, url, type: 'script', requestId: 'native-1' },
    rule: { rulesetId: '_dynamic', ruleId: 3 },
});
native();
await flush();
ruleBody.condition.urlFilter = 'after.example';
native('https://after.example/');
await flush();
state = await send(first, 'read');
assert.match(state.entries[0].detail, /before.example/);
assert.match(state.entries[1].detail, /after.example/);
assert.equal(state.entries[0].source, 'browser.onRuleMatchedDebug (native)');
const nativeStock = (ruleId, rulesetId = 'easylist') => api.declarativeNetRequest.onRuleMatchedDebug.emit({
    request: { tabId: 12, frameId: 0, url: 'https://stock.example/', type: 'script' },
    rule: { rulesetId, ruleId },
});
nativeStock(1);
nativeStock(2);
await flush();
state = await send(first, 'read');
assert.match(state.entries.at(-2).detail, /packaged native rule:.*packaged-1.example/);
assert.match(state.entries.at(-1).detail, /packaged native rule:.*packaged-2.example/);
assert.equal(staticReads, 1, 'concurrent static matches share a single packaged read');
nativeStock(1);
nativeStock(3, 'https://untrusted.example/list');
await flush();
state = await send(first, 'read');
assert.equal(staticReads, 1, 'cached summaries and undeclared ruleset IDs never trigger more fetches');
assert.match(state.entries.at(-1).detail, /rule body unavailable/,
    'an unresolvable body still preserves the native event');
for ( let id = 3; id <= 130; id++ ) {
    nativeStock(id);
    await flush();
}
const beforeEviction = staticReads;
nativeStock(1);
await flush();
assert.equal(staticReads, beforeEviction + 1, 'static summaries are bounded to 128 entries');
await send(first, 'stop');
await send(first, 'start');
nativeStock(1);
await flush();
assert.equal(staticReads, beforeEviction + 2, 'stopping the last capture clears packaged lookup caches');
assert.equal(logger.recordContent({ kind: 'dom', detail: 'spoof' }, { id: 'other', tab: { id: 12 } }), false);
assert.equal(logger.recordContent({ kind: 'dnr', detail: 'spoof' }, { id: 'fixture', tab: { id: 12 } }), false,
    'a content diagnostic must never manufacture a native DNR event');
assert.equal(logger.recordContent({ kind: 'dom', phase: 'procedural-applied', detail: 'x'.repeat(20000), tabId: 90 }, {
    id: 'fixture', tab: { id: 12 }, frameId: 9, url: 'https://real-frame.example/',
}), true);
state = await send(first, 'read');
assert.equal(state.entries.at(-1).tabId, 12);
assert.equal(state.entries.at(-1).frameId, 9);
assert.equal(state.entries.at(-1).detail.length, 2048);
assert.equal(state.entries.at(-1).url, 'https://real-frame.example/');
allowed = true;
await send(first, 'stop');
state = await send(first, 'start');
assert.equal(state.networkEnabled, true);
assert.deepEqual([ ...api.webRequest.onBeforeRequest.filters.values() ], [ { urls: [ '<all_urls>' ], tabId: 12 } ],
    'native listener scopes observations to explicitly captured tabs');
api.webRequest.onBeforeRequest.emit({ tabId: 99, url: 'https://not-captured.example/' });
api.webRequest.onCompleted.emit({ tabId: 12, url: 'https://allowed.example/?secret=1', statusCode: 200, fromCache: true });
api.webRequest.onErrorOccurred.emit({ tabId: 12, url: 'https://blocked.example/', error: 'net::ERR_BLOCKED_BY_CLIENT' });
state = await send(first, 'read');
assert.equal(state.entries.some(e => e.url === 'https://not-captured.example/'), false);
assert.equal(state.entries.at(-2).phase, 'completed');
assert.equal(state.entries.at(-1).kind, 'network', 'client errors alone are observations, not native block matches');
assert.equal(state.entries.at(-1).phase, 'error');
api.webRequest.onBeforeRedirect.emit({ tabId: 12, url: 'https://redirect.example/', statusCode: 302, redirectUrl: 'https://target.example/' });
state = await send(first, 'read');
assert.equal(state.entries.at(-1).phase, 'redirected');
assert.match(state.entries.at(-1).detail, /target=https:\/\/target.example/);
for ( let i = 0; i < LOGGER_LIMIT + 40; i++ ) {
    api.webRequest.onBeforeRequest.emit({ tabId: 12, url: `https://bounded.example/${i}` });
}
state = await send(first, 'read');
assert.equal(state.entries.length, LOGGER_LIMIT);
assert.ok(state.discarded >= 40);
assert.equal(state.entries.at(-1).url, `https://bounded.example/${LOGGER_LIMIT + 39}`);
let release;
gate = new Promise(resolve => { release = resolve; });
for ( let i = 0; i < 80; i++ ) { native(); }
await flush();
assert.equal(peakReads, 16, 'native lookup work must also be bounded');
await send(first, 'clear');
release();
gate = undefined;
state = await send(first, 'read');
assert.equal(state.entries.length, 0, 'late lookup must not repopulate cleared history');
const second = connect();
await send(second, 'start', 90);
logger.record({ kind: 'scriptlet', phase: 'registered', source: 'stock', detail: 'count=2' });
logger.record({ kind: 'network', phase: 'requested', tabId: 90, url: 'https://second.example/' });
assert.equal((await send(first, 'read')).entries.some(e => e.url === 'https://second.example/'), false);
first.disconnect();
await flush();
assert.equal(logger.isCapturing(12), false);
assert.equal(logger.isCapturing(90), true);
assert.equal((await send(second, 'read')).entries.some(e => e.url === 'https://second.example/'), true);
assert.equal((await send(second, 'read')).entries.some(e => e.kind === 'scriptlet'), true,
    'closing another captured tab keeps global diagnostics shared with remaining clients');
api.tabs.onRemoved.emit(90);
await flush();
assert.equal(logger.isCapturing(90), false);
assert.equal(api.webRequest.onBeforeRequest.listeners.size, 0, 'closing captured tab detaches observation');
second.disconnect();
await flush();
assert.equal(api.declarativeNetRequest.onRuleMatchedDebug.listeners.size, 0);
assert.equal(api.webNavigation.onCommitted.listeners.size, 0);
assert.ok(stops.some(([ tabId ]) => tabId === 12));
assert.equal((await send(connect(), 'read')).entries.length, 0, 'closing last window erases temporary records');
assert.equal(redactLoggerURL('https://user:password@example.com/path?secret=1#token'), 'https://example.com/path');
assert.equal(redactLoggerURL('data:text/plain,private'), '');
const exported = JSON.stringify(exportLoggerEntries([{
    url: 'https://username:password@example.com/path?token=private#secret',
    detail: 'private filter and session token', requestId: 'private-id',
    kind: 'network', phase: 'requested', source: 'browser.webRequest (observation)',
}]));
assert.equal(/password|username|token|secret|private/.test(exported), false,
    'UI export uses an allowlist and omits free-text fields and request IDs');

const contentCode = await readFile(new URL(
    '../platform/mv3/extension/js/scripting/logger-content.js', import.meta.url
), 'utf8');
const createContent = async capture => {
    const messages = [];
    const queries = [];
    const contentEvents = event();
    const context = {
        self: {},
        chrome: { runtime: {
            onMessage: contentEvents,
            sendMessage: async message => {
                if ( message.what === 'getLoggerCapture' ) { return capture; }
                messages.push(message);
                return true;
            },
        } },
        CSSStyleSheet: class {
            replaceSync(text) {
                if ( text === 'invalid' ) { throw new Error('Invalid stylesheet'); }
                this.cssRules = text.split(',').map(selectorText => ({ selectorText }));
            }
        },
        document: { querySelector: selector => { queries.push(selector); return selector !== '.missing'; } },
    };
    await vm.runInNewContext(contentCode, context);
    return { context, messages, queries, contentEvents };
};
assert.equal((await createContent(false)).context.self.ublockPlusLogger, undefined,
    'content code does no inspection when capture is off');
const content = await createContent(true);
content.contentEvents.emit({ what: 'sampleLoggerCSS', css: '.ad,.missing' });
assert.equal(content.messages.length, 1);
assert.equal(content.messages[0].phase, 'css-selector-present');
assert.match(content.messages[0].detail, /not proof of visibility/);
content.contentEvents.emit({ what: 'sampleLoggerCSS', css: 'invalid' });
assert.equal(content.messages.length, 1, 'invalid CSS does not affect the page or make up matches');
content.context.self.ublockPlusLogger('body:has(.ad)', 3, 'remove');
assert.equal(content.messages[1].phase, 'procedural-applied');
assert.match(content.messages[1].detail, /matched nodes=3; action=remove/);
for ( let i = 0; i < 200; i++ ) { content.context.self.ublockPlusLogger('.ad', 1, 'hide'); }
assert.equal(content.messages.length, 32, 'content diagnostic messages are capped per frame');
content.contentEvents.emit({ what: 'stopLoggerContent' });
assert.equal(content.context.self.ublockPlusLogger, undefined);
assert.equal(content.contentEvents.listeners.size, 0, 'stop removes the isolated observer hook');
const boundedCSS = await createContent(true);
boundedCSS.contentEvents.emit({ what: 'sampleLoggerCSS', css: Array(90).fill('.ad').join(',') });
assert.equal(boundedCSS.queries.length, 32, 'a stylesheet cannot trigger an unbounded selector scan');
const englishUI = loggerUIText('en-US');
const vietnameseUI = loggerUIText('vi-VN');
assert.equal(vietnameseUI.start, 'Bắt đầu');
assert.equal(vietnameseUI.language, 'vi');
assert.deepEqual(Object.keys(vietnameseUI).sort(), Object.keys(englishUI).sort());
assert.deepEqual(Object.keys(vietnameseUI.kinds).sort(), Object.keys(englishUI.kinds).sort());
assert.equal(vietnameseUI.details.length, englishUI.details.length);
assert.equal(vietnameseUI.columns.length, englishUI.columns.length);
assert.equal(loggerUIText('fr').language, 'en', 'other locales retain readable English fallback');
console.log('Unified logger provenance, opt-in permission, bounds, tab isolation, cleanup and redaction passed.');
