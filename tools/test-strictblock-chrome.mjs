/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// Strict blocking of a built Chromium package, in a real Chrome:
//
//   node tools/test-strictblock-chrome.mjs [--extension dist/build/uBlockPlus.chromium]
//       [--chrome <chrome.exe>] [--output report.json] [--timeout 600000]
//       [--measure-seconds 40]
//
// Strict-block rules are plain extensionPath redirects: strictblock.html
// asks the service worker which address was blocked (strictblock-tracker.js)
// and keeps it in its own history entry. This test loads a copy of the
// package unpacked, headless, in a fresh temporary profile, with every host
// name mapped to a local HTTP server (no traffic leaves the machine), and
// checks:
// - the exact blocked address on the strict-block page, for a stock list
//   rule (a host of the packaged strictblock/ublock-badware.json) in a new
//   tab, a typed navigation, a link, after a server redirect, after Back and
//   Forward, after a reload, in a duplicated tab, with the service worker
//   stopped, in a window.open popup, and for two quick navigations; and for
//   a My filters $doc filter added through the extension's own messages;
//   after a server redirect the page shows it within a second (no wait for
//   an event which never comes), also with the optional webRequest
//   permission granted on Standard (the source Diagnostics offers);
// - on the low-memory profile (Standard): no onRuleMatchedDebug source, so
//   the approximate navigation start, My filters $doc filters left as plain
//   blocks, and no permanent "don't warn" on a guessed host;
// - Proceed (for the browser session) and "Don't warn me again" (kept
//   across a service worker restart and a rebuild of the session rules),
//   for both, loading the site itself (the server sees the request);
// - a Proceed site also matched by a lower-priority main_frame block still
//   loads (the exclusion allow rule);
// - strict blocking off: the My filters $doc filter gives the browser's own
//   blocked page and the stock site loads;
// - the regex capacity report leaves at least 850 shared regex rules free
//   with the default lists;
// - service worker uptime and CPU with and without the onRuleMatchedDebug
//   listener (reported, not asserted; --measure-seconds 0 skips it).
// Chrome is closed, and the profile and the package copy are removed.

import {
    cdp,
    closeChrome,
    copyExtension,
    createTempDir,
    findChrome,
    installHardTimeout,
    launchChrome,
    parseOptions,
    removeTempDir,
    sleep,
} from './chrome-cdp-harness.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

const options = parseOptions(process.argv.slice(2), {
    extension: 'dist/build/uBlockPlus.chromium',
    chrome: '',
    output: '',
    timeout: 600000,
    'measure-seconds': 40,
});
const clearHardTimeout = installHardTimeout(options.timeout, 'Strict-block Chrome test');
const extensionSource = path.resolve(options.extension);
const chromePath = findChrome(options.chrome);
assert.ok(chromePath !== '', 'Chrome not found: use --chrome <path> or CHROME_PATH');

// A dynamic rule ID no part of the extension uses (dnr-namespaces.js).
const TEST_DYNAMIC_RULE_ID = 6500001;
const EXACT_SOURCES = [ 'rule-match', 'webrequest' ];

const report = {
    extension: extensionSource,
    chrome: chromePath,
    startedAt: new Date().toISOString(),
    cases: [],
    steps: [],
};
const step = (name, details = {}) => {
    report.steps.push({ name, ...details });
    console.log(`ok - ${name}${Object.keys(details).length !== 0 ? ` ${JSON.stringify(details)}` : ''}`);
};

/******************************************************************************/

// Hosts of the package. Stock hosts come from the packaged strict-block rules
// of ublock-badware, among those no other default rule concerns for
// documents or popups, so that the checks below have a single cause. Their
// top-level domain must not be HSTS-preloaded (the server speaks HTTP).

const readPackageJSON = async relative => JSON.parse(await readFile(
    path.join(extensionSource, relative.replace(/^\/+/, '')), 'utf8'
));
const manifest = await readPackageJSON('manifest.json');
const rulesetDetails = await readPackageJSON('rulesets/ruleset-details.json');
const defaultRulesets = manifest.declarative_net_request.rule_resources
    .filter(resource => resource.enabled);
const badwareName = rulesetDetails.find(details => details.id === 'ublock-badware')?.name;
assert.ok(defaultRulesets.some(resource => resource.id === 'ublock-badware') && badwareName,
    'ublock-badware is a default list');

const plainTLDs = new Set([
    'com', 'net', 'org', 'info', 'biz', 'jp', 'ru', 'xyz', 'top', 'online',
    'site', 'club', 'shop', 'store', 'live', 'cn', 'de', 'fr', 'pl', 'br',
]);
const isPlainHost = host =>
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) &&
    plainTLDs.has(host.slice(host.lastIndexOf('.') + 1));
const suffixes = host => {
    const out = [];
    for ( let hn = host; hn.includes('.'); hn = hn.slice(hn.indexOf('.') + 1) ) {
        out.push(hn);
    }
    return out;
};

const pickStockHosts = async count => {
    const badware = await readPackageJSON('rulesets/strictblock/ublock-badware.json');
    // Hosts which any other default rule mentions for documents, popups
    // or exclusions, or which another strict-block list also names.
    const concerned = new Set();
    const mention = value => {
        for ( const hn of JSON.stringify(value).match(/[a-z0-9.-]+\.[a-z]{2,}/g) ?? [] ) {
            concerned.add(hn);
        }
    };
    for ( const resource of defaultRulesets ) {
        const main = await readPackageJSON(resource.path);
        for ( const rule of main ) {
            const types = rule.condition.resourceTypes;
            if (
                types?.includes('main_frame') ||
                rule.action.type === 'allow' ||
                rule.action.type === 'allowAllRequests'
            ) {
                mention(rule.condition);
            }
        }
        const popup = await readPackageJSON(`rulesets/popup/${resource.id}.json`)
            .catch(( ) => undefined);
        if ( popup !== undefined ) { mention(popup); }
        const sb = await readPackageJSON(`rulesets/strictblock/${resource.id}.json`)
            .catch(( ) => []);
        for ( const rule of sb ) {
            if ( resource.id !== 'ublock-badware' ) { mention(rule.condition); }
            mention(rule.condition.excludedRequestDomains ?? []);
        }
    }
    const hosts = [];
    for ( const rule of badware ) {
        const { requestDomains, excludedRequestDomains } = rule.condition;
        if ( Array.isArray(requestDomains) === false || excludedRequestDomains ) { continue; }
        for ( const host of requestDomains ) {
            if ( isPlainHost(host) === false ) { continue; }
            if ( suffixes(host).some(hn => concerned.has(hn)) ) { continue; }
            // An exclusion covers subdomains: no host under another.
            if ( hosts.some(other =>
                suffixes(host).includes(other) || suffixes(other).includes(host)
            ) ) {
                continue;
            }
            hosts.push(host);
            if ( hosts.length === count ) { return hosts; }
        }
    }
    throw new Error(`Only ${hosts.length} usable ublock-badware hosts`);
};

// A host whose images the default lists block, for the measurements.
const pickImageHost = async ( ) => {
    for ( const id of [ 'easylist', 'ublock-filters', 'easyprivacy' ] ) {
        const resource = defaultRulesets.find(r => r.id === id);
        if ( resource === undefined ) { continue; }
        for ( const rule of await readPackageJSON(resource.path) ) {
            const { condition, action } = rule;
            if ( action.type !== 'block' || rule.priority !== undefined && rule.priority !== 10 ) {
                continue;
            }
            const keys = Object.keys(condition);
            if ( keys.length !== 1 || keys[0] !== 'requestDomains' ) { continue; }
            const host = condition.requestDomains.find(isPlainHost);
            if ( host !== undefined ) { return host; }
        }
    }
    throw new Error('No blocked image host in the default lists');
};

const [ caseHost, permanentHost, offHost ] = await pickStockHosts(3);
const imageHost = await pickImageHost();
const mine = {
    proceed: 'sb-mine-proceed.test',
    permanent: 'sb-mine-keep.test',
    off: 'sb-mine-off.test',
};
const myFilters = [
    `||${mine.proceed}^$doc`,
    `||${mine.permanent}^$document`,
    `||${mine.off}^$all`,
].join('\n');
report.hosts = { caseHost, permanentHost, offHost, imageHost, mine };

/******************************************************************************/

// Local server: every host name resolves to it. Records every request.
const hits = [];
const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const escapeHTML = text => String(text).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const server = createServer((request, response) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(request.url, 'http://localhost');
    hits.push({ host, path: `${url.pathname}${url.search}`, at: Date.now() });
    response.setHeader('Cache-Control', 'no-store');
    const html = body => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><meta charset="utf-8">${body}`);
    };
    const to = url.searchParams.get('to') ?? '';
    switch ( url.pathname ) {
    case '/redirect':
        response.writeHead(302, { Location: to });
        response.end();
        return;
    case '/links':
        html(`<title>links</title><p id="links">links</p><a id="link" href="${escapeHTML(to)}">go</a>`);
        return;
    case '/pixel.gif':
        response.setHeader('Content-Type', 'image/gif');
        response.end(pixel);
        return;
    case '/images': {
        const n = Number(url.searchParams.get('n')) || 0;
        const src = `http://${url.searchParams.get('host')}:${port}/pixel.gif?k=${url.searchParams.get('k')}&i=`;
        html(`<title>images</title><p id="images">images</p><script>
            self.__settled = 0; self.__failed = 0;
            for ( let i = 0; i < ${n}; i++ ) {
                const img = new Image();
                img.onload = ( ) => { self.__settled += 1; };
                img.onerror = ( ) => { self.__settled += 1; self.__failed += 1; };
                img.src = ${JSON.stringify(src)} + i;
                document.body.append(img);
            }
        </script>`);
        return;
    }
    case '/beacon': {
        const src = `http://${url.searchParams.get('host')}:${port}/pixel.gif?beacon=`;
        const ms = Number(url.searchParams.get('ms')) || 2000;
        html(`<title>beacon</title><p id="beacon">beacon</p><script>
            self.__beacons = 0;
            setInterval(( ) => {
                self.__beacons += 1;
                new Image().src = ${JSON.stringify(src)} + Date.now();
            }, ${ms});
        </script>`);
        return;
    }
    default:
        html(`<title>origin ${escapeHTML(host)}</title><p id="origin">ORIGIN ${escapeHTML(host)}${escapeHTML(url.pathname)}</p>`);
    }
});
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const at = (host, pathname) => `http://${host}:${port}${pathname}`;
const hitsFor = (host, since, pathname) => hits.filter(hit =>
    hit.host === host && hit.at >= since &&
    (pathname === undefined || hit.path === pathname)
);

/******************************************************************************/

let browser;
let extensionDir;
let profileDir;
let failure;
try {
    extensionDir = await copyExtension(extensionSource, 'ublock-plus-strictblock-package-');
    profileDir = await createTempDir('ublock-plus-strictblock-profile-');
    browser = await launchChrome({
        chromePath,
        profileDir,
        args: [
            // Every host name is the local server: no traffic leaves.
            '--host-resolver-rules=MAP * 127.0.0.1',
            '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
        ],
    });
    report.browser = browser.product;
    const { evaluate, targets, attach, openTab, closeTab, waitFor, serviceWorkerTarget } =
        cdp(browser);
    const send = browser.send;

    const { id } = await send('Extensions.loadUnpacked', { path: extensionDir },
        undefined, 60000);
    report.extensionId = id;
    const extensionOrigin = `chrome-extension://${id}`;
    step('the package loads unpacked', { browser: browser.product });

    // Service worker versions, from the ServiceWorker domain of a blank tab.
    const control = await openTab('about:blank');
    const versions = new Map();
    const statusLog = [];
    browser.on(message => {
        if ( message.method !== 'ServiceWorker.workerVersionUpdated' ) { return; }
        for ( const version of message.params.versions ) {
            if ( version.scriptURL.startsWith(`${extensionOrigin}/`) === false ) { continue; }
            const previous = versions.get(version.versionId)?.runningStatus;
            versions.set(version.versionId, version);
            if ( previous !== version.runningStatus ) {
                statusLog.push({ t: Date.now(), status: version.runningStatus });
            }
        }
    });
    await send('ServiceWorker.enable', {}, control.sessionId);
    const workerStatus = ( ) => {
        const running = Array.from(versions.values())
            .find(version => version.runningStatus !== 'stopped');
        return running?.runningStatus ?? 'stopped';
    };
    const stopWorker = async ( ) => {
        await sleep(200);
        for ( const version of versions.values() ) {
            if ( version.runningStatus === 'stopped' ) { continue; }
            await send('ServiceWorker.stopWorker', { versionId: version.versionId },
                control.sessionId).catch(( ) => { });
        }
        await waitFor(( ) => workerStatus() === 'stopped',
            { timeoutMs: 10000, what: 'the service worker to stop' });
    };

    // The extension's own messages, from one of its pages.
    let dashboard;
    const openDashboard = async ( ) => {
        dashboard = await openTab(`${extensionOrigin}/dashboard.html`);
        await waitFor(( ) => evaluate(dashboard.sessionId,
            `location.protocol === 'chrome-extension:' && typeof chrome.runtime?.sendMessage === 'function'`),
        { what: 'the dashboard page' });
    };
    const closeDashboard = async ( ) => {
        if ( dashboard === undefined ) { return; }
        await closeTab(dashboard.targetId);
        dashboard = undefined;
    };
    const message = async (request, timeoutMs = 60000) => {
        if ( dashboard === undefined ) { await openDashboard(); }
        return evaluate(dashboard.sessionId,
            `import('./js/ext.js').then(ext => ext.sendMessage(${JSON.stringify(request)}))`,
            { timeoutMs });
    };
    const inExtension = async (expression, timeoutMs = 30000) => {
        if ( dashboard === undefined ) { await openDashboard(); }
        return evaluate(dashboard.sessionId, expression, { timeoutMs });
    };
    const capacity = ( ) => message({ what: 'getRegexCapacity' });
    const waitForPlan = async (test, what) => {
        let last;
        try {
            return await waitFor(async ( ) => {
                last = await capacity();
                return test(last) ? last : false;
            }, { timeoutMs: 60000, intervalMs: 500, what });
        } catch ( reason ) {
            throw new Error(`${reason.message}: ${JSON.stringify(last?.strictBlock)}`);
        }
    };

    const config = await message({ what: 'getCurrentConfig' });
    assert.equal(config.strictBlockMode, true, 'Strict blocking is on by default');
    const capabilities = await message({ what: 'getRuntimeCapabilities' });
    report.strictBlockUrlSource = capabilities.strictBlockUrlSource;
    assert.ok(EXACT_SOURCES.includes(capabilities.strictBlockUrlSource),
        `The unpacked install learns the exact address: ${capabilities.strictBlockUrlSource}`);
    assert.equal(capabilities.strictBlockUrlExact, true);
    const stockPlan = await waitForPlan(r => r.strictBlock.redirectCount > 0,
        'the stock strict-block rules');
    step('stock strict-block redirects are installed', {
        redirects: stockPlan.strictBlock.redirectCount,
        source: capabilities.strictBlockUrlSource,
    });

    // My filters, through the extension's own message, as the dashboard's
    // My filters editor saves them.
    // One redirect rule may cover several filters.
    await message({ what: 'setSandboxFilters', text: myFilters }, 120000);
    const redirectsFor = (rules, host) => rules.some(rule =>
        rule.id < 1000000 && rule.action.type === 'redirect' &&
        rule.priority > 1000000 &&
        rule.action.redirect?.extensionPath === '/strictblock.html' &&
        JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]' &&
        (rule.condition.requestDomains?.includes(host) ||
            rule.condition.urlFilter?.includes(host))
    );
    await waitFor(async ( ) => {
        const rules = await message({ what: 'getAllSessionRules' });
        return Object.values(mine).every(host => redirectsFor(rules, host));
    }, { timeoutMs: 60000, intervalMs: 500, what: 'the My filters strict-block redirects' });
    const userPlan = await capacity();
    assert.ok(userPlan.strictBlock.userRedirects > 0);
    step('My filters $doc, $document and $all filters get strict-block redirects', {
        userRedirects: userPlan.strictBlock.userRedirects,
    });

    // Regex capacity with the default lists: the shared pool is free for
    // imported lists and My filters.
    report.regexCapacity = userPlan;
    assert.ok(userPlan.shared.free >= 850,
        `At least 850 free shared regex rules, not ${userPlan.shared.free}`);
    assert.ok(userPlan.static.enabled > 0 && userPlan.static.packaged >= userPlan.static.enabled);
    step('the shared regex pool is mostly free', {
        free: userPlan.shared.free,
        strictBlockRegex: userPlan.shared.session.strictBlock,
        staticEnabled: userPlan.static.enabled,
    });

    /**************************************************************************/

    // What a tab shows.
    const PAGE_STATE = `(( ) => {
        const q = s => document.querySelector(s);
        const base = { href: location.href, marked: self.__ubpMarker === true };
        if ( location.protocol === 'chrome-extension:' && location.pathname === '/strictblock.html' ) {
            if ( document.body === null || document.body.classList.contains('loading') ) {
                return { kind: 'loading', ...base };
            }
            return {
                kind: 'strictblock', ...base,
                sinceOrigin: Math.round(performance.now()),
                origin: location.origin,
                hash: location.hash,
                shownUrl: q('#theURL > p > span')?.textContent ?? '',
                urlHidden: q('#theURL')?.hidden === true,
                note: q('#urlNote')?.hidden === false ? q('#urlNote').textContent : '',
                reason: q('#reason')?.hidden === false ? q('#reason').textContent.trim() : '',
                proceedDisabled: q('#proceed')?.disabled === true,
                dontWarnDisabled: q('#disableWarning')?.disabled === true,
                state: history.state?.ublockPlusStrictBlock ?? null,
            };
        }
        if ( location.href.startsWith('chrome-error:') ) {
            // The browser's error page fills itself in after it loaded.
            const code = q('.error-code')?.textContent.trim() ?? '';
            if ( code === '' ) { return { kind: 'loading', ...base }; }
            return { kind: 'error', ...base, code, text: document.body?.innerText ?? '' };
        }
        for ( const kind of [ 'origin', 'links', 'images', 'beacon' ] ) {
            const p = q('#' + kind);
            if ( p !== null ) { return { kind, ...base, text: p.textContent }; }
        }
        return { kind: 'other', ...base };
    })()`;
    const waitForKind = async (sessionId, kind, what, {
        fresh = false,
        timeoutMs = 15000,
        intervalMs = 100,
    } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let last;
        for (;;) {
            try {
                last = await evaluate(sessionId, PAGE_STATE, { timeoutMs: 5000 });
                if ( last.kind === kind && (fresh === false || last.marked === false) ) {
                    return last;
                }
            } catch ( reason ) {
                last = { error: String(reason?.message ?? reason) };
            }
            if ( Date.now() > deadline ) {
                throw new Error(`${what}: expected a ${kind} page, got ${JSON.stringify(last)}`);
            }
            await sleep(intervalMs);
        }
    };
    const newTarget = async (before, test, what) => waitFor(async ( ) =>
        (await targets()).find(info =>
            info.type === 'page' && before.has(info.targetId) === false && test(info)
        ), { what });
    const targetIds = async ( ) => new Set((await targets()).map(info => info.targetId));

    // The strict-block page shows `url` exactly, as the browser reported it,
    // and names the list. `maxReadyMs`: the page must be shown that soon after
    // its navigation started (polled every 10 ms, so an upper bound).
    const expectExact = async (label, sessionId, url, {
        listName = badwareName,
        fromHistory = false,
        blockedHost,
        since,
        fresh = false,
        maxReadyMs,
        source,
    } = {}) => {
        let page = await waitForKind(sessionId, 'strictblock', label, {
            fresh,
            intervalMs: maxReadyMs !== undefined ? 10 : 100,
        });
        const { sinceOrigin } = page;
        // The reason line follows the list names, which the page asks for
        // on its own: it may come just after the page is shown.
        if ( fromHistory === false ) {
            page = await waitFor(async ( ) => {
                const state = await evaluate(sessionId, PAGE_STATE, { timeoutMs: 5000 });
                return state.kind === 'strictblock' && state.reason !== '' ? state : false;
            }, { timeoutMs: 5000, intervalMs: 50, what: `${label}: the reason line` })
                .catch(( ) => page);
            page.sinceOrigin = sinceOrigin;
        }
        const expected = new URL(url).href;
        const result = {
            label,
            shownUrl: page.shownUrl,
            source: page.state?.source ?? null,
            owner: page.state?.owner ?? null,
            reason: page.reason,
            note: page.note,
            readyAfterMs: page.sinceOrigin,
        };
        report.cases.push(result);
        assert.equal(page.shownUrl, expected, `${label}: the exact blocked address`);
        assert.equal(page.urlHidden, false, label);
        assert.equal(page.note, '', `${label}: no approximate or unavailable note`);
        assert.equal(page.proceedDisabled, false, label);
        assert.equal(page.origin, extensionOrigin,
            `${label}: the page commits under the extension's own ID`);
        assert.ok(page.hash.length > 1, `${label}: the address is kept in the fragment`);
        if ( fromHistory ) {
            assert.ok(page.state === null ||
                [ ...EXACT_SOURCES, 'fragment' ].includes(page.state.source), label);
        } else {
            assert.ok(EXACT_SOURCES.includes(page.state?.source),
                `${label}: exact source, not ${page.state?.source}`);
            assert.ok(page.reason.includes(listName),
                `${label}: the reason names ${listName}: ${page.reason}`);
        }
        if ( blockedHost !== undefined ) {
            assert.equal(hitsFor(blockedHost, since).length, 0,
                `${label}: the blocked site was not contacted`);
        }
        if ( source !== undefined ) {
            assert.equal(page.state?.source, source, `${label}: learned through ${source}`);
        }
        if ( maxReadyMs !== undefined ) {
            assert.ok(page.sinceOrigin <= maxReadyMs,
                `${label}: shown ${page.sinceOrigin} ms after the navigation started, ` +
                `more than ${maxReadyMs} ms`);
        }
        console.log(`ok - ${label}: ${page.shownUrl} (${result.source ?? 'history'}, ${page.sinceOrigin} ms)`);
        return page;
    };
    // Measured: about 100-200 ms; the 1,500 ms wait for an event which does
    // not come shows as 1,600 ms and more.
    const QUICK_MS = 1000;

    /**************************************************************************/

    // Exact address for a stock rule.
    let since = Date.now();
    const url1 = at(caseHost, '/c1/new-tab?q=1');
    const tab1 = await openTab(url1);
    await expectExact('C1 new tab', tab1.sessionId, url1, { blockedHost: caseHost, since });

    since = Date.now();
    const url2 = at(caseHost, '/c2/typed?q=2');
    const tab2 = await openTab('about:blank');
    await send('Page.navigate', { url: url2, transitionType: 'typed' }, tab2.sessionId);
    await expectExact('C2 typed address', tab2.sessionId, url2, { blockedHost: caseHost, since });
    await closeTab(tab2.targetId);

    const url3 = at(caseHost, '/c3/link?q=3');
    const tab3 = await openTab(at('ok.test', `/links?to=${encodeURIComponent(url3)}`));
    await send('Page.enable', {}, tab3.sessionId);
    await waitForKind(tab3.sessionId, 'links', 'C3 link page');
    since = Date.now();
    await evaluate(tab3.sessionId, `document.getElementById('link').click(), true`,
        { userGesture: true });
    await expectExact('C3 link', tab3.sessionId, url3, { blockedHost: caseHost, since });

    since = Date.now();
    const url4 = at(caseHost, '/c4/after-redirect?q=4');
    const tab4 = await openTab(at('ok.test', `/redirect?to=${encodeURIComponent(url4)}`));
    await expectExact('C4 after a server redirect', tab4.sessionId, url4,
        { blockedHost: caseHost, since, maxReadyMs: QUICK_MS });
    assert.equal(hitsFor('ok.test', since, `/redirect?to=${encodeURIComponent(url4)}`).length, 1);
    await closeTab(tab4.targetId);

    // Back and Forward, in the C3 tab: links page, strict-block page, then
    // another page.
    await send('Page.navigate', { url: at('ok.test', '/c5/elsewhere') }, tab3.sessionId);
    await waitForKind(tab3.sessionId, 'origin', 'C5 another page');
    const { entries, currentIndex } = await send('Page.getNavigationHistory', {}, tab3.sessionId);
    const linksEntry = entries.findIndex(entry => entry.url.includes('/links?'));
    const blockedEntry = entries.findIndex(entry =>
        entry.url.startsWith(`${extensionOrigin}/strictblock.html`));
    assert.ok(linksEntry !== -1 && blockedEntry > linksEntry && currentIndex > blockedEntry,
        JSON.stringify(entries.map(entry => entry.url)));
    since = Date.now();
    await send('Page.navigateToHistoryEntry', { entryId: entries[blockedEntry].id }, tab3.sessionId);
    await expectExact('C5 Back', tab3.sessionId, url3,
        { fromHistory: true, blockedHost: caseHost, since });
    await send('Page.navigateToHistoryEntry', { entryId: entries[linksEntry].id }, tab3.sessionId);
    await waitForKind(tab3.sessionId, 'links', 'C6 back to the links page');
    since = Date.now();
    await send('Page.navigateToHistoryEntry', { entryId: entries[blockedEntry].id }, tab3.sessionId);
    await expectExact('C6 Forward', tab3.sessionId, url3,
        { fromHistory: true, blockedHost: caseHost, since });
    await closeTab(tab3.targetId);

    // Reload the C1 tab.
    await evaluate(tab1.sessionId, 'self.__ubpMarker = true');
    since = Date.now();
    await send('Page.reload', {}, tab1.sessionId);
    await expectExact('C7 reload', tab1.sessionId, url1,
        { fromHistory: true, blockedHost: caseHost, since, fresh: true });

    // Duplicate the C1 tab (tabs.duplicate, from the page itself).
    const beforeDuplicate = await targetIds();
    since = Date.now();
    await evaluate(tab1.sessionId,
        'chrome.tabs.getCurrent().then(tab => chrome.tabs.duplicate(tab.id)).then(tab => tab.id)');
    const duplicate = await newTarget(beforeDuplicate,
        info => info.url.startsWith(`${extensionOrigin}/strictblock.html`), 'the duplicated tab');
    const duplicateSession = await attach(duplicate.targetId);
    await expectExact('C8 duplicated tab', duplicateSession, url1,
        { fromHistory: true, blockedHost: caseHost, since });
    await closeTab(duplicate.targetId);
    await closeTab(tab1.targetId);

    // With the service worker stopped: the matched rule wakes it.
    await closeDashboard();
    await stopWorker();
    since = Date.now();
    const url9 = at(caseHost, '/c9/cold-worker?q=9');
    const tab9 = await openTab(url9);
    await expectExact('C9 stopped service worker', tab9.sessionId, url9,
        { blockedHost: caseHost, since });
    await closeTab(tab9.targetId);

    // window.open() with a user gesture.
    const url10 = at(caseHost, '/c10/popup?q=10');
    const opener = await openTab(at('ok.test', `/links?to=${encodeURIComponent(url10)}`));
    await waitForKind(opener.sessionId, 'links', 'C10 opener page');
    const beforePopup = await targetIds();
    since = Date.now();
    await evaluate(opener.sessionId, `void window.open(${JSON.stringify(url10)}), true`,
        { userGesture: true });
    const popup = await newTarget(beforePopup, ( ) => true, 'the popup');
    await expectExact('C10 window.open popup', await attach(popup.targetId), url10,
        { blockedHost: caseHost, since });
    await closeTab(popup.targetId);
    await closeTab(opener.targetId);

    // Two quick navigations in one tab: the page shows the second address.
    const url11a = at(caseHost, '/c11/first?q=11');
    const url11b = at(caseHost, '/c11/second?q=11');
    const tab11 = await openTab('about:blank');
    since = Date.now();
    await send('Page.navigate', { url: url11a }, tab11.sessionId);
    await sleep(15);
    await send('Page.navigate', { url: url11b }, tab11.sessionId);
    await sleep(500);
    await expectExact('C11 two quick navigations', tab11.sessionId, url11b,
        { blockedHost: caseHost, since });
    await closeTab(tab11.targetId);

    // My filters $doc filters.
    const myFiltersName = 'My filters';
    since = Date.now();
    const url12 = at(mine.proceed, '/c12/my-filters?q=12');
    const tab12 = await openTab(url12);
    const page12 = await expectExact('C12 My filters', tab12.sessionId, url12,
        { listName: myFiltersName, blockedHost: mine.proceed, since });
    assert.equal(page12.state?.owner?.kind, 'sandbox');
    await closeTab(tab12.targetId);
    since = Date.now();
    const url13 = at(mine.permanent, '/c13/my-filters-redirect?q=13');
    const tab13 = await openTab(at('ok.test', `/redirect?to=${encodeURIComponent(url13)}`));
    await expectExact('C13 My filters after a server redirect', tab13.sessionId, url13,
        { listName: myFiltersName, blockedHost: mine.permanent, since, maxReadyMs: QUICK_MS });
    await closeTab(tab13.targetId);

    // The optional webRequest permission, as Diagnostics grants it on
    // Standard (Experimental has it already): the source becomes webRequest,
    // which must also name the address after a server redirect, where Chrome
    // fires no onBeforeRedirect for the strict-block hop.
    const sourceBefore = (await message({ what: 'getRuntimeCapabilities' })).strictBlockUrlSource;
    let grantedHere = false;
    if ( sourceBefore !== 'webrequest' ) {
        if ( dashboard === undefined ) { await openDashboard(); }
        grantedHere = await evaluate(dashboard.sessionId,
            `chrome.permissions.request({ permissions: [ 'webRequest' ] })`,
            { userGesture: true, timeoutMs: 15000 });
        assert.equal(grantedHere, true, 'The optional webRequest permission is granted');
        await waitFor(async ( ) =>
            (await message({ what: 'getRuntimeCapabilities' })).strictBlockUrlSource === 'webrequest',
        { timeoutMs: 15000, intervalMs: 200, what: 'the webRequest address source' });
    }
    for ( const [ label, host, listName, pathname ] of [
        [ 'C14 webRequest, direct', caseHost, badwareName, '/c14/direct?q=14' ],
        [ 'C15 webRequest, after a server redirect', caseHost, badwareName, '/c15/after-redirect?q=15' ],
        [ 'C16 webRequest, My filters after a server redirect', mine.permanent, myFiltersName,
            '/c16/my-filters-redirect?q=16' ],
    ] ) {
        since = Date.now();
        const url = at(host, pathname);
        const start = label.includes('redirect')
            ? at('ok.test', `/redirect?to=${encodeURIComponent(url)}`)
            : url;
        const tab = await openTab(start);
        await expectExact(label, tab.sessionId, url, {
            listName, blockedHost: host, since, maxReadyMs: QUICK_MS, source: 'webrequest',
        });
        await closeTab(tab.targetId);
    }
    if ( grantedHere ) {
        assert.equal(await inExtension(
            `chrome.permissions.remove({ permissions: [ 'webRequest' ] })`), true);
        await waitFor(async ( ) =>
            (await message({ what: 'getRuntimeCapabilities' })).strictBlockUrlSource === sourceBefore,
        { timeoutMs: 15000, intervalMs: 200, what: `the ${sourceBefore} address source again` });
    }
    step('the webRequest source names the address, also after a server redirect', {
        sourceBefore, grantedHere,
    });

    // The low-memory profile gives up the onRuleMatchedDebug source, which
    // keeps the worker alive while the user browses: the address becomes
    // the start of the navigation, My filters $doc filters are plain blocks
    // again, and a permanent "don't warn" is not offered on a guessed host.
    if ( sourceBefore === 'rule-match' ) {
        const { selected } = await message({ what: 'getMemoryProfile' });
        const sourceNow = async ( ) =>
            (await message({ what: 'getRuntimeCapabilities' })).strictBlockUrlSource;
        await message({ what: 'setMemoryProfile', profile: 'low-memory' });
        await waitFor(async ( ) => await sourceNow() === 'navigation-start',
            { timeoutMs: 15000, intervalMs: 200, what: 'the navigation-start source' });
        await waitForPlan(r => r.strictBlock.redirectCount > 0 && r.strictBlock.userRedirects === 0,
            'stock redirects only on the low-memory profile');
        const url17 = at(caseHost, '/c17/low-memory?q=17');
        const tab17 = await openTab(url17);
        const page17 = await waitForKind(tab17.sessionId, 'strictblock', 'C17 low-memory profile');
        report.cases.push({ label: 'C17 low-memory profile', shownUrl: page17.shownUrl,
            source: page17.state?.source ?? null, note: page17.note });
        assert.equal(page17.shownUrl, new URL(url17).href, 'C17: where the navigation started');
        assert.equal(page17.state?.source, 'navigation-start');
        assert.notEqual(page17.note, '', 'C17: the address is marked approximate');
        assert.equal(page17.proceedDisabled, false);
        assert.equal(page17.dontWarnDisabled, true, 'C17: no permanent choice on a guessed host');
        await closeTab(tab17.targetId);
        await message({ what: 'setMemoryProfile', profile: selected });
        await waitFor(async ( ) => await sourceNow() === 'rule-match',
            { timeoutMs: 15000, intervalMs: 200, what: 'the rule-match source again' });
        await waitForPlan(r => r.strictBlock.userRedirects > 0, 'the My filters redirects again');
        step('the low-memory profile gives up the rule-match source', { restored: selected });
    }

    /**************************************************************************/

    // Proceed, and "Don't warn me again".
    const loadsOrigin = async (label, url, host) => {
        const started = Date.now();
        const tab = await openTab(url);
        const page = await waitForKind(tab.sessionId, 'origin', label);
        const pathname = new URL(url).pathname + new URL(url).search;
        assert.equal(page.href, new URL(url).href, label);
        assert.ok(hitsFor(host, started, pathname).length >= 1, `${label}: the server was contacted`);
        await closeTab(tab.targetId);
        console.log(`ok - ${label}`);
    };
    const proceed = async (label, url, host, { permanent, listName }) => {
        const tab = await openTab(url);
        await expectExact(label, tab.sessionId, url, { listName });
        if ( permanent ) {
            assert.equal(await evaluate(tab.sessionId,
                `(( ) => { const box = document.getElementById('disableWarning'); box.click(); return box.checked; })()`,
                { userGesture: true }), true);
        }
        const started = Date.now();
        await evaluate(tab.sessionId, `document.getElementById('proceed').click(), true`,
            { userGesture: true });
        const page = await waitForKind(tab.sessionId, 'origin', `${label}: Proceed`);
        assert.equal(page.href, new URL(url).href, `${label}: Proceed opens the blocked address`);
        const pathname = new URL(url).pathname + new URL(url).search;
        assert.ok(hitsFor(host, started, pathname).length >= 1, `${label}: the server was contacted`);
        await closeTab(tab.targetId);
        console.log(`ok - ${label}: Proceed loads the site`);
    };

    await proceed('Proceed (stock)', at(caseHost, '/proceed?p=1'), caseHost,
        { permanent: false, listName: badwareName });
    await loadsOrigin('Proceed (stock) lasts for the session', at(caseHost, '/proceed/again'), caseHost);
    await proceed('Proceed (My filters)', at(mine.proceed, '/proceed?p=2'), mine.proceed,
        { permanent: false, listName: myFiltersName });
    await loadsOrigin('Proceed (My filters) lasts for the session',
        at(mine.proceed, '/proceed/again'), mine.proceed);

    // The excluded stock site keeps an allow rule for its documents, so that
    // a lower-priority main_frame block (a stock rule which is no strict-block
    // candidate) does not end on the browser's error page after Proceed.
    const afterProceed = await message({ what: 'getAllSessionRules' });
    assert.ok(afterProceed.some(rule =>
        rule.id < 1000000 && rule.action.type === 'allow' && rule.priority === 29 &&
        rule.condition.requestDomains?.includes(caseHost) &&
        JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]'
    ), 'The stock exclusion allow rule');
    await inExtension(`chrome.declarativeNetRequest.updateDynamicRules({ addRules: [ {
        id: ${TEST_DYNAMIC_RULE_ID}, priority: 10, action: { type: 'block' },
        condition: { requestDomains: [ ${JSON.stringify(caseHost)} ], resourceTypes: [ 'main_frame' ] },
    } ] }).then(( ) => true)`);
    try {
        await loadsOrigin('Proceed (stock) also beats a main_frame block at priority 10',
            at(caseHost, '/proceed/blocked-too'), caseHost);
    } finally {
        await inExtension(`chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ ${TEST_DYNAMIC_RULE_ID} ] }).then(( ) => true)`);
    }

    await proceed("Don't warn (stock)", at(permanentHost, '/dont-warn?p=3'), permanentHost,
        { permanent: true, listName: badwareName });
    await proceed("Don't warn (My filters)", at(mine.permanent, '/dont-warn?p=4'), mine.permanent,
        { permanent: true, listName: myFiltersName });
    const excluded = await capacity();
    assert.equal(excluded.strictBlock.exclusions, 4, 'Two temporary and two permanent exclusions');

    // A service worker restart keeps them, and so does a rebuild of the
    // session rules by the restarted worker.
    await closeDashboard();
    await stopWorker();
    await loadsOrigin("Don't warn (stock) after a service worker restart",
        at(permanentHost, '/after-restart'), permanentHost);
    await loadsOrigin("Don't warn (My filters) after a service worker restart",
        at(mine.permanent, '/after-restart'), mine.permanent);
    await message({ what: 'setStrictBlockMode', state: false });
    await waitForPlan(r => r.strictBlock.redirectCount === 0, 'strict blocking off');
    await message({ what: 'setStrictBlockMode', state: true });
    const rebuilt = await waitForPlan(r =>
        r.strictBlock.redirectCount > 0 &&
        r.strictBlock.userRedirects === userPlan.strictBlock.userRedirects,
    'strict blocking back on');
    assert.equal(rebuilt.strictBlock.exclusions, 4, 'The exclusions are kept');
    await loadsOrigin("Don't warn (stock) after the rules were rebuilt",
        at(permanentHost, '/after-rebuild'), permanentHost);
    await loadsOrigin("Don't warn (My filters) after the rules were rebuilt",
        at(mine.permanent, '/after-rebuild'), mine.permanent);
    since = Date.now();
    const tabOn = await openTab(at(offHost, '/still-on'));
    await expectExact('Other sites are still strict-blocked', tabOn.sessionId,
        at(offHost, '/still-on'), { blockedHost: offHost, since });
    await closeTab(tabOn.targetId);
    step('Proceed and "Don\'t warn me again" work for stock lists and My filters');

    /**************************************************************************/

    // Strict blocking off: My filters $doc filters block as the browser
    // does, stock strict-block sites load.
    await message({ what: 'setStrictBlockMode', state: false });
    await waitForPlan(r => r.strictBlock.redirectCount === 0, 'strict blocking off');
    const offRules = await message({ what: 'getAllSessionRules' });
    assert.equal(offRules.some(rule => rule.id < 1000000 && rule.action.type === 'redirect'),
        false, 'No strict-block redirect is installed');
    await loadsOrigin('Strict blocking off: the stock site loads', at(offHost, '/off'), offHost);
    since = Date.now();
    const urlOff = at(mine.off, '/off');
    const tabOff = await openTab(urlOff);
    const errorPage = await waitForKind(tabOff.sessionId, 'error',
        'Strict blocking off: My filters $all');
    assert.equal(errorPage.code, 'ERR_BLOCKED_BY_CLIENT');
    assert.equal(hitsFor(mine.off, since).length, 0);
    assert.equal((await targets()).find(info => info.targetId === tabOff.targetId)?.url, urlOff,
        'The tab keeps the blocked address');
    report.blockedPage = { code: errorPage.code, text: errorPage.text.slice(0, 200) };
    await closeTab(tabOff.targetId);
    step('strict blocking off: the browser blocks My filters documents, stock sites load');

    /**************************************************************************/

    // Service worker cost of the onRuleMatchedDebug listener, which strict
    // blocking keeps only while a redirect is installed and webRequest is not
    // granted: worker CPU while pages with 300 blocked images load (worker
    // attached for the profiler), then worker uptime (worker detached) while
    // a page requests a blocked image every 2 s.
    const measureSeconds = options['measure-seconds'];
    if ( measureSeconds > 0 ) {
        const busyMs = profile => {
            const idle = new Set(profile.nodes.filter(node =>
                [ '(idle)', '(program)', '(garbage collector)' ].includes(node.callFrame.functionName)
            ).map(node => node.id));
            let us = 0;
            profile.samples.forEach((sample, i) => {
                if ( idle.has(sample) === false ) { us += profile.timeDeltas[i] ?? 0; }
            });
            return us / 1000;
        };
        const measure = async listener => {
            // A stopped worker has no target: a message starts it.
            await message({ what: 'getCurrentConfig' });
            await closeDashboard();
            const worker = await serviceWorkerTarget(id);
            const workerSession = await attach(worker.targetId);
            await send('Profiler.enable', {}, workerSession);
            await send('Profiler.setSamplingInterval', { interval: 100 }, workerSession);
            const runs = [];
            for ( let k = 0; k < 4; k++ ) {
                await send('Profiler.start', {}, workerSession);
                const tab = await openTab(at('ok.test', `/images?n=300&host=${imageHost}&k=${k}`));
                const done = await waitFor(( ) => evaluate(tab.sessionId, `self.__settled === 300 &&
                    document.readyState === 'complete' && (( ) => {
                        const nav = performance.getEntriesByType('navigation')[0];
                        return { load: nav.loadEventEnd, failed: self.__failed };
                    })()`), { timeoutMs: 30000, what: 'the images page' });
                await sleep(300);
                const { profile } = await send('Profiler.stop', {}, workerSession);
                runs.push({ loadMs: Math.round(done.load * 10) / 10, blocked: done.failed,
                    workerBusyMs: Math.round(busyMs(profile) * 100) / 100 });
                await closeTab(tab.targetId);
            }
            await send('Target.detachFromTarget', { sessionId: workerSession }).catch(( ) => { });
            // Uptime: from a stopped worker, nothing attached.
            await stopWorker();
            const start = Date.now();
            const initial = workerStatus();
            const firstEvent = statusLog.length;
            const beacon = await openTab(at('ok.test', `/beacon?host=${imageHost}&ms=2000`));
            await sleep(measureSeconds * 1000);
            const beacons = await evaluate(beacon.sessionId, 'self.__beacons');
            await closeTab(beacon.targetId);
            const end = Date.now();
            const events = statusLog.slice(firstEvent).filter(event => event.t <= end);
            let upMs = 0;
            let up = initial !== 'stopped';
            let from = start;
            for ( const event of events ) {
                const nowUp = event.status !== 'stopped';
                if ( up && nowUp === false ) { upMs += event.t - from; }
                if ( up === false && nowUp ) { from = event.t; }
                up = nowUp;
            }
            if ( up ) { upMs += end - from; }
            const average = key => Math.round(runs.slice(1).reduce((sum, run) =>
                sum + run[key], 0) / (runs.length - 1) * 100) / 100;
            return {
                listener,
                pages: runs,
                averageLoadMs: average('loadMs'),
                averageWorkerBusyMs: average('workerBusyMs'),
                uptime: {
                    seconds: Math.round((end - start) / 100) / 10,
                    workerUpSeconds: Math.round(upMs / 100) / 10,
                    workerStarts: events.filter(event => event.status === 'starting').length,
                    blockedBeacons: beacons,
                },
            };
        };
        // Strict blocking is off here: no redirect, so no listener.
        const without = await measure(false);
        await message({ what: 'setStrictBlockMode', state: true });
        await waitForPlan(r => r.strictBlock.redirectCount > 0, 'strict blocking on');
        const withListener = await measure(true);
        report.workerCost = { without, with: withListener };
        step('measured the onRuleMatchedDebug listener', {
            without: { loadMs: without.averageLoadMs, workerBusyMs: without.averageWorkerBusyMs,
                workerUpSeconds: without.uptime.workerUpSeconds, of: without.uptime.seconds },
            with: { loadMs: withListener.averageLoadMs, workerBusyMs: withListener.averageWorkerBusyMs,
                workerUpSeconds: withListener.uptime.workerUpSeconds, of: withListener.uptime.seconds },
        });
    }
    report.result = 'passed';
} catch ( reason ) {
    failure = reason;
    report.result = 'failed';
    report.error = String(reason?.stack ?? reason);
} finally {
    report.chromeForceKilled = await closeChrome(browser);
    server.close();
    report.profileRemoved = profileDir !== undefined && await removeTempDir(profileDir);
    report.packageCopyRemoved = extensionDir !== undefined && await removeTempDir(extensionDir);
    report.finishedAt = new Date().toISOString();
    if ( options.output !== '' ) {
        const output = path.resolve(options.output);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    clearHardTimeout();
}
if ( failure !== undefined ) { throw failure; }
assert.ok(report.profileRemoved && report.packageCopyRemoved, 'Temporary folders are removed');
console.log(`Strict-block Chrome test passed on ${report.browser}: ${report.cases.length} pages checked.`);
