/*******************************************************************************
    uBlock Plus+ - which address a strict-block redirect replaced
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later

    Strict-block redirects are plain extensionPath redirects: they carry no
    URL, so the strictblock.html page asks the service worker which address
    was blocked in its tab. The answer comes from browser events, in order of
    preference:

    1. 'webrequest': webRequest.onBeforeRedirect and onBeforeRequest, main
       frames only, when the optional webRequest permission is granted (always
       in Experimental). Exact. After a server redirect Chrome reports the
       DNR hop only as an onBeforeRequest for strictblock.html with the same
       requestId, so the last web address of each request is remembered.
    2. 'rule-match': declarativeNetRequest.onRuleMatchedDebug, which Chrome
       delivers only to unpacked installs with declarativeNetRequestFeedback.
       Exact. It fires for every matched rule, so it is registered only while
       a strict-block redirect is installed, never next to webRequest, and not
       on the low-memory profile: it keeps the worker from ever idling.
    3. 'navigation-start': webNavigation.onBeforeNavigate of the top frame,
       fed by background.js. Approximate: a server redirect after the start
       is not seen.
    4. 'unavailable'.

    The page then carries the address in its own history entry (fragment and
    history.state), so Back/Forward, reload and duplicated tabs need no event.

    No import from ext.js or background.js: every browser API is injected, so
    tools/test-strictblock-tracker.mjs runs it in Node.
******************************************************************************/

import {
    STRICTBLOCK_PAGE_PATH,
    isStrictBlockSessionRule,
    ownerForRuleId,
} from './strictblock-rules.js';

/******************************************************************************/

export const LAST_MATCH_STORAGE_KEY = 'strictBlock.lastMatch';
export const PLAN_STORAGE_KEY = 'strictBlock.plan';

const exactSources = new Set([ 'webrequest', 'rule-match' ]);

const isWebURL = raw => {
    if ( typeof raw !== 'string' ) { return false; }
    try {
        const { protocol } = new URL(raw);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
    }
    return false;
};

// The redirect target is chrome-extension://<host>/strictblock.html, where
// <host> is the use_dynamic_url GUID rather than the extension ID. An
// extensionPath may carry a query and a fragment.
const isStrictBlockPageURL = raw => {
    if ( typeof raw !== 'string' ) { return false; }
    try {
        const url = new URL(raw);
        return url.protocol === 'chrome-extension:' &&
            url.pathname === STRICTBLOCK_PAGE_PATH;
    } catch {
    }
    return false;
};

const isTabId = tabId => Number.isInteger(tabId) && tabId >= 0;

const isRequestId = id =>
    typeof id === 'string' && id !== '' || Number.isSafeInteger(id);

const resolveNamespace = value => typeof value === 'function' ? value() : value;

// Owners cross the message boundary and storage.session: keep known shapes.
export function sanitizeStrictBlockOwner(owner) {
    if ( owner instanceof Object === false ) { return; }
    let out;
    if ( owner.kind === 'imported' || owner.kind === 'sandbox' ) {
        out = { kind: owner.kind };
    } else if (
        owner.kind === 'stock' &&
        typeof owner.rulesetId === 'string' &&
        /^[\w.-]{1,64}$/.test(owner.rulesetId)
    ) {
        out = { kind: 'stock', rulesetId: owner.rulesetId };
    } else {
        return;
    }
    if ( Number.isSafeInteger(owner.source) && owner.source > 0 ) {
        out.source = owner.source;
    }
    return out;
}

const sanitizeRecord = raw => {
    if ( raw instanceof Object === false ) { return; }
    if ( isWebURL(raw.url) === false ) { return; }
    if ( Number.isFinite(raw.t) === false ) { return; }
    if ( exactSources.has(raw.source) === false ) { return; }
    const rec = { url: raw.url, t: raw.t, source: raw.source };
    if ( isStrictBlockSessionRule({ id: raw.ruleId }) ) {
        rec.ruleId = raw.ruleId;
    }
    const owner = sanitizeStrictBlockOwner(raw.owner);
    if ( owner !== undefined ) { rec.owner = owner; }
    return rec;
};

/******************************************************************************/

export function createStrictBlockTracker({
    dnr,
    // The optional webRequest permission can be granted and removed while
    // the worker runs, so these may be getters returning the live namespace.
    webRequest,
    webNavigation,
    permissions,
    sessionRead,
    sessionWrite,
    now = Date.now,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
    waitMs = 1500,
    slackMs = 100,
    navSlackMs = 1000,
    maxTabs = 64,
} = {}) {
    // tabId -> { url, t, source, ruleId?, owner? }, least recently set first.
    const records = new Map();
    // tabId -> { url, t }: the last top-level navigation start.
    const navigations = new Map();
    // tabId -> Set of callbacks re-checking a pending getDetails().
    const waiters = new Map();
    // webRequest requestId -> the last web address of that main-frame
    // request, least recently set first. Memory only.
    const requestURLs = new Map();

    let registered = false;
    let active = true;
    let lowMemory = false;
    let webRequestNamespace;
    let ruleMatchRegistered = false;
    let owners = null;
    let planGeneration = 0;
    let planPromise;
    let restorePromise;
    let writeChain = Promise.resolve();

    const sessionRuleset = ( ) => dnr?.SESSION_RULESET_ID ?? '_session';

    const ruleMatchEvent = ( ) => {
        const event = dnr?.onRuleMatchedDebug;
        return typeof event?.addListener === 'function' ? event : undefined;
    };

    const webRequestRedirectEvent = ( ) => {
        const event = resolveNamespace(webRequest)?.onBeforeRedirect;
        return typeof event?.addListener === 'function' ? event : undefined;
    };

    // Browser event times: webRequest and webNavigation timeStamps are epoch
    // milliseconds taken when the event happened, not when the worker got it.
    // onRuleMatchedDebug has none: its records carry the arrival time.
    const eventTime = details => Number.isFinite(details?.timeStamp)
        ? details.timeStamp
        : now();

    /**************************************************************************/

    // Session 'strictBlock.plan'.owners tells which session rule IDs are
    // strict-block redirects, and whose. The cache is dropped whenever the
    // plan changes (setActive/setPlan) and reloaded on demand.

    const loadPlan = ( ) => {
        if ( owners !== null ) { return Promise.resolve(); }
        if ( planPromise !== undefined ) { return planPromise; }
        if ( typeof sessionRead !== 'function' ) { return Promise.resolve(); }
        const generation = planGeneration;
        planPromise = Promise.resolve().then(( ) =>
            sessionRead(PLAN_STORAGE_KEY)
        ).then(plan => {
            if ( generation !== planGeneration ) { return; }
            if ( Array.isArray(plan?.owners) ) { owners = plan.owners; }
        }).catch(( ) => {
        }).finally(( ) => {
            if ( generation === planGeneration ) { planPromise = undefined; }
        });
        return planPromise;
    };

    const invalidatePlan = ( ) => {
        planGeneration += 1;
        planPromise = undefined;
        owners = null;
    };

    /**************************************************************************/

    // storage.session mirror, so that a worker restart between the event and
    // the page's question loses nothing.

    const trim = map => {
        while ( map.size > maxTabs ) {
            map.delete(map.keys().next().value);
        }
    };

    const restore = ( ) => {
        if ( restorePromise !== undefined ) { return restorePromise; }
        restorePromise = (async ( ) => {
            if ( typeof sessionRead !== 'function' ) { return; }
            let stored;
            try {
                stored = await sessionRead(LAST_MATCH_STORAGE_KEY);
            } catch {
            }
            if ( stored?.schemaVersion !== 1 ) { return; }
            if ( Array.isArray(stored.records) === false ) { return; }
            // Records received since the worker started are newer.
            const current = Array.from(records);
            records.clear();
            // storage.session is open to content scripts (background.js):
            // a record from the future would win every later selection.
            const latest = now() + slackMs;
            for ( const entry of stored.records ) {
                if ( Array.isArray(entry) === false ) { continue; }
                const [ tabId, raw ] = entry;
                if ( isTabId(tabId) === false ) { continue; }
                const rec = sanitizeRecord(raw);
                if ( rec === undefined ) { continue; }
                if ( rec.t > latest ) { continue; }
                records.delete(tabId);
                records.set(tabId, rec);
            }
            for ( const [ tabId, rec ] of current ) {
                records.delete(tabId);
                records.set(tabId, rec);
            }
            trim(records);
        })();
        return restorePromise;
    };

    const persist = ( ) => {
        if ( typeof sessionWrite !== 'function' ) { return writeChain; }
        writeChain = writeChain.then(restore).then(( ) =>
            sessionWrite(LAST_MATCH_STORAGE_KEY, {
                schemaVersion: 1,
                records: Array.from(records),
            })
        ).catch(( ) => {
        });
        return writeChain;
    };

    /**************************************************************************/

    const notify = (tabId, removed = false) => {
        const set = waiters.get(tabId);
        if ( set === undefined ) { return; }
        for ( const check of Array.from(set) ) { check(removed); }
    };

    const record = (tabId, rec) => {
        records.delete(tabId);
        records.set(tabId, rec);
        trim(records);
        notify(tabId);
        void persist();
    };

    // The page carries the address in its own history entry once it has it:
    // an answered record is dropped, so that the storage.session copy only
    // holds addresses no page asked for yet.
    const forget = (tabId, rec) => {
        if ( records.get(tabId) !== rec ) { return; }
        records.delete(tabId);
        void persist();
    };

    const isMainFrameRequest = details =>
        (details?.type === undefined || details.type === 'main_frame') &&
        isTabId(details?.tabId);

    // A redirect straight from the blocked address: the direct case.
    const onBeforeRedirect = details => {
        if ( isMainFrameRequest(details) === false ) { return; }
        if ( isStrictBlockPageURL(details.redirectUrl) === false ) { return; }
        if ( isWebURL(details.url) === false ) { return; }
        // Its onBeforeRequest for strictblock.html must not record it twice.
        requestURLs.delete(details.requestId);
        record(details.tabId, {
            url: details.url,
            t: eventTime(details),
            source: 'webrequest',
        });
    };

    // After a server redirect Chrome fires no onBeforeRedirect for the DNR
    // hop: onBeforeRequest(A), onBeforeRedirect(A -> B), onBeforeRequest(B),
    // onBeforeRequest(strictblock.html), all with one requestId. The blocked
    // address is then the request's previous web address.
    const onBeforeRequest = details => {
        if ( isMainFrameRequest(details) === false ) { return; }
        if ( isRequestId(details.requestId) === false ) { return; }
        const { requestId } = details;
        if ( isWebURL(details.url) ) {
            requestURLs.delete(requestId);
            requestURLs.set(requestId, details.url);
            trim(requestURLs);
            return;
        }
        if ( isStrictBlockPageURL(details.url) === false ) { return; }
        const url = requestURLs.get(requestId);
        if ( url === undefined ) { return; }
        requestURLs.delete(requestId);
        record(details.tabId, {
            url,
            t: eventTime(details),
            source: 'webrequest',
        });
    };

    const onRuleMatched = info => {
        const request = info?.request;
        const rule = info?.rule;
        if ( request?.type !== 'main_frame' ) { return; }
        if ( rule?.rulesetId !== sessionRuleset() ) { return; }
        if ( isStrictBlockSessionRule({ id: rule.ruleId }) === false ) { return; }
        if ( isTabId(request.tabId) === false ) { return; }
        if ( isWebURL(request.url) === false ) { return; }
        const rec = {
            url: request.url,
            t: now(),
            source: 'rule-match',
            ruleId: rule.ruleId,
        };
        if ( owners !== null ) {
            // Exclusion allow rules share the ID range: redirects only.
            const owner = ownerForRuleId(owners, rule.ruleId);
            if ( owner === undefined ) { return; }
            rec.owner = owner;
        } else {
            // A worker woken by this very event has no plan in memory yet:
            // keep the record, getDetails() checks it against the plan.
            void loadPlan();
        }
        record(request.tabId, rec);
    };

    /**************************************************************************/

    const syncRuleMatchListener = ( ) => {
        const event = ruleMatchEvent();
        if ( event === undefined ) {
            ruleMatchRegistered = false;
            return;
        }
        const wanted = registered && active && lowMemory === false &&
            webRequestNamespace === undefined;
        if ( wanted === ruleMatchRegistered ) { return; }
        try {
            if ( wanted ) {
                event.addListener(onRuleMatched);
            } else {
                event.removeListener(onRuleMatched);
            }
            ruleMatchRegistered = wanted;
        } catch {
        }
    };

    const webRequestListeners = [
        [ 'onBeforeRedirect', onBeforeRedirect ],
        [ 'onBeforeRequest', onBeforeRequest ],
    ];

    const removeWebRequestListeners = namespace => {
        for ( const [ name, fn ] of webRequestListeners ) {
            try {
                namespace?.[name]?.removeListener(fn);
            } catch {
            }
        }
    };

    // Both listeners or none: onBeforeRedirect alone misses every block
    // which follows a server redirect.
    const registerWebRequest = ( ) => {
        const namespace = resolveNamespace(webRequest);
        if ( webRequestRedirectEvent() === undefined ) { return false; }
        if ( typeof namespace.onBeforeRequest?.addListener !== 'function' ) {
            return false;
        }
        try {
            for ( const [ name, fn ] of webRequestListeners ) {
                namespace[name].addListener(fn, {
                    urls: [ '<all_urls>' ],
                    types: [ 'main_frame' ],
                });
            }
            webRequestNamespace = namespace;
            return true;
        } catch {
        }
        removeWebRequestListeners(namespace);
        return false;
    };

    const unregisterWebRequest = ( ) => {
        if ( webRequestNamespace === undefined ) { return; }
        removeWebRequestListeners(webRequestNamespace);
        webRequestNamespace = undefined;
        requestURLs.clear();
    };

    /**************************************************************************/

    // Selection. A record belongs to the page's navigation when it arrived
    // after the page's navigation started: t >= timeOrigin - slackMs, where
    // the slack absorbs the clock difference between the page and the worker
    // (measured: records arrive 2-70 ms after timeOrigin). A record from
    // before timeOrigin is also superseded when a later navigation to another
    // address started in the same tab: two quick navigations are about 50 ms
    // apart, well inside the slack, and the second page must never show the
    // first address. Navigations are timed by their start, not by arrival:
    // after a server redirect, the start of the redirecting navigation
    // reaches the worker after the match of the address it led to.

    const isRedirectRecord = rec => {
        if ( rec.source !== 'rule-match' || rec.owner !== undefined ) {
            return true;
        }
        // Without a plan in session storage there is nothing to check
        // against: the ID range alone is the best information available.
        if ( owners === null ) { return true; }
        return ownerForRuleId(owners, rec.ruleId) !== undefined;
    };

    const isSuperseded = (tabId, rec) => {
        const nav = navigations.get(tabId);
        return nav !== undefined && nav.t > rec.t && nav.url !== rec.url;
    };

    const pick = (tabId, timeOrigin, strict) => {
        const rec = records.get(tabId);
        if ( rec === undefined ) { return; }
        if ( rec.t < timeOrigin - slackMs ) { return; }
        if ( isRedirectRecord(rec) === false ) { return; }
        if ( strict && rec.t < timeOrigin && isSuperseded(tabId, rec) ) {
            return;
        }
        return rec;
    };

    const freshNavigation = (tabId, timeOrigin) => {
        const nav = navigations.get(tabId);
        if ( nav === undefined ) { return; }
        return nav.t >= timeOrigin - navSlackMs ? nav : undefined;
    };

    const exactListening = ( ) =>
        webRequestNamespace !== undefined || ruleMatchRegistered;

    const navigationListening = ( ) => {
        const navigation = resolveNamespace(webNavigation);
        return typeof navigation?.onBeforeNavigate?.addListener === 'function';
    };

    // Resolves with test()'s first defined result after an event for the
    // tab, or undefined after waitMs or when the tab is removed.
    const waitFor = (tabId, test) => new Promise(resolve => {
        let set = waiters.get(tabId);
        if ( set === undefined ) {
            set = new Set();
            waiters.set(tabId, set);
        }
        let timer;
        const done = result => {
            clearTimer(timer);
            set.delete(check);
            if ( set.size === 0 && waiters.get(tabId) === set ) {
                waiters.delete(tabId);
            }
            resolve(result);
        };
        const check = removed => {
            if ( removed ) { return done(); }
            const result = test();
            if ( result !== undefined ) { done(result); }
        };
        set.add(check);
        timer = setTimer(( ) => { done(); }, waitMs);
    });

    // Best effort: getMatchedRules has no URL and is rate limited, but it
    // names the rule for the webRequest and navigation-start sources.
    const ownerFromMatchedRules = async (tabId, timeOrigin) => {
        if ( typeof dnr?.getMatchedRules !== 'function' ) { return; }
        let details;
        try {
            details = await dnr.getMatchedRules({
                tabId,
                minTimeStamp: Math.floor(timeOrigin - slackMs),
            });
        } catch {
            return;
        }
        await loadPlan();
        if ( owners === null ) { return; }
        let best;
        for ( const info of details?.rulesMatchedInfo ?? [] ) {
            if ( info?.rule?.rulesetId !== sessionRuleset() ) { continue; }
            const owner = ownerForRuleId(owners, info.rule.ruleId);
            if ( owner === undefined ) { continue; }
            const timeStamp = Number.isFinite(info.timeStamp) ? info.timeStamp : 0;
            if ( best !== undefined && best.timeStamp > timeStamp ) { continue; }
            best = { owner, timeStamp };
        }
        return best?.owner;
    };

    const ownerOf = async (rec, tabId, timeOrigin) => {
        if ( rec.owner !== undefined ) { return rec.owner; }
        if ( rec.source === 'rule-match' && owners !== null ) {
            return ownerForRuleId(owners, rec.ruleId);
        }
        return ownerFromMatchedRules(tabId, timeOrigin);
    };

    const withOwner = (details, owner) => {
        const sanitized = sanitizeStrictBlockOwner(owner);
        if ( sanitized !== undefined ) { details.owner = sanitized; }
        return details;
    };

    /**************************************************************************/

    const tracker = {
        // Must run synchronously at the top level of the service worker, so
        // that the events which wake the worker reach these listeners.
        registerTopLevelListeners() {
            if ( registered ) { return; }
            registered = true;
            registerWebRequest();
            syncRuleMatchListener();
        },

        // Active while the session plan has at least one redirect. Inactive,
        // the onRuleMatchedDebug firehose is removed; the main-frame
        // webRequest listener stays. Every call means the plan changed.
        setActive(state) {
            active = state === true;
            invalidatePlan();
            syncRuleMatchListener();
        },

        setPlan(plan) {
            active = plan?.redirectCount > 0;
            invalidatePlan();
            if ( Array.isArray(plan?.owners) ) { owners = plan.owners; }
            syncRuleMatchListener();
        },

        // The low-memory profile gives up the onRuleMatchedDebug source: it
        // keeps the worker alive for as long as the user browses. The
        // webRequest source, main frames only, stays. Returns whether the
        // URL source changed, which changes the session plan.
        setLowMemory(state) {
            const before = tracker.urlSource();
            lowMemory = state === true;
            syncRuleMatchListener();
            return tracker.urlSource() !== before;
        },

        onBeforeNavigate(details) {
            if ( details?.frameId !== 0 ) { return; }
            if ( isTabId(details.tabId) === false ) { return; }
            if ( isWebURL(details.url) === false ) { return; }
            navigations.delete(details.tabId);
            navigations.set(details.tabId, {
                url: details.url,
                t: eventTime(details),
            });
            trim(navigations);
            notify(details.tabId);
        },

        onTabRemoved(tabId) {
            navigations.delete(tabId);
            notify(tabId, true);
            if ( records.delete(tabId) ) { void persist(); }
        },

        // The optional webRequest permission was granted or removed.
        async permissionsChanged() {
            let granted = webRequestRedirectEvent() !== undefined;
            if ( granted && typeof permissions?.contains === 'function' ) {
                try {
                    granted = await permissions.contains({
                        permissions: [ 'webRequest' ],
                    });
                } catch {
                    granted = false;
                }
            }
            if ( registered ) {
                if ( granted && webRequestNamespace === undefined ) {
                    registerWebRequest();
                } else if ( granted === false ) {
                    unregisterWebRequest();
                }
                syncRuleMatchListener();
            }
            return tracker.urlSource();
        },

        // { url, source, owner? }: source is 'webrequest' or 'rule-match'
        // (exact), 'navigation-start' (approximate) or 'none' with url ''.
        async getDetails(tabId, timeOrigin) {
            if ( isTabId(tabId) === false || Number.isFinite(timeOrigin) === false ) {
                return { url: '', source: 'none' };
            }
            await restore();
            await loadPlan();
            let rec = pick(tabId, timeOrigin, true);
            if ( rec === undefined && exactListening() ) {
                rec = await waitFor(tabId, ( ) => pick(tabId, timeOrigin, true));
            } else if (
                rec === undefined && navigationListening() &&
                freshNavigation(tabId, timeOrigin) === undefined
            ) {
                // Without an exact source only the navigation start can
                // come; it may arrive after the page asked.
                await waitFor(tabId, ( ) => freshNavigation(tabId, timeOrigin));
            }
            if ( rec === undefined ) {
                // A superseded record which no newer event replaced.
                rec = pick(tabId, timeOrigin, false);
            }
            if ( rec !== undefined ) {
                forget(tabId, rec);
                const details = { url: rec.url, source: rec.source };
                return withOwner(details, await ownerOf(rec, tabId, timeOrigin));
            }
            const nav = freshNavigation(tabId, timeOrigin);
            if ( nav !== undefined ) {
                const details = { url: nav.url, source: 'navigation-start' };
                return withOwner(details,
                    await ownerFromMatchedRules(tabId, timeOrigin)
                );
            }
            return { url: '', source: 'none' };
        },

        // How the page learns the blocked address on this browser. Based on
        // registered listeners, so it never claims more than was granted.
        urlSource() {
            if ( registered && webRequestNamespace !== undefined ) {
                return 'webrequest';
            }
            if (
                registered && lowMemory === false &&
                ruleMatchEvent() !== undefined
            ) {
                return 'rule-match';
            }
            if ( navigationListening() ) { return 'navigation-start'; }
            return 'unavailable';
        },

        isExact() {
            return exactSources.has(tracker.urlSource());
        },

        // For tests and diagnostics.
        snapshot() {
            return {
                registered,
                active,
                lowMemory,
                webRequestListener: webRequestNamespace !== undefined,
                ruleMatchListener: ruleMatchRegistered,
                records: Array.from(records, ([ tabId, rec ]) => [ tabId, { ...rec } ]),
                navigations: Array.from(navigations, ([ tabId, nav ]) => [ tabId, { ...nav } ]),
                pendingTabs: Array.from(waiters.keys()),
            };
        },

        flush() {
            return writeChain;
        },
    };

    return tracker;
}

/******************************************************************************/
