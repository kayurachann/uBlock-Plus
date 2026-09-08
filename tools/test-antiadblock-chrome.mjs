#!/usr/bin/env node
/* uBlock Plus+ native anti-adblock regressions. GPL-3.0-or-later. */
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
const profile = await mkdtemp(resolve(tmpdir(), 'ubp-anti-profile-'));
const extension = await mkdtemp(resolve(tmpdir(), 'ubp-anti-artifact-'));
await cp(options.extension, extension, { recursive: true,
    filter: path => !path.split(/[\\/]/).includes('_metadata') });
await mkdir(options.output, { recursive: true });
const loadedTree = await tree(extension);
assert.deepEqual(loadedTree, await tree(options.extension));
const report = { started: new Date().toISOString(), options, profile, extension,
    loadedFiles: loadedTree.length, loadedTreeSHA256: hash(JSON.stringify(loadedTree)),
    version: JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')).version,
    methodology: 'Unmodified package, real Chrome compiler/userScripts/DNR and local HTTP fixtures. User Scripts is enabled through Chrome UI in an isolated profile. No injected replacement engine, mocked network responses or external website scoring.',
    setupStage: 'launch', diagnostics: [], cases: [], requests: [], observations: [] };
const diagnose = (kind, details) => {
    if ( report.diagnostics.length >= 100 ) { report.diagnostics.shift(); }
    report.diagnostics.push({ at: new Date().toISOString(), kind, details });
};
let token = 0;
const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    report.requests.push({ host: url.hostname, path: url.pathname, token: url.searchParams.get('case') });
    response.setHeader('Cache-Control', 'no-store');
    if ( url.pathname.endsWith('.js') ) {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(url.pathname === '/real-ad.js' ? 'window.adPayload = true;' : 'window.baitPayload = true;');
        return;
    }
    response.setHeader('Content-Type', 'text/html');
    if ( url.pathname === '/parent' ) {
        response.end(`<!doctype html><title>Ancestor fixture</title><iframe src="http://child.anti.localhost:${server.address().port}/?case=${url.searchParams.get('case')}"></iframe>`);
        return;
    }
    const source = `http://assets.anti.localhost:${server.address().port}`;
    response.end(`<!doctype html><meta charset="utf-8"><title>Anti-adblock regression fixture</title>
<script>window.adblockDetected = true; window.adPayload = false; window.baitPayload = false; window.baitLoaded = false;</script>
<script src="${source}/real-ad.js?case=${url.searchParams.get('case')}"></script>
<script src="${source}/bait.js?case=${url.searchParams.get('case')}" onload="window.baitLoaded = true"></script>
<style>body{font:18px system-ui;padding:30px}.ad-bait{width:80px;height:20px}#content{padding:20px;background:#d9fbe3}</style>
<div class="ad-bait">Bait</div><div class="real-ad">Advertisement fixture</div>
<h1 id="wall">Please disable your ad blocker</h1><section id="content" hidden>Article is available <button onclick="this.textContent='Interaction works'">Read article</button></section>
<script>document.querySelector('#wall').hidden = window.adblockDetected === false;
document.querySelector('#content').hidden = window.adblockDetected !== false;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = hostname => `http://${hostname}:${server.address().port}`;
const { chromium } = await import(pathToFileURL(options.playwright).href);
let context;
const check = async (name, action) => {
    const result = { name };
    try { result.details = await action(); result.passed = true; }
    catch (error) { result.passed = false; result.error = error.stack; }
    report.cases.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name}${result.passed ? '' : `: ${result.error}`}`);
};
try {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: options.chrome, headless: false, ignoreDefaultArgs: true,
        viewport: { width: 1120, height: 850 },
        args: [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
            '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
            '--no-default-browser-check', '--mute-audio' ],
    });
    context.on('page', page => {
        page.on('console', event => {
            if ( ![ 'warning', 'error' ].includes(event.type()) ) { return; }
            diagnose('page-console', { url: page.url(), type: event.type(), text: event.text().slice(0, 1000) });
        });
        page.on('pageerror', error => diagnose('page-error', { url: page.url(), error: error.message.slice(0, 1000) }));
        page.on('crash', () => diagnose('page-crash', { url: page.url() }));
    });
    const cdp = await context.browser().newBrowserCDPSession();
    report.browser = await cdp.send('Browser.getVersion');
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    report.extensionId = id;
    const workerURL = `chrome-extension://${id}/js/background.js`;
    const settings = await context.newPage();
    const versions = new Map();
    const workerSession = await context.newCDPSession(settings);
    workerSession.on('ServiceWorker.workerVersionUpdated', event => {
        const relevant = event.versions.filter(version => version.scriptURL === workerURL);
        for ( const version of relevant ) { versions.set(version.versionId, version); }
        while ( versions.size > 32 ) { versions.delete(versions.keys().next().value); }
        if ( relevant.length === 0 ) { return; }
        diagnose('worker-versions', relevant.map(version => ({
            versionId: version.versionId, scriptURL: version.scriptURL,
            runningStatus: version.runningStatus, status: version.status,
        })));
    });
    workerSession.on('ServiceWorker.workerErrorReported', event => {
        if ( !event.errorMessage.sourceURL?.startsWith(`chrome-extension://${id}/`) ) { return; }
        diagnose('worker-error', { ...event.errorMessage,
            errorMessage: event.errorMessage.errorMessage.slice(0, 1000) });
    });
    await workerSession.send('ServiceWorker.enable');
    // Finish the initial installation before stopping its worker. Otherwise the
    // permission restart can interrupt first-run configuration and invalidate
    // the test's setup before any filtering assertion has run.
    report.setupStage = 'initial-dashboard';
    const initialDashboard = await context.newPage();
    await initialDashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await initialDashboard.waitForFunction(() => !document.body.classList.contains('loading'));
    report.initialModes = await initialDashboard.evaluate(async () =>
        (await import('./js/ext.js')).sendMessage({ what: 'getFilteringModeDetails' }));
    assert.ok(report.initialModes && Array.isArray(report.initialModes.complete), 'Initial worker serves filtering configuration');
    report.initialDashboardReadyBeforeUserScriptsToggle = true;
    await check('packaged allow regexes are supported and stock DNR is initialized', async () => {
        const native = await initialDashboard.evaluate(async () => ({
            enabled: await chrome.declarativeNetRequest.getEnabledRulesets(),
            dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
            session: await chrome.declarativeNetRequest.getSessionRules(),
        }));
        const details = JSON.parse(await readFile(resolve(extension, 'rulesets/ruleset-details.json'), 'utf8'));
        const allowRules = [];
        let stockRegexRules = 0;
        for ( const list of native.enabled ) {
            if ( !details.find(entry => entry.id === list)?.rules.regex ) { continue; }
            const rules = JSON.parse(await readFile(resolve(extension, `rulesets/regex/${list}.json`), 'utf8'));
            stockRegexRules += rules.length;
            for ( const rule of rules ) {
                if ( ![ 'allow', 'allowAllRequests' ].includes(rule.action.type) ) { continue; }
                if ( typeof rule.condition.regexFilter !== 'string' ) { continue; }
                const options = { regex: rule.condition.regexFilter,
                    isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
                    requireCapturing: rule.action.redirect?.regexSubstitution !== undefined };
                const result = await initialDashboard.evaluate(options =>
                    chrome.declarativeNetRequest.isRegexSupported(options), options);
                allowRules.push({ list, id: rule.id, regexSHA256: hash(options.regex),
                    isCaseSensitive: options.isCaseSensitive, requireCapturing: options.requireCapturing,
                    ...result });
            }
        }
        const stockDynamicCount = native.dynamic.filter(rule =>
            rule.id > 0 && rule.id < 5000000 && typeof rule.condition.regexFilter === 'string').length;
        report.nativeStockStartup = { enabled: native.enabled, stockRegexRules, stockDynamicCount,
            dynamicCount: native.dynamic.length, sessionCount: native.session.length, allowRules };
        assert.deepEqual(allowRules.filter(rule => rule.isSupported !== true), [],
            'Every packaged allow regex must be representable by the native engine');
        assert.ok(stockRegexRules > 0, 'The default package must contain stock regex rules');
        // Native installation may finish while the per-rule probes run. After
        // checking every allow, observe current DNR state instead of asserting
        // against the snapshot taken before those asynchronous probes.
        await initialDashboard.waitForFunction(async () =>
            (await chrome.declarativeNetRequest.getDynamicRules()).some(rule =>
                rule.id > 0 && rule.id < 5000000 && typeof rule.condition.regexFilter === 'string'),
        null, { timeout: 30000, polling: 100 });
        const installed = await initialDashboard.evaluate(async () => ({
            dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
            session: await chrome.declarativeNetRequest.getSessionRules(),
        }));
        report.nativeStockStartup.stockDynamicCount = installed.dynamic.filter(rule =>
            rule.id > 0 && rule.id < 5000000 && typeof rule.condition.regexFilter === 'string').length;
        report.nativeStockStartup.dynamicCount = installed.dynamic.length;
        report.nativeStockStartup.sessionCount = installed.session.length;
        assert.ok(report.nativeStockStartup.stockDynamicCount > 0,
            'The default stock regex rules must actually be installed after initial startup');
        const startupErrors = report.diagnostics.filter(event => event.kind === 'worker-error' &&
            /allow exception.*unsupported regex|startSession\/DNR refresh|updateDynamicAndSessionRules\//i.test(event.details.errorMessage));
        assert.deepEqual(startupErrors, [], 'Stock DNR startup must not report a failed refresh');
        return report.nativeStockStartup;
    });
    await initialDashboard.close();
    report.setupStage = 'enable-user-scripts';
    await settings.goto(`chrome://extensions/?id=${id}`);
    const userScripts = settings.locator('extensions-detail-view #allow-user-scripts cr-toggle');
    await userScripts.waitFor();
    if ( await userScripts.evaluate(element => element.checked) === false ) { await userScripts.click(); }
    assert.equal(await userScripts.evaluate(element => element.checked), true);
    // Chrome exposes the newly granted capability in fresh extension contexts.
    // Follow the documented restart step before testing USER_SCRIPT messaging.
    report.setupStage = 'restart-worker';
    const until = async predicate => {
        for ( let i = 0; i < 100; i++ ) {
            const value = predicate();
            if ( value ) { return value; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Service worker transition timed out');
    };
    const version = await until(() => Array.from(versions.values()).findLast(value =>
        value.scriptURL === workerURL && value.runningStatus === 'running'));
    await workerSession.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await until(() => versions.get(version.versionId)?.runningStatus === 'stopped');
    report.workerRestartedAfterUserScriptsToggle = true;
    report.setupStage = 'restarted-dashboard';
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await dashboard.waitForFunction(() => !document.body.classList.contains('loading'));
    await dashboard.waitForFunction(() => typeof chrome.userScripts?.getScripts === 'function');
    await dashboard.evaluate(() => chrome.userScripts.getScripts());
    await workerSession.detach();
    await settings.close();
    report.setupStage = 'filtering-cases';
    const message = request => dashboard.evaluate(async request =>
        (await import('./js/ext.js')).sendMessage(request), request);
    const setMode = mode => message({ what: 'setFilteringModeDetails', modes: {
        none: mode === 'off' ? [ 'all-urls' ] : [], basic: mode === 'basic' ? [ 'all-urls' ] : [],
        optimal: [], complete: mode === 'complete' ? [ 'all-urls' ] : [],
    } });
    await setMode('complete');
    await message({ what: 'setMemoryProfile', profile: 'low-memory', deviceMemoryGiB: 2 });
    const apply = text => message({ what: 'setSandboxFilters', text });
    const inspect = async (hostname = 'anti.localhost', path = '/') => {
        const page = await context.newPage();
        const failures = [];
        page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
        const caseToken = String(++token);
        await page.goto(`${origin(hostname)}${path}?case=${caseToken}`, { waitUntil: 'load' });
        const frame = path === '/parent' ? page.frames().find(f => f.url().startsWith(origin('child.anti.localhost'))) : page;
        assert.ok(frame, 'Fixture frame loaded');
        const state = await frame.evaluate(() => ({
            detected: window.adblockDetected, ad: window.adPayload, baitPayload: window.baitPayload,
            baitLoaded: window.baitLoaded, baitVisible: document.querySelector('.ad-bait').offsetHeight > 0,
            realAdVisible: document.querySelector('.real-ad').offsetHeight > 0,
            contentVisible: !document.querySelector('#content').hidden,
        }));
        state.requests = report.requests.filter(request => request.token === caseToken);
        state.failures = failures;
        report.observations.push({ case: report.cases.length + 1, hostname, path, state });
        return { page, frame, state };
    };
    const withPage = async (callback, hostname, path) => {
        const value = await inspect(hostname, path);
        try { await callback(value); return value.state; }
        finally { await value.page.close(); }
    };
    const protection = [
        'anti.localhost##+js(set, adblockDetected, false)',
        '/real-ad.js$script,domain=anti.localhost,to=assets.anti.localhost',
        '/bait.js$script,domain=anti.localhost,to=assets.anti.localhost,redirect=noopjs',
        'anti.localhost##.real-ad', 'anti.localhost##.ad-bait', 'anti.localhost#@#.ad-bait',
    ].join('\n');
    await check('unfiltered positive control exposes detector and network payload', async () => {
        await apply('');
        await setMode('off');
        try { return await withPage(({ state }) => { assert.equal(state.detected, true); assert.equal(state.ad, true); assert.equal(state.baitPayload, true); }); }
        finally { await setMode('complete'); }
    });
    const assertProtected = async ({ page, state }) => {
        assert.equal(state.detected, false);
        assert.equal(state.contentVisible, true);
        assert.equal(state.ad, false);
        assert.equal(state.baitLoaded, true, 'Redirect supplies a successful harmless script load');
        assert.equal(state.baitPayload, false);
        await page.waitForFunction(() => document.querySelector('.real-ad').offsetHeight === 0 &&
            document.querySelector('.ad-bait').offsetHeight > 0, null, { timeout: 10000 });
        state.baitVisible = true;
        state.realAdVisible = false;
        assert.equal(state.requests.filter(request => request.path.endsWith('.js')).length, 0);
        await page.getByRole('button', { name: 'Read article' }).click();
        assert.equal(await page.getByRole('button').innerText(), 'Interaction works');
    };
    await check('scoped scriptlet, redirect and bait exception preserve usable content', async () => {
        await apply(protection);
        return withPage(assertProtected);
    });
    await check('inactive MV2 and Firefox branches cannot cancel anti-adblock protection', async () => {
        await apply(`!#if env_mv3\n${protection}\n!#else\nanti.localhost#@#+js(set, adblockDetected, false)\n/real-ad.js$script,domain=anti.localhost,to=assets.anti.localhost,badfilter\n!#endif\n!#if env_firefox\n@@||assets.anti.localhost^$script\n!#endif`);
        return withPage(async value => {
            await assertProtected(value);
            await value.page.screenshot({ path: resolve(options.output, 'conditional-anti-adblock.png') });
        });
    });
    await check('Off restores page scripts, bait and original network', async () => {
        await setMode('off');
        try { return await withPage(({ state }) => {
            assert.equal(state.detected, true); assert.equal(state.ad, true);
            assert.equal(state.baitPayload, true); assert.equal(state.realAdVisible, true);
        }); } finally { await setMode('complete'); }
    });
    await check('Basic mode honors explicitly opted-in personal scriptlets and network filters', async () => {
        await apply(protection); await setMode('basic');
        try { return await withPage(({ state }) => { assert.equal(state.detected, false); assert.equal(state.ad, false); }); }
        finally { await setMode('complete'); }
    });
    await check('ordinary network exception wins over the redirect', async () => {
        await apply(`${protection}\n@@/bait.js$script,domain=anti.localhost,to=assets.anti.localhost`);
        return withPage(({ state }) => { assert.equal(state.baitPayload, true); assert.equal(state.baitLoaded, true); });
    });
    await check('AdGuard detector alias loads the packaged nofab API without the original script', async () => {
        await apply('/bait.js$script,domain=anti.localhost,to=assets.anti.localhost,redirect=prevent-fab-3.2.0');
        return withPage(async ({ page, state }) => {
            assert.equal(state.baitLoaded, true);
            assert.equal(state.baitPayload, false);
            assert.equal(state.requests.some(request => request.path === '/bait.js'), false);
            state.detectorAPI = await page.evaluate(() => {
                const result = { detected: 0, notDetected: 0 };
                window.blockAdBlock.onDetected(() => result.detected++)
                    .onNotDetected(() => result.notDetected++);
                return result;
            });
            assert.deepEqual(state.detectorAPI, { detected: 0, notDetected: 1 });
        });
    });
    await check('entity-only scriptlet exception prevents intervention', async () => {
        await apply('anti.localhost##+js(set, adblockDetected, false)\nanti.*#@#+js(set, adblockDetected, false)');
        return withPage(({ state }) => { assert.equal(state.detected, true); });
    });
    await check('ancestor-only exception protects child frame', async () => {
        const childScriptlet = 'child.anti.localhost##+js(set, adblockDetected, false)';
        await apply(childScriptlet);
        const withoutException = await withPage(({ state }) => {
            assert.equal(state.detected, false, 'The scriptlet must intervene in the child frame without an exception');
            assert.equal(state.contentVisible, true);
        }, 'parent.anti.localhost', '/parent');
        await apply(`${childScriptlet}\nparent.anti.localhost>>#@#+js(set, adblockDetected, false)`);
        const withException = await withPage(({ state }) => {
            assert.equal(state.detected, true);
            assert.equal(state.contentVisible, false);
        }, 'parent.anti.localhost', '/parent');
        return { withoutException, withException };
    });
    await check('unknown conditional rejects update and preserves prior protection', async () => {
        await apply(protection);
        await assert.rejects(apply('!#if env_unknown_future\n@@||assets.anti.localhost^$script\n!#endif'), /Unsupported filter condition/);
        return withPage(assertProtected);
    });
    report.registeredUserScripts = await dashboard.evaluate(async () =>
        (await chrome.userScripts.getScripts()).map(script => ({ id: script.id, world: script.world, runAt: script.runAt })));
} catch (error) {
    report.fatal = error.stack;
    console.error(error);
    report.fatalPages = await Promise.all((context?.pages() || []).map(async page => {
        const url = page.url();
        try {
            const state = await Promise.race([
                page.evaluate(() => ({ readyState: document.readyState,
                    loading: document.body?.classList.contains('loading'),
                    userScriptsAvailable: typeof chrome.userScripts?.getScripts === 'function' })),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Diagnostic read timed out')), 2000)),
            ]);
            return { url, state };
        } catch (diagnosticError) { return { url, error: diagnosticError.message }; }
    }));
}
finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    report.finished = new Date().toISOString();
    report.passed = !report.fatal && report.cases.length === 11 && report.cases.every(value => value.passed);
    await writeFile(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`REPORT ${resolve(options.output, 'report.json')}`);
    process.exitCode = report.passed ? 0 : 1;
}
