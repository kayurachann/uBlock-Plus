#!/usr/bin/env node
/* uBlock Plus+ native popup regressions. GPL-3.0-or-later. */
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { tmpdir } from 'node:os';

const options = {};
for ( let i = 2; i < process.argv.length; i++ ) {
    const key = process.argv[i].replace(/^--/, '');
    assert.ok([ 'extension', 'chrome', 'playwright', 'output' ].includes(key));
    const value = process.argv[++i];
    assert.ok(isAbsolute(value), 'Use explicit absolute paths');
    options[key] = resolve(value);
}
for ( const key of [ 'extension', 'chrome', 'playwright', 'output' ] ) {
    assert.ok(options[key], `Missing --${key}`);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tree = async (directory, prefix = '') => {
    const result = [];
    for ( const entry of await readdir(directory, { withFileTypes: true }) ) {
        if ( entry.name === '_metadata' ) { continue; }
        const path = resolve(directory, entry.name);
        if ( entry.isDirectory() ) { result.push(...await tree(path, `${prefix}${entry.name}/`)); }
        else { result.push({ path: prefix + entry.name, sha256: hash(await readFile(path)) }); }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
};
await mkdir(options.output, { recursive: true });
const extension = await mkdtemp(resolve(tmpdir(), 'ubp-popup-artifact-'));
await cp(options.extension, extension, { recursive: true,
    filter: path => !path.split(/[\\/]/).includes('_metadata') });
const loadedTree = await tree(extension);
assert.deepEqual(loadedTree, await tree(options.extension));
const report = { started: new Date().toISOString(), options, extension,
    harnessSHA256: hash(await readFile(new URL(import.meta.url))),
    loadedFiles: loadedTree.length, loadedTreeSHA256: hash(JSON.stringify(loadedTree)),
    version: JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')).version,
    methodology: 'Unmodified package and local HTTP fixtures in installed Google Chrome. Separate clean profiles retain normal native popup protection or disable only that blocker for causal lab controls. No User Scripts permission, replacement popup engine, external site, or mocked response. Handle null/closed is not used as proof of blocking.',
    runs: [], cases: [], requests: [], diagnostics: [] };
const fixtures = new Map();
const timers = new Set();
const escapeHTML = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('case') || '';
    const fixture = fixtures.get(token);
    let body = '';
    request.on('data', data => { body += data.toString(); });
    request.on('end', () => {
        report.requests.push({ at: Date.now(), host: url.hostname, path: url.pathname,
            token, method: request.method, body: body.slice(0, 200) });
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if ( url.pathname === '/fixture' && fixture ) {
        const target = fixture.target;
        const quoted = JSON.stringify(target);
        const htmlTarget = escapeHTML(target);
        const script = `window.handles=[];window.attempts=[];
function openTracked(url, name='_blank', features='') {
 const activation={active:navigator.userActivation.isActive,ever:navigator.userActivation.hasBeenActive};
 const handle=window.open(url,name,features); handles.push(handle);
 attempts.push({url,name,features,activation,returnedNull:handle===null,at:Date.now()}); return handle;
}
function action(){${fixture.script || `openTracked(${quoted});`}}
${fixture.automatic ? 'setTimeout(action, 900);' : ''}`;
        response.end(`<!doctype html><meta charset="utf-8"><title>Popup fixture ${token}</title>
<style>body{font:18px system-ui;padding:24px}button,a,input{display:inline-block;margin:10px;padding:14px}iframe{width:620px;height:180px}</style>
<h1>Native popup fixture: ${escapeHTML(fixture.name)}</h1>
<button id="open" onclick="action()">Open requested window</button>
<a id="link" href="${htmlTarget}" target="_blank" rel="opener">Open requested link</a>
<a id="noopener" href="${htmlTarget}" target="_blank" rel="noopener">Open secure link</a>
<form id="get" action="${htmlTarget}" target="_blank"><input name="case" value="${token}" type="hidden"><button id="submit-get">Submit GET</button></form>
<form id="post" action="${htmlTarget}" method="post" target="_blank"><input name="entry" value="fixture-only" type="hidden"><button id="submit-post">Submit POST</button></form>
<form id="override" action="${escapeHTML(origin(fixture.hostname))}/unused?case=${token}" target="_blank"><input name="case" value="${token}" type="hidden"><button id="submit-override" formaction="${htmlTarget}">Submit alternate endpoint</button></form>
<iframe name="existingFrame" id="existing" src="${escapeHTML(origin(fixture.hostname))}/frame?case=${token}"></iframe>
${fixture.frame ? `<iframe id="source-frame" src="${escapeHTML(origin(`frame.${fixture.hostname}`))}/frame-source?case=${token}"></iframe>` : ''}
<script>${script}</script>`);
        return;
    }
    if ( url.pathname === '/frame-source' && fixture ) {
        response.end(`<!doctype html><button id="frame-open" onclick="window.open(${escapeHTML(JSON.stringify(fixture.target))})">Open from frame</button>`);
        return;
    }
    if ( url.pathname === '/slow' ) {
        // Chrome sees the destination URL before this response completes. This
        // exposes erroneous expiry of already accepted trusted navigations.
        response.write('<!doctype html><title>Slow popup loading</title><p>Response started');
        const timer = setTimeout(() => {
            timers.delete(timer);
            response.end('<p id="done">Slow popup completed</p>');
        }, 6500);
        timers.add(timer);
        return;
    }
    response.end(`<!doctype html><title>Harmless popup target</title><h1 id="target">${escapeHTML(url.pathname)}</h1><p>No external request, account, or payment is used.</p>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = hostname => `http://${hostname}:${server.address().port}`;
const { chromium } = await import(pathToFileURL(options.playwright).href);
let serial = 0;

async function runSuite(nativePopupBlocking) {
    const modeName = nativePopupBlocking ? 'normal' : 'isolated-lab';
    const profile = await mkdtemp(resolve(tmpdir(), 'ubp-popup-profile-'));
    const args = [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
        '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
        '--no-default-browser-check', '--mute-audio' ];
    if ( nativePopupBlocking === false ) { args.push('--disable-popup-blocking'); }
    const run = { mode: modeName, profile, args, nativePopupBlocking, errors: [] };
    report.runs.push(run);
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, {
            executablePath: options.chrome, headless: false, ignoreDefaultArgs: true,
            viewport: { width: 1120, height: 850 }, args,
        });
        context.setDefaultTimeout(12000);
        const cdp = await context.browser().newBrowserCDPSession();
        run.browser = await cdp.send('Browser.getVersion');
        run.actualCommandLine = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
        assert.equal(run.actualCommandLine.includes('--disable-popup-blocking'), !nativePopupBlocking);
        assert.equal(run.actualCommandLine.includes('--no-sandbox'), false);
        const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
        run.extensionId = id;
        context.on('page', page => {
            page.on('pageerror', error => {
                if ( run.errors.length < 100 ) { run.errors.push({ url: page.url(), error: error.message }); }
            });
        });
        const dashboard = await context.newPage();
        await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
        await dashboard.waitForFunction(() => !document.body.classList.contains('loading'));
        const inspectionSession = await context.newCDPSession(dashboard);
        const inspectWithoutGesture = async expression => {
            const response = await inspectionSession.send('Runtime.evaluate', {
                expression, userGesture: false, awaitPromise: true, returnByValue: true,
            });
            assert.equal(response.exceptionDetails, undefined, 'Read-only CDP inspection succeeds');
            return response.result.value;
        };
        await dashboard.evaluate(() => {
            window.popupNativeEvents = [];
            const record = (kind, details) => {
                if ( window.popupNativeEvents.length >= 400 ) { window.popupNativeEvents.shift(); }
                window.popupNativeEvents.push({ at: Date.now(), kind, ...details });
            };
            chrome.tabs.onCreated.addListener(tab => record('tabs.onCreated', {
                tabId: tab.id, openerTabId: tab.openerTabId, url: tab.url, pendingUrl: tab.pendingUrl,
            }));
            chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
                if ( !change.url && !change.status ) { return; }
                record('tabs.onUpdated', { tabId, openerTabId: tab.openerTabId,
                    url: tab.url, pendingUrl: tab.pendingUrl, change });
            });
            chrome.tabs.onRemoved.addListener(tabId => record('tabs.onRemoved', { tabId }));
            chrome.webNavigation.onCreatedNavigationTarget.addListener(details =>
                record('webNavigation.onCreatedNavigationTarget', details));
        });
        const message = request => dashboard.evaluate(async request =>
            (await import('./js/ext.js')).sendMessage(request), request);
        const setMode = mode => message({ what: 'setFilteringModeDetails', modes: {
            none: mode === 'off' ? [ 'all-urls' ] : [], basic: mode === 'basic' ? [ 'all-urls' ] : [],
            optimal: [], complete: mode === 'complete' ? [ 'all-urls' ] : [],
        } });
        await message({ what: 'setPopupBlockMode', state: true });
        await setMode('complete');
        let currentMode = 'complete';
        let currentFilters;
        let popupFeatureEnabled = true;
        run.contentScripts = await dashboard.evaluate(async () =>
            (await chrome.scripting.getRegisteredContentScripts()).map(script => ({
                id: script.id, js: script.js, allFrames: script.allFrames,
                runAt: script.runAt, matchOriginAsFallback: script.matchOriginAsFallback,
                matchCount: script.matches?.length || 0, excludeCount: script.excludeMatches?.length || 0,
            })));
        assert.ok(run.contentScripts.some(script => script.id === 'prevent-popup'));
        run.userScriptsEnabled = await dashboard.evaluate(async () => {
            try { await chrome.userScripts.getScripts(); return true; } catch { return false; }
        });
        assert.equal(run.userScriptsEnabled, false, 'The observer must work without optional User Scripts');

        const test = async config => {
            const token = `${modeName}-${++serial}`;
            const hostname = `case${serial}.popup.localhost`;
            const targetHost = config.sameHost ? hostname : `destination${serial}.localtest.localhost`;
            const target = `${origin(targetHost)}${config.slow ? '/slow' : '/target'}?case=${token}`;
            const fixture = { ...config, token, hostname, target };
            if ( config.makeScript ) { fixture.script = config.makeScript({ target, token, hostname }); }
            fixtures.set(token, fixture);
            const result = { name: config.name, mode: modeName, token, hostname,
                target, observations: {}, started: new Date().toISOString() };
            report.cases.push(result);
            let opener;
            const targets = [];
            let onPage;
            try {
                if ( popupFeatureEnabled !== (config.switchEnabled !== false) ) {
                    popupFeatureEnabled = config.switchEnabled !== false;
                    await message({ what: 'setPopupBlockMode', state: popupFeatureEnabled });
                }
                const filtering = config.filtering || 'complete';
                if ( currentMode !== filtering ) { await setMode(filtering); currentMode = filtering; }
                await message({ what: 'replacePopupPolicies', policies: { [hostname]: config.policy || 'block' } });
                const filters = config.filters?.({ hostname, targetHost }) || '';
                if ( currentFilters !== filters ) {
                    await message({ what: 'setSandboxFilters', text: filters }); currentFilters = filters;
                }
                await message({ what: 'clearPopupDiagnostics' });
                await dashboard.evaluate(() => { window.popupNativeEvents = []; });
                opener = await context.newPage();
                onPage = page => {
                    if ( page === opener || page === dashboard ) { return; }
                    const entry = { page, created: Date.now(), closed: null, urls: [] };
                    targets.push(entry);
                    page.on('framenavigated', frame => {
                        if ( frame === page.mainFrame() ) { entry.urls.push(frame.url()); }
                    });
                    page.on('close', () => { entry.closed = Date.now(); });
                };
                context.on('page', onPage);
                await opener.goto(`${origin(hostname)}/fixture?case=${token}`, { waitUntil: 'load' });
                const openerTabId = await inspectWithoutGesture(
                    `chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(opener.url())})?.id)`
                );
                assert.ok(Number.isSafeInteger(openerTabId));
                result.observations.openerTabId = openerTabId;
                const collector = () => inspectWithoutGesture(
                    `chrome.tabs.sendMessage(${openerTabId}, { what: 'getPopupGestureContext' }, { frameId: 0 }).catch(() => null)`
                );
                if ( config.automatic !== true ) {
                    if ( config.frame ) {
                        await opener.frameLocator('#source-frame').locator('#frame-open').click();
                    } else if ( config.keyboard ) {
                        await opener.locator('#link').focus();
                        await opener.keyboard.press('Enter');
                    } else {
                        await opener.locator(config.selector || '#open').click();
                        if ( config.twice ) {
                            result.observations.collectorAfterFirstClick = await collector();
                            await opener.locator(config.selector || '#open').click();
                            result.observations.collectorAfterSecondClick = await collector();
                        }
                    }
                }
                // Playwright's extension-page evaluate carries user activation;
                // forwarding a message can propagate it to the content script.
                // Inspect automatic fixtures only after their timer has fired.
                if ( config.automatic !== true ) { result.observations.collector = await collector(); }
                await pause(config.wait || (config.automatic ? 2400 : 1400));
                if ( config.automatic === true ) { result.observations.collector = await collector(); }
                if ( config.navigateOpener ) {
                    await message({ what: 'setPopupPolicy', hostname: 'strict-next.popup.localhost', mode: 'strict' });
                    await opener.goto(`${origin('strict-next.popup.localhost')}/next?case=${token}`);
                    await pause(1400);
                }
                result.observations.targets = targets.map(entry => ({ created: entry.created,
                    closed: entry.closed, urls: entry.urls, alive: !entry.page.isClosed(),
                    currentURL: entry.page.url() }));
                result.observations.openerAlive = !opener.isClosed();
                if ( !opener.isClosed() ) {
                    result.observations.page = await opener.evaluate(() => ({
                        attempts: window.attempts || [], handles: (window.handles || []).map(handle => {
                            try { return { null: handle === null, closed: handle?.closed }; }
                            catch { return { inaccessible: true }; }
                        }), frames: Array.from(document.querySelectorAll('iframe'), element => ({
                            name: element.name, src: element.src,
                        })),
                    }));
                }
                result.observations.chromeTabs = await dashboard.evaluate(() =>
                    chrome.tabs.query({}).then(tabs => tabs.map(tab => ({
                        id: tab.id, openerTabId: tab.openerTabId, url: tab.url, pendingUrl: tab.pendingUrl,
                    }))));
                result.observations.nativeEvents = await dashboard.evaluate(() => window.popupNativeEvents);
                result.observations.diagnostics = await message({ what: 'getPopupDiagnostics' });
                result.observations.requests = report.requests.filter(request => request.token === token);
                const alive = targets.filter(entry => !entry.page.isClosed()).length;
                const blocked = result.observations.diagnostics.filter(entry => entry.action === 'blocked').length;
                result.observations.aliveTargets = alive;
                result.observations.successfulClosures = blocked;
                if ( config.automatic ) {
                    assert.ok(result.observations.page.attempts.length > 0, 'Automatic fixture attempted window.open');
                    assert.ok(result.observations.page.attempts.every(attempt =>
                        attempt.activation.active === false && attempt.activation.ever === false),
                    'No test-driver interaction granted user activation before the automatic attempt');
                }
                assert.equal(result.observations.openerAlive, true, 'The originating tab stays open');
                const expectedAlive = nativePopupBlocking && config.nativeAlive !== undefined
                    ? config.nativeAlive : config.alive;
                assert.equal(alive, expectedAlive, 'Actual surviving target tabs');
                if ( config.blocked !== undefined && (!nativePopupBlocking || config.assertNativeBlock) ) {
                    assert.equal(blocked, config.blocked, 'Successful extension closure diagnostics');
                }
                if ( config.selector?.startsWith('#submit-') ) {
                    assert.equal(result.observations.collector?.targetURL, target,
                        'Gesture collector records the actual form submitter destination');
                }
                if ( config.assertion ) { await config.assertion(result, opener, targets); }
                result.passed = true;
            } catch (error) {
                result.passed = false;
                result.error = error.stack;
                if ( opener && !opener.isClosed() ) {
                    await opener.screenshot({ path: resolve(options.output, `${token}.png`) }).catch(() => {});
                }
            } finally {
                if ( onPage ) { context.off('page', onPage); }
                await Promise.all(targets.map(entry => entry.page.close().catch(() => {})));
                if ( opener ) { await opener.close().catch(() => {}); }
                await writeFile(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2));
            }
            console.log(`${result.passed ? 'PASS' : 'FAIL'} [${modeName}] ${config.name}${result.passed ? '' : `: ${result.error}`}`);
        };

        await test({ name: 'Off preserves a clicked cross-host window', filtering: 'off', alive: 1, blocked: 0 });
        await test({ name: 'Off automatic control isolates the built-in blocker', filtering: 'off', automatic: true,
            alive: 1, nativeAlive: 0, blocked: 0 });
        await test({ name: 'Disabling the popup feature preserves an automatic window', switchEnabled: false,
            automatic: true, alive: 1, nativeAlive: 0, blocked: 0 });
        await test({ name: 'Smart preserves a trusted cross-host link', selector: '#link', alive: 1, blocked: 0 });
        await test({ name: 'Smart preserves keyboard activation', keyboard: true, alive: 1, blocked: 0 });
        await test({ name: 'Smart preserves a slow trusted cross-host navigation', slow: true, wait: 8000,
            alive: 1, blocked: 0, assertion: async (result, opener, targets) => {
                void result; void opener;
                assert.equal(await targets[0].page.locator('#done').count(), 1);
            } });
        await test({ name: 'Smart preserves two rapid independent clicks', twice: true, alive: 2, blocked: 0,
            assertion: async result => {
                const attempts = result.observations.page.attempts;
                assert.equal(attempts.length, 2);
                assert.ok(attempts.every(attempt => attempt.activation.active === true));
                assert.ok(attempts[1].at - attempts[0].at < 750, 'Two real trusted clicks occur within the former deduplication window');
                assert.ok(result.observations.collectorAfterSecondClick.sequence >
                    result.observations.collectorAfterFirstClick.sequence,
                'Independent trusted clicks have independent gesture sequences');
            } });
        await test({ name: 'Smart blocks an automatic unrelated window', automatic: true,
            alive: 0, nativeAlive: 0, blocked: 1 });
        await test({ name: 'Smart permits one automatic directly related window', automatic: true, sameHost: true,
            alive: 1, nativeAlive: 0, blocked: 0 });
        await test({ name: 'Smart blocks excess automatic related windows', automatic: true, sameHost: true,
            alive: 1, nativeAlive: 0, blocked: 2,
            makeScript: ({ target }) => `for(let i=0;i<3;i++)openTracked(${JSON.stringify(target)}+'&item='+i);` });
        await test({ name: 'A single trusted click does not authorize a popup flood', alive: 1, nativeAlive: 1, blocked: 3,
            makeScript: ({ target }) => `for(let i=0;i<4;i++)openTracked(${JSON.stringify(target)}+'&item='+i);` });
        await test({ name: 'Smart preserves a GET form in a new tab', selector: '#submit-get', alive: 1, blocked: 0 });
        await test({ name: 'Smart preserves a POST form in a new tab', selector: '#submit-post', alive: 1, blocked: 0,
            assertion: async result => assert.ok(result.observations.requests.some(request =>
                request.path === '/target' && request.method === 'POST' && request.body === 'entry=fixture-only')) });
        await test({ name: 'Smart respects submitter formaction', selector: '#submit-override', alive: 1, blocked: 0 });
        await test({ name: 'Strict recognizes the overridden same-host form target', selector: '#submit-override',
            sameHost: true, policy: 'strict', alive: 1, blocked: 0 });
        await test({ name: 'Smart preserves a legitimate blank document', alive: 1, blocked: 0,
            makeScript: () => 'const child=openTracked("about:blank");if(child){child.document.write("<!doctype html><title>Receipt preview</title><p id=receipt>Local preview</p>");child.document.close();}' });
        await test({ name: 'Blank then navigation keeps its trusted activation', alive: 1, blocked: 0,
            makeScript: ({ target }) => `const child=openTracked('about:blank');if(child)setTimeout(()=>child.location=${JSON.stringify(target)},1000);`, wait: 2600 });
        await test({ name: 'Noopener null handle does not mean the tab was blocked', alive: 1, blocked: 0,
            makeScript: ({ target }) => `openTracked(${JSON.stringify(target)},'_blank','noopener');` });
        await test({ name: 'A named iframe navigation does not create or close tabs', alive: 0, blocked: 0,
            makeScript: ({ target }) => `openTracked(${JSON.stringify(target)},'existingFrame');`,
            assertion: async (result, opener) => {
                assert.ok(opener.frames().some(frame => frame.url() === result.target));
            } });
        await test({ name: 'Trusted child survives a later strict opener navigation', selector: '#link',
            navigateOpener: true, alive: 1, blocked: 0 });
        await test({ name: 'Trusted iframe link remains usable', frame: true, alive: 1, blocked: 0 });
        await test({ name: 'Basic defers contextual automatic-popup judgments', filtering: 'basic', automatic: true,
            alive: 1, nativeAlive: 0, blocked: 0 });
        await test({ name: 'Allow policy preserves an automatic window', policy: 'allow', automatic: true,
            alive: 1, nativeAlive: 0, blocked: 0 });
        await test({ name: 'Strict explicitly blocks unrelated trusted windows', policy: 'strict', alive: 0, blocked: 1, assertNativeBlock: true });
        await test({ name: 'Compiled popup block retains authority over Allow policy', policy: 'allow', alive: 0, blocked: 1, assertNativeBlock: true,
            filters: ({ hostname, targetHost }) => `||${targetHost}^$popup,domain=${hostname}` });
        await test({ name: 'Compiled popup exception preserves an explicitly allowed window', policy: 'allow', alive: 1, blocked: 0,
            filters: ({ hostname, targetHost }) => `||${targetHost}^$popup,domain=${hostname}\n@@||${targetHost}^$popup,domain=${hostname}` });
        await test({ name: 'Off takes precedence over an explicit compiled popup block', filtering: 'off', alive: 1, blocked: 0,
            filters: ({ hostname, targetHost }) => `||${targetHost}^$popup,domain=${hostname}` });
        run.completed = true;
    } catch (error) {
        run.error = error.stack;
        console.error(`[${modeName}] setup/run error: ${error.stack}`);
    } finally {
        if ( context ) { await context.close(); }
    }
}

try {
    await runSuite(true);
    await runSuite(false);
} finally {
    for ( const timer of timers ) { clearTimeout(timer); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(await tree(extension), loadedTree, 'Loaded package source files remain unchanged');
    report.finished = new Date().toISOString();
    report.passed = report.cases.filter(result => result.passed).length;
    report.failed = report.cases.filter(result => !result.passed).length;
    report.total = report.cases.length;
    await writeFile(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, total: report.total,
        runsCompleted: report.runs.filter(run => run.completed).length,
        report: resolve(options.output, 'report.json') }));
    if ( report.failed || report.runs.some(run => run.completed !== true) ) { process.exitCode = 1; }
}
