#!/usr/bin/env node
/* uBlock Plus+ repeatable native Chrome microbenchmarks. GPL-3.0-or-later. */
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { tmpdir } from 'node:os';

const options = {};
for ( let i = 2; i < process.argv.length; i++ ) {
    const key = process.argv[i].slice(2);
    if ( key === 'verify-fail-open' ) {
        options.verifyFailOpen = true;
        continue;
    }
    assert.ok([ 'extension', 'chrome', 'playwright', 'output' ].includes(key));
    const value = process.argv[++i];
    assert.ok(isAbsolute(value), 'Use explicit absolute paths');
    options[key] = resolve(value);
}
for ( const key of [ 'extension', 'chrome', 'playwright', 'output' ] ) {
    assert.ok(options[key], `Missing --${key}`);
}
const { chromium } = await import(pathToFileURL(options.playwright).href);
const profile = await mkdtemp(resolve(tmpdir(), 'ublock-perf-profile-'));
const extension = await mkdtemp(resolve(tmpdir(), 'ublock-perf-package-'));
await cp(options.extension, extension, { recursive: true });
await mkdir(options.output, { recursive: true });
const hashes = {};
for ( const name of [ 'manifest.json', 'js/memory-manager.js', 'js/scripting/css-specific.js' ] ) {
    const contents = await readFile(resolve(extension, name));
    assert.deepEqual(contents, await readFile(resolve(options.extension, name)));
    hashes[name] = createHash('sha256').update(contents).digest('hex');
}
const report = {
    options, profile, extension, hashes, started: new Date().toISOString(),
    methodology: 'Instrumented native storage calls; synthetic cosmetic dictionaries, real packaged code and real DOM. No whole-browser RAM or physical low-end hardware claim.',
    cosmetic: [],
};
const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    response.end('<!doctype html><title>Cosmetic performance fixture</title>' +
        Array.from({ length: 12 }, (_, i) => `<div class="perf-ad-${i}">Fixture ${i}</div>`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://perf.localhost:${server.address().port}/`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: options.chrome, headless: false, ignoreDefaultArgs: true, viewport: null,
        args: [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
            '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
            '--no-default-browser-check', '--window-size=1000,800' ],
    });
    context.setDefaultTimeout(20000);
    const cdp = await context.browser().newBrowserCDPSession();
    report.browser = await cdp.send('Browser.getVersion');
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await dashboard.waitForFunction(() => document.body.classList.contains('loading') === false);
    const message = request => dashboard.evaluate(async request =>
        (await import('./js/ext.js')).sendMessage(request), request);
    // Only the isolated synthetic fixture is injected manually. Native stock
    // registration is disabled here to avoid mixing its work into the sample.
    const modes = { none: [], basic: [ 'all-urls' ], optimal: [], complete: [] };
    await message({ what: 'setFilteringModeDetails', modes });
    await message({ what: 'setMemoryProfile', profile: 'low-memory', deviceMemoryGiB: 2 });
    const worker = context.serviceWorkers().find(value => value.url() ===
        `chrome-extension://${id}/js/background.js`);
    assert.ok(worker);
    await message({ what: 'getMemoryProfile', deviceMemoryGiB: 2 });
    await worker.evaluate(() => {
        const original = chrome.storage.local.get.bind(chrome.storage.local);
        self.__profilePerf = { reads: 0, original };
        chrome.storage.local.get = (...args) => { self.__profilePerf.reads++; return original(...args); };
    });
    report.profileReads = { callsPerSample: 200, includesMessageRoundTrip: true, samples: [] };
    try {
        for ( let sample = 0; sample < 5; sample++ ) {
            const before = await worker.evaluate(() => self.__profilePerf.reads);
            const ms = await dashboard.evaluate(async () => {
                const { sendMessage } = await import('./js/ext.js');
                const start = performance.now();
                for ( let i = 0; i < 200; i++ ) {
                    await sendMessage({ what: 'getMemoryProfile', deviceMemoryGiB: 2 });
                }
                return performance.now() - start;
            });
            const after = await worker.evaluate(() => self.__profilePerf.reads);
            report.profileReads.samples.push({ ms, storageReads: after - before });
        }
    } finally {
        await worker.evaluate(() => {
            chrome.storage.local.get = self.__profilePerf.original;
            delete self.__profilePerf;
        });
    }
    report.fixture = await dashboard.evaluate(async () => {
        const entries = {};
        for ( let i = 0; i < 12; i++ ) {
            entries[`css.specific.perf-${i}`] = {
                hostnames: [ 'perf.localhost' ], hasEntities: false, regexes: [],
                selectors: [ `.perf-ad-${i}`, ...Array.from({ length: 8000 },
                    (_, n) => `.unused-dictionary-${i}-selector-${n}`) ],
                selectorLists: [ '0' ], selectorListRefs: [ 0 ],
            };
        }
        entries['css.specific.perf-exception'] = {
            hostnames: [ 'perf.localhost' ], hasEntities: false, regexes: [],
            selectors: [ '.perf-ad-0' ], selectorLists: [ '-1' ], selectorListRefs: [ 0 ],
        };
        await chrome.storage.local.set(entries);
        return { ids: Object.keys(entries).map(key => key.slice('css.specific.'.length)),
            jsonBytes: new TextEncoder().encode(JSON.stringify(entries)).length };
    });
    const site = await context.newPage();
    site.on('pageerror', error => console.error(`Fixture page error: ${error.message}`));
    const exec = async (func, args = [], allFrames = false) => {
        const tabId = await dashboard.evaluate(async url =>
            (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, site.url());
        assert.ok(tabId);
        return dashboard.evaluate(async ({ tabId, funcName, args, allFrames }) => {
            // Dispatch functions supplied below through executeScript, without
            // evaluating strings or changing the artifact on disk.
            const functions = {
                setup: (ids, controls = {}) => {
                    if ( self.cssAPI === undefined ) { return { error: 'cssAPI missing', url: document.URL }; }
                    if ( self.__perfOriginal ) {
                        chrome.storage.local.get = self.__perfOriginal.get;
                        chrome.storage.session.set = self.__perfOriginal.set;
                        self.cssAPI.insert = self.__perfOriginal.insert;
                    }
                    self.specificImports = ids;
                    self.__perf = { reads: 0, active: 0, peak: 0, done: false,
                        modeReadsCompleted: 0, cacheWrites: 0, insertions: 0,
                        paused: false, started: performance.now() };
                    const get = chrome.storage.local.get.bind(chrome.storage.local);
                    const set = chrome.storage.session.set.bind(chrome.storage.session);
                    const insert = self.cssAPI.insert.bind(self.cssAPI);
                    self.__perfOriginal = { get, set, insert };
                    chrome.storage.local.get = async (...args) => {
                        const state = self.__perf;
                        if ( String(args[0]).startsWith('css.specific.') === false ) {
                            const value = await get(...args);
                            if ( args[0] === 'filteringModeDetails' ) { state.modeReadsCompleted++; }
                            return value;
                        }
                        state.reads++;
                        state.active++;
                        state.peak = Math.max(state.peak, state.active);
                        try {
                            const value = await get(...args);
                            if ( args[0] === controls.pauseKey ) {
                                state.paused = true;
                                await new Promise(resolve => { self.__perfRelease = resolve; });
                                state.paused = false;
                            }
                            return value;
                        } finally { state.active--; }
                    };
                    chrome.storage.session.set = async (...args) => {
                        const result = await set(...args);
                        if ( Object.keys(args[0]).some(key => key.startsWith('cache.css.')) ) {
                            self.__perf.cacheWrites++;
                            self.__perf.done = true;
                            self.__perf.ms = performance.now() - self.__perf.started;
                        }
                        return result;
                    };
                    self.cssAPI.insert = css => {
                        self.__perf.insertions++;
                        self.__perf.done = true;
                        self.__perf.ms = performance.now() - self.__perf.started;
                        insert(css);
                    };
                    return { initialized: true, url: document.URL };
                },
                result: () => self.__perf || { done: false, missing: true, url: document.URL },
                release: () => {
                    self.__perfRelease?.();
                    delete self.__perfRelease;
                    return true;
                },
            };
            const results = await chrome.scripting.executeScript({
                target: { tabId, allFrames }, world: 'ISOLATED', func: functions[funcName], args,
            });
            return allFrames ? results.map(value => value.result) : results[0].result;
        }, { tabId, funcName: func, args, allFrames });
    };
    const inject = async (files, allFrames = false) => dashboard.evaluate(async ({ url, files, allFrames }) => {
        const tabId = (await chrome.tabs.query({})).find(tab => tab.url === url)?.id;
        await chrome.scripting.executeScript({ target: { tabId, allFrames }, world: 'ISOLATED', files });
    }, { url: site.url(), files, allFrames });
    for ( const selected of [ 'low-memory', 'balanced' ] ) {
        await message({ what: 'setMemoryProfile', profile: selected, deviceMemoryGiB: 2 });
        for ( const kind of [ 'cold-1', 'cold-2', 'cold-3', 'warm', 'off', 're-enabled' ] ) {
            // Direct test-profile writes preserve fixture dictionaries while
            // exercising the content script's own Off predicate.
            await dashboard.evaluate(async ({ off, clear, modes }) => {
                await chrome.storage.local.set({ filteringModeDetails: {
                    ...modes, none: off ? [ 'perf.localhost' ] : [],
                } });
                if ( clear ) { await chrome.storage.session.remove('cache.css.perf.localhost'); }
            }, { off: kind === 'off', clear: kind !== 'warm', modes });
            await site.goto(url);
            await inject([ 'js/scripting/css-api.js', 'js/scripting/isolated-api.js' ]);
            const setup = await exec('setup', [ report.fixture.ids ]);
            assert.ok(setup?.initialized, JSON.stringify(setup));
            await inject([ 'js/scripting/css-specific.js' ]);
            let metrics;
            for ( let i = 0; i < 200; i++ ) {
                metrics = await exec('result');
                assert.ok(metrics, 'Metrics are serializable');
                assert.equal(metrics.missing, undefined, JSON.stringify(metrics));
                if ( metrics.done ) { break; }
                await delay(25);
            }
            assert.ok(metrics.done, 'Content script completed');
            if ( kind !== 'off' ) { await site.locator('.perf-ad-1').waitFor({ state: 'hidden' }); }
            const visible = await site.locator('[class^="perf-ad-"]').evaluateAll(nodes =>
                nodes.map(node => getComputedStyle(node).display !== 'none'));
            assert.deepEqual(visible, Array.from({ length: 12 }, (_, i) => kind === 'off' || i === 0));
            if ( kind === 'warm' ) { assert.equal(metrics.reads, 0); }
            else if ( kind !== 'off' ) { assert.equal(metrics.reads, report.fixture.ids.length); }
            const pageCDP = await context.newCDPSession(site);
            await pageCDP.send('HeapProfiler.collectGarbage');
            const retainedPageHeap = await pageCDP.send('Runtime.getHeapUsage');
            await pageCDP.detach();
            report.cosmetic.push({ profile: selected, kind, ...metrics, visible, retainedPageHeap });
            console.log(`${selected} ${kind}: ${metrics.reads} reads, peak ${metrics.peak}, ${metrics.ms.toFixed(1)} ms`);
        }
    }
    if ( options.verifyFailOpen ) {
        report.quality = [];
        const readVisibility = frame => frame.locator('[class^="perf-ad-"]').evaluateAll(nodes =>
            nodes.map(node => getComputedStyle(node).display !== 'none'));
        const cachePresent = () => dashboard.evaluate(async () =>
            Object.hasOwn(await chrome.storage.session.get('cache.css.perf.localhost'),
                'cache.css.perf.localhost'));
        const resetFixture = async () => dashboard.evaluate(async modes => {
            await chrome.storage.local.set({ filteringModeDetails: modes });
            await chrome.storage.session.remove('cache.css.perf.localhost');
        }, modes);
        const waitForMetrics = async (predicate, allFrames = false) => {
            for ( let i = 0; i < 200; i++ ) {
                const metrics = await exec('result', [], allFrames);
                if ( predicate(metrics) ) { return metrics; }
                await delay(25);
            }
            throw new Error('Quality fixture did not reach the expected native state');
        };
        const settleDOM = () => site.evaluate(() => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await message({ what: 'setMemoryProfile', profile: 'low-memory', deviceMemoryGiB: 2 });
        await resetFixture();
        const exception = await dashboard.evaluate(async () => {
            const key = 'css.specific.perf-exception';
            const bin = await chrome.storage.local.get(key);
            await chrome.storage.local.remove(key);
            return bin[key];
        });
        assert.ok(exception);
        await site.goto(url);
        await inject([ 'js/scripting/css-api.js', 'js/scripting/isolated-api.js' ]);
        await exec('setup', [ report.fixture.ids ]);
        await inject([ 'js/scripting/css-specific.js' ]);
        const missingMetrics = await waitForMetrics(metrics =>
            metrics.reads === report.fixture.ids.length && metrics.active === 0);
        await settleDOM();
        const missingVisible = await readVisibility(site);
        assert.ok(missingVisible.every(Boolean), 'Missing exception dictionary must leave every element visible');
        assert.equal(await cachePresent(), false, 'Partial results must not reach the native session cache');
        assert.equal(missingMetrics.cacheWrites, 0);
        assert.equal(missingMetrics.insertions, 0);
        report.quality.push({ kind: 'missing-exception-fails-open', ...missingMetrics, visible: missingVisible,
            cachePresent: false });

        // Restore the real native storage record and retry on the same document.
        await dashboard.evaluate(async exception => {
            await chrome.storage.local.set({ 'css.specific.perf-exception': exception });
        }, exception);
        await exec('setup', [ report.fixture.ids ]);
        await inject([ 'js/scripting/css-specific.js' ]);
        const retryMetrics = await waitForMetrics(metrics => metrics.done && metrics.active === 0);
        await site.locator('.perf-ad-1').waitFor({ state: 'hidden' });
        const retryVisible = await readVisibility(site);
        assert.deepEqual(retryVisible, Array.from({ length: 12 }, (_, i) => i === 0));
        assert.equal(await cachePresent(), true);
        assert.equal(retryMetrics.reads, report.fixture.ids.length);
        report.quality.push({ kind: 'restored-exception-same-document-retry', ...retryMetrics,
            visible: retryVisible, cachePresent: true });

        await resetFixture();
        await site.goto(url);
        await inject([ 'js/scripting/css-api.js', 'js/scripting/isolated-api.js' ]);
        await exec('setup', [ report.fixture.ids, { pauseKey: 'css.specific.perf-5' } ]);
        await inject([ 'js/scripting/css-specific.js' ]);
        await waitForMetrics(metrics => metrics.paused);
        await dashboard.evaluate(async modes => {
            await chrome.storage.local.set({ filteringModeDetails: { ...modes, none: [ 'perf.localhost' ] } });
            await chrome.storage.session.remove('cache.css.perf.localhost');
        }, modes);
        await exec('release');
        const canceledMetrics = await waitForMetrics(metrics => metrics.reads === report.fixture.ids.length &&
            metrics.active === 0 && metrics.modeReadsCompleted === 2);
        await settleDOM();
        const canceledVisible = await readVisibility(site);
        assert.ok(canceledVisible.every(Boolean), 'Off during native dictionary loading must cancel filtering');
        assert.equal(await cachePresent(), false, 'Canceled lookup must not repopulate the cache');
        assert.equal(canceledMetrics.cacheWrites, 0);
        assert.equal(canceledMetrics.insertions, 0);
        report.quality.push({ kind: 'off-during-native-read-cancels', ...canceledMetrics,
            visible: canceledVisible, cachePresent: false });

        await message({ what: 'setMemoryProfile', profile: 'balanced', deviceMemoryGiB: 2 });
        await resetFixture();
        await site.goto(url);
        await site.evaluate(async frameURL => {
            const frame = document.createElement('iframe');
            const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
            frame.src = frameURL;
            document.body.append(frame);
            await loaded;
        }, `${url}child`);
        assert.equal(site.frames().length, 2);
        await inject([ 'js/scripting/css-api.js', 'js/scripting/isolated-api.js' ], true);
        const frameSetups = await exec('setup', [ report.fixture.ids ], true);
        assert.equal(frameSetups.length, 2);
        assert.ok(frameSetups.every(value => value.initialized));
        await inject([ 'js/scripting/css-specific.js' ], true);
        const frameMetrics = await waitForMetrics(metrics => metrics.length === 2 &&
            metrics.every(value => value.done && value.active === 0), true);
        for ( const [ index, frame ] of site.frames().entries() ) {
            await frame.locator('.perf-ad-1').waitFor({ state: 'hidden' });
            const visible = await readVisibility(frame);
            assert.deepEqual(visible, Array.from({ length: 12 }, (_, i) => i === 0));
            assert.ok(frameMetrics[index].peak <= 2, 'Each frame keeps its own bounded lookup budget');
            report.quality.push({ kind: 'concurrent-same-origin-frame', frameURL: frame.url(),
                ...frameMetrics[index], visible });
        }
        console.log(`Native cosmetic quality: ${report.quality.length} checks passed.`);
    }
    report.passed = true;
} catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
} finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await writeFile(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, error: report.error, output: options.output }));
