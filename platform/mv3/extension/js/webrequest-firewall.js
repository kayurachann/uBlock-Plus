/*******************************************************************************
    uBlock Plus+ - optional synchronous firewall block supplement
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later
******************************************************************************/

import { evaluateFirewall, parseFirewall, within } from './firewall-core.js';

const modeNames = [ 'none', 'basic', 'optimal', 'complete' ];
const MAX_FRAMES_PER_TAB = 256;
const initialStatus = () => ({
    implemented: true, declared: false, permissionGranted: false,
    listenerRegistered: false, ready: false, state: 'not-configured',
    ruleCount: 0, error: '',
});
let activeService;

export const getWebRequestFirewallStatus = () =>
    activeService?.getStatus() ?? initialStatus();

function httpHostname(url) {
    try {
        const parsed = new URL(url);
        if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ) {
            return parsed.hostname.toLowerCase().replace(/\.$/, '');
        }
    } catch { /* Unknown and restricted contexts fail open. */ }
    return '';
}

// Match mode-manager's ordering, including inherited Off scopes.
function isOff(modes, hostname) {
    for ( const name of modeNames ) {
        const hosts = modes[name];
        if ( hosts.includes(hostname) ||
            (hosts.includes('all-urls') === false &&
                hosts.some(scope => within(hostname, scope))) ) {
            return name === 'none';
        }
    }
    return modeNames.find(name => modes[name].includes('all-urls')) === 'none';
}

export function createWebRequestFirewall(deps) {
    const status = initialStatus();
    const permissions = deps.manifest?.permissions ?? [];
    status.declared = permissions.includes('webRequest') &&
        permissions.includes('webRequestBlocking');
    status.state = status.declared ? 'starting' : 'not-configured';
    const tabs = new Map();
    let revision = 0;
    let mutations = 0;
    let initialized = false;
    let failed = false;
    let snapshot;
    let hydrationInvalidations;

    const suspend = () => {
        revision += 1;
        snapshot = undefined;
        status.ready = false;
        if ( status.declared && failed === false ) {
            status.state = status.permissionGranted ? 'suspended' : 'permission-required';
        }
    };
    const fail = reason => {
        suspend();
        failed = true;
        status.error = reason?.message || String(reason);
        status.state = status.declared ? 'error' : 'not-configured';
    };
    const refresh = async () => {
        if ( status.declared === false || failed || mutations !== 0 ||
            initialized === false || status.listenerRegistered === false ) { return; }
        const version = revision;
        try {
            const granted = await deps.permissions.contains({
                permissions: [ 'webRequest', 'webRequestBlocking' ],
            });
            if ( version !== revision ) { return; }
            status.permissionGranted = granted === true;
            if ( granted !== true ) {
                status.state = 'permission-required';
                return;
            }
            const candidate = await deps.getSnapshot();
            if ( version !== revision ) { return; }
            if ( candidate.error ) { throw new Error(candidate.error); }
            const rules = parseFirewall(candidate.text).rules;
            const modes = {};
            for ( const name of modeNames ) {
                const hosts = candidate.modes?.[name];
                if ( Array.isArray(hosts) === false ||
                    hosts.some(host => typeof host !== 'string') ) {
                    throw new Error('Invalid filtering-mode snapshot');
                }
                modes[name] = hosts.slice();
            }
            if ( typeof candidate.domainFromHostname !== 'function' ) {
                throw new Error('Public Suffix List unavailable');
            }
            snapshot = { rules, modes, domainFromHostname: candidate.domainFromHostname };
            status.ruleCount = rules.length;
            status.error = '';
            status.ready = true;
            status.state = 'active';
        } catch ( reason ) {
            if ( version !== revision ) { return; }
            snapshot = undefined;
            status.ready = false;
            status.error = reason?.message || String(reason);
            status.state = 'error';
        }
    };

    const observeNavigation = (details, committed = false) => {
        if ( status.declared === false || Number.isInteger(details?.tabId) === false ||
            details.tabId < 0 ) { return; }
        hydrationInvalidations?.add(details.tabId);
        const previous = tabs.get(details.tabId);
        const timestamp = Number.isFinite(details.timeStamp) ? details.timeStamp : 0;
        if ( previous && timestamp < previous.timestamp ) { return; }
        if ( details.frameId !== 0 ) {
            if ( previous?.pending !== false ||
                Number.isInteger(details.frameId) === false || details.frameId < 1 ) { return; }
            const frames = previous.frames;
            const oldFrame = frames.get(details.frameId);
            if ( oldFrame && timestamp < oldFrame.timestamp ) { return; }
            const removeSubtree = frameId => {
                const pending = [ frameId ];
                while ( pending.length ) {
                    const removed = pending.pop();
                    frames.delete(removed);
                    for ( const [ id, frame ] of frames ) {
                        if ( frame.parentFrameId === removed ) { pending.push(id); }
                    }
                }
            };
            removeSubtree(details.frameId);
            // Frame-removal notifications are not available. Evict old context
            // conservatively instead of retaining an unbounded frame history.
            while ( frames.size >= MAX_FRAMES_PER_TAB ) {
                removeSubtree(frames.keys().next().value);
            }
            const parentFrameId = details.parentFrameId ?? oldFrame?.parentFrameId;
            const parent = parentFrameId === 0
                ? previous.documentId : frames.get(parentFrameId)?.documentId;
            frames.set(details.frameId, {
                parentFrameId, timestamp,
                documentId: committed && parent && details.parentDocumentId === parent
                    ? details.documentId : undefined,
            });
            return;
        }
        const hostname = httpHostname(details.url);
        if ( hostname === '' ) {
            // Keep a timestamp tombstone so a delayed old commit cannot revive
            // a previous HTTP page after navigation to a restricted URL.
            tabs.set(details.tabId, { hostname: '', timestamp, pending: true });
            return;
        }
        tabs.set(details.tabId, {
            hostname, timestamp, pending: committed === false,
            documentId: committed ? details.documentId : undefined,
            frames: new Map(),
        });
    };

    // Rebuild current document identities after worker sleep. Query results
    // never overwrite a navigation/removal observed while the query was pending.
    // This is best effort and bounded; an unhydrated context still fails open.
    const hydrateTabs = async () => {
        if ( status.declared === false || failed ||
            typeof deps.getTabs !== 'function' || typeof deps.getFrames !== 'function' ) { return; }
        const invalidated = new Set();
        hydrationInvalidations = invalidated;
        let timer;
        const load = async () => {
            if ( await deps.permissions.contains({
                permissions: [ 'webRequest', 'webRequestBlocking' ],
            }) !== true ) { return; }
            const candidates = (await deps.getTabs()).slice(0, 256);
            let cursor = 0;
            await Promise.all(Array.from({ length: 4 }, async () => {
                while ( cursor < candidates.length && hydrationInvalidations === invalidated ) {
                    const { id } = candidates[cursor++];
                    if ( Number.isInteger(id) === false || id < 0 || tabs.has(id) ) { continue; }
                    let frames;
                    try { frames = await deps.getFrames(id); } catch { continue; }
                    if ( hydrationInvalidations !== invalidated || invalidated.has(id) ||
                        tabs.has(id) || Array.isArray(frames) === false ) { continue; }
                    const root = frames.find(frame => frame.frameId === 0);
                    if ( !root || root.errorOccurred || root.documentLifecycle !== 'active' ||
                        typeof root.documentId !== 'string' || httpHostname(root.url) === '' ) { continue; }
                    const current = new Map();
                    const pending = frames.filter(frame => frame.frameId > 0).slice(0, MAX_FRAMES_PER_TAB);
                    // The API does not guarantee parent-before-child ordering.
                    for ( let pass = 0; pass < MAX_FRAMES_PER_TAB && pending.length; pass++ ) {
                        let added = 0;
                        for ( let index = pending.length - 1; index >= 0; index-- ) {
                            const frame = pending[index];
                            const parent = frame.parentFrameId === 0
                                ? root.documentId : current.get(frame.parentFrameId)?.documentId;
                            if ( !parent || frame.parentDocumentId !== parent ||
                                frame.errorOccurred || frame.documentLifecycle !== 'active' ||
                                typeof frame.documentId !== 'string' || current.has(frame.frameId) ) { continue; }
                            current.set(frame.frameId, { documentId: frame.documentId,
                                parentFrameId: frame.parentFrameId, timestamp: 0 });
                            pending.splice(index, 1);
                            added++;
                        }
                        if ( added === 0 ) { break; }
                    }
                    tabs.set(id, { hostname: httpHostname(root.url), timestamp: 0,
                        pending: false, documentId: root.documentId, frames: current });
                }
            }));
        };
        try {
            await Promise.race([ load(), new Promise(resolve => {
                timer = setTimeout(resolve, 2000);
            }) ]);
        } catch { /* Closed/restricted tabs and browser errors fail open. */ }
        finally {
            clearTimeout(timer);
            if ( hydrationInvalidations === invalidated ) { hydrationInvalidations = undefined; }
        }
    };

    const onBeforeRequest = details => {
        // Capture native main-frame provenance even before snapshots are ready.
        // Filtering a root document is deliberately left to existing DNR.
        if ( details.type === 'main_frame' ) {
            observeNavigation({ ...details, frameId: 0 });
            return {};
        }
        if ( status.ready === false || snapshot === undefined ||
            Number.isInteger(details.tabId) === false || details.tabId < 0 ) { return {}; }
        try {
            const top = tabs.get(details.tabId);
            const destination = httpHostname(details.url);
            if ( !top || top.pending || destination === '' ||
                (details.documentLifecycle && details.documentLifecycle !== 'active') ||
                isOff(snapshot.modes, top.hostname) ) { return {}; }
            if ( details.frameId === 0 &&
                (!top.documentId || top.documentId !== details.documentId) ) { return {}; }
            if ( details.frameId > 0 ) {
                const documentId = details.type === 'sub_frame'
                    ? details.parentDocumentId : details.documentId;
                const frameId = details.type === 'sub_frame'
                    ? details.parentFrameId : details.frameId;
                const expected = frameId === 0 ? top.documentId : top.frames.get(frameId)?.documentId;
                if ( !documentId || !expected || documentId !== expected ) { return {}; }
            }
            if ( Number.isInteger(details.frameId) === false || details.frameId < 0 ) {
                // Workers can outlive their creator. A tab ID alone does not
                // prove that a request belongs to its currently committed page.
                if ( !details.documentId ||
                    (details.documentId !== top.documentId &&
                        Array.from(top.frames.values()).some(frame =>
                            frame.documentId === details.documentId) === false) ) {
                    return {};
                }
            }
            const domain = snapshot.domainFromHostname(top.hostname);
            if ( typeof domain !== 'string' || domain === '' ) { return {}; }
            const rule = evaluateFirewall(snapshot.rules, top.hostname, destination,
                details.type, within(destination, domain) === false);
            if ( rule?.action !== 'block' ) { return {}; }
            try {
                deps.record?.({ ...details, kind: 'network', phase: 'blocked',
                    source: 'browser.webRequest (firewall supplement)', detail: rule.raw });
            } catch { /* Diagnostics cannot alter a filtering decision. */ }
            return { cancel: true };
        } catch {
            return {};
        }
    };

    // A synchronous registration is required when a service worker wakes.
    // addListener can silently succeed without the permission: refresh also
    // checks permissions.contains before enabling any supplemental decision.
    if ( status.declared ) {
        try {
            if ( typeof deps.webRequest?.onBeforeRequest?.addListener !== 'function' ) {
                throw new Error('Blocking webRequest API unavailable');
            }
            deps.webRequest.onBeforeRequest.addListener(onBeforeRequest,
                { urls: [ 'http://*/*', 'https://*/*' ] }, [ 'blocking' ]);
            status.listenerRegistered = true;
        } catch ( reason ) {
            fail(reason);
        }
    }

    const service = {
        getStatus: () => ({ ...status }),
        initialize: async () => {
            await hydrateTabs();
            initialized = true;
            await refresh();
        },
        beginMutation: () => {
            mutations += 1;
            suspend();
        },
        endMutation: async () => {
            mutations = Math.max(0, mutations - 1);
            await refresh();
        },
        permissionsChanged: () => {
            suspend();
            status.permissionGranted = false;
        },
        fail,
        observeNavigation,
        forgetTab: tabId => {
            hydrationInvalidations?.add(tabId);
            tabs.delete(tabId);
        },
    };
    activeService = service;
    return service;
}
