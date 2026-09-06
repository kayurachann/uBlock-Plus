/* uBlock Plus+ — opt-in, local MV3 diagnostics. GPL-3.0-or-later. */

import { webext } from './ext-compat.js';

export const LOGGER_LIMIT = 512;
const MAX_CLIENTS = 4;
const MAX_DETAIL = 2048;
const MAX_PENDING_LOOKUPS = 16;
const MAX_STATIC_SUMMARIES = 128;
const kinds = new Set([ 'network', 'dnr', 'cosmetic', 'dom', 'scriptlet', 'system' ]);
const clip = (value, limit = MAX_DETAIL) => typeof value === 'string'
    ? value.slice(0, limit) : '';

export function createLoggerService(api, options = {}) {
    const clients = new Map();
    const records = [];
    const bindings = [];
    const staticSummaries = new Map();
    const staticLoads = new Map();
    let sequence = 0;
    let generation = 0;
    let discarded = 0;
    let pendingLookups = 0;
    let networkEnabled = false;
    let nativeMatchesEnabled = false;
    let operation = Promise.resolve();
    const captured = tabId => {
        for ( const client of clients.values() ) {
            if ( client.capturing && client.tabId === tabId ) { return true; }
        }
        return false;
    };
    const anyCapture = ( ) => Array.from(clients.values()).some(c => c.capturing);
    const readPackagedRules = options.readPackagedRules || (async path => {
        const response = await fetch(api.runtime.getURL(`/${path}`));
        if ( response.ok !== true ) { throw new Error('Packaged rules unavailable'); }
        return response.json();
    });
    const staticRuleSummary = async (rulesetId, ruleId, before) => {
        const key = `${rulesetId}/${ruleId}`;
        if ( staticSummaries.has(key) ) { return staticSummaries.get(key); }
        // Native IDs may only resolve to immutable, manifest-declared assets.
        // Never construct a fetch URL from request URLs or content messages.
        const resource = api.runtime.getManifest?.().declarative_net_request
            ?.rule_resources?.find(entry => entry.id === rulesetId);
        if ( /^\/?rulesets\/main\/[a-z0-9_-]+\.json$/.test(resource?.path) === false ) {
            return;
        }
        const path = resource.path.replace(/^\//, '');
        let loading = staticLoads.get(path);
        if ( loading === undefined ) {
            loading = Promise.resolve().then(( ) => readPackagedRules(path));
            staticLoads.set(path, loading);
            const release = ( ) => {
                if ( staticLoads.get(path) === loading ) { staticLoads.delete(path); }
            };
            loading.then(release, release);
        }
        const rules = await loading;
        if ( Array.isArray(rules) === false ) { return; }
        const rule = rules.find(entry => entry.id === ruleId);
        if ( rule === undefined ) { return; }
        const detail = clip(`${key}; packaged native rule: ${JSON.stringify(rule)}`);
        if ( before === generation && anyCapture() ) {
            if ( staticSummaries.size === MAX_STATIC_SUMMARIES ) {
                staticSummaries.delete(staticSummaries.keys().next().value);
            }
            staticSummaries.set(key, detail);
        }
        // Only short summaries survive the lookup, never a full ruleset map.
        return detail;
    };
    const record = event => {
        if ( anyCapture() === false ) { return; }
        if ( Number.isInteger(event.tabId) && captured(event.tabId) === false ) { return; }
        if ( kinds.has(event.kind) === false ) { return; }
        const entry = {
            id: ++sequence,
            time: Date.now(),
            kind: event.kind,
            phase: clip(event.phase, 64),
            source: clip(event.source, 96),
            detail: clip(event.detail),
            tabId: Number.isInteger(event.tabId) ? event.tabId : -1,
            frameId: Number.isInteger(event.frameId) ? event.frameId : -1,
            url: clip(event.url),
            type: clip(event.type, 64),
            requestId: clip(event.requestId, 128),
        };
        if ( records.length === LOGGER_LIMIT ) {
            records.shift();
            discarded += 1;
        }
        records.push(entry);
        return entry;
    };
    const state = client => ({
        capturing: client?.capturing === true,
        tabId: client?.tabId ?? -1,
        networkEnabled,
        nativeMatchesEnabled,
        limit: LOGGER_LIMIT,
        discarded,
        entries: records.filter(e => e.tabId === client?.tabId || e.tabId === -1),
    });
    const bind = (event, listener, ...args) => {
        if ( typeof event?.addListener !== 'function' ) { return false; }
        try {
            event.addListener(listener, ...args);
            bindings.push([ event, listener ]);
            return true;
        } catch {
            return false;
        }
    };
    const injectObserver = async (tabId, frameId) => {
        if ( captured(tabId) === false ) { return; }
        if ( typeof api.scripting?.executeScript !== 'function' ) { return; }
        const target = { tabId };
        if ( Number.isInteger(frameId) ) { target.frameIds = [ frameId ]; }
        else { target.allFrames = true; }
        await api.scripting?.executeScript({
            target,
            files: [ '/js/scripting/logger-content.js' ],
            injectImmediately: true,
        }).catch(( ) => {});
    };
    const stopContent = tabId => {
        if ( Number.isInteger(tabId) === false || tabId < 0 ) { return; }
        try {
            api.tabs?.sendMessage(tabId, { what: 'stopLoggerContent' }).catch(( ) => {});
        } catch { /* A disappearing tab must not break logger cleanup. */ }
    };
    const network = phase => details => {
        if ( captured(details.tabId) === false ) { return; }
        record({
            ...details,
            kind: 'network', phase, source: 'browser.webRequest (observation)',
            // ERR_BLOCKED_BY_CLIENT alone cannot identify which extension acted.
            detail: phase === 'error' ? clip(details.error) :
                phase === 'redirected' ? `HTTP ${details.statusCode}; target=${clip(details.redirectUrl)}` :
                    phase === 'completed' ? `HTTP ${details.statusCode}; cache=${details.fromCache === true}` :
                        clip(details.method, 16),
        });
    };
    const matched = details => {
        const request = details.request || {};
        if ( captured(request.tabId) === false ) { return; }
        const { rulesetId, ruleId } = details.rule || {};
        const entry = record({
            ...request, kind: 'dnr', phase: 'matched',
            source: 'browser.onRuleMatchedDebug (native)',
            detail: `${rulesetId}/${ruleId}; rule body unavailable`,
        });
        const method = rulesetId === api.declarativeNetRequest.DYNAMIC_RULESET_ID
            ? 'getDynamicRules' : rulesetId === api.declarativeNetRequest.SESSION_RULESET_ID
                ? 'getSessionRules' : undefined;
        if ( pendingLookups >= MAX_PENDING_LOOKUPS ) { return; }
        const before = generation;
        pendingLookups += 1;
        // Resolve mutable rules immediately and keep only a bounded summary.
        // Chrome does not provide an atomic event + rule-body snapshot.
        let lookup;
        try {
            lookup = method === undefined
                ? staticRuleSummary(rulesetId, ruleId, before)
                : api.declarativeNetRequest[method]({ ruleIds: [ ruleId ] });
        } catch {
            pendingLookups -= 1;
            return;
        }
        Promise.resolve(lookup).then(rules => {
            if ( before !== generation || records.includes(entry) === false ) { return; }
            if ( method === undefined ) {
                if ( typeof rules === 'string' ) { entry.detail = rules; }
                return;
            }
            const rule = rules.find(r => r.id === ruleId);
            if ( rule === undefined ) { return; }
            entry.detail = clip(`${rulesetId}/${ruleId}; lookup (not atomic): ${JSON.stringify(rule)}`);
        }).catch(( ) => {}).finally(( ) => { pendingLookups -= 1; });
    };
    const detach = ( ) => {
        for ( const [ event, listener ] of bindings.splice(0) ) {
            try { event.removeListener(listener); } catch {}
        }
        networkEnabled = false;
        nativeMatchesEnabled = false;
    };
    const configure = async ( ) => {
        detach();
        if ( anyCapture() === false ) {
            staticSummaries.clear();
            staticLoads.clear();
            return;
        }
        const permitted = await api.permissions?.contains({ permissions: [ 'webRequest' ] })
            .catch(( ) => false);
        if ( anyCapture() === false ) { return; }
        if ( permitted ) {
            networkEnabled = true;
            const tabIds = new Set(Array.from(clients.values()).filter(c => c.capturing).map(c => c.tabId));
            for ( const tabId of tabIds ) {
                // Filter at the browser boundary, not just after receiving URLs.
                const filter = { urls: [ '<all_urls>' ], tabId };
                const before = bind(api.webRequest?.onBeforeRequest, network('requested'), filter);
                const completed = bind(api.webRequest?.onCompleted, network('completed'), filter);
                const failed = bind(api.webRequest?.onErrorOccurred, network('error'), filter);
                bind(api.webRequest?.onBeforeRedirect, network('redirected'), filter);
                networkEnabled &&= before && completed && failed;
            }
        }
        nativeMatchesEnabled = bind(api.declarativeNetRequest?.onRuleMatchedDebug, matched);
        bind(api.webNavigation?.onCommitted, details => {
            if ( captured(details.tabId) ) { void injectObserver(details.tabId, details.frameId); }
        });
        bind(api.tabs?.onRemoved, tabId => {
            for ( const client of clients.values() ) {
                if ( client.tabId === tabId ) { client.capturing = false; }
            }
            void enqueue(configure);
        });
        bind(api.permissions?.onRemoved, ( ) => { void enqueue(configure); });
    };
    const enqueue = fn => {
        operation = operation.then(fn, fn);
        return operation;
    };
    const clear = (tabId, includeGlobal = true) => {
        for ( let i = records.length - 1; i >= 0; i-- ) {
            if ( records[i].tabId === tabId || (includeGlobal && records[i].tabId === -1) ) {
                records.splice(i, 1);
            }
        }
        generation += 1;
        discarded = 0;
    };
    const disconnect = port => enqueue(async ( ) => {
        const client = clients.get(port);
        clients.delete(port);
        if ( client !== undefined && captured(client.tabId) === false ) {
            stopContent(client.tabId);
            clear(client.tabId, anyCapture() === false);
        }
        await configure();
        if ( anyCapture() === false ) {
            records.length = 0;
            generation += 1;
        }
    });
    const connected = port => {
        if ( port.name !== 'ublock-plus-logger' ) { return; }
        const expected = api.runtime.getURL('/matched-rules.html');
        let senderURL;
        try {
            const parsed = new URL(port.sender?.url);
            parsed.search = ''; parsed.hash = '';
            senderURL = parsed.href;
        } catch {}
        if ( port.sender?.id !== api.runtime.id || senderURL !== expected ||
            clients.size >= MAX_CLIENTS ) {
            port.disconnect();
            return;
        }
        const client = { capturing: false, tabId: -1 };
        const respond = message => {
            try { port.postMessage(message); } catch { /* Window closed while an API was pending. */ }
        };
        clients.set(port, client);
        port.onMessage.addListener(message => {
            void enqueue(async ( ) => {
                if ( clients.has(port) === false ) { return; }
                try {
                    switch ( message.what ) {
                    case 'start': {
                        if ( Number.isInteger(message.tabId) === false || message.tabId < 0 ) {
                            throw new Error('Choose an existing browser tab.');
                        }
                        await api.tabs.get(message.tabId);
                        const previous = client.tabId;
                        client.tabId = message.tabId;
                        client.capturing = true;
                        if ( previous !== client.tabId && captured(previous) === false ) {
                            stopContent(previous);
                            clear(previous, false);
                        }
                        await configure();
                        await injectObserver(client.tabId);
                        break;
                    }
                    case 'stop':
                        client.capturing = false;
                        if ( captured(client.tabId) === false ) { stopContent(client.tabId); }
                        await configure();
                        break;
                    case 'clear':
                        clear(client.tabId);
                        break;
                    case 'read':
                        break;
                    default:
                        return;
                    }
                    respond({ ...state(client), request: message.what });
                } catch (reason) {
                    respond({ ...state(client), error: String(reason) });
                }
            });
        });
        port.onDisconnect.addListener(( ) => { void disconnect(port); });
        respond(state(client));
    };
    api.runtime.onConnect?.addListener(connected);
    return {
        isCapturing: captured,
        record,
        recordContent(request, sender) {
            if ( sender?.id !== api.runtime.id || captured(sender?.tab?.id) === false ) { return false; }
            if ( [ 'dom', 'cosmetic', 'scriptlet' ].includes(request.kind) === false ) { return false; }
            record({
                kind: request.kind,
                phase: request.phase,
                source: 'extension content diagnostic',
                detail: request.detail,
                tabId: sender.tab.id,
                frameId: sender.frameId,
                url: sender.url,
            });
            return true;
        },
        recordCSS(css, sender) {
            if ( typeof css !== 'string' || sender?.id !== api.runtime.id ||
                captured(sender?.tab?.id) === false ) { return; }
            record({
                kind: 'cosmetic', phase: 'stylesheet-inserted',
                source: 'extension CSS insertion (successful)', detail: css,
                tabId: sender.tab.id, frameId: sender.frameId, url: sender.url,
            });
            try {
                api.tabs.sendMessage(sender.tab.id, {
                    what: 'sampleLoggerCSS', css: css.slice(0, 65536),
                }, { frameId: sender.frameId }).catch(( ) => {});
            } catch { /* Diagnostics never change the result of CSS insertion. */ }
        },
    };
}

const logger = createLoggerService(webext);
export const isLoggerCapturing = tabId => logger.isCapturing(tabId);
export const recordLoggerEvent = event => logger.record(event);
export const recordContentDiagnostic = (request, sender) => logger.recordContent(request, sender);
export const recordCSSInsertion = (css, sender) => logger.recordCSS(css, sender);
