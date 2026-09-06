#!/usr/bin/env node
/* uBlock Plus+ native draft-firewall UI regression. GPL-3.0-or-later. */
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { tmpdir } from 'node:os';

const usage = 'node tools/test-firewall-tester-chrome.mjs --extension <absolute unpacked directory> ' +
    '--chrome <absolute executable> --playwright <absolute index.mjs> --output <absolute directory>';
const options = {};
for ( let i = 2; i < process.argv.length; i++ ) {
    const match = /^--(extension|chrome|playwright|output)(?:=(.+))?$/.exec(process.argv[i]);
    if ( match === null ) { throw new Error(usage); }
    const value = match[2] ?? process.argv[++i];
    if ( typeof value !== 'string' || isAbsolute(value) === false ) {
        throw new Error(`All paths must be absolute. ${usage}`);
    }
    options[match[1]] = resolve(value);
}
for ( const key of [ 'extension', 'chrome', 'playwright', 'output' ] ) {
    if ( options[key] === undefined ) { throw new Error(usage); }
}
const hash = value => createHash('sha256').update(value).digest('hex');
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
const { chromium } = await import(pathToFileURL(options.playwright).href);
const profile = await mkdtemp(resolve(tmpdir(), 'ublock-tester-profile-'));
const extension = await mkdtemp(resolve(tmpdir(), 'ublock-tester-artifact-'));
await mkdir(options.output, { recursive: true });
await cp(options.extension, extension, {
    recursive: true,
    filter: path => path.split(/[\\/]/).includes('_metadata') === false,
});
const loadedTree = await tree(extension);
assert.deepEqual(loadedTree, await tree(options.extension));
assert.ok(loadedTree.some(entry => entry.path === 'js/firewall-tester.js'), 'Build the candidate first');
const report = {
    started: new Date().toISOString(), options, profile, extension,
    loadedFiles: loadedTree.length, loadedTreeSHA256: hash(JSON.stringify(loadedTree)),
    methodology: 'Real Chrome loads the unmodified package. The actual dashboard sends draft requests to the actual worker. Only two race tests delay delivery of an already-computed native message response; they do not replace its result.',
    cases: [], requests: [],
};
let phase = 'draft-tests';
const server = createServer((request, response) => {
    report.requests.push({ phase, path: request.url });
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    response.end('<!doctype html><title>Draft tester local fixture</title><p>Native local fixture</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}`;
let context;
try {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: options.chrome, headless: false, ignoreDefaultArgs: true,
        viewport: null, locale: 'en-US',
        args: [ `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--remote-debugging-port=0',
            '--enable-unsafe-extension-debugging', '--enable-automation', '--no-first-run',
            '--no-default-browser-check', '--lang=en-US', '--window-size=1120,1000' ],
    });
    context.setDefaultTimeout(20000);
    const cdp = await context.browser().newBrowserCDPSession();
    report.browser = await cdp.send('Browser.getVersion');
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    report.extensionId = id;
    const dashboard = await context.newPage();
    const pageErrors = [];
    dashboard.on('pageerror', error => pageErrors.push(error.message));
    await dashboard.goto(`chrome-extension://${id}/dashboard.html#siteRules`);
    await dashboard.waitForFunction(() => document.body.classList.contains('loading') === false);
    const button = dashboard.locator('#firewallTestRequest');
    await dashboard.locator('#firewallTester summary').click();
    await dashboard.waitForFunction(() => document.querySelector('#firewallTestRequest')?.disabled === false);
    const message = request => dashboard.evaluate(async request =>
        (await import('./js/ext.js')).sendMessage(request), request);
    await message({ what: 'setFilteringModeDetails', modes: {
        none: [ 'off.example' ], basic: [ 'all-urls' ], optimal: [], complete: [],
    } });
    // Seed a real persistent policy so unchanged-state assertions are not just
    // comparisons of empty rule sets. This only changes the isolated profile.
    const permanent = 'live.example * 3p-script block';
    await message({ what: 'applyFirewallRules', text: permanent, permanent: true });
    const snapshot = () => dashboard.evaluate(async () => {
        const stable = value => {
            if ( Array.isArray(value) ) { return value.map(stable); }
            if ( value && typeof value === 'object' ) {
                return Object.fromEntries(Object.keys(value).sort().map(key => [ key, stable(value[key]) ]));
            }
            return value;
        };
        const digest = async value => {
            const encoded = new TextEncoder().encode(JSON.stringify(stable(value)));
            const bytes = await crypto.subtle.digest('SHA-256', encoded);
            return { bytes: encoded.byteLength,
                sha256: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('') };
        };
        const [ local, session, dynamicRules, sessionRules, enabledRulesets ] = await Promise.all([
            chrome.storage.local.get(null), chrome.storage.session.get(null),
            chrome.declarativeNetRequest.getDynamicRules(),
            chrome.declarativeNetRequest.getSessionRules(),
            chrome.declarativeNetRequest.getEnabledRulesets(),
        ]);
        // Invalid-input errors use the existing diagnostic console. It is not
        // filtering configuration, but it must not retain entered private URLs.
        const { console: diagnosticConsole, ...sessionSettings } = session;
        const diagnostics = JSON.stringify(diagnosticConsole ?? []);
        for ( const marker of [ 'must-not-fetch', 'private=example', 'user:pass',
            'https://news.example/', 'ftp://example.net/script.js' ] ) {
            if ( diagnostics.includes(marker) ) { throw new Error('Diagnostic console retained test URL input'); }
        }
        return {
            local: await digest(local), session: await digest(sessionSettings),
            diagnosticConsole: await digest(diagnosticConsole ?? []),
            dynamicRules: await digest(dynamicRules.sort((a, b) => a.id - b.id)),
            sessionRules: await digest(sessionRules.sort((a, b) => a.id - b.id)),
            enabledRulesets: await digest(enabledRulesets.sort()),
            permanentText: local['firewall.permanent'], sessionText: session['firewall.session'],
            nativeSessionRules: sessionRules.length,
        };
    });
    report.before = await snapshot();
    assert.equal(report.before.permanentText, permanent);
    assert.equal(report.before.sessionText, permanent);
    assert.ok(report.before.nativeSessionRules > 0);
    const fill = async ({ text = '* * 3p-script block', source = 'https://news.example/',
        destination = 'https://ads.example.net/script.js', type = 'script' } = {}) => {
        await dashboard.locator('#firewallRules').fill(text);
        await dashboard.locator('#firewallTest-source').fill(source);
        await dashboard.locator('#firewallTest-destination').fill(destination);
        await dashboard.locator('#firewallTest-type').selectOption(type);
    };
    const result = dashboard.locator('#firewallTestResult');
    const run = async (name, input, expected, extra = []) => {
        await fill(input);
        await button.click();
        await dashboard.waitForFunction(() => document.querySelector('#firewallTestRequest')?.disabled === false);
        const text = await result.textContent();
        assert.ok(text.includes(expected), `${name}: ${text}`);
        for ( const item of extra ) { assert.ok(text.includes(item), `${name}: missing ${item}: ${text}`); }
        report.cases.push({ name, result: text });
    };
    await run('third-party block', {}, 'Draft: block', [ 'Third party (3p)', '* * 3p-script block' ]);
    await run('specific-source noop', { text: '* * 3p-script block\nnews.example * 3p-script noop' },
        'Draft: noop', [ 'filter lists may still block', 'news.example * 3p-script noop' ]);
    await run('destination allow precedence', { text: '* * 3p-script block\n* ads.example.net * allow' },
        'Draft: allow', [ '* ads.example.net * allow' ]);
    await run('Off overrides draft', { source: 'https://off.example/' }, 'Off applies');
    await run('first-party script', { text: '* * 1p-script block', source: 'https://www.example.com/',
        destination: 'https://cdn.example.com/script.js' }, 'Draft: block', [ 'First party (1p)' ]);
    await run('PSL separates github.io tenants', { source: 'https://alice.github.io/',
        destination: 'https://bob.github.io/script.js' }, 'Draft: block', [ 'Third party (3p)' ]);
    await run('PSL preserves tenant subdomain', { text: '* * 1p-script noop', source: 'https://alice.github.io/',
        destination: 'https://cdn.alice.github.io/script.js' }, 'Draft: noop', [ 'First party (1p)' ]);
    await run('one-character source precedence', { source: 'http://n/',
        text: '* * 3p-script block\nn * 3p-script noop' }, 'Draft: noop', [ 'n * 3p-script noop' ]);
    await run('image type', { text: '* * image block', type: 'image' }, 'Draft: block', [ '* * image block' ]);
    await run('no matching cell', { text: '* * image block' }, 'No firewall cell matches');
    await run('local HTTP URL is never fetched', { destination: `${fixture}/must-not-fetch?private=example#fragment` },
        'Draft: block', [ '127.0.0.1' ]);
    await run('reject URL credentials', { source: 'https://user:pass@news.example/' }, 'Remove credentials');
    await run('reject unsupported URL scheme', { destination: 'ftp://example.net/script.js' }, 'Only HTTP(S)');
    await run('reject invalid draft', { text: '* * inline-script block' }, 'inline-script');
    await run('reject empty source', { source: '' }, 'specific hostname');

    // Hold the real worker response at the dashboard boundary to reproduce an
    // edit while a request is pending, without mocking its evaluator or result.
    for ( const invalid of [ false, true ] ) {
        await fill({ text: invalid ? '* * inline-script block' : '* * 3p-script block' });
        await dashboard.evaluate(() => {
            const original = chrome.runtime.sendMessage;
            self.__firewallTesterRace = { original, held: false };
            chrome.runtime.sendMessage = function(request, ...args) {
                const response = original.call(chrome.runtime, request, ...args);
                if ( request.what !== 'testFirewallRequest' ) { return response; }
                return response.then(value => new Promise(resolve => {
                    self.__firewallTesterRace.held = true;
                    self.__firewallTesterRace.release = () => resolve(value);
                }));
            };
        });
        try {
            await button.click();
            await dashboard.waitForFunction(() => self.__firewallTesterRace?.held === true);
            await dashboard.locator('#firewallTest-source').fill('edited.example');
            await dashboard.evaluate(() => self.__firewallTesterRace.release());
            await dashboard.waitForFunction(() => document.querySelector('#firewallTestRequest')?.disabled === false);
            const text = await result.textContent();
            assert.equal(text, 'Inputs changed; test again.');
            report.cases.push({ name: invalid ? 'stale error discarded' : 'stale success discarded', result: text });
        } finally {
            await dashboard.evaluate(() => {
                chrome.runtime.sendMessage = self.__firewallTesterRace.original;
                delete self.__firewallTesterRace;
            });
        }
    }
    await run('revert setup', {}, 'Draft: block');
    await dashboard.locator('#firewallRevert').click();
    await dashboard.waitForFunction(() => document.querySelector('#firewallRevert')?.disabled === false);
    assert.equal(await result.textContent(), '');
    assert.equal(await dashboard.locator('#firewallRules').inputValue(), permanent);
    report.cases.push({ name: 'load permanent rules clears explanation', result: 'cleared' });
    await run('import setup', {}, 'Draft: block');
    const imported = '* * image noop';
    const importPath = resolve(options.output, 'firewall-import-fixture.txt');
    await writeFile(importPath, imported + '\n');
    await dashboard.locator('#dynamicFirewall input[type=file]').setInputFiles(importPath);
    await dashboard.waitForFunction(expected => document.querySelector('#firewallRules')?.value.trim() === expected,
        imported);
    await dashboard.waitForFunction(() => document.querySelector('#firewallTestRequest')?.disabled === false);
    assert.equal(await result.textContent(), '');
    report.cases.push({ name: 'import clears explanation', result: 'cleared' });
    await run('screenshot example', { text: '* * 3p-script block\nnews.example * 3p-script noop' }, 'Draft: noop');
    // Fit the whole panel in the viewport so the real sticky navigation does
    // not cover the editor midway through an element screenshot.
    await dashboard.setViewportSize({ width: 1120, height: 1520 });
    await dashboard.evaluate(() => {
        const panel = document.querySelector('#dynamicFirewall');
        window.scrollTo(0, Math.max(0, panel.getBoundingClientRect().top + window.scrollY - 80));
    });
    await dashboard.locator('#dynamicFirewall').screenshot({ path: resolve(options.output, 'firewall-tester.png') });
    report.after = await snapshot();
    for ( const key of Object.keys(report.before) ) {
        if ( key === 'diagnosticConsole' ) { continue; }
        assert.deepEqual(report.after[key], report.before[key], `Draft testing must not change ${key}`);
    }
    report.cases.push({ name: 'all stored settings and native DNR unchanged', result: 'all hashes identical' });
    report.cases.push({ name: 'diagnostic console contains no entered URL',
        result: 'Existing error logging is separate from configuration; URL markers and credentials absent' });
    assert.equal(report.requests.length, 0, 'Entering/testing fixture URLs must send no HTTP requests');
    report.cases.push({ name: 'no request side effect', result: '0 local HTTP requests during draft tests' });

    // Positive control proves that the no-fetch counter above observes a real,
    // reachable server, rather than obtaining zero from a broken fixture.
    phase = 'positive-control';
    const response = await fetch(`${fixture}/positive-control`);
    assert.equal(response.status, 200);
    assert.equal(report.requests.length, 1);
    report.cases.push({ name: 'HTTP counter positive control', result: '1 intentional request' });
    phase = 'authorization';
    const site = await context.newPage();
    await site.goto(`${fixture}/authorization`);
    const authorization = await dashboard.evaluate(async fixture => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url === `${fixture}/authorization`);
        const injected = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'ISOLATED',
            func: async () => {
                const response = await chrome.runtime.sendMessage({ what: 'testFirewallRequest',
                    text: '* * 3p-script block', source: 'news.example',
                    destination: 'ads.example.net', type: 'script' });
                // Chrome's callback transport can serialize an omitted reply
                // as null. Either empty representation carries no decision.
                return { rejected: response === undefined || response === null,
                    responseType: response === null ? 'null' : typeof response };
            },
        });
        return injected[0].result;
    }, fixture);
    report.authorization = authorization;
    assert.equal(authorization.rejected, true);
    report.cases.push({ name: 'content-script sender cannot access tester', result: authorization });
    assert.deepEqual(pageErrors, [], 'The native dashboard must not throw');
    report.passed = true;
} catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
} finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    report.finished = new Date().toISOString();
    await writeFile(resolve(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, checks: report.cases.length,
    error: report.error, output: options.output }));
