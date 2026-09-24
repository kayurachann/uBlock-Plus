/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

// Build-time only (make-rulesets.js, Chromium packages): asks a real Chrome
// whether its RE2 accepts each stock regexFilter, with
// chrome.declarativeNetRequest.isRegexSupported(). Node has no RE2, and a
// static regex which RE2 rejects makes Chrome refuse the whole unpacked
// extension.
//
// Chrome is started headless with a fresh temporary profile created here
// (never the user's profile), talks over --remote-debugging-pipe (no port is
// opened), loads a throwaway extension which only declares
// declarativeNetRequest, and is closed at the end. Only the process started
// here is ever killed, and both temporary folders are removed. Nothing is
// downloaded, and no registry or policy is read or written.
//
// Verdicts: 'ok', 'syntaxError', 'memoryLimitExceeded' (Chrome's reasons),
// or 'unverified' when no Chrome answered. Chrome's answers are cached in
// `cacheFile`; the cache is used only when Chrome is unavailable. With
// `required`, a build without a working Chrome fails instead.

import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { rmSync } from 'node:fs';

/******************************************************************************/

export const REGEX_VERDICT_CACHE_SCHEMA_VERSION = 1;
const BATCH_SIZE = 500;
const CLOSE_GRACE_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const regexVerdictKey = options => JSON.stringify([
    options.regex,
    options.isCaseSensitive === true,
    options.requireCapturing === true,
]);

// Browser.getVersion reports 'HeadlessChrome/<version>' in some headless
// modes: the engine is the same.
const normalizeProduct = product => typeof product === 'string'
    ? product.replace(/^HeadlessChrome\//, 'Chrome/')
    : '';

const withTimeout = (promise, ms, what) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(( ) => {
                reject(new Error(`${what} timed out after ${ms} ms`));
            }, ms);
        }),
    ]).finally(( ) => { clearTimeout(timer); });
};

/******************************************************************************/

// Minimal CDP client over --remote-debugging-pipe: messages are JSON strings
// separated by NUL bytes, on file descriptors 3 (to Chrome) and 4 (from).
function launchBrowser(executable, args) {
    const child = spawn(executable, [ '--remote-debugging-pipe', ...args ], {
        stdio: [ 'ignore', 'ignore', 'ignore', 'pipe', 'pipe' ],
        windowsHide: true,
    });
    const writer = child.stdio[3];
    const reader = child.stdio[4];
    const pending = new Map();
    let buffer = Buffer.alloc(0);
    let nextId = 0;
    let failure;
    const failAll = reason => {
        failure ??= reason;
        for ( const { reject } of pending.values() ) { reject(failure); }
        pending.clear();
    };
    const exited = new Promise(resolve => {
        child.once('exit', ( ) => {
            failAll(new Error('Chrome exited'));
            resolve();
        });
        child.once('error', reason => {
            failAll(reason);
            resolve();
        });
    });
    reader?.on('data', chunk => {
        buffer = Buffer.concat([ buffer, chunk ]);
        let end;
        while ( (end = buffer.indexOf(0)) !== -1 ) {
            let message;
            try {
                message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
            } catch {
                message = {};
            }
            buffer = buffer.subarray(end + 1);
            if ( message.id === undefined ) { continue; }
            const entry = pending.get(message.id);
            if ( entry === undefined ) { continue; }
            pending.delete(message.id);
            if ( message.error ) {
                entry.reject(new Error(JSON.stringify(message.error)));
            } else {
                entry.resolve(message.result);
            }
        }
    });
    reader?.on('error', failAll);
    writer?.on('error', failAll);
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        if ( failure !== undefined ) { return reject(failure); }
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        const message = { id, method, params };
        if ( sessionId !== undefined ) { message.sessionId = sessionId; }
        writer.write(`${JSON.stringify(message)}\0`);
    });
    const running = ( ) =>
        child.pid !== undefined &&
        child.exitCode === null && child.signalCode === null;
    return { child, send, exited, running };
}

// The process tree of the Chrome started here, and nothing else.
function killBrowser(browser) {
    if ( browser.running() === false ) { return; }
    try {
        if ( process.platform === 'win32' ) {
            execFileSync('taskkill', [ '/PID', `${browser.child.pid}`, '/T', '/F' ],
                { stdio: 'ignore', windowsHide: true });
        } else {
            browser.child.kill('SIGKILL');
        }
    } catch {
    }
}

const probeManifest = {
    manifest_version: 3,
    name: 'uBlock Plus+ build: regex check',
    version: '1.0',
    description: 'Temporary build-time extension: checks regexFilter support.',
    permissions: [ 'declarativeNetRequest' ],
};

const probePage = '<!doctype html><meta charset="utf-8"><title>regex check</title>\n';

/******************************************************************************/

export function createRegexVerdictResolver({
    chromePath = '',
    cacheFile = '',
    required = false,
    log = ( ) => { },
    timeoutMs = 120000,
} = {}) {
    let startPromise;
    let browser;
    let browserVersion = '';
    let pageSession;
    let profileDir = '';
    let extensionDir = '';
    let closed = false;
    let cache;
    const fromChrome = new Map();
    const answeredBy = new Set();
    let unverifiedCount = 0;

    const removeTemporaryDirsSync = ( ) => {
        for ( const dir of [ profileDir, extensionDir ] ) {
            if ( dir === '' ) { continue; }
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch {
            }
        }
    };
    // The build may exit without calling close() (uncaught error).
    const onExit = ( ) => {
        if ( browser !== undefined ) { killBrowser(browser); }
        removeTemporaryDirsSync();
    };

    const readCache = async ( ) => {
        if ( cache !== undefined ) { return cache; }
        cache = { chromeVersion: '', verdicts: new Map() };
        if ( cacheFile === '' ) { return cache; }
        try {
            const data = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
            if (
                data?.schemaVersion === REGEX_VERDICT_CACHE_SCHEMA_VERSION &&
                typeof data.chromeVersion === 'string' &&
                data.verdicts instanceof Object
            ) {
                cache.chromeVersion = data.chromeVersion;
                for ( const [ key, verdict ] of Object.entries(data.verdicts) ) {
                    if ( typeof verdict !== 'string' ) { continue; }
                    cache.verdicts.set(key, verdict);
                }
            }
        } catch {
        }
        return cache;
    };

    const writeCache = async ( ) => {
        if ( cacheFile === '' || fromChrome.size === 0 ) { return; }
        const previous = await readCache();
        const verdicts = previous.chromeVersion === browserVersion
            ? new Map(previous.verdicts)
            : new Map();
        for ( const [ key, verdict ] of fromChrome ) {
            verdicts.set(key, verdict);
        }
        const sorted = Array.from(verdicts).sort((a, b) =>
            a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)
        );
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, `${JSON.stringify({
            schemaVersion: REGEX_VERDICT_CACHE_SCHEMA_VERSION,
            chromeVersion: browserVersion,
            verdicts: Object.fromEntries(sorted),
        }, null, 1)}\n`);
    };

    const evaluate = async (expression, what) => {
        const result = await withTimeout(browser.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        }, pageSession), timeoutMs, what);
        if ( result.exceptionDetails ) {
            throw new Error(`${what}: ${result.exceptionDetails.exception?.description ??
                result.exceptionDetails.text}`);
        }
        return result.result?.value;
    };

    const launch = async ( ) => {
        if ( typeof chromePath !== 'string' || chromePath === '' ) {
            throw new Error('no Chrome executable was given (chrome=<path>)');
        }
        await fs.access(chromePath);
        // The long form of an 8.3 TEMP path, for Chrome.
        const temporaryParent = await fs.realpath(os.tmpdir());
        profileDir = await fs.mkdtemp(path.join(temporaryParent, 'ublock-plus-regex-profile-'));
        extensionDir = await fs.mkdtemp(path.join(temporaryParent, 'ublock-plus-regex-probe-'));
        await fs.writeFile(path.join(extensionDir, 'manifest.json'),
            `${JSON.stringify(probeManifest, null, 1)}\n`);
        await fs.writeFile(path.join(extensionDir, 'check.html'), probePage);
        process.once('exit', onExit);
        browser = launchBrowser(chromePath, [
            `--user-data-dir=${profileDir}`,
            '--headless=new',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-sync',
            '--enable-unsafe-extension-debugging',
            'about:blank',
        ]);
        const step = (method, params, sessionId) =>
            withTimeout(browser.send(method, params, sessionId), timeoutMs, method);
        const { product } = await step('Browser.getVersion');
        browserVersion = normalizeProduct(product);
        const { id } = await step('Extensions.loadUnpacked', { path: extensionDir });
        const { targetId } = await step('Target.createTarget', {
            url: `chrome-extension://${id}/check.html`,
        });
        ({ sessionId: pageSession } = await step('Target.attachToTarget', {
            targetId,
            flatten: true,
        }));
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const ready = await evaluate(
                `location.protocol === 'chrome-extension:' &&
                typeof chrome?.declarativeNetRequest?.isRegexSupported === 'function'`,
                'Waiting for the regex check page'
            ).catch(( ) => false);
            if ( ready === true ) { break; }
            if ( Date.now() > deadline ) {
                throw new Error('the regex check page did not load');
            }
            await sleep(50);
        }
        log(`Regex verdicts: checking with ${browserVersion}`);
    };

    const start = ( ) => {
        if ( startPromise !== undefined ) { return startPromise; }
        if ( closed ) {
            startPromise = Promise.resolve(false);
            return startPromise;
        }
        startPromise = launch().then(( ) => true, async reason => {
            await shutdown();
            const message = `Regex verdicts: Chrome is unavailable (${reason?.message ?? reason})`;
            if ( required ) {
                throw new Error(`${message}; regexVerdicts=required`);
            }
            const cached = await readCache();
            const fallback = cached.verdicts.size !== 0
                ? `using ${cached.verdicts.size} cached verdicts of ${cached.chromeVersion || 'an unknown Chrome'}`
                : 'no cached verdicts';
            // Without Chrome, the build reports the regexes as not verified.
            if ( typeof chromePath !== 'string' || chromePath === '' ) {
                log(`Regex verdicts: no Chrome given (chrome=<path>), ${fallback}`);
            } else {
                log(`!!! ${message}; ${fallback}`);
            }
            return false;
        });
        return startPromise;
    };

    const checkWithChrome = async list => {
        const out = [];
        for ( let i = 0; i < list.length; i += BATCH_SIZE ) {
            const batch = list.slice(i, i + BATCH_SIZE).map(options => ({
                regex: options.regex,
                isCaseSensitive: options.isCaseSensitive === true,
                requireCapturing: options.requireCapturing === true,
            }));
            const verdicts = await evaluate(`Promise.all(${JSON.stringify(batch)}.map(options =>
                chrome.declarativeNetRequest.isRegexSupported(options).then(
                    result => result.isSupported ? 'ok' : String(result.reason || 'unsupported'),
                    ( ) => ''
                )
            ))`, 'isRegexSupported');
            if (
                Array.isArray(verdicts) === false ||
                verdicts.length !== batch.length ||
                verdicts.some(verdict => typeof verdict !== 'string' || verdict === '')
            ) {
                throw new Error('isRegexSupported() gave no usable answer');
            }
            out.push(...verdicts);
        }
        return out;
    };

    // Verdicts for a list of isRegexSupported() options, in the same order.
    const resolve = async optionsList => {
        if ( closed ) { throw new Error('Regex verdict resolver is closed'); }
        const keys = optionsList.map(regexVerdictKey);
        const todo = new Map();
        for ( let i = 0; i < keys.length; i++ ) {
            if ( fromChrome.has(keys[i]) || todo.has(keys[i]) ) { continue; }
            todo.set(keys[i], optionsList[i]);
        }
        if ( todo.size !== 0 && await start() && browser?.running() ) {
            try {
                const verdicts = await checkWithChrome(Array.from(todo.values()));
                Array.from(todo.keys()).forEach((key, i) => {
                    fromChrome.set(key, verdicts[i]);
                });
                answeredBy.add(browserVersion);
            } catch (reason) {
                const message = `Regex verdicts: Chrome failed (${reason?.message ?? reason})`;
                await shutdown();
                if ( required ) { throw new Error(message); }
                log(`!!! ${message}`);
            }
        } else if ( todo.size !== 0 && required ) {
            throw new Error('Regex verdicts: Chrome is unavailable; regexVerdicts=required');
        }
        const cached = await readCache();
        return keys.map(key => {
            const verdict = fromChrome.get(key);
            if ( verdict !== undefined ) { return verdict; }
            const cachedVerdict = cached.verdicts.get(key);
            if ( cachedVerdict !== undefined ) {
                answeredBy.add(cached.chromeVersion);
                return cachedVerdict;
            }
            unverifiedCount += 1;
            return 'unverified';
        });
    };

    // The browser which gave every verdict so far, or '' when some regex
    // could not be checked, or when verdicts came from different versions.
    const chromeVersion = ( ) => {
        if ( unverifiedCount !== 0 ) { return ''; }
        if ( answeredBy.size === 1 ) {
            return Array.from(answeredBy)[0];
        }
        if ( answeredBy.size === 0 ) { return browserVersion; }
        return '';
    };

    const shutdown = async ( ) => {
        if ( browser !== undefined ) {
            if ( browser.running() ) {
                await withTimeout(browser.send('Browser.close'), 5000, 'Browser.close')
                    .catch(( ) => { });
                await withTimeout(browser.exited, CLOSE_GRACE_MS, 'Chrome exit')
                    .catch(( ) => { });
                killBrowser(browser);
                await withTimeout(browser.exited, 5000, 'Chrome exit')
                    .catch(( ) => { });
            }
        }
        for ( const dir of [ profileDir, extensionDir ] ) {
            if ( dir === '' ) { continue; }
            await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
                .catch(( ) => { });
        }
        process.removeListener('exit', onExit);
    };

    const close = async ( ) => {
        if ( closed ) { return; }
        closed = true;
        await shutdown();
        await writeCache().catch(reason => {
            log(`!!! Regex verdicts: cache not written (${reason?.message ?? reason})`);
        });
    };

    return {
        start: ( ) => start(),
        resolve,
        chromeVersion,
        close,
        get required() { return required; },
    };
}
