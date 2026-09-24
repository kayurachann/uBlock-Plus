/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// Helpers for the real-Chrome tests (tools/test-*-chrome.mjs) which drive
// Chrome over the DevTools protocol, without any dependency:
// - Chrome is always started with a fresh, empty --user-data-dir created
//   under the temporary folder by createTempDir(), never with a user
//   profile, and talks over --remote-debugging-pipe (no port is opened);
// - only the process started here is ever killed (with its own child
//   processes), and the temporary folders are removed, also when the test
//   fails or hits its hard timeout;
// - nothing is downloaded, and no registry, policy or system setting is read
//   or written.

import { cp, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { rmSync } from 'node:fs';

export const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(( ) => {
                reject(new Error(`${what} timed out after ${ms} ms`));
            }, ms);
        }),
    ]).finally(( ) => { clearTimeout(timer); });
}

/******************************************************************************/

// `--name value` options. `defaults` lists the known names; a boolean default
// makes a flag without value.
export function parseOptions(argv, defaults) {
    const options = { ...defaults };
    for ( let i = 0; i < argv.length; i++ ) {
        const name = argv[i].replace(/^--/, '');
        if ( argv[i].startsWith('--') === false || name in defaults === false ) {
            throw new Error(`Unknown option ${argv[i]}`);
        }
        if ( typeof defaults[name] === 'boolean' ) {
            options[name] = true;
            continue;
        }
        const value = argv[++i];
        if ( value === undefined ) { throw new Error(`Missing value for ${argv[i - 1]}`); }
        options[name] = typeof defaults[name] === 'number' ? Number(value) : value;
    }
    return options;
}

// An explicit path, then CHROME_PATH, then the usual install locations.
export function findChrome(explicit = '') {
    const candidates = [ explicit, process.env.CHROME_PATH ];
    if ( process.platform === 'win32' ) {
        for ( const root of [
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            process.env.LOCALAPPDATA,
        ] ) {
            if ( typeof root !== 'string' || root === '' ) { continue; }
            candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
    } else if ( process.platform === 'darwin' ) {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium', '/usr/bin/chromium-browser');
    }
    for ( const candidate of candidates ) {
        if ( typeof candidate !== 'string' || candidate === '' ) { continue; }
        if ( existsSync(candidate) ) { return path.resolve(candidate); }
    }
    return '';
}

/******************************************************************************/

// Every temporary folder of a test comes from here: the long form of the
// temporary folder (Chrome dislikes 8.3 paths), then mkdtemp.
const temporaryDirs = new Set();

export async function createTempDir(prefix) {
    const parent = await realpath(os.tmpdir());
    const dir = await mkdtemp(path.join(parent, prefix));
    temporaryDirs.add(dir);
    return dir;
}

export async function removeTempDir(dir) {
    if ( temporaryDirs.has(dir) === false ) {
        throw new Error(`Not a temporary folder of this test: ${dir}`);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
        .catch(( ) => { });
    const removed = await stat(dir).then(( ) => false, ( ) => true);
    if ( removed ) { temporaryDirs.delete(dir); }
    return removed;
}

// A copy of the built package: Chrome writes _metadata into an unpacked
// extension folder, and the test must not touch the build.
export async function copyExtension(source, prefix) {
    const manifest = await stat(path.join(source, 'manifest.json')).catch(( ) => undefined);
    if ( manifest?.isFile() !== true ) {
        throw new Error(`No built extension in ${source}`);
    }
    const dir = await createTempDir(prefix);
    await cp(source, dir, {
        recursive: true,
        filter: file => path.basename(file) !== '_metadata',
    });
    return dir;
}

/******************************************************************************/

const browsers = new Set();

const running = browser =>
    browser.child.pid !== undefined &&
    browser.child.exitCode === null && browser.child.signalCode === null;

// The process tree of a Chrome started here, and nothing else.
function killBrowserSync(browser) {
    if ( running(browser) === false ) { return false; }
    try {
        if ( process.platform === 'win32' ) {
            execFileSync('taskkill', [ '/PID', `${browser.child.pid}`, '/T', '/F' ],
                { stdio: 'ignore', windowsHide: true });
        } else {
            browser.child.kill('SIGKILL');
        }
    } catch {
    }
    return true;
}

// Last resort, when the test exits without its own cleanup (uncaught error,
// hard timeout): kill what it started and remove its temporary folders.
function emergencyCleanup() {
    for ( const browser of browsers ) { killBrowserSync(browser); }
    for ( const dir of temporaryDirs ) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
        }
    }
}
process.once('exit', emergencyCleanup);

// Fails the test after `ms` whatever it is waiting for.
export function installHardTimeout(ms, label) {
    const timer = setTimeout(( ) => {
        console.error(`${label}: hard timeout after ${ms} ms`);
        process.exitCode = 1;
        emergencyCleanup();
        process.exit(1);
    }, ms);
    timer.unref();
    return ( ) => { clearTimeout(timer); };
}

/******************************************************************************/

// Starts Chrome on a fresh profile folder from createTempDir(). Returns
// { child, pid, send(), on(), exited, running(), product }.
export async function launchChrome({
    chromePath,
    profileDir,
    headless = true,
    args = [],
    timeoutMs = 30000,
}) {
    if ( typeof chromePath !== 'string' || existsSync(chromePath) === false ) {
        throw new Error(`Chrome not found (use --chrome or CHROME_PATH): ${chromePath}`);
    }
    // Never a user profile: only an empty folder this test created.
    if (
        temporaryDirs.has(profileDir) === false ||
        (await readdir(profileDir)).length !== 0
    ) {
        throw new Error(`Chrome needs a fresh temporary profile folder: ${profileDir}`);
    }
    const child = spawn(chromePath, [
        '--remote-debugging-pipe',
        `--user-data-dir=${profileDir}`,
        ...(headless ? [ '--headless=new' ] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--enable-unsafe-extension-debugging',
        '--lang=en-US',
        ...args,
        'about:blank',
    ], {
        stdio: [ 'ignore', 'ignore', 'ignore', 'pipe', 'pipe' ],
        windowsHide: true,
    });
    const writer = child.stdio[3];
    const reader = child.stdio[4];
    const pending = new Map();
    const listeners = new Set();
    let buffer = Buffer.alloc(0);
    let nextId = 0;
    let failure;
    const failAll = reason => {
        failure ??= reason;
        for ( const { reject } of pending.values() ) { reject(failure); }
        pending.clear();
    };
    const browser = { child, pid: child.pid };
    browsers.add(browser);
    browser.exited = new Promise(resolve => {
        child.once('exit', ( ) => { failAll(new Error('Chrome exited')); resolve(); });
        child.once('error', reason => { failAll(reason); resolve(); });
    });
    reader.on('data', chunk => {
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
            if ( message.id !== undefined ) {
                const entry = pending.get(message.id);
                if ( entry === undefined ) { continue; }
                pending.delete(message.id);
                if ( message.error ) {
                    entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
                } else {
                    entry.resolve(message.result);
                }
                continue;
            }
            for ( const listener of listeners ) {
                try { listener(message); } catch { }
            }
        }
    });
    reader.on('error', failAll);
    writer.on('error', failAll);
    browser.send = (method, params = {}, sessionId, ms = timeoutMs) => {
        const request = new Promise((resolve, reject) => {
            if ( failure !== undefined ) { return reject(failure); }
            const id = ++nextId;
            pending.set(id, { resolve, reject, method });
            const message = { id, method, params };
            if ( sessionId !== undefined ) { message.sessionId = sessionId; }
            writer.write(`${JSON.stringify(message)}\0`);
        });
        return withTimeout(request, ms, method);
    };
    browser.on = listener => {
        listeners.add(listener);
        return ( ) => { listeners.delete(listener); };
    };
    browser.running = ( ) => running(browser);
    const version = await browser.send('Browser.getVersion');
    // 'HeadlessChrome/<version>' in some headless modes: the same engine.
    browser.product = String(version.product).replace(/^HeadlessChrome\//, 'Chrome/');
    return browser;
}

// Browser.close, then the process tree if it is still there. Returns true
// when it had to be killed.
export async function closeChrome(browser) {
    if ( browser === undefined ) { return false; }
    let forced = false;
    if ( running(browser) ) {
        await browser.send('Browser.close', {}, undefined, 5000).catch(( ) => { });
        await withTimeout(browser.exited, 10000, 'Chrome exit').catch(( ) => { });
        forced = killBrowserSync(browser);
        await withTimeout(browser.exited, 5000, 'Chrome exit').catch(( ) => { });
    }
    browsers.delete(browser);
    // Chrome's child processes may hold profile files for a moment.
    await sleep(500);
    return forced;
}

/******************************************************************************/

// Protocol helpers on top of a browser from launchChrome().
export function cdp(browser) {
    const evaluate = async (sessionId, expression, {
        userGesture = false,
        timeoutMs = 20000,
    } = {}) => {
        const result = await browser.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture,
        }, sessionId, timeoutMs);
        if ( result.exceptionDetails ) {
            throw new Error(result.exceptionDetails.exception?.description ??
                result.exceptionDetails.text);
        }
        return result.result?.value;
    };
    const targets = async ( ) => (await browser.send('Target.getTargets')).targetInfos;
    const attach = async targetId => (await browser.send('Target.attachToTarget', {
        targetId,
        flatten: true,
    })).sessionId;
    const openTab = async url => {
        const { targetId } = await browser.send('Target.createTarget', { url });
        return { targetId, sessionId: await attach(targetId) };
    };
    const closeTab = targetId => browser.send('Target.closeTarget', { targetId })
        .catch(( ) => { });
    const targetUrl = async targetId =>
        (await targets()).find(info => info.targetId === targetId)?.url;
    // Resolves with the result of `test` once it is truthy.
    const waitFor = async (test, { timeoutMs = 15000, intervalMs = 100, what = 'condition' } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let last;
        for (;;) {
            try {
                last = await test();
                if ( last ) { return last; }
            } catch ( reason ) {
                last = reason;
            }
            if ( Date.now() > deadline ) {
                throw new Error(`Timed out waiting for ${what}` +
                    (last instanceof Error ? ` (${last.message})` : ''));
            }
            await sleep(intervalMs);
        }
    };
    const serviceWorkerTarget = extensionId => waitFor(async ( ) =>
        (await targets()).find(info =>
            info.type === 'service_worker' &&
            info.url.startsWith(`chrome-extension://${extensionId}/`)
        ), { timeoutMs: 30000, what: 'the extension service worker' });
    return {
        evaluate, targets, attach, openTab, closeTab, targetUrl, waitFor,
        serviceWorkerTarget,
    };
}
