// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// End-to-end automatic update in a real, visible Google Chrome on Windows:
//
//   node tools/test-auto-update-chrome.mjs --extension dist/build/uBlockPlus.chromium
//       [--chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"] [--output report.json]
//
// The test copies the build into a temporary "installed" folder, publishes a
// newer copy of the same build on a loopback release server, installs the
// packaged updater (registering the native messaging host under HKCU for the
// duration of the test, then restoring any previous registration), loads the
// extension with Load unpacked semantics into a throwaway profile, grants the
// optional permission through Chrome's real dialog (UI Automation), and
// verifies: check → download → verify → apply → reload into the new version
// with settings kept, then rollback. The GitHub API response is served
// through CDP request interception; nothing contacts the Internet.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

if ( process.platform !== 'win32' ) {
    console.log('Auto-update Chrome test: Windows only.');
    process.exit(0);
}

const options = {
    chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    extension: '',
    output: '',
};
for ( let i = 2; i < process.argv.length; i += 2 ) {
    const key = process.argv[i].replace(/^--/, '');
    assert.ok(key in options, `Unknown option ${process.argv[i]}`);
    options[key] = path.resolve(process.argv[i + 1]);
}
assert.ok(options.extension, '--extension <built extension folder> is required');

const HOST = 'io.github.kayurachann.ublock_plus.updater';
const REGISTRY_ROOTS = [
    'HKCU:\\Software\\Google\\Chrome', 'HKCU:\\Software\\Microsoft\\Edge',
    'HKCU:\\Software\\Chromium', 'HKCU:\\Software\\BraveSoftware\\Brave-Browser',
];
const report = { steps: [] };
const step = (name, details = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...details });
    console.log(`✔ ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = command => execFileSync('powershell.exe', [ '-NoProfile', '-NonInteractive', '-Command', command ],
    { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------------------
// Minimal CDP client over --remote-debugging-pipe (no Playwright needed).

function launchChrome(executable, args) {
    const child = spawn(executable, [ '--remote-debugging-pipe', ...args ],
        { stdio: [ 'ignore', 'ignore', 'ignore', 'pipe', 'pipe' ] });
    const writer = child.stdio[3];
    const reader = child.stdio[4];
    let buffer = Buffer.alloc(0);
    let nextId = 0;
    const pending = new Map();
    const listeners = new Set();
    reader.on('data', chunk => {
        buffer = Buffer.concat([ buffer, chunk ]);
        let end;
        while ( (end = buffer.indexOf(0)) !== -1 ) {
            const message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
            buffer = buffer.subarray(end + 1);
            if ( message.id !== undefined && pending.has(message.id) ) {
                const { resolve, reject } = pending.get(message.id);
                pending.delete(message.id);
                if ( message.error ) { reject(new Error(JSON.stringify(message.error))); } else { resolve(message.result); }
            } else {
                for ( const listener of listeners ) { listener(message); }
            }
        }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        writer.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
    return {
        child, send,
        on: listener => listeners.add(listener),
        close: async () => { try { await send('Browser.close'); } catch { } },
    };
}

// ---------------------------------------------------------------------------
// ZIP writer (deflate) with forward-slash entry names, like the release build.

function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for ( const [ name, data ] of files ) {
        const nameBytes = Buffer.from(name, 'utf8');
        const compressed = deflateRawSync(data);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + compressed.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([ ...locals, ...centrals, end ]);
}

async function listFiles(root, prefix = '') {
    const out = [];
    for ( const entry of await readdir(path.join(root, prefix), { withFileTypes: true }) ) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if ( entry.name === '_metadata' ) { continue; }
        if ( entry.isDirectory() ) { out.push(...await listFiles(root, relative)); } else { out.push(relative); }
    }
    return out;
}

// ---------------------------------------------------------------------------

const builtManifest = JSON.parse(await readFile(path.join(options.extension, 'manifest.json'), 'utf8'));
assert.equal(builtManifest.short_name, 'uBlock Plus+');
assert.ok(/^\d+(\.\d+){0,2}$/.test(builtManifest.version), 'Use a release build (make-mv3.ps1 -Version)');
const fromVersion = builtManifest.version;
const toVersion = `${fromVersion}.1`;
report.fromVersion = fromVersion;
report.toVersion = toVersion;

const fixture = await mkdtemp(path.join(os.tmpdir(), 'ubp-e2e-update-'));
const installDir = path.join(fixture, 'Extensions', 'uBlock-Plus');
const updaterRoot = path.join(fixture, 'Updater');
const profile = path.join(fixture, 'Profile');
await mkdir(profile, { recursive: true });
await cp(options.extension, installDir, { recursive: true, filter: source => path.basename(source) !== '_metadata' });

// The "next release": the same build with a newer version and a marker,
// which its file list names as a real build would (rollback refuses to touch
// a folder with files no package listed).
const files = [];
let listed = false;
for ( const relative of await listFiles(installDir) ) {
    let data = await readFile(path.join(installDir, ...relative.split('/')));
    if ( relative === 'manifest.json' ) {
        const manifest = JSON.parse(data.toString('utf8'));
        manifest.version = toVersion;
        data = Buffer.from(JSON.stringify(manifest, null, 2));
    } else if ( relative === 'updater/package-files.json' ) {
        const list = JSON.parse(data.toString('utf8'));
        list.push('e2e-update-marker.txt');
        list.sort();
        data = Buffer.from(`${JSON.stringify(list, null, 1)}\n`);
        listed = true;
    }
    files.push([ relative, data ]);
}
assert.ok(listed, 'The build lists its files in updater/package-files.json');
files.push([ 'e2e-update-marker.txt', Buffer.from(toVersion) ]);
const asset = `uBlock-Plus_${toVersion}.chromium.zip`;
const zip = makeZip(files);
const digest = createHash('sha256').update(zip).digest('hex');
step('prepared packages', { files: files.length, zipBytes: zip.length });

const served = [];
const server = createServer((request, response) => {
    served.push(request.url);
    if ( request.url === `/releases/download/v${toVersion}/${asset}` ) {
        response.setHeader('Content-Length', zip.length);
        response.end(zip);
    } else if ( request.url === `/releases/download/v${toVersion}/${asset}.sha256` ) {
        response.end(`${digest}  ${asset}\n`);
    } else {
        response.statusCode = 404;
        response.end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const releaseList = JSON.stringify([ {
    tag_name: `v${toVersion}`, draft: false, prerelease: true, name: `uBlock Plus+ ${toVersion}`,
    published_at: new Date().toISOString(),
    assets: [ { name: asset }, { name: `${asset}.sha256` } ],
} ]);

// Remember any existing registration so that the developer's own updater is
// restored afterwards.
const savedRegistrations = REGISTRY_ROOTS.map(root => {
    const key = `${root}\\NativeMessagingHosts\\${HOST}`;
    const value = ps(`if ( Test-Path '${key}' ) { (Get-Item '${key}').GetValue('') } else { '<none>' }`);
    return { key, value };
});

let chrome;
try {
    const install = execFileSync('powershell.exe', [ '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(installDir, 'updater', 'install-updater.ps1'),
        '-InstallRoot', updaterRoot, '-ReleaseBaseUrl', `${base}/releases/download`, '-ApiBaseUrl', base ],
    { encoding: 'utf8' });
    const config = JSON.parse(await readFile(path.join(updaterRoot, 'config.json'), 'utf8'));
    assert.equal(config.installations.length, 1);
    assert.equal(config.installations[0].extensionDir.toLowerCase(), installDir.toLowerCase(),
        'The packaged installer defaults to its own extension folder');
    step('installed the packaged updater', { output: install.split(/\r?\n/).filter(Boolean).slice(-6) });

    chrome = launchChrome(options.chrome, [
        `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging', '--no-first-run',
        '--no-default-browser-check', '--lang=en-US', '--window-size=1100,900',
    ]);
    const version = await chrome.send('Browser.getVersion');
    report.browser = version.product;

    const pageEval = async (sessionId, expression, gesture = false) => {
        // A session whose target went away (the worker reloaded) never answers.
        const result = await Promise.race([
            chrome.send('Runtime.evaluate', {
                expression, awaitPromise: true, returnByValue: true, userGesture: gesture,
            }, sessionId),
            sleep(20000).then(( ) => { throw new Error('evaluation timed out'); }),
        ]);
        if ( result.exceptionDetails ) {
            throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
        }
        return result.result.value;
    };
    const openPage = async url => {
        const { targetId } = await chrome.send('Target.createTarget', { url });
        const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
        await sleep(1500);
        return { targetId, sessionId };
    };

    // Chrome disables unpacked extensions on reload unless Developer mode is on.
    const extensionsPage = await openPage('chrome://extensions/');
    await pageEval(extensionsPage.sessionId,
        'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
    const { id } = await chrome.send('Extensions.loadUnpacked', { path: installDir });
    assert.ok(config.installations[0].extensionIds.includes(id),
        `Chrome's unpacked ID ${id} must be derived by the installer`);
    report.extensionId = id;
    step('loaded the extension; installer derived the same ID', { id });

    // Serve the GitHub release list to the service worker.
    let interceptions = 0;
    chrome.on(message => {
        if ( message.method !== 'Fetch.requestPaused' ) { return; }
        interceptions += 1;
        chrome.send('Fetch.fulfillRequest', {
            requestId: message.params.requestId, responseCode: 200,
            responseHeaders: [ { name: 'content-type', value: 'application/json' }, { name: 'etag', value: '"e2e"' } ],
            body: Buffer.from(releaseList).toString('base64'),
        }, message.sessionId).catch(() => { });
    });
    const attachWorker = async () => {
        for ( let attempt = 0; attempt < 60; attempt++ ) {
            const { targetInfos } = await chrome.send('Target.getTargets');
            const worker = targetInfos.find(info => info.type === 'service_worker' &&
                info.url.startsWith(`chrome-extension://${id}/`));
            if ( worker ) {
                const { sessionId } = await chrome.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
                await chrome.send('Fetch.enable', { patterns: [ { urlPattern: 'https://api.github.com/*' } ] }, sessionId);
                return sessionId;
            }
            await sleep(250);
        }
        throw new Error('The extension service worker did not start');
    };
    let workerSession = await attachWorker();
    const workerVersion = () => pageEval(workerSession, 'chrome.runtime.getManifest().version');
    assert.equal(await workerVersion(), fromVersion);
    await pageEval(workerSession, `chrome.storage.local.set({ 'e2e.marker': ${JSON.stringify(fromVersion)} })`);

    const dashboard = await openPage(`chrome-extension://${id}/dashboard.html#settings`);
    const message = request => pageEval(dashboard.sessionId,
        `import('./js/ext.js').then(ext => ext.sendMessage(${JSON.stringify(request)}))`);
    let status = await message({ what: 'getUpdateStatus', probe: true });
    assert.equal(status.currentVersion, fromVersion);
    assert.equal(status.installType, 'development');
    assert.equal(status.permission, false, 'nativeMessaging starts optional and ungranted');
    assert.equal(status.installBlockedBy, 'permission-required');
    step('dashboard reports the missing permission');

    // Grant through Chrome's own dialog. The click returns at once; the page
    // then waits for the dialog. The clicker blocks this process meanwhile.
    await pageEval(dashboard.sessionId, `document.querySelector('#autoUpdateGrant').click(), true`, true);
    let clicker;
    try {
        clicker = execFileSync('powershell.exe', [ '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::RootElement
$button = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ControlTypeProperty), ([Windows.Automation.ControlType]::Button)
# Chrome ignores input on a dialog shown moments ago (clickjacking
# protection): click after a pause, and again until the dialog is gone.
function Find-Allow {
  foreach ( $window in $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition) ) {
    if ( $window.Current.ProcessId -ne ${chrome.child.pid} ) { continue }
    foreach ( $candidate in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $button) ) {
      if ( $candidate.Current.Name -eq 'Allow' ) { return $candidate }
    }
  }
  return $null
}
$deadline = (Get-Date).AddSeconds(30)
$clicks = 0
while ( (Get-Date) -lt $deadline ) {
  $allow = Find-Allow
  if ( $null -eq $allow ) {
    if ( $clicks -gt 0 ) { "clicked"; exit 0 }
    Start-Sleep -Milliseconds 300
    continue
  }
  Start-Sleep -Milliseconds 1000
  try { $allow.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $clicks++ } catch { }
  Start-Sleep -Milliseconds 1000
}
if ( $clicks -gt 0 ) { "dialog stayed open after $clicks clicks" } else { 'not found' }
exit 1` ], { encoding: 'utf8' }).trim();
    } catch (reason) {
        clicker = String(reason?.stdout || reason).trim();
    }
    assert.equal(clicker, 'clicked', 'Chrome showed the permission dialog and took the click');
    // Chrome binds native messaging only into contexts created after the
    // grant: the extension restarts once and reopens its Updates section. The
    // restart waits up to 60 s for running filter-list transactions.
    let reopened;
    for ( let attempt = 0; attempt < 180 && reopened === undefined; attempt++ ) {
        await sleep(500);
        const { targetInfos } = await chrome.send('Target.getTargets');
        reopened = targetInfos.find(info => info.type === 'page' && info.targetId !== dashboard.targetId &&
            info.url === `chrome-extension://${id}/dashboard.html#settings/autoUpdate`);
    }
    if ( reopened === undefined ) {
        report.activationDiagnostics = {
            pageError: await pageEval(dashboard.sessionId,
                `document.querySelector('#autoUpdate .autoUpdateError')?.textContent || ''`).catch(String),
            state: await pageEval(workerSession,
                `chrome.storage.local.get('autoUpdate.state').then(bin => bin['autoUpdate.state'])`).catch(String),
            permission: await pageEval(workerSession,
                `chrome.permissions.contains({ permissions: [ 'nativeMessaging' ] })`).catch(String),
            targets: (await chrome.send('Target.getTargets')).targetInfos.map(info => `${info.type} ${info.url}`),
        };
        console.log('activation diagnostics', JSON.stringify(report.activationDiagnostics).slice(0, 3000));
    }
    assert.ok(reopened, 'The dashboard reopened on the Updates section after the one-time restart');
    const settingsPage = {
        sessionId: (await chrome.send('Target.attachToTarget', { targetId: reopened.targetId, flatten: true })).sessionId,
    };
    await sleep(1500);
    workerSession = await attachWorker();
    // The page shows once Settings rendered; then the Updates heading has focus.
    for ( let attempt = 0; attempt < 20 && report.reopenedAtUpdates !== true; attempt++ ) {
        report.reopenedAtUpdates = await pageEval(settingsPage.sessionId,
            `document.activeElement?.closest('#autoUpdate') !== null`);
        if ( report.reopenedAtUpdates !== true ) { await sleep(250); }
    }
    assert.equal(report.reopenedAtUpdates, true, 'The reopened dashboard focuses the Updates section');
    const settingsMessage = request => pageEval(settingsPage.sessionId,
        `import('./js/ext.js').then(ext => ext.sendMessage(${JSON.stringify(request)}))`);
    for ( let attempt = 0; attempt < 40; attempt++ ) {
        status = await settingsMessage({ what: 'getUpdateStatus', probe: true });
        if ( status.permission && status.updater?.connected ) { break; }
        await sleep(500);
    }
    report.permissionProbe = await pageEval(workerSession, `chrome.permissions.contains({ permissions: [ 'nativeMessaging' ] })
        .then(granted => ({ granted, connectNative: typeof chrome.runtime.connectNative }))`);
    assert.equal(status.permission, true, JSON.stringify(report.permissionProbe));
    assert.equal(status.restartRequired, false);
    assert.equal(status.updater?.connected, true, JSON.stringify(status.updater));
    assert.equal(status.updater.installedVersion, fromVersion);
    assert.equal(await pageEval(workerSession, `chrome.storage.local.get('e2e.marker').then(bin => bin['e2e.marker'])`),
        fromVersion, 'The activation restart keeps extension storage');
    let statusText = '';
    for ( let attempt = 0; attempt < 20 && /connected/.test(statusText) === false; attempt++ ) {
        await sleep(300);
        statusText = await pageEval(settingsPage.sessionId, `document.querySelector('#autoUpdate .autoUpdateUpdaterStatus').textContent`);
    }
    assert.match(statusText, /Updater .* connected/);
    step('granted nativeMessaging through the real dialog; restarted once; updater connected', { statusText });

    // Check now → automatic install → reload into the new version.
    const reloadStarted = Date.now();
    await settingsMessage({ what: 'checkForUpdatesNow' }).catch(() => { });
    assert.ok(interceptions >= 1, 'The worker requested the release list');
    let reached = '';
    for ( let attempt = 0; attempt < 240 && reached !== toVersion; attempt++ ) {
        await sleep(500);
        try {
            workerSession = await attachWorker();
            reached = await workerVersion();
        } catch {
            // The worker is being replaced by the reload.
        }
    }
    assert.equal(reached, toVersion, 'The extension reloaded into the new version');
    report.updateSeconds = Math.round((Date.now() - reloadStarted) / 1000);
    const disk = JSON.parse(await readFile(path.join(installDir, 'manifest.json'), 'utf8'));
    assert.equal(disk.version, toVersion);
    assert.equal(await readFile(path.join(installDir, 'e2e-update-marker.txt'), 'utf8'), toVersion);
    const kept = await pageEval(workerSession, `chrome.storage.local.get('e2e.marker').then(bin => bin['e2e.marker'])`);
    assert.equal(kept, fromVersion, 'Extension storage survives the update');
    let state;
    for ( let attempt = 0; attempt < 20; attempt++ ) {
        state = await pageEval(workerSession, `chrome.storage.local.get('autoUpdate.state').then(bin => bin['autoUpdate.state'])`);
        if ( state?.lastUpdate?.to === toVersion ) { break; }
        await sleep(500);
    }
    assert.deepEqual([ state.lastUpdate?.from, state.lastUpdate?.to ], [ fromVersion, toVersion ]);
    const rulesets = await pageEval(workerSession, 'chrome.declarativeNetRequest.getEnabledRulesets()');
    assert.ok(rulesets.length > 0, 'Static rulesets are active after the update');
    step('updated automatically', { seconds: report.updateSeconds, enabledRulesets: rulesets.length });

    // Rollback from the new version's dashboard.
    const dashboard2 = await openPage(`chrome-extension://${id}/dashboard.html#settings`);
    const message2 = request => pageEval(dashboard2.sessionId,
        `import('./js/ext.js').then(ext => ext.sendMessage(${JSON.stringify(request)}))`);
    status = await message2({ what: 'getUpdateStatus', probe: true });
    assert.equal(status.updater?.backupVersion, fromVersion);
    const rollbackText = await pageEval(dashboard2.sessionId,
        `new Promise(r => setTimeout(() => r(document.querySelector('#autoUpdateRollback')?.hidden === false ? document.querySelector('#autoUpdateRollback').textContent.trim() : ''), 1000))`);
    assert.match(rollbackText, new RegExp(fromVersion.replaceAll('.', '\\.')));
    // The reply may not arrive: the worker reloads right after answering.
    report.rollbackReply = await message2({ what: 'rollbackUpdate' }).catch(String);
    reached = '';
    for ( let attempt = 0; attempt < 120 && reached !== fromVersion; attempt++ ) {
        await sleep(500);
        try {
            workerSession = await attachWorker();
            reached = await workerVersion();
        } catch {
        }
    }
    if ( reached !== fromVersion ) {
        report.rollbackDiagnostics = {
            state: await pageEval(workerSession,
                `chrome.storage.local.get('autoUpdate.state').then(bin => bin['autoUpdate.state'])`).catch(String),
            disk: await readFile(path.join(installDir, 'manifest.json'), 'utf8')
                .then(text => JSON.parse(text).version, String),
        };
        console.log('rollback diagnostics', JSON.stringify(report.rollbackReply),
            JSON.stringify(report.rollbackDiagnostics).slice(0, 3000));
    }
    assert.equal(reached, fromVersion, 'Rollback reloaded the previous version');
    assert.equal(await stat(path.join(installDir, 'e2e-update-marker.txt')).then(() => true, () => false), false);
    step('rolled back', { version: reached });
    assert.ok(served.some(url => url.endsWith('.sha256')) && served.some(url => url.endsWith('.zip')));
    report.result = 'passed';
} catch (reason) {
    report.result = 'failed';
    report.error = String(reason?.stack || reason);
    throw reason;
} finally {
    await chrome?.close();
    server.close();
    for ( const { key, value } of savedRegistrations ) {
        if ( value === '<none>' ) {
            ps(`if ( Test-Path '${key}' ) { Remove-Item '${key}' -Recurse -Force }`);
        } else {
            ps(`New-Item -Path '${key}' -Force | Out-Null; Set-Item -LiteralPath '${key}' -Value '${value.replaceAll("'", "''")}'`);
        }
    }
    await sleep(1000);
    if ( options.output ) { await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`); }
    await rm(fixture, { recursive: true, force: true }).catch(() => { });
}
console.log(`Auto-update Chrome test passed on ${report.browser}: ${fromVersion} → ${toVersion} → ${fromVersion}.`);
