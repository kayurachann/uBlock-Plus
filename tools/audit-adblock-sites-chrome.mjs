import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { tmpdir } from 'node:os';

// Observational audit, intentionally excluded from npm test: live services,
// geography and browser network failures can make scores inconclusive.
const options = {};
for ( let i = 2; i < process.argv.length; i++ ) {
    const key = process.argv[i].replace(/^--/, '');
    assert.ok([ 'extension', 'chrome', 'playwright', 'output', 'sites', 'modes' ].includes(key));
    const value = process.argv[++i];
    if ( key === 'sites' || key === 'modes' ) { options[key] = value.split(','); continue; }
    assert.ok(isAbsolute(value), 'Use explicit absolute paths');
    options[key] = resolve(value);
}
for ( const key of [ 'extension', 'chrome', 'playwright', 'output' ] ) {
    assert.ok(options[key], `Missing --${key}`);
}
const extensionSource = options.extension;
const output = options.output;
const { chromium } = await import(pathToFileURL(options.playwright));
const manifest = JSON.parse(await readFile(resolve(extensionSource, 'manifest.json'), 'utf8'));
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
const sourceTree = await tree(extensionSource);
const allSites = [
    { id: 'adblock-tester', url: 'https://adblock-tester.com/', wait: 18000 },
    { id: 'turtlecute', url: 'https://adblock.turtlecute.org/', wait: 18000 },
    { id: 'primavera-recipe', url: 'https://www.primaverakitchen.com/garlic-butter-lamb-chops/', wait: 18000 },
    { id: 'uploadvr', url: 'https://www.uploadvr.com/', wait: 18000 },
    { id: 'money', url: 'https://www.money.pl/', wait: 16000 },
    { id: 'samplette', url: 'https://samplette.io/97436653', wait: 16000 },
];
assert.ok(!options.sites || options.sites.every(id => allSites.some(site => site.id === id)));
const corpus = options.sites ? allSites.filter(site => options.sites.includes(site.id)) : allSites;
const requestedModes = options.modes || [ 'off', 'complete' ];
assert.ok(requestedModes.length > 0 && requestedModes.every(mode => [ 'off', 'complete' ].includes(mode)));
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), version: manifest.version, extensionSource,
    loadedFiles: sourceTree.length, loadedTreeSHA256: hash(JSON.stringify(sourceTree)),
    methodology: 'Real Chrome; separate clean profiles for global Off and Complete; unchanged packaged lists, no custom test-site filters, no mocked responses. Live-page observations are not assertions of universal protection. Audio muted. No login; reject optional cookies and close newsletter overlays through visible controls when needed for the recipe and Samplette interactions. At most 1500 requests/page before abandoning an inconclusive page.', runs: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for ( const mode of requestedModes ) {
    const profile = await mkdtemp(resolve(tmpdir(), 'ubp-aa-live-profile-'));
    const extension = await mkdtemp(resolve(tmpdir(), 'ubp-aa-live-package-'));
    await cp(extensionSource, extension, { recursive: true, filter: path => !path.split(/[\\/]/).includes('_metadata') });
    assert.deepEqual(await tree(extension), sourceTree);
    const run = { mode, profile, extension, pages: [] };
    report.runs.push(run);
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, {
            executablePath: options.chrome,
            headless: false, ignoreDefaultArgs: true, viewport: { width: 1280, height: 900 },
            args: [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
                '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
                '--no-default-browser-check', '--mute-audio', '--window-size=1320,1000' ],
        });
        context.setDefaultTimeout(20000);
        const cdp = await context.browser().newBrowserCDPSession();
        run.browser = await cdp.send('Browser.getVersion');
        const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
        run.extensionId = id;
        const dashboard = await context.newPage();
        await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
        await dashboard.waitForFunction(() => !document.body.classList.contains('loading'));
        const message = request => dashboard.evaluate(async request => (await import('./js/ext.js')).sendMessage(request), request);
        const modes = { none: [], basic: [], optimal: [], complete: [] };
        modes[mode === 'off' ? 'none' : 'complete'] = ['all-urls'];
        await message({ what: 'setFilteringModeDetails', modes });
        run.nativeState = await dashboard.evaluate(async () => ({
            manifest: chrome.runtime.getManifest().version,
            rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
            registeredScripts: (await chrome.scripting.getRegisteredContentScripts()).map(s => ({ id: s.id, world: s.world, runAt: s.runAt })),
            userScriptsAvailable: typeof chrome.userScripts,
        }));
        assert.equal(run.nativeState.manifest, manifest.version);
        for ( const site of corpus ) {
            const page = await context.newPage();
            const item = { id: site.id, url: site.url, started: new Date().toISOString(), requestCount: 0, failures: {}, pageErrors: [], interactions: [] };
            run.pages.push(item);
            page.on('request', () => {
                item.requestCount++;
                if ( item.requestCount !== 1501 ) { return; }
                item.inconclusive = 'request-budget-exceeded';
                page.close().catch(() => {});
            });
            page.on('requestfailed', request => {
                const reason = request.failure()?.errorText || 'unknown';
                item.failures[reason] = (item.failures[reason] || 0) + 1;
            });
            page.on('pageerror', error => { if (item.pageErrors.length < 10) item.pageErrors.push(error.message.slice(0,500)); });
            page.on('dialog', dialog => dialog.dismiss());
            page.on('popup', popup => popup.close());
            try {
                const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                item.status = response?.status();
                await delay(site.wait);
                if ( site.id === 'primavera-recipe' ) {
                    for ( const frame of page.frames() ) {
                        const reject = frame.getByText('Reject All', { exact: true }).first();
                        if ( await reject.isVisible() ) {
                            await reject.click({ timeout: 5000 });
                            item.interactions.push({ action: 'Reject optional cookies' });
                        }
                    }
                    const closeNewsletter = page.locator('.formkit-overlay').getByRole('button', { name: 'Close', exact: true });
                    if ( await closeNewsletter.isVisible() ) {
                        await closeNewsletter.click({ timeout: 5000 });
                        item.interactions.push({ action: 'Close newsletter form without submitting' });
                    }
                    const jump = page.getByRole('link', { name: /^jump to recipe$/i }).first();
                    if ( await jump.count() ) {
                        try {
                            await jump.click({ timeout: 7000 });
                            await delay(1000);
                            item.interactions.push({ action: 'Jump to Recipe', clicked: true,
                                scrollY: await page.evaluate(() => scrollY) });
                        } catch (error) { item.interactions.push({ action: 'Jump to Recipe', error: error.message }); }
                    } else { item.interactions.push({ action: 'Jump to Recipe', available: false }); }
                }
                if ( site.id === 'samplette' ) {
                    const reject = page.getByRole('button', { name: 'Reject', exact: true });
                    if ( await reject.isVisible() ) { await reject.click(); item.interactions.push({ action: 'Reject optional cookies' }); }
                    const before = page.url();
                    try {
                        await page.getByRole('button', { name: 'Random (D)', exact: true }).click({ timeout: 7000 });
                        await delay(10000);
                        item.interactions.push({ action: 'Random next track', before, after: page.url(), title: await page.title(), naturalPlaybackEndTested: false });
                    } catch (error) { item.interactions.push({ action: 'Random next track', error: error.message }); }
                }
                item.finalURL = page.url();
                item.title = await page.title();
                item.observation = await page.evaluate(() => ({
                    text: document.body?.innerText.slice(0, 35000),
                    headings: Array.from(document.querySelectorAll('h1,h2')).slice(0,25).map(e=>e.textContent.trim()),
                    buttons: Array.from(document.querySelectorAll('button,input[type=button]')).filter(e => e.getBoundingClientRect().width > 0).slice(0,35).map(e=>({text:e.textContent.trim().slice(0,120),label:e.getAttribute('aria-label'),title:e.getAttribute('title')})),
                    frames: Array.from(document.querySelectorAll('iframe')).slice(0,15).map(e=>({title:e.title, src:e.src.slice(0,200)})),
                }));
                const imageName = `${mode}-${site.id}.png`;
                // Capture the actual viewport without waiting for remote fonts
                // or animation stability on an externally controlled page.
                const screenshotSession = await context.newCDPSession(page);
                try {
                    const screenshot = await screenshotSession.send('Page.captureScreenshot', { format: 'png' });
                    await writeFile(resolve(output, imageName), Buffer.from(screenshot.data, 'base64'));
                    item.screenshotMethod = 'Chrome Page.captureScreenshot';
                } finally { await screenshotSession.detach(); }
                item.screenshot = imageName;
            } catch (error) { item.error = error.message; }
            finally { await page.close().catch(() => {}); }
            item.finished = new Date().toISOString();
            console.log(`${mode} ${site.id}: ${item.status ?? 'ERROR'} ${item.title ?? item.error} ${JSON.stringify(item.failures)}`);
            await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
        }
    } catch (error) { run.fatal = error.stack; console.error(error); }
    finally { await context?.close(); }
}
report.finished = new Date().toISOString();
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(`REPORT ${resolve(output, 'report.json')}`);
process.exitCode = report.runs.some(run=>run.fatal) ? 1 : 0;
