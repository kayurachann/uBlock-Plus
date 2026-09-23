// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Automatic update policy (update-core.js) and worker orchestration
// (update-manager.js) with fake browser APIs, network and native updater.

import {
    UPDATE_ALARM,
    UPDATE_HOST_NAME,
    UPDATE_RELEASES_API,
    UPDATE_RETRY_ALARM,
    UPDATE_SETTINGS_KEY,
    UPDATE_STATE_KEY,
    applyUpdatePolicy,
    assetNameFor,
    classifyNativeError,
    compactReleases,
    compareVersions,
    editionFromManifest,
    isDevelopmentVersion,
    nextRetryDelay,
    normalizeUpdateSettings,
    normalizeUpdaterReply,
    parseVersion,
    selectUpdate,
    updatePolicyFrom,
} from '../platform/mv3/extension/js/update-core.js';
import assert from 'node:assert/strict';
import { createUpdateManager } from '../platform/mv3/extension/js/update-manager.js';

// ---------------------------------------------------------------------------
// update-core

assert.deepEqual(parseVersion('1.2.3'), [ 1, 2, 3 ]);
assert.deepEqual(parseVersion('v1.2.3.4'), [ 1, 2, 3, 4 ]);
for ( const invalid of [ '', 'v', '01.2', '1.2.3.4.5', '65536', '1.2.x', '1..2', ' 1.2', 1, null, '1.74.1b1' ] ) {
    assert.equal(parseVersion(invalid), null, `${invalid} is not a version`);
}
assert.equal(compareVersions('1.2', '1.2.0'), 0);
assert.equal(compareVersions('1.10', '1.9'), 1);
assert.equal(compareVersions('1.1.2', '1.2'), -1);
assert.throws(() => compareVersions('1.2', 'nope'));
assert.equal(isDevelopmentVersion('2026.923.1530'), true, 'Timestamp builds are development builds');
assert.equal(isDevelopmentVersion('1.1.2'), false);
assert.equal(isDevelopmentVersion('garbage'), true);
assert.equal(editionFromManifest({ name: '__MSG_extName__' }), 'standard');
assert.equal(editionFromManifest({ name: 'uBlock Plus+ Experimental' }), 'experimental');
assert.equal(editionFromManifest({ name: 'x', key: 'MIIB' }), 'experimental');
assert.equal(assetNameFor('1.2.0', 'standard'), 'uBlock-Plus_1.2.0.chromium.zip');
assert.equal(assetNameFor('1.2.0', 'experimental'), 'uBlock-Plus_1.2.0.experimental.chromium.zip');

assert.deepEqual(normalizeUpdateSettings(undefined), { schemaVersion: 1, check: true, install: 'auto', channel: 'preview' });
assert.deepEqual(normalizeUpdateSettings({ check: false, install: 'notify', channel: 'stable', extra: 1 }),
    { schemaVersion: 1, check: false, install: 'notify', channel: 'stable' });
assert.deepEqual(normalizeUpdateSettings({ install: 'always', check: 'yes' }), normalizeUpdateSettings({}));
assert.throws(() => normalizeUpdateSettings({ install: 'always' }, { strict: true }));
assert.throws(() => normalizeUpdateSettings({ check: 1 }, { strict: true }));
assert.throws(() => normalizeUpdateSettings([], { strict: true }));

// Managed storage caps the user settings.
assert.equal(updatePolicyFrom(undefined), '');
assert.equal(updatePolicyFrom({ autoUpdate: 'auto' }), '');
for ( const typo of [ 'Off', 'disabled', 'NOTIFY', 0, false, [] ] ) {
    assert.equal(updatePolicyFrom({ autoUpdate: typo }), 'notify',
        `An unrecognized value (${JSON.stringify(typo)}) never allows silent installs`);
}
assert.equal(updatePolicyFrom({ autoUpdate: '' }), '');
assert.equal(updatePolicyFrom({ autoUpdate: null }), '');
assert.equal(updatePolicyFrom({ autoUpdate: 'off', disabledFeatures: [ 'dashboard' ] }), 'off');
assert.equal(updatePolicyFrom({ autoUpdate: 'notify' }), 'notify');
assert.equal(updatePolicyFrom({ disabledFeatures: [ 'dashboard' ] }), 'notify',
    'With the Updates section hidden, the extension never replaces itself silently');
assert.equal(updatePolicyFrom({ disabledFeatures: 'dashboard' }), '');
assert.deepEqual(applyUpdatePolicy(normalizeUpdateSettings({}), 'off'),
    { schemaVersion: 1, check: false, install: 'notify', channel: 'preview' });
assert.deepEqual(applyUpdatePolicy(normalizeUpdateSettings({ channel: 'stable' }), 'notify'),
    { schemaVersion: 1, check: true, install: 'notify', channel: 'stable' });
assert.deepEqual(applyUpdatePolicy(normalizeUpdateSettings({}), ''), normalizeUpdateSettings({}));

const asset = (version, edition = 'standard') => [ assetNameFor(version, edition), `${assetNameFor(version, edition)}.sha256` ];
const githubRelease = (tag, extra = {}, assets = null) => ({
    tag_name: tag, draft: false, prerelease: true, name: `Release ${tag}`,
    published_at: '2026-09-20T00:00:00Z', body: 'x'.repeat(5000),
    assets: (assets || asset(tag.slice(1))).map(name => ({ name, browser_download_url: `https://evil.example/${name}` })),
    ...extra,
});
const compact = compactReleases([
    githubRelease('v1.3.0', { name: 'Evil\u0000\u001b[31m name\n\twith   spaces' }),
    githubRelease('1.74.1b1'),
    githubRelease('v1.2.0.1.0'),
    null,
    'string',
    { tag_name: 'v9.0.0', assets: 'none' },
]);
assert.equal(compact.length, 2);
assert.equal(compact[0].name, 'Evil [31m name with spaces', 'Control characters are stripped');
assert.equal('body' in compact[0], false, 'Release notes are not cached');
assert.deepEqual(compact[1].assets, []);
assert.equal(JSON.stringify(compact).includes('evil.example'), false, 'Download URLs from the API are never kept');

const releases = compactReleases([
    githubRelease('v2.0.0', { draft: true }),
    githubRelease('v1.9.0', {}, [ 'uBlock-Plus_1.9.0.chromium.zip' ]),
    githubRelease('v1.8.0', {}, asset('1.8.0', 'experimental')),
    githubRelease('v1.5.0'),
    githubRelease('v1.4.0', { prerelease: false }),
    githubRelease('v1.1.2', { prerelease: false }),
]);
assert.equal(selectUpdate(releases, { currentVersion: '1.1.2', channel: 'preview', edition: 'standard' }).version, '1.5.0');
assert.equal(selectUpdate(releases, { currentVersion: '1.1.2', channel: 'stable', edition: 'standard' }).version, '1.4.0');
assert.equal(selectUpdate(releases, { currentVersion: '1.1.2', channel: 'preview', edition: 'experimental' }).version, '1.8.0');
assert.equal(selectUpdate(releases, { currentVersion: '1.5.0', channel: 'preview', edition: 'standard' }), null);
assert.equal(selectUpdate(releases, { currentVersion: 'bad', channel: 'preview', edition: 'standard' }), null);
assert.equal(selectUpdate(releases, { currentVersion: '1.1.2', channel: 'preview', edition: 'standard' }).page,
    'https://github.com/kayurachann/uBlock-Plus/releases/tag/v1.5.0', 'Release page is built locally');

assert.equal(nextRetryDelay(1), 15 * 60 * 1000);
assert.equal(nextRetryDelay(2), 30 * 60 * 1000);
assert.equal(nextRetryDelay(50), 24 * 60 * 60 * 1000, 'Backoff is capped at one day');
assert.equal(nextRetryDelay(1, 3 * 60 * 60 * 1000), 3 * 60 * 60 * 1000, 'Server retry time wins');

assert.equal(normalizeUpdaterReply(null).error.code, 'invalid-reply');
assert.equal(normalizeUpdaterReply({ v: 2, ok: true }).error.code, 'unsupported-protocol');
assert.equal(normalizeUpdaterReply({ v: 1, ok: false, error: { code: '<img onerror>', message: 'm' } }).error.code, 'updater-error');
assert.equal(normalizeUpdaterReply({ v: 1, ok: false, error: { code: 'checksum-mismatch', message: 'bad' } }).error.code, 'checksum-mismatch');
assert.equal(normalizeUpdaterReply({ v: 1, ok: false, error: { code: 'busy', message: 'Another update is already running.' } }).error.code,
    'update-busy', 'The updater lock is another update, not a filter-list transaction');
assert.deepEqual(normalizeUpdaterReply({ v: 1, ok: true, version: '1.2.0', applied: { from: '1.1.0', to: '1.2.0' }, evil: 1 }),
    { ok: true, version: '1.2.0', applied: { from: '1.1.0', to: '1.2.0' } });
assert.equal(classifyNativeError('Specified native messaging host not found.'), 'updater-missing');
assert.equal(classifyNativeError('Access to the specified native messaging host is forbidden.'), 'updater-forbidden');
assert.equal(classifyNativeError('Native host has exited.'), 'updater-failed');
assert.equal(classifyNativeError('Something else'), 'updater-error');

// ---------------------------------------------------------------------------
// update-manager harness

function createHarness(options = {}) {
    // Split incognito mode: two workers share storage.local and the alarms.
    const storage = options.shared?.storage || new Map(Object.entries(options.storage || {}));
    const alarmsCreated = [];
    const alarmsCleared = [];
    const alarmRegistry = options.shared?.alarmRegistry || new Map();
    const fetches = [];
    const broadcasts = [];
    const nativeCalls = [];
    const timers = [];
    let clock = options.now ?? 1_000_000_000_000;
    let reloads = 0;
    const responses = options.responses || [];
    const native = options.native || {};
    const runtime = {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        lastError: undefined,
        getManifest: () => ({ version: options.version || '1.1.2', name: options.name || '__MSG_extName__' }),
        getPlatformInfo: async () => ({ os: options.os || 'win' }),
        reload: () => { reloads += 1; },
        sendNativeMessage(name, message, callback) {
            assert.equal(name, UPDATE_HOST_NAME);
            nativeCalls.push(message);
            // A promise reply lets a test hold the updater mid-operation.
            Promise.resolve(native[message.cmd]?.(message)).then(reply => {
                if ( reply instanceof Error ) {
                    runtime.lastError = { message: reply.message };
                    callback(undefined);
                    runtime.lastError = undefined;
                    return;
                }
                callback(reply);
            });
        },
    };
    const settingsOpened = [];
    if ( options.binding === false ) {
        // Permission granted while this worker was running: Chrome has not
        // bound the native messaging functions into it.
        delete runtime.sendNativeMessage;
    }
    if ( options.nativeMessaging !== false && options.binding !== false ) {
        runtime.connectNative = name => {
            assert.equal(name, UPDATE_HOST_NAME);
            const messageListeners = [];
            const disconnectListeners = [];
            return {
                onMessage: { addListener: fn => messageListeners.push(fn) },
                onDisconnect: { addListener: fn => disconnectListeners.push(fn) },
                disconnect() {},
                postMessage(message) {
                    nativeCalls.push(message);
                    const script = native.stagePort?.(message) || [];
                    let delay = 0;
                    for ( const step of script ) {
                        delay += 1;
                        setTimeout(() => {
                            if ( step === 'disconnect' ) {
                                runtime.lastError = { message: 'Native host has exited.' };
                                disconnectListeners.forEach(fn => fn());
                                runtime.lastError = undefined;
                                return;
                            }
                            messageListeners.forEach(fn => fn({ id: message.id, ...step }));
                        }, delay);
                    }
                },
            };
        };
    }
    const manager = createUpdateManager({
        runtime,
        alarms: {
            async get(name) { return alarmRegistry.get(name); },
            async create(name, details) { alarmsCreated.push({ name, ...details }); alarmRegistry.set(name, details); },
            async clear(name) { alarmsCleared.push(name); alarmRegistry.delete(name); return true; },
        },
        permissions: { async contains() { return options.permission !== false; } },
        localRead: async key => structuredClone(storage.get(key)),
        localWrite: async (key, value) => { storage.set(key, structuredClone(value)); },
        fetch: async (url, init) => {
            fetches.push({ url, init });
            const next = responses.shift();
            if ( next instanceof Error ) { throw next; }
            return next;
        },
        now: () => clock,
        broadcast: message => broadcasts.push(message),
        isBusy: options.isBusy || (async () => false),
        getInstallType: async () => options.installType || 'development',
        getPolicy: options.getPolicy || (async () => options.policy || {}),
        inIncognito: options.incognito === true,
        reloadDelay: 0,
        setTimer: fn => timers.push(fn),
        openSettingsPage: async () => { settingsOpened.push(true); },
    });
    return {
        manager, storage, alarmRegistry, alarmsCreated, settingsOpened, alarmsCleared, fetches, broadcasts, nativeCalls, runtime,
        advance: ms => { clock += ms; },
        runTimers: () => { while ( timers.length ) { timers.shift()(); } },
        get reloads() { return reloads; },
        state: () => storage.get(UPDATE_STATE_KEY),
    };
}

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const helloOk = (installedVersion = '1.1.2') => () => ({ v: 1, ok: true, updaterVersion: '1.0.0', installedVersion, edition: 'standard', stagedVersion: null, backupVersion: null });
// Cached release list offering these versions (install only installs what
// the selected channel offers).
const offering = (...versions) => ({ [UPDATE_STATE_KEY]: {
    schemaVersion: 1,
    releases: versions.map(version => ({
        tag: `v${version}`, draft: false, prerelease: true, name: '', publishedAt: '', assets: asset(version),
    })),
} });
const stageOk = version => () => [ { v: 1, ok: true, version } ];
const applyOk = (from, to) => () => ({ v: 1, ok: true, applied: { from, to } });
// A native reply held until the test releases it.
const gate = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release: value => release(value) };
};

// initialize(): alarm management and post-reload bookkeeping.
{
    const h = createHarness({ storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, pendingReload: { from: '1.1.1', to: '1.1.2', at: 1 },
        available: { version: '1.1.2' }, install: null,
    } } });
    await h.manager.initialize();
    assert.equal(h.alarmsCreated.length, 1);
    assert.equal(h.alarmsCreated[0].name, UPDATE_ALARM);
    assert.equal(h.alarmsCreated[0].periodInMinutes, 360);
    assert.ok(h.alarmsCreated[0].delayInMinutes >= 2);
    assert.deepEqual([ h.state().lastUpdate.from, h.state().lastUpdate.to ], [ '1.1.1', '1.1.2' ]);
    assert.equal(h.state().pendingReload, null);
    assert.equal(h.state().available, null, 'The now-installed version is no longer offered');
    await h.manager.initialize();
    assert.equal(h.alarmsCreated.length, 1, 'An existing alarm is kept');
}
{
    const h = createHarness({ storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, pendingReload: { from: '1.1.2', to: '1.2.0', at: 1 },
        install: { version: '1.2.0', phase: 'download', startedAt: 1 },
    } } });
    await h.manager.initialize();
    assert.equal(h.state().lastError.code, 'reload-mismatch');
    assert.equal(h.state().install, null, 'A stale install marker is cleared');
}
{
    const h = createHarness({ storage: { [UPDATE_SETTINGS_KEY]: { check: false } } });
    await h.manager.initialize();
    assert.deepEqual(h.alarmsCleared, [ UPDATE_ALARM, UPDATE_RETRY_ALARM ]);
    assert.equal(h.alarmsCreated.length, 0);
    const incognito = createHarness({ incognito: true });
    await incognito.manager.initialize();
    assert.equal(incognito.alarmsCreated.length, 0, 'The incognito worker never schedules checks');
    assert.equal(incognito.alarmsCleared.length, 0, 'The incognito worker never clears the shared alarms');
}

// check(): network hygiene, selection, ETag reuse, throttling, rate limits.
{
    const list = [ githubRelease('v1.2.0'), githubRelease('v1.1.2') ];
    const h = createHarness({
        installType: 'normal',
        responses: [
            jsonResponse(list, { headers: { etag: '"abc"' } }),
            new Response(null, { status: 304 }),
            new Response('{}', { status: 403, headers: { 'x-ratelimit-reset': String((1_000_000_000_000 + 3 * 60 * 60 * 1000) / 1000 + 7200) } }),
        ],
    });
    let status = await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 1);
    assert.equal(h.fetches[0].url, UPDATE_RELEASES_API);
    const init = h.fetches[0].init;
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.headers['If-None-Match'], undefined);
    assert.equal(status.available.version, '1.2.0');
    assert.equal(status.installBlockedBy, 'not-unpacked', 'CRX/policy installs are not auto-installed');
    assert.equal(h.nativeCalls.length, 0);
    assert.ok(h.broadcasts.some(message => message.autoUpdate === true));

    status = await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 1, 'Manual checks are throttled to one per minute');
    assert.equal(status.throttled, true, 'A throttled Check now says so');
    assert.equal(status.retryAt, h.state().lastCheck + 60 * 1000);
    h.advance(61 * 1000);
    status = await h.manager.check({ manual: false });
    assert.equal(h.fetches.length, 1, 'Scheduled checks wait at least 30 minutes');
    h.advance(30 * 60 * 1000);
    status = await h.manager.check({ manual: false });
    assert.equal(h.fetches.length, 2);
    assert.equal(h.fetches[1].init.headers['If-None-Match'], '"abc"', 'The ETag is revalidated');
    assert.equal(status.available.version, '1.2.0', 'A 304 reuses cached releases');

    h.advance(31 * 60 * 1000);
    status = await h.manager.check({ manual: false });
    assert.equal(status.lastError.code, 'rate-limited');
    assert.ok(status.nextCheckAfter - h.state().lastCheck >= 2 * 60 * 60 * 1000, 'Rate-limit reset time is honoured');
    assert.equal(status.available.version, '1.2.0', 'A failed check keeps the last known result');
    h.advance(31 * 60 * 1000);
    await h.manager.check({ manual: false });
    assert.equal(h.fetches.length, 3, 'Backoff suppresses scheduled checks');
}
{
    const h = createHarness({
        responses: [ new Response('x'.repeat(10), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }) ],
    });
    const status = await h.manager.check({ manual: true });
    assert.equal(status.lastError.code, 'response-too-large');
    assert.equal(h.state().failures, 1);
}
{
    const h = createHarness({ storage: { [UPDATE_SETTINGS_KEY]: { check: false } }, responses: [ jsonResponse([]) ] });
    await h.manager.check({ manual: false });
    assert.equal(h.fetches.length, 0, 'Disabled checks never contact the network automatically');
    await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 1, 'A manual check still works when automatic checks are off');
}
{
    const h = createHarness({ version: '2026.923.1530', responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ] });
    const status = await h.manager.check({ manual: true });
    assert.equal(status.devBuild, true);
    assert.equal(status.available, null, 'Development builds never look outdated');
    assert.equal(status.installBlockedBy, 'development-build');
}
{
    // Tampered cached state is normalized before use.
    const h = createHarness({ storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, lastCheck: -5, failures: 'many', etag: 'x'.repeat(500),
        releases: [ { tag: 'v9.9.9', assets: [ '<img>' ] }, { tag: 'evil' } ],
    } } });
    const status = await h.manager.getStatus();
    assert.equal(status.lastCheck, 0);
    assert.equal(h.storage.get(UPDATE_STATE_KEY).failures, 'many', 'Reads do not rewrite state');
}

// Automatic installation through the native updater.
{
    const h = createHarness({
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: {
            hello: helloOk(),
            stagePort: message => {
                assert.deepEqual([ message.v, message.cmd, message.version ], [ 1, 'stage', '1.2.0' ]);
                return [
                    { event: 'progress', phase: 'download', received: 1048576, total: 30000000 },
                    { v: 1, ok: true, version: '1.2.0' },
                ];
            },
            apply: message => {
                assert.equal(message.version, '1.2.0');
                return { v: 1, ok: true, applied: { from: '1.1.2', to: '1.2.0' } };
            },
        },
    });
    await h.manager.check({ manual: false });
    await settle();
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello', 'stage', 'apply' ]);
    assert.ok(h.nativeCalls.every(call => call.v === 1 && Object.keys(call).every(key => [ 'v', 'id', 'cmd', 'version' ].includes(key))),
        'Only version strings are sent to the updater; never URLs or paths');
    assert.deepEqual(h.state().pendingReload.to, '1.2.0');
    assert.equal(h.state().install, null);
    assert.equal(h.reloads, 0);
    h.runTimers();
    assert.equal(h.reloads, 1, 'The extension reloads into the new version');
}
{
    const h = createHarness({
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        storage: { [UPDATE_SETTINGS_KEY]: { install: 'notify' } },
        native: { hello: helloOk() },
    });
    await h.manager.check({ manual: false });
    await settle();
    assert.equal(h.nativeCalls.length, 0, 'Notify mode never installs');
}
{
    const h = createHarness({ responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ], permission: false });
    const status = await h.manager.check({ manual: false });
    await settle();
    assert.equal(status.installBlockedBy, 'permission-required');
    assert.equal(h.nativeCalls.length, 0);
}

// Manual installation failures are recorded, never half-applied.
for ( const [ label, native, code ] of [
    [ 'missing updater', { hello: () => new Error('Specified native messaging host not found.') }, 'updater-missing' ],
    [ 'forbidden', { hello: () => new Error('Access to the specified native messaging host is forbidden.') }, 'updater-forbidden' ],
    [ 'checksum', { hello: helloOk(), stagePort: () => [ { v: 1, ok: false, error: { code: 'checksum-mismatch', message: 'bad' } } ] }, 'checksum-mismatch' ],
    [ 'crash', { hello: helloOk(), stagePort: () => [ 'disconnect' ] }, 'updater-failed' ],
    [ 'wrong stage', { hello: helloOk(), stagePort: () => [ { v: 1, ok: true, version: '9.0.0' } ] }, 'identity-mismatch' ],
    [ 'apply failure', { hello: helloOk(), stagePort: () => [ { v: 1, ok: true, version: '1.2.0' } ], apply: () => ({ v: 1, ok: false, error: { code: 'apply-failed', message: 'restored' } }) }, 'apply-failed' ],
    [ 'wrong edition', { hello: () => ({ v: 1, ok: true, installedVersion: '1.1.2', edition: 'experimental' }) }, 'identity-mismatch' ],
    [ 'older folder', { hello: helloOk('1.0.0') }, 'folder-mismatch' ],
    [ 'updater lock', { hello: helloOk(), stagePort: () => [ { v: 1, ok: false, error: { code: 'busy', message: 'Another update is already running.' } } ] }, 'update-busy' ],
] ) {
    const h = createHarness({ native, storage: offering('1.2.0') });
    await assert.rejects(h.manager.install('1.2.0'), error => error.code === code, label);
    assert.equal(h.state().lastError.code, code, label);
    assert.equal(h.state().install, null, label);
    assert.equal(h.state().pendingReload, null, label);
    h.runTimers();
    assert.equal(h.reloads, 0, `${label}: no reload`);
}
{
    const h = createHarness({ native: { hello: helloOk('1.3.0') } });
    const result = await h.manager.install('1.2.0');
    assert.equal(result.version, '1.3.0', 'A folder already updated by the command-line updater is picked up');
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello' ]);
    h.runTimers();
    assert.equal(h.reloads, 1);
}
for ( const [ label, options, code ] of [
    [ 'no permission', { permission: false }, 'permission-required' ],
    [ 'crx install', { installType: 'normal' }, 'not-unpacked' ],
    [ 'dev build', { version: '2026.1.1' }, 'development-build' ],
    [ 'incognito', { incognito: true }, 'incognito' ],
    [ 'busy', { isBusy: async () => true }, 'filters-busy' ],
    [ 'linux', { os: 'linux' }, 'unsupported-os' ],
    [ 'mac', { os: 'mac' }, 'unsupported-os' ],
    [ 'policy off', { policy: { autoUpdate: 'off' } }, 'disabled-by-policy' ],
] ) {
    const h = createHarness({ ...options, native: { hello: helloOk() }, storage: offering('1.2.0') });
    await assert.rejects(h.manager.install('1.2.0'), error => error.code === code, label);
    assert.equal(h.nativeCalls.length, 0, label);
}
{
    const h = createHarness({ native: { hello: helloOk() } });
    await assert.rejects(h.manager.install('1.1.2'), error => error.code === 'not-newer');
    await assert.rejects(h.manager.install('1.2.0; calc'), error => error.code === 'invalid-version');
}
{
    const h = createHarness({ storage: offering('1.2.0'), native: {
        hello: helloOk(),
        stagePort: () => [ 'disconnect' ],
    } });
    const first = h.manager.install('1.2.0');
    const second = h.manager.install('1.2.0');
    assert.equal(first, second, 'Installs are single-flight');
    await assert.rejects(first, error => error.code === 'updater-failed');
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello', 'stage' ], 'Only one install ran');
}

// Rollback
{
    const h = createHarness({ native: { rollback: () => ({ v: 1, ok: true, applied: { from: '1.2.0', to: '1.1.0' } }) } });
    const result = await h.manager.rollback();
    assert.equal(result.version, '1.1.0');
    assert.equal(h.state().pendingReload.rollback, true);
    h.runTimers();
    assert.equal(h.reloads, 1);
    const failed = createHarness({ native: { rollback: () => ({ v: 1, ok: false, error: { code: 'no-backup', message: 'none' } }) } });
    await assert.rejects(failed.manager.rollback(), error => error.code === 'no-backup');
    assert.equal(failed.state().lastError.code, 'no-backup');
}

// Settings and status
{
    const h = createHarness({ native: { hello: helloOk() } });
    await assert.rejects(h.manager.setSettings({ install: 'yolo' }));
    let settings = await h.manager.setSettings({ channel: 'stable' });
    assert.equal(settings.channel, 'stable');
    assert.equal(settings.install, 'auto', 'Unspecified settings keep their value');
    assert.equal(h.alarmsCreated.length, 1);
    settings = await h.manager.setSettings({ check: false });
    assert.deepEqual(h.alarmsCleared, [ UPDATE_ALARM, UPDATE_RETRY_ALARM ]);
    const status = await h.manager.getStatus({ probe: true });
    assert.equal(status.updater.connected, true);
    assert.equal(status.updater.version, '1.0.0');
    assert.equal(status.extensionId, h.runtime.id);
    assert.equal(status.edition, 'standard');
    assert.equal(status.settings.check, false);
    const missing = createHarness({ native: { hello: () => new Error('Specified native messaging host not found.') } });
    const missingStatus = await missing.manager.getStatus({ probe: true });
    assert.equal(missingStatus.updater.connected, false);
    assert.equal(missingStatus.updater.error.code, 'updater-missing');
    assert.equal(await missing.manager.onAlarm({ name: 'other' }), false);
}

// A permission granted while the worker runs needs one restart before the
// native messaging functions exist; the worker then reopens the settings.
{
    const h = createHarness({ binding: false, native: { hello: helloOk() } });
    let status = await h.manager.getStatus({ probe: true });
    assert.equal(status.permission, false);
    assert.equal(status.restartRequired, true);
    assert.equal(status.installBlockedBy, 'restart-required');
    await assert.rejects(h.manager.install('1.2.0'), error => error.code === 'restart-required');
    assert.equal(h.nativeCalls.length, 0);
    const result = await h.manager.activateUpdater();
    assert.equal(result.reloading, true);
    assert.equal(h.reloads, 0);
    h.runTimers();
    assert.equal(h.reloads, 1, 'The extension restarts once to bind native messaging');
    assert.equal(h.state().reopenSettings, true);
    // The next worker, now with the binding, reopens the Updates section once.
    const next = createHarness({ storage: Object.fromEntries(h.storage), native: { hello: helloOk() } });
    await next.manager.initialize();
    assert.equal(next.settingsOpened.length, 1);
    assert.equal(next.state().reopenSettings, undefined);
    await next.manager.initialize();
    assert.equal(next.settingsOpened.length, 1, 'The settings page is reopened only once');
    status = await next.manager.getStatus({ probe: true });
    assert.equal(status.permission, true);
    assert.equal(status.restartRequired, false);
    assert.equal(status.updater.connected, true);
    const connected = await next.manager.activateUpdater();
    assert.equal(connected.reloading, false, 'No restart when the binding is already present');
    const denied = createHarness({ permission: false });
    await assert.rejects(denied.manager.activateUpdater(), error => error.code === 'permission-required');
    const automatic = createHarness({ binding: false, responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ] });
    await automatic.manager.check({ manual: false });
    await settle();
    assert.equal(automatic.state().lastError, null, 'A pending restart is not reported as an install error');
}

// A rollback holds the version rolled back from: automatic installs skip it
// until a newer release appears or the user selects "Install now".
{
    const before = createHarness({ version: '1.3.0', native: {
        rollback: () => ({ v: 1, ok: true, applied: { from: '1.3.0', to: '1.2.0' } }),
    } });
    await before.manager.rollback();
    assert.equal(before.state().reopenSettings, true, 'Restore reopens the Updates section after the reload');
    const list = () => [ githubRelease('v1.3.0'), githubRelease('v1.2.0') ];
    // The next worker runs the restored version.
    const h = createHarness({
        version: '1.2.0',
        storage: Object.fromEntries(before.storage),
        responses: [
            jsonResponse(list()),
            jsonResponse(list()),
            jsonResponse([ githubRelease('v1.3.1'), ...list() ]),
        ],
        native: {
            hello: helloOk('1.2.0'),
            stagePort: message => [ { v: 1, ok: true, version: message.version } ],
            apply: message => ({ v: 1, ok: true, applied: { from: '1.2.0', to: message.version } }),
        },
    });
    await h.manager.initialize();
    assert.equal(h.settingsOpened.length, 1);
    assert.equal(h.state().lastUpdate.rollback, true);
    assert.equal(h.state().heldVersion, '1.3.0');
    for ( let i = 0; i < 2; i++ ) {
        h.advance(6 * 60 * 60 * 1000);
        await h.manager.onAlarm({ name: UPDATE_ALARM });
        await settle();
        assert.deepEqual(h.nativeCalls, [], 'The version rolled back from is not reinstalled automatically');
    }
    const status = await h.manager.getStatus();
    assert.equal(status.available.version, '1.3.0', 'The held version is still offered');
    assert.equal(status.heldVersion, '1.3.0');
    h.advance(6 * 60 * 60 * 1000);
    await h.manager.onAlarm({ name: UPDATE_ALARM });
    await settle();
    assert.equal(h.fetches.length, 3);
    assert.equal(h.state().heldVersion, null, 'A strictly newer release ends the hold');
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello', 'stage', 'apply' ]);
    assert.equal(h.state().pendingReload.to, '1.3.1');
    assert.equal(h.state().reopenSettings, undefined, 'Automatic installs do not reopen the dashboard');
}
{
    const h = createHarness({
        version: '1.2.0',
        storage: { [UPDATE_STATE_KEY]: { ...offering('1.3.0')[UPDATE_STATE_KEY], heldVersion: '1.3.0' } },
        native: { hello: helloOk('1.2.0'), stagePort: stageOk('1.3.0'), apply: applyOk('1.2.0', '1.3.0') },
    });
    await h.manager.initialize();
    assert.equal(h.state().heldVersion, '1.3.0');
    assert.equal((await h.manager.install('1.3.0')).version, '1.3.0', 'Install now installs a held version');
    assert.equal(h.state().heldVersion, null, 'and ends the hold');
    assert.equal(h.state().reopenSettings, true, 'Install now reopens the Updates section after the reload');
    const later = createHarness({ version: '1.3.0', storage: { [UPDATE_STATE_KEY]: { schemaVersion: 1, heldVersion: '1.3.0' } } });
    await later.manager.initialize();
    assert.equal(later.state().heldVersion, null, 'A hold on a version no longer newer is dropped');
}

// initialize() keeps the marker of an install this worker is running.
{
    const hello = gate();
    const h = createHarness({ storage: offering('1.2.0'), native: { hello: () => hello.promise } });
    const running = h.manager.install('1.2.0');
    await settle();
    assert.equal(h.state().install.phase, 'prepare');
    await h.manager.initialize();
    assert.equal(h.state().install?.phase, 'prepare');
    assert.equal(h.state().lastError, null, 'A running install is not reported as interrupted');
    hello.release(new Error('Native host has exited.'));
    await assert.rejects(running, error => error.code === 'updater-failed');
}

// Split incognito mode: the incognito worker shares storage.local and the
// alarms with the regular worker, and must leave both alone.
{
    const hello = gate();
    const regular = createHarness({ storage: offering('1.2.0'), native: { hello: () => hello.promise } });
    await regular.manager.initialize();
    const running = regular.manager.install('1.2.0');
    await settle();
    const snapshot = structuredClone(regular.state());
    snapshot.reopenSettings = true;
    snapshot.pendingReload = { from: '1.1.2', to: '1.2.0', at: 1, automatic: false };
    regular.storage.set(UPDATE_STATE_KEY, structuredClone(snapshot));
    assert.equal(snapshot.install.version, '1.2.0');
    const incognito = createHarness({ incognito: true, shared: regular, native: { hello: helloOk() } });
    await incognito.manager.initialize();
    assert.deepEqual(regular.state(), snapshot, 'The incognito worker leaves the marker, pendingReload and reopenSettings');
    assert.equal(regular.alarmRegistry.has(UPDATE_ALARM), true, 'and the shared alarm');
    assert.deepEqual([ incognito.alarmsCreated, incognito.alarmsCleared ], [ [], [] ]);
    assert.equal(incognito.settingsOpened.length, 0);
    const status = await incognito.manager.getStatus({ probe: true });
    assert.equal(status.incognito, true);
    assert.equal(status.installBlockedBy, 'incognito');
    await assert.rejects(incognito.manager.install('1.2.0'), error => error.code === 'incognito');
    await assert.rejects(incognito.manager.rollback(), error => error.code === 'incognito');
    await assert.rejects(incognito.manager.check({ manual: true }), error => error.code === 'incognito');
    await assert.rejects(incognito.manager.setSettings({ check: false }), error => error.code === 'incognito');
    await incognito.manager.onAlarm({ name: UPDATE_ALARM });
    await incognito.manager.onAlarm({ name: UPDATE_RETRY_ALARM });
    // Without the native binding, the regular worker would restart; the
    // incognito worker must neither flag a reopen nor reload the extension
    // under the regular worker's install.
    const incognitoRestart = createHarness({ incognito: true, binding: false, shared: regular });
    await assert.rejects(incognitoRestart.manager.activateUpdater(), error => error.code === 'incognito');
    incognitoRestart.runTimers();
    assert.equal(incognitoRestart.reloads, 0, 'The incognito worker never reloads the extension');
    assert.deepEqual(regular.state(), snapshot, 'Probes and refused actions write nothing to the shared state');
    assert.equal(incognito.fetches.length, 0);
    hello.release(new Error('Native host has exited.'));
    await assert.rejects(running);
}

// Switching to stable releases withdraws a cached pre-release.
{
    const list = () => [ githubRelease('v1.2.0'), githubRelease('v1.1.2', { prerelease: false }) ];
    const h = createHarness({
        storage: { [UPDATE_SETTINGS_KEY]: { install: 'notify' } },
        responses: [ jsonResponse(list()), jsonResponse(list()) ],
        native: { hello: helloOk(), stagePort: stageOk('1.2.0'), apply: applyOk('1.1.2', '1.2.0') },
    });
    let status = await h.manager.check({ manual: true });
    assert.deepEqual([ status.available.version, status.available.prerelease ], [ '1.2.0', true ]);
    await h.manager.setSettings({ channel: 'stable' });
    status = await h.manager.getStatus();
    assert.equal(status.available, null, 'The stable channel does not offer the pre-release');
    await assert.rejects(h.manager.install('1.2.0'), error => error.code === 'not-offered');
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello' ], 'Nothing is downloaded');
    assert.equal(h.state().lastError.code, 'not-offered');
    h.advance(5 * 1000);
    status = await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 2, 'The first Check now after a channel change is not throttled');
    assert.equal(status.throttled, undefined);
    assert.equal(status.available, null);
    await h.manager.setSettings({ channel: 'preview' });
    assert.equal((await h.manager.getStatus()).available.version, '1.2.0');
}

// Check now repeats a failed check at once, except after a rate limit.
{
    const h = createHarness({ installType: 'normal', responses: [
        new TypeError('Failed to fetch'),
        jsonResponse([]),
        new Response('{}', { status: 403 }),
    ] });
    let status = await h.manager.check({ manual: true });
    assert.equal(status.lastError.code, 'network-error');
    h.advance(5 * 1000);
    status = await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 2);
    assert.equal(status.lastError, null);
    h.advance(61 * 1000);
    status = await h.manager.check({ manual: true });
    assert.equal(status.lastError.code, 'rate-limited');
    h.advance(5 * 1000);
    status = await h.manager.check({ manual: true });
    assert.equal(h.fetches.length, 3, 'A rate limit keeps the throttle');
    assert.equal(status.throttled, true);
}

// Fetch failures are network errors whatever their DOMException code.
for ( const reason of [
    new DOMException('signal timed out', 'TimeoutError'),
    new DOMException('The operation was aborted.', 'AbortError'),
    new TypeError('Failed to fetch'),
] ) {
    const h = createHarness({ responses: [ reason ] });
    const status = await h.manager.check({ manual: true });
    assert.equal(status.lastError.code, 'network-error', reason.name);
}

// A failed check is retried when its backoff ends, not six hours later.
{
    const h = createHarness({ installType: 'normal', responses: [
        new TypeError('Failed to fetch'),
        jsonResponse([ githubRelease('v1.2.0') ]),
    ] });
    await h.manager.initialize();
    h.advance(6 * 60 * 60 * 1000);
    await h.manager.onAlarm({ name: UPDATE_ALARM });
    const retry = h.alarmsCreated.find(alarm => alarm.name === UPDATE_RETRY_ALARM);
    assert.equal(retry.when, h.state().nextCheckAfter);
    assert.equal(retry.when - h.state().lastCheck, 15 * 60 * 1000, 'The first retry follows the 15-minute backoff');
    h.advance(15 * 60 * 1000);
    assert.equal(await h.manager.onAlarm({ name: UPDATE_RETRY_ALARM }), true);
    assert.equal(h.fetches.length, 2, 'The retry runs before the next six-hourly alarm');
    assert.equal(h.state().available.version, '1.2.0');
    assert.equal(h.alarmRegistry.has(UPDATE_RETRY_ALARM), false, 'A successful check clears the retry');
}
{
    const t0 = 1_000_000_000_000;
    const h = createHarness({ storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, lastCheck: t0 - 60 * 1000, failures: 2, nextCheckAfter: t0 + 30 * 60 * 1000,
    } } });
    await h.manager.initialize();
    assert.deepEqual(h.alarmsCreated.find(alarm => alarm.name === UPDATE_RETRY_ALARM),
        { name: UPDATE_RETRY_ALARM, when: t0 + 30 * 60 * 1000 }, 'A lost retry alarm is scheduled again');
    const off = createHarness({ storage: { [UPDATE_SETTINGS_KEY]: { check: false } }, responses: [ new TypeError('offline') ] });
    await off.manager.check({ manual: true });
    assert.equal(off.alarmsCreated.length, 0, 'No retry when automatic checks are off');
}

// Filter-list transactions and running update operations.
{
    const h = createHarness({ isBusy: async () => true, native: {
        rollback: () => ({ v: 1, ok: true, applied: { from: '1.1.2', to: '1.1.0' } }),
    } });
    await assert.rejects(h.manager.rollback(), error => error.code === 'filters-busy');
    assert.equal(h.nativeCalls.length, 0, 'No rollback during a filter-list transaction');
    const restart = createHarness({ binding: false, isBusy: async () => true });
    await assert.rejects(restart.manager.activateUpdater(), error => error.code === 'filters-busy');
    restart.runTimers();
    assert.equal(restart.reloads, 0, 'No restart during a filter-list transaction');
    const automatic = createHarness({
        isBusy: async () => true,
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk() },
    });
    await automatic.manager.check({ manual: false });
    await settle();
    assert.equal(automatic.nativeCalls.length, 0);
    assert.equal(automatic.state().lastError.code, 'filters-busy', 'A blocked automatic install is reported');
}
{
    const rollbackGate = gate();
    const h = createHarness({
        storage: offering('1.2.0'),
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk(), rollback: () => rollbackGate.promise },
    });
    const rolling = h.manager.rollback();
    await assert.rejects(h.manager.install('1.2.0'), error => error.code === 'update-busy');
    await assert.rejects(h.manager.rollback(), error => error.code === 'update-busy');
    assert.equal((await h.manager.getStatus()).installing, true);
    await h.manager.check({ manual: false });
    await settle();
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'rollback' ], 'No automatic install starts during a rollback');
    rollbackGate.release({ v: 1, ok: true, applied: { from: '1.1.2', to: '1.1.0' } });
    await rolling;
    assert.equal(h.state().lastError, null, 'A refused concurrent action is not recorded');
}
{
    const hello = gate();
    const h = createHarness({ storage: offering('1.2.0'), native: {
        hello: () => hello.promise,
        rollback: () => ({ v: 1, ok: true, applied: { from: '1.1.2', to: '1.1.0' } }),
    } });
    const installing = h.manager.install('1.2.0');
    await assert.rejects(h.manager.rollback(), error => error.code === 'update-busy');
    assert.equal(h.nativeCalls.some(call => call.cmd === 'rollback'), false);
    hello.release(new Error('Native host has exited.'));
    await assert.rejects(installing);
}

// A worker woken by an update action waits for its startup (background.js
// isUpdateBlocked) and then proceeds, instead of refusing with filters-busy.
{
    const native = { hello: helloOk(), stagePort: stageOk('1.2.0'), apply: applyOk('1.1.2', '1.2.0') };
    const startup = gate();
    const waitForStartup = async () => { await startup.promise; return false; };
    const manual = createHarness({ storage: offering('1.2.0'), isBusy: waitForStartup, native });
    const automatic = createHarness({
        isBusy: waitForStartup, responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ], native,
    });
    const restore = createHarness({ isBusy: waitForStartup, native: {
        rollback: () => ({ v: 1, ok: true, applied: { from: '1.1.2', to: '1.1.0' } }),
    } });
    const installing = manual.manager.install('1.2.0');
    const rolling = restore.manager.rollback();
    await automatic.manager.check({ manual: false });
    await settle();
    for ( const h of [ manual, automatic, restore ] ) {
        assert.deepEqual(h.nativeCalls, [], 'Nothing reaches the updater before startup settles');
    }
    startup.release();
    assert.equal((await installing).version, '1.2.0', 'Install now proceeds after startup');
    assert.equal((await rolling).version, '1.1.0', 'Restore proceeds after startup');
    await settle();
    assert.deepEqual(automatic.nativeCalls.map(call => call.cmd), [ 'hello', 'stage', 'apply' ],
        'The automatic install proceeds after startup');
    for ( const h of [ manual, automatic, restore ] ) {
        assert.equal(h.state().lastError, null, 'No refusal is recorded');
        assert.notEqual(h.state().pendingReload, null);
    }
    assert.equal(automatic.alarmRegistry.has(UPDATE_RETRY_ALARM), false);
}

// An automatic install refused because filtering work was running is tried
// again after five minutes, without another request to GitHub.
{
    let busy = true;
    const h = createHarness({
        isBusy: async () => busy,
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk(), stagePort: stageOk('1.2.0'), apply: applyOk('1.1.2', '1.2.0') },
    });
    await h.manager.initialize();
    h.advance(6 * 60 * 60 * 1000);
    await h.manager.onAlarm({ name: UPDATE_ALARM });
    await settle();
    const refused = h.state().lastError;
    assert.equal(refused.code, 'filters-busy');
    assert.deepEqual(h.alarmRegistry.get(UPDATE_RETRY_ALARM), { when: refused.at + 5 * 60 * 1000 },
        'A short retry is scheduled');
    busy = false;
    h.advance(5 * 60 * 1000);
    assert.equal(await h.manager.onAlarm({ name: UPDATE_RETRY_ALARM }), true);
    await settle();
    assert.equal(h.fetches.length, 1, 'The retry does not ask GitHub again');
    assert.deepEqual(h.nativeCalls.map(call => call.cmd), [ 'hello', 'stage', 'apply' ]);
    assert.equal(h.state().lastError, null, 'The refusal is not left behind');
    assert.equal(h.state().pendingReload.to, '1.2.0');
}
{
    let busy = true;
    const h = createHarness({
        isBusy: async () => busy,
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk() },
    });
    await h.manager.check({ manual: false });
    await settle();
    assert.equal(h.state().lastError.code, 'filters-busy');
    await h.manager.setSettings({ install: 'notify' });
    busy = false;
    await h.manager.onAlarm({ name: UPDATE_RETRY_ALARM });
    await settle();
    assert.equal(h.nativeCalls.length, 0, 'The retry respects "Only notify me"');
    assert.equal(h.fetches.length, 1);
    assert.equal(h.state().lastError, null, 'A refusal which no longer matters is cleared');
}

// An automatic install reads the settings, the policy and the hold again
// just before it starts: the administrator policy comes from a cache which
// refreshes asynchronously, and the user may change a setting meanwhile.
for ( const label of [ 'policy notify', 'dashboard lock', 'user setting', 'rollback hold' ] ) {
    let policy = {};
    let h = null;
    h = createHarness({
        getPolicy: async () => policy,
        // The change lands after the check decided to install.
        isBusy: async () => {
            if ( label === 'policy notify' ) { policy = { autoUpdate: 'notify' }; }
            if ( label === 'dashboard lock' ) { policy = { disabledFeatures: [ 'dashboard' ] }; }
            if ( label === 'user setting' ) { h.storage.set(UPDATE_SETTINGS_KEY, { install: 'notify' }); }
            if ( label === 'rollback hold' ) { h.storage.set(UPDATE_STATE_KEY, { ...h.state(), heldVersion: '1.2.0' }); }
            return false;
        },
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk(), stagePort: stageOk('1.2.0'), apply: applyOk('1.1.2', '1.2.0') },
    });
    await h.manager.check({ manual: false });
    await settle();
    assert.deepEqual(h.nativeCalls, [], `${label}: no automatic install`);
    assert.equal(h.state().lastError, null, `${label}: nothing to report`);
    assert.equal(h.state().install, null, label);
    h.runTimers();
    assert.equal(h.reloads, 0, label);
}

// A clock which went backwards does not postpone scheduled checks until it
// catches up again.
{
    const t0 = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const ahead = createHarness({ installType: 'normal', storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, lastCheck: t0 + 3 * day, lastSuccess: t0 + 3 * day,
    } }, responses: [ jsonResponse([]) ] });
    await ahead.manager.onAlarm({ name: UPDATE_ALARM });
    assert.equal(ahead.fetches.length, 1, 'A last check "in the future" is due');
    const retry = createHarness({ installType: 'normal', storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, lastCheck: t0 + 3 * day, failures: 1, nextCheckAfter: t0 + 3 * day + 15 * 60 * 1000,
    } }, responses: [ jsonResponse([]) ] });
    await retry.manager.onAlarm({ name: UPDATE_RETRY_ALARM });
    assert.equal(retry.fetches.length, 1, 'So is a retry time recorded while the clock was ahead');
    const far = createHarness({ installType: 'normal', storage: { [UPDATE_STATE_KEY]: {
        schemaVersion: 1, lastCheck: t0 - 60 * 60 * 1000, failures: 1, nextCheckAfter: t0 + 30 * day,
    } }, responses: [ jsonResponse([]) ] });
    await far.manager.onAlarm({ name: UPDATE_ALARM });
    assert.equal(far.fetches.length, 0, 'The backoff still applies');
    far.advance(day);
    await far.manager.onAlarm({ name: UPDATE_ALARM });
    assert.equal(far.fetches.length, 1, 'No wait exceeds the longest backoff');
}

// macOS and Linux copies are updated by hand.
{
    const h = createHarness({ os: 'linux', responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ], native: { hello: helloOk() } });
    const status = await h.manager.check({ manual: false });
    await settle();
    assert.equal(status.os, 'linux');
    assert.equal(status.installBlockedBy, 'unsupported-os');
    assert.equal(status.available.version, '1.2.0', 'Other systems still learn about new versions');
    assert.equal(h.nativeCalls.length, 0);
    assert.equal(h.state().lastError, null, 'and are not told that the Windows updater is missing');
    await assert.rejects(h.manager.rollback(), error => error.code === 'unsupported-os');
}

// Development builds schedule no checks.
{
    const h = createHarness({ version: '2026.923.1530', responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ] });
    await h.manager.initialize();
    assert.equal(h.alarmsCreated.length, 0);
    assert.deepEqual(h.alarmsCleared, [ UPDATE_ALARM, UPDATE_RETRY_ALARM ]);
    h.advance(6 * 60 * 60 * 1000);
    await h.manager.onAlarm({ name: UPDATE_ALARM });
    assert.equal(h.fetches.length, 0, 'A leftover alarm does not reach GitHub');
    await h.manager.setSettings({ channel: 'stable' });
    assert.equal(h.alarmsCreated.length, 0);
}

// Managed storage "autoUpdate" and the dashboard lock.
{
    const h = createHarness({
        policy: { autoUpdate: 'off' },
        storage: { [UPDATE_STATE_KEY]: { schemaVersion: 1, available: { version: '1.2.0' } } },
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk() },
    });
    await h.manager.initialize();
    assert.equal(h.alarmsCreated.length, 0, 'Policy "off" schedules no checks');
    assert.equal(h.state().available, null, 'and no longer offers a version found earlier');
    h.advance(6 * 60 * 60 * 1000);
    await h.manager.onAlarm({ name: UPDATE_ALARM });
    await assert.rejects(h.manager.check({ manual: true }), error => error.code === 'disabled-by-policy');
    assert.equal(h.fetches.length, 0);
    const status = await h.manager.getStatus();
    assert.equal(status.policy, 'off');
    assert.deepEqual([ status.settings.check, status.settings.install ], [ false, 'notify' ]);
    assert.equal(status.installBlockedBy, 'disabled-by-policy');
    await assert.rejects(h.manager.setSettings({ check: true }), error => error.code === 'disabled-by-policy');
    await assert.rejects(h.manager.setSettings({ install: 'auto' }), error => error.code === 'disabled-by-policy');
    assert.equal((await h.manager.setSettings({ channel: 'stable' })).channel, 'stable', 'Other settings still change');
    assert.equal(h.alarmsCreated.length, 0);
}
for ( const policy of [ { autoUpdate: 'notify' }, { disabledFeatures: [ 'dashboard' ] } ] ) {
    const label = JSON.stringify(policy);
    const h = createHarness({
        policy,
        responses: [ jsonResponse([ githubRelease('v1.2.0') ]) ],
        native: { hello: helloOk(), stagePort: stageOk('1.2.0'), apply: applyOk('1.1.2', '1.2.0') },
    });
    await h.manager.initialize();
    assert.equal(h.alarmsCreated.length, 1, `${label}: checks still run`);
    const status = await h.manager.check({ manual: false });
    await settle();
    assert.equal(status.available.version, '1.2.0', label);
    assert.equal(status.settings.install, 'notify', label);
    assert.equal(h.nativeCalls.length, 0, `${label}: never installs automatically`);
    await assert.rejects(h.manager.setSettings({ install: 'auto' }), error => error.code === 'disabled-by-policy');
    assert.equal((await h.manager.install('1.2.0')).version, '1.2.0', `${label}: Install now still works`);
}

// The updater undid an interrupted apply: the user is told, and the worker
// reloads when the restored files differ from the code it runs.
{
    const recovered = restored => () => ({
        v: 1, ok: true, updaterVersion: '1.0.0', installedVersion: restored, edition: 'standard',
        recovered: { restored, interrupted: '1.3.0', extra: 'ignored' },
    });
    const same = createHarness({ native: { hello: recovered('1.1.2') } });
    await same.manager.getStatus({ probe: true });
    assert.equal(same.state().lastError.code, 'update-undone');
    assert.match(same.state().lastError.message, /1\.3\.0.*1\.1\.2/);
    same.runTimers();
    assert.equal(same.reloads, 0, 'Restored files match the running version: no reload');
    const differs = createHarness({ native: { hello: recovered('1.1.0') } });
    await differs.manager.getStatus({ probe: true });
    differs.runTimers();
    assert.equal(differs.reloads, 1, 'The worker reloads into the restored version');
    assert.deepEqual(normalizeUpdaterReply({ v: 1, ok: true, recovered: { restored: 'x', interrupted: '1' } }), { ok: true },
        'A malformed recovery report is ignored');
}

console.log('Automatic updates: version policy, release selection, network hygiene, backoff and retry alarm, native install, activation restart, rollback and hold, split incognito, channel switch, busy guards, unsupported systems, development builds, managed policy, interrupted-update recovery and settings passed.');
