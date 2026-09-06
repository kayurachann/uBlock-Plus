#!/usr/bin/env node
/* uBlock Plus+ native optional-firewall regression. GPL-3.0-or-later. */

import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { tmpdir } from 'node:os';

const usage = 'node tools/test-webrequest-firewall-chrome.mjs ' +
    '--extension <absolute unpacked directory> --chrome <absolute executable> ' +
    '--playwright <absolute playwright-core index.mjs> --output <absolute directory>';
const options = {};
for ( let i = 2; i < process.argv.length; i++ ) {
    const match = /^--(extension|chrome|playwright|output)(?:=(.+))?$/.exec(process.argv[i]);
    if ( match === null ) { throw new Error(usage); }
    const value = match[2] ?? process.argv[++i];
    if ( typeof value !== 'string' || isAbsolute(value) === false ) {
        throw new Error(`All paths must be explicit and absolute. ${usage}`);
    }
    options[match[1]] = resolve(value);
}
for ( const key of [ 'extension', 'chrome', 'playwright', 'output' ] ) {
    if ( options[key] === undefined ) { throw new Error(usage); }
}
const { chromium } = await import(pathToFileURL(options.playwright).href);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = resolve(options.output, stamp);
const extension = await mkdtemp(resolve(tmpdir(), 'ublock-webrequest-artifact-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tree = async (directory, prefix = '') => {
    const entries = [];
    for ( const entry of await readdir(directory, { withFileTypes: true }) ) {
        if ( entry.name === '_metadata' ) { continue; }
        const path = resolve(directory, entry.name);
        if ( entry.isDirectory() ) {
            entries.push(...await tree(path, `${prefix}${entry.name}/`));
        } else {
            entries.push({ path: prefix + entry.name, sha256: hash(await readFile(path)) });
        }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
};
await mkdir(output, { recursive: true });
await cp(options.extension, extension, {
    recursive: true,
    filter: path => path.split(/[\\/]/).includes('_metadata') === false,
});
const loadedTree = await tree(extension);
assert.deepEqual(loadedTree, await tree(options.extension));
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
assert.ok(manifest.permissions.includes('webRequestBlocking'), 'Use the optional blocking package');
assert.ok(manifest.key, 'The optional package must have a stable manifest key');
const extensionId = hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
const report = {
    started: new Date().toISOString(), options, output, extension, extensionId,
    loadedFiles: loadedTree.length, loadedTreeSHA256: hash(JSON.stringify(loadedTree)),
    runs: [], requests: [],
};
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6gAAAABJRU5ErkJggg==',
    'base64'
);
const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    report.requests.push({
        host: url.hostname, path: url.pathname, token: url.searchParams.get('case'),
        kind: url.searchParams.get('kind'), time: Date.now(),
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if ( url.pathname === '/worker.js' ) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(`fetch(${JSON.stringify(url.searchParams.get('target'))})` +
            '.then(async r=>postMessage({text:await r.text()}))' +
            '.catch(e=>postMessage({error:String(e)}));');
        return;
    }
    if ( url.pathname === '/probe' ) {
        const kind = url.searchParams.get('kind');
        response.setHeader('Content-Type', kind === 'image' ? 'image/png' :
            kind === 'script' || kind === 'worker-script' ? 'text/javascript' : 'text/html');
        response.end(kind === 'image' ? png : kind === 'worker-script'
            ? 'postMessage({text:"REAL_WORKER_SCRIPT"});'
            : kind === 'script' ? 'window.fixtureScriptLoaded=true;' : `REAL_${kind}`);
        return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Native optional-firewall fixture</title>' +
        '<h1>Local HTTP fixture</h1><p>Every response comes from this HTTP server.</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const sourceHost = 'source-fw.localhost';
const destinationHost = 'destination-fw.localhost';
const origin = host => `http://${host}:${port}`;
const baselineModes = { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] };
const allKinds = [ 'fetch', 'frame', 'image', 'script', 'worker-fetch', 'xhr' ];
const until = async (get, predicate, label, timeout = 20000) => {
    const start = Date.now();
    let value;
    do {
        value = await get();
        if ( predicate(value) ) { return value; }
        await delay(75);
    } while ( Date.now() - start < timeout );
    throw new Error(`${label}: ${JSON.stringify(value)}`);
};

async function run(withSwitch) {
    const run = { label: withSwitch ? 'allowlisted' : 'no-switch', scenarios: [] };
    report.runs.push(run);
    // Chrome's DNR database can fail on deep Windows profile paths. Keep the
    // isolated profile short while preserving its exact location in the report.
    const profile = await mkdtemp(resolve(tmpdir(), `ublock-webrequest-${run.label}-`));
    run.profile = profile;
    let context;
    let dashboard;
    let site;
    let loggerPage;
    const message = request => dashboard.evaluate(async request =>
        (await import('./js/ext.js')).sendMessage(request), request);
    const firewall = (text, permanent = false) =>
        message({ what: 'applyFirewallRules', text, permanent });
    const modes = value => message({ what: 'setFilteringModeDetails', modes: value });
    const status = async () => (await message({ what: 'getRuntimeCapabilities' }))
        .webRequestFirewall;
    const scenario = async (name, action) => {
        try {
            run.scenarios.push({ name, passed: true, details: await action() });
            console.log(`PASS ${run.label}: ${name}`);
        } catch (error) {
            run.scenarios.push({ name, passed: false, error: error.stack });
            console.error(`FAIL ${run.label}: ${name}: ${error.message}`);
            throw error;
        }
    };
    const requestsFor = token => report.requests.filter(request =>
        request.token === token && request.path === '/probe');
    const probe = async (label, expected, page = site, destination = destinationHost) => {
        const token = `${run.label}-${label}-${Date.now()}`;
        const state = await page.evaluate(async ({ destination, token }) => {
            const target = kind => `${destination}/probe?case=${token}&kind=${kind}`;
            const results = {};
            const tasks = [];
            const task = (kind, action) => tasks.push(new Promise(resolve => {
                const timer = setTimeout(() => finish({ error: 'fixture-timeout' }), 10000);
                const finish = value => { clearTimeout(timer); results[kind] = value; resolve(); };
                action(finish);
            }));
            task('fetch', done => fetch(target('fetch'))
                .then(async response => done({ text: await response.text() }))
                .catch(error => done({ error: String(error) })));
            task('xhr', done => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', target('xhr'));
                xhr.onload = () => done({ text: xhr.responseText });
                xhr.onerror = () => done({ error: 'network-error' });
                xhr.send();
            });
            for ( const [ kind, tag ] of [ [ 'image', 'img' ], [ 'script', 'script' ], [ 'frame', 'iframe' ] ] ) {
                task(kind, done => {
                    const node = document.createElement(tag);
                    node.onload = () => { node.remove(); done({ loaded: true }); };
                    node.onerror = () => { node.remove(); done({ error: 'network-error' }); };
                    node.src = target(kind);
                    document.body.append(node);
                });
            }
            task('worker-fetch', done => {
                const worker = new Worker('/worker.js?target=' + encodeURIComponent(target('worker-fetch')));
                worker.onmessage = event => { worker.terminate(); done(event.data); };
                worker.onerror = event => { worker.terminate(); done({ error: event.message || 'network-error' }); };
            });
            await Promise.all(tasks);
            return results;
        }, { destination: origin(destination), token });
        await delay(150);
        const received = requestsFor(token).map(request => request.kind).sort();
        assert.deepEqual(received, expected.slice().sort());
        for ( const [ kind, value ] of Object.entries(state) ) {
            assert.notEqual(value.error, 'fixture-timeout', kind);
            if ( kind === 'frame' ) { continue; } // A blocked iframe can still fire load.
            if ( expected.includes(kind) ) { assert.ok(value.loaded || value.text, kind); }
            else { assert.ok(value.error, kind); }
        }
        return { token, received, state };
    };
    // This deliberate, temporary test mutation isolates the new API from the
    // existing DNR firewall. It is not presented as an ordinary DNR baseline.
    const withoutFirewallDNR = async action => {
        const saved = await dashboard.evaluate(async () => {
            const { FIREWALL_RULE_BASE: base, FIREWALL_RULE_LIMIT: count } =
                await import('./js/firewall-core.js');
            const own = (await chrome.declarativeNetRequest.getSessionRules())
                .filter(rule => rule.id >= base && rule.id < base + count);
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: own.map(rule => rule.id) });
            return own;
        });
        try { return { removedDNRRules: saved.length, result: await action() }; }
        finally {
            await dashboard.evaluate(async saved => {
                const current = await chrome.declarativeNetRequest.getSessionRules();
                const ids = new Set(saved.map(rule => rule.id));
                await chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: current.filter(rule => ids.has(rule.id)).map(rule => rule.id),
                    addRules: saved,
                });
            }, saved);
        }
    };
    const stopBackground = async () => {
        const versions = [];
        const session = await context.newCDPSession(site);
        session.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
        await session.send('ServiceWorker.enable');
        const workerURL = `chrome-extension://${extensionId}/js/background.js`;
        const version = await until(() => versions.findLast(value =>
            value.scriptURL === workerURL && value.runningStatus === 'running'), Boolean, 'Running worker');
        await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
        await until(() => versions.findLast(value => value.versionId === version.versionId)?.runningStatus,
            value => value === 'stopped', 'Worker stopped');
        await session.detach();
    };
    try {
        context = await chromium.launchPersistentContext(profile, {
            executablePath: options.chrome, headless: false, ignoreDefaultArgs: true, viewport: null,
            args: [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
                '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
                '--no-default-browser-check', '--window-size=1000,800',
                ...(withSwitch ? [ `--allowlisted-extension-id=${extensionId}` ] : []) ],
        });
        context.setDefaultTimeout(20000);
        const browserCDP = await context.browser().newBrowserCDPSession();
        run.version = await browserCDP.send('Browser.getVersion');
        run.commandLine = await browserCDP.send('Browser.getBrowserCommandLine');
        for ( const argument of run.commandLine.arguments ) {
            assert.equal(/^--(no-sandbox|disable-setuid-sandbox|disable-web-security|disable-popup-blocking|headless|disable-features)(=|$)/.test(argument), false);
        }
        assert.equal((await browserCDP.send('Extensions.loadUnpacked', { path: extension })).id, extensionId);
        dashboard = await context.newPage();
        await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
        await dashboard.waitForFunction(() => document.body.classList.contains('loading') === false);
        await modes(baselineModes);
        await firewall('');
        site = await context.newPage();
        await site.goto(`${origin(sourceHost)}/`);
        await scenario('actual-granted-permission-and-status', async () => {
            const granted = await dashboard.evaluate(() =>
                chrome.permissions.contains({ permissions: [ 'webRequestBlocking' ] }));
            assert.equal(granted, withSwitch);
            const current = await until(status, value => value?.permissionGranted === withSwitch &&
                (withSwitch === false || value.ready), 'Native supplement status');
            // Chromium can accept registration silently when the permission is
            // absent; only the actual grant and ready state imply activation.
            assert.equal(current.listenerRegistered, true);
            assert.equal(current.ready, withSwitch);
            return current;
        });
        await scenario('unfiltered-real-network-baseline', () => probe('baseline', allKinds));
        await scenario('ordinary-dnr-firewall-remains-active', async () => {
            await firewall(`* ${destinationHost} * block`);
            return probe('ordinary-block', []);
        });
        await dashboard.locator('#dashboard-nav [data-pane="diagnostics"]').click();
        await until(() => dashboard.locator('#runtimeCapabilities').innerText(),
            text => text.includes(withSwitch ? 'dnr+webrequest-firewall' : 'dnr'), 'Rendered capabilities');
        await dashboard.screenshot({ path: resolve(output, `diagnostics-${run.label}.png`), fullPage: true });
        await scenario('isolated-supplement-network-coverage', async () => {
            const tabId = await dashboard.evaluate(async url =>
                (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, site.url());
            loggerPage = await context.newPage();
            await loggerPage.goto(`chrome-extension://${extensionId}/matched-rules.html?tab=${tabId}`);
            await loggerPage.locator('#start').click();
            await until(() => loggerPage.locator('#stop').isEnabled(), Boolean, 'Logger capture started');
            const result = await withoutFirewallDNR(() => probe('isolated-block', withSwitch ? [] : allKinds));
            if ( withSwitch ) {
                const rows = await until(() => loggerPage.locator('#matchedEntries').innerText(),
                    text => text.includes('browser.webRequest (firewall supplement)'), 'Explicit native source');
                result.loggerText = rows;
                await loggerPage.screenshot({ path: resolve(output, 'logger-native-supplement.png'), fullPage: true });
            }
            await loggerPage.close(); loggerPage = undefined;
            return result;
        });
        await scenario('site-off-restores-network', async () => {
            await modes({ ...baselineModes, none: [ sourceHost ] });
            const result = await probe('off', allKinds);
            await modes(baselineModes);
            return result;
        });
        for ( const action of [ 'allow', 'noop' ] ) {
            await scenario(`${action}-overrides-broader-block`, async () => {
                await firewall(`* * * block\n${sourceHost} ${destinationHost} * ${action}\n${sourceHost} ${sourceHost} * noop`);
                return probe(action, allKinds);
            });
        }
        await scenario('noop-retains-personal-static-network-rule', async () => {
            await firewall(`* * * block\n${sourceHost} ${destinationHost} * noop\n${sourceHost} ${sourceHost} * noop`);
            await message({ what: 'setSandboxFilters', text: `||${destinationHost}^$xmlhttprequest` });
            try { return await probe('noop-static', [ 'frame', 'image', 'script' ]); }
            finally { await message({ what: 'setSandboxFilters', text: '' }); }
        });
        await scenario('new-top-domain-party-rule-and-first-post-navigation-request', async () => {
            await firewall('* * 3p-script block');
            const fresh = await context.newPage();
            try {
                await fresh.goto(`${origin(`fresh-${Date.now()}.localhost`)}/`);
                return await probe('new-domain-party', allKinds.filter(kind => kind !== 'script'), fresh);
            } finally { await fresh.close(); }
        });
        await scenario('tabless-extension-fetch-is-fail-open', async () => {
            await firewall(`* ${destinationHost} * block`);
            const token = `${run.label}-tabless-${Date.now()}`;
            const worker = context.serviceWorkers().find(value => value.url() ===
                `chrome-extension://${extensionId}/js/background.js`);
            assert.ok(worker, 'Extension service worker exists');
            // An extension dashboard is still a browser tab; only the service
            // worker supplies the tabless request this assertion is about.
            const result = await worker.evaluate(async url =>
                (await fetch(url)).text(), `${origin(destinationHost)}/probe?case=${token}&kind=extension-fetch`);
            assert.equal(result, 'REAL_extension-fetch');
            assert.equal(requestsFor(token).length, 1);
            return { result, reachedServer: true };
        });
        await scenario('worker-restart-preserves-temporary-noop', async () => {
            await firewall(`* ${destinationHost} * block`, true);
            await firewall(`* ${destinationHost} * noop`);
            await stopBackground();
            // First real page traffic wakes the extension; cold state must not
            // resurrect the permanent block over the saved temporary noop.
            const result = await probe('worker-wakeup-noop', allKinds);
            const state = await message({ what: 'getFirewallState' });
            assert.equal(state.permanentText, `* ${destinationHost} * block`);
            assert.equal(state.sessionText, `* ${destinationHost} * noop`);
            const current = await until(status, value => withSwitch === false || value?.ready, 'Rehydrated supplement');
            await firewall('', true);
            return { result, state, status: current };
        });
        await scenario('worker-restart-rehydrates-existing-page-before-blocking', async () => {
            await firewall(`* ${destinationHost} * block`, true);
            await stopBackground();
            // Wake through the extension dashboard, without navigating the
            // existing fixture tab. Only assert supplemental blocking once the
            // service reports its configuration and document state are ready.
            const current = await until(status, value => withSwitch
                ? value?.ready === true : value?.state === 'permission-required', 'Rehydrated existing document');
            const result = await withoutFirewallDNR(() =>
                probe('worker-rehydrated-existing-page', withSwitch ? [] : allKinds));
            await firewall('', true);
            return { result, status: current, fixtureWasNotNavigated: true };
        });
        run.finalStatus = await status();
    } catch (error) {
        run.fatal = error.stack;
        console.error(error);
    } finally {
        await context?.close();
        run.passed = run.fatal === undefined && run.scenarios.every(value => value.passed);
    }
}

try { await run(false); await run(true); }
finally {
    await new Promise(resolve => server.close(resolve));
    report.finished = new Date().toISOString();
    report.passed = report.runs.every(run => run.passed);
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(output, 'REPORT.md'), [
        '# Native optional-firewall regression', '',
        `Result: **${report.passed ? 'PASS' : 'FAIL'}**.`,
        `Loaded tree SHA256: ${report.loadedTreeSHA256}. ${report.loadedFiles} files.`, '',
        ...report.runs.flatMap(run => [
            `## ${run.label} — ${run.version?.product}`, '',
            ...run.scenarios.map(value => `- ${value.passed ? 'PASS' : 'FAIL'}: ${value.name}`),
            run.fatal || '', '',
        ]),
        'Every response came from a real local HTTP server. No routing or CDP response replacement was used.',
        'The isolated-supplement case temporarily removes only firewall-owned session DNR rules, then restores them; this is explicitly an API isolation test, not ordinary fallback behavior.',
        'The shipped supplement is tested on supported subresource requests and tabless fail-open behavior. This suite does not claim main-navigation blocking or a complete uBO engine.',
        'The exact extension copy and Chrome profiles are isolated under the operating system temporary directory to avoid Windows path-length failures; their paths are recorded in report.json. Personal profiles, browser policies and security settings are not changed.',
    ].join('\n'));
    await writeFile(resolve(options.output, 'latest.json'), JSON.stringify({ output, passed: report.passed }, null, 2));
    console.log(`REPORT ${resolve(output, 'report.json')}`);
    process.exitCode = report.passed ? 0 : 1;
}
