/*******************************************************************************

    uBlock Plus+ - automatic updates for unpacked installations
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

// The worker only reads public release metadata from GitHub. Installing is
// delegated to the separately installed, user-approved native updater
// (platform/mv3/updater), which downloads the package itself, verifies it and
// replaces the unpacked folder. The extension then reloads from disk. No
// remote code is fetched or executed by the extension.

import {
    UPDATE_ALARM,
    UPDATE_BUSY_RETRY_MS,
    UPDATE_CHECK_PERIOD_MINUTES,
    UPDATE_HOST_NAME,
    UPDATE_MAX_BACKOFF_MS,
    UPDATE_MAX_RESPONSE_BYTES,
    UPDATE_MIN_AUTOMATIC_INTERVAL_MS,
    UPDATE_MIN_MANUAL_INTERVAL_MS,
    UPDATE_PROTOCOL,
    UPDATE_RELEASES_API,
    UPDATE_RETRY_ALARM,
    UPDATE_SETTINGS_KEY,
    UPDATE_STATE_KEY,
    applyUpdatePolicy,
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
} from './update-core.js';

const STATE_SCHEMA = 1;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

const PROGRESS_WRITE_INTERVAL_MS = 1500;

const emptyState = ( ) => ({
    schemaVersion: STATE_SCHEMA,
    lastCheck: 0,
    lastSuccess: 0,
    etag: '',
    releases: [],
    available: null,
    failures: 0,
    nextCheckAfter: 0,
    lastError: null,
    install: null,
    pendingReload: null,
    lastUpdate: null,
    updater: null,
    // The version the user rolled back from: automatic installs skip it.
    heldVersion: null,
});

function normalizeState(value) {
    const out = emptyState();
    if ( value === null || typeof value !== 'object' || value.schemaVersion !== STATE_SCHEMA ) {
        return out;
    }
    for ( const key of [ 'lastCheck', 'lastSuccess', 'failures', 'nextCheckAfter' ] ) {
        if ( Number.isSafeInteger(value[key]) && value[key] >= 0 ) { out[key] = value[key]; }
    }
    if ( typeof value.etag === 'string' && value.etag.length <= 200 ) { out.etag = value.etag; }
    // Re-validate cached releases: storage.local is readable and writable by
    // content scripts of this extension, so treat it as untrusted input.
    if ( Array.isArray(value.releases) ) {
        out.releases = compactReleases(value.releases.map(release => ({
            tag_name: release?.tag,
            draft: release?.draft,
            prerelease: release?.prerelease,
            name: release?.name,
            published_at: release?.publishedAt,
            assets: Array.isArray(release?.assets) ? release.assets.map(name => ({ name })) : [],
        })));
    }
    if ( value.reopenSettings === true ) { out.reopenSettings = true; }
    if ( parseVersion(value.heldVersion) !== null ) { out.heldVersion = value.heldVersion; }
    for ( const key of [ 'available', 'lastError', 'install', 'pendingReload', 'lastUpdate', 'updater' ] ) {
        if ( value[key] !== null && typeof value[key] === 'object' && Array.isArray(value[key]) === false ) {
            out[key] = value[key];
        }
    }
    return out;
}

const errorRecord = (code, message, during, now) => ({
    code: typeof code === 'string' ? code.slice(0, 40) : 'error',
    message: String(message || '').slice(0, 300),
    during,
    at: now,
});

export class UpdateError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

export function createUpdateManager(deps) {
    const {
        runtime,
        alarms,
        permissions,
        localRead,
        localWrite,
        fetch = globalThis.fetch.bind(globalThis),
        now = ( ) => Date.now(),
        broadcast = ( ) => {},
        log = ( ) => {},
        isBusy = async ( ) => false,
        getInstallType = async ( ) => 'unknown',
        // Managed storage: { autoUpdate, disabledFeatures }.
        getPolicy = async ( ) => ({}),
        inIncognito = false,
        reloadDelay = 250,
        setTimer = (fn, ms) => setTimeout(fn, ms),
        openSettingsPage = async ( ) => {},
    } = deps;

    // Install and rollback both replace the extension folder: one at a time.
    let operation = null;
    let checkPromise = null;
    let stateQueue = Promise.resolve();
    // The first Check now after a channel change is not throttled.
    let channelChanged = false;
    let platformOS;

    const manifest = runtime.getManifest();
    const currentVersion = manifest.version;
    const edition = editionFromManifest(manifest);
    const devBuild = isDevelopmentVersion(currentVersion);

    const readSettings = async ( ) => normalizeUpdateSettings(await localRead(UPDATE_SETTINGS_KEY));
    const readState = async ( ) => normalizeState(await localRead(UPDATE_STATE_KEY));

    const readPolicy = async ( ) => {
        try {
            return updatePolicyFrom(await getPolicy());
        } catch {
            return '';
        }
    };

    // The user settings, capped by the administrator policy.
    const readSettingsAndPolicy = async ( ) => {
        const [ settings, policy ] = await Promise.all([ readSettings(), readPolicy() ]);
        return { settings: applyUpdatePolicy(settings, policy), policy };
    };

    // The native updater exists only for Windows.
    const getOS = async ( ) => {
        if ( platformOS === undefined ) {
            try {
                const os = (await runtime.getPlatformInfo())?.os;
                if ( typeof os === 'string' ) { platformOS = os; }
            } catch {
            }
        }
        return platformOS ?? '';
    };

    // Serialize read-modify-write cycles so concurrent checks, progress
    // events and installs cannot overwrite each other's fields.
    const updateState = mutate => {
        const result = stateQueue.then(async ( ) => {
            const state = await readState();
            const next = await mutate(state) || state;
            await localWrite(UPDATE_STATE_KEY, next);
            return next;
        });
        stateQueue = result.catch(( ) => {});
        return result;
    };

    const notify = ( ) => {
        try { broadcast({ autoUpdate: true }); } catch { }
    };

    const permissionGranted = async ( ) => {
        try {
            return await permissions.contains({ permissions: [ 'nativeMessaging' ] }) === true;
        } catch {
            return false;
        }
    };

    // Chrome binds runtime.connectNative/sendNativeMessage only in contexts
    // created after the optional permission was granted, so a running worker
    // needs one restart before it can reach the updater.
    const hasBinding = ( ) => typeof runtime.connectNative === 'function' &&
        typeof runtime.sendNativeMessage === 'function';

    const hasPermission = async ( ) => await permissionGranted() && hasBinding();

    /**************************************************************************/

    const sendNative = request => new Promise(resolve => {
        const message = { v: UPDATE_PROTOCOL, id: `${request.cmd}-${now()}`, ...request };
        try {
            runtime.sendNativeMessage(UPDATE_HOST_NAME, message, reply => {
                const lastError = runtime.lastError;
                if ( lastError ) {
                    resolve({ ok: false, error: {
                        code: classifyNativeError(lastError.message),
                        message: lastError.message,
                    } });
                    return;
                }
                resolve(normalizeUpdaterReply(reply));
            });
        } catch (reason) {
            resolve({ ok: false, error: { code: classifyNativeError(reason?.message), message: String(reason?.message || reason) } });
        }
    });

    // Staging downloads tens of megabytes. A native port keeps the worker
    // alive while the updater is actually working and reports progress.
    const stageThroughPort = (version, onProgress) => new Promise(resolve => {
        const id = `stage-${now()}`;
        let settled = false;
        let port;
        const finish = reply => {
            if ( settled ) { return; }
            settled = true;
            clearTimeout(timer);
            try { port?.disconnect(); } catch { }
            resolve(reply);
        };
        const timer = setTimeout(( ) => {
            finish({ ok: false, error: { code: 'timeout', message: 'The updater did not finish in time.' } });
        }, INSTALL_TIMEOUT_MS);
        try {
            port = runtime.connectNative(UPDATE_HOST_NAME);
        } catch (reason) {
            finish({ ok: false, error: { code: classifyNativeError(reason?.message), message: String(reason?.message || reason) } });
            return;
        }
        port.onMessage.addListener(message => {
            if ( message?.id !== id ) { return; }
            if ( message.event === 'progress' ) {
                onProgress({
                    phase: typeof message.phase === 'string' ? message.phase.slice(0, 20) : '',
                    received: Number.isSafeInteger(message.received) ? message.received : 0,
                    total: Number.isSafeInteger(message.total) ? message.total : 0,
                });
                return;
            }
            finish(normalizeUpdaterReply(message));
        });
        port.onDisconnect.addListener(( ) => {
            const lastError = runtime.lastError;
            finish({ ok: false, error: {
                code: classifyNativeError(lastError?.message || 'disconnected'),
                message: lastError?.message || 'The updater closed the connection.',
            } });
        });
        port.postMessage({ v: UPDATE_PROTOCOL, id, cmd: 'stage', version });
    });

    /**************************************************************************/

    const installEligibility = async ( ) => {
        if ( inIncognito ) { return 'incognito'; }
        if ( devBuild ) { return 'development-build'; }
        if ( await getInstallType() !== 'development' ) { return 'not-unpacked'; }
        if ( await getOS() !== 'win' ) { return 'unsupported-os'; }
        if ( await readPolicy() === 'off' ) { return 'disabled-by-policy'; }
        if ( await permissionGranted() === false ) { return 'permission-required'; }
        if ( hasBinding() === false ) { return 'restart-required'; }
        return '';
    };

    const filtersBusyError = message => new UpdateError('filters-busy',
        message || 'A filter list update is in progress; try again when it finishes.');

    async function probeUpdater() {
        if ( await hasPermission() === false ) { return null; }
        const reply = await sendNative({ cmd: 'hello' });
        const updater = reply.ok
            ? {
                connected: true,
                version: reply.updaterVersion || '',
                installedVersion: reply.installedVersion || '',
                stagedVersion: reply.stagedVersion || '',
                backupVersion: reply.backupVersion || '',
                edition: reply.edition || '',
                checkedAt: now(),
            }
            : { connected: false, error: reply.error, checkedAt: now() };
        // A read-modify-write from the incognito worker could overwrite a
        // marker the regular worker writes at the same time.
        if ( inIncognito === false ) {
            await updateState(state => {
                state.updater = updater;
                // The updater restored its backup after an interrupted apply:
                // tell the user instead of leaving a silent downgrade.
                if ( reply.ok && reply.recovered ) {
                    state.lastError = errorRecord('update-undone',
                        `The interrupted update to ${reply.recovered.interrupted || '?'} was undone; ${reply.recovered.restored} was restored.`,
                        'install', now());
                }
            });
        }
        // Files on disk now differ from the code this worker runs.
        if ( reply.ok && reply.recovered && reply.recovered.restored !== currentVersion ) {
            log(`Auto-update: reloading into restored ${reply.recovered.restored}`);
            setTimer(( ) => runtime.reload(), reloadDelay);
        }
        return updater;
    }

    async function performInstall(version, automatic) {
        const parts = parseVersion(version);
        if ( parts === null ) { throw new UpdateError('invalid-version', 'Invalid version'); }
        const blocked = await installEligibility();
        if ( blocked !== '' ) { throw new UpdateError(blocked, blocked); }
        if ( compareVersions(parts, currentVersion) <= 0 ) {
            throw new UpdateError('not-newer', `${version} is not newer than ${currentVersion}`);
        }
        if ( await isBusy() ) { throw filtersBusyError(); }
        if ( automatic ) {
            // The settings, the administrator policy (read from a cache which
            // refreshes asynchronously) or the hold may have changed since
            // the check decided to install.
            const [ { settings }, state ] = await Promise.all([ readSettingsAndPolicy(), readState() ]);
            if ( settings.install !== 'auto' ) {
                throw new UpdateError('notify-only', 'Automatic installation is off.');
            }
            if ( state.heldVersion !== null && compareVersions(parts, state.heldVersion) <= 0 ) {
                throw new UpdateError('held', `${version} is held after a restore.`);
            }
        }
        await updateState(state => {
            state.install = { version, phase: 'prepare', startedAt: now(), automatic, progress: null };
        });
        notify();

        const hello = await sendNative({ cmd: 'hello' });
        if ( hello.ok === false ) { throw new UpdateError(hello.error.code, hello.error.message); }
        if ( hello.edition && hello.edition !== edition ) {
            throw new UpdateError('identity-mismatch', 'The updater manages a different edition.');
        }
        const onDisk = hello.installedVersion || '';
        let applied = false;
        if ( onDisk !== currentVersion ) {
            // The folder already holds another version (for example after the
            // command-line updater ran). Reload only into a newer version.
            if ( parseVersion(onDisk) === null || compareVersions(onDisk, currentVersion) <= 0 ) {
                throw new UpdateError('folder-mismatch',
                    `The extension folder holds ${onDisk || 'an unknown version'}, not ${currentVersion}.`);
            }
            applied = true;
            version = onDisk;
        }

        if ( applied === false ) {
            // Install only what the selected channel offers, for example not
            // a pre-release found before switching to stable releases.
            const [ settings, cached ] = await Promise.all([ readSettings(), readState() ]);
            const offered = selectUpdate(
                cached.releases.filter(release => compareVersions(release.tag, parts) === 0),
                { currentVersion, channel: settings.channel, edition }
            );
            if ( offered === null ) {
                throw new UpdateError('not-offered',
                    `${version} is not offered on the ${settings.channel} channel.`);
            }
            version = offered.version;
            let lastWrite = 0;
            await updateState(state => { if ( state.install ) { state.install.phase = 'download'; } });
            notify();
            const staged = await stageThroughPort(version, progress => {
                const t = now();
                if ( t - lastWrite < PROGRESS_WRITE_INTERVAL_MS ) { return; }
                lastWrite = t;
                updateState(state => {
                    if ( state.install ) { state.install.progress = progress; }
                }).then(notify, ( ) => {});
            });
            if ( staged.ok === false ) { throw new UpdateError(staged.error.code, staged.error.message); }
            if ( staged.version !== version ) {
                throw new UpdateError('identity-mismatch', 'The updater staged a different version.');
            }
            if ( await isBusy() ) {
                throw filtersBusyError('A filter list update started; the download was kept for later.');
            }
            await updateState(state => { if ( state.install ) { state.install.phase = 'apply'; } });
            notify();
            const reply = await sendNative({ cmd: 'apply', version });
            if ( reply.ok === false ) { throw new UpdateError(reply.error.code, reply.error.message); }
            if ( reply.applied?.to !== version ) {
                throw new UpdateError('identity-mismatch', 'The updater applied a different version.');
            }
        }

        await updateState(state => {
            state.install = null;
            state.lastError = null;
            state.pendingReload = { from: currentVersion, to: version, at: now(), automatic };
            if ( automatic === false ) {
                // "Install now" ends a rollback hold, and the Updates section
                // reopens after the reload to show the result.
                state.heldVersion = null;
                state.reopenSettings = true;
            }
        });
        notify();
        log(`Auto-update: reloading into ${version}`);
        setTimer(( ) => runtime.reload(), reloadDelay);
        return { reloading: true, version };
    }

    const updateBusyError = ( ) =>
        new UpdateError('update-busy', 'Another update operation is running.');

    // Conditions of automatic installs which the next check retries without
    // reporting them.
    const SILENT_AUTOMATIC = [
        'permission-required', 'restart-required', 'not-unpacked', 'notify-only', 'held',
    ];

    // Filtering work is short: an automatic install which it kept from
    // starting is tried again soon (retryDeferredInstall).
    const scheduleBusyRetry = async ( ) => {
        if ( alarms === undefined ) { return; }
        try {
            await alarms.create(UPDATE_RETRY_ALARM, { when: now() + UPDATE_BUSY_RETRY_MS });
        } catch (reason) {
            log(`Auto-update retry alarm/${reason}`);
        }
    };

    function install(version, { automatic = false } = {}) {
        if ( operation?.kind === 'install' ) { return operation.promise; }
        if ( operation !== null ) { return Promise.reject(updateBusyError()); }
        const promise = performInstall(version, automatic).catch(async reason => {
            const code = reason?.code || 'error';
            // The incognito worker never writes the shared update state.
            if ( code === 'incognito' ) { throw reason; }
            await updateState(state => {
                state.install = null;
                if ( automatic && SILENT_AUTOMATIC.includes(code) ) { return; }
                state.lastError = errorRecord(code, reason?.message, 'install', now());
            }).catch(( ) => {});
            if ( automatic && code === 'filters-busy' ) { await scheduleBusyRetry(); }
            notify();
            throw reason;
        }).finally(( ) => {
            operation = null;
        });
        operation = { kind: 'install', promise };
        return promise;
    }

    async function performRollback() {
        const blocked = await installEligibility();
        if ( blocked !== '' ) { throw new UpdateError(blocked, blocked); }
        if ( await isBusy() ) { throw filtersBusyError(); }
        const reply = await sendNative({ cmd: 'rollback' });
        if ( reply.ok === false ) {
            await updateState(state => {
                state.lastError = errorRecord(reply.error.code, reply.error.message, 'rollback', now());
            });
            notify();
            throw new UpdateError(reply.error.code, reply.error.message);
        }
        await updateState(state => {
            state.lastError = null;
            state.pendingReload = { from: currentVersion, to: reply.applied?.to || '', at: now(), rollback: true };
            state.reopenSettings = true;
        });
        notify();
        setTimer(( ) => runtime.reload(), reloadDelay);
        return { reloading: true, version: reply.applied?.to || '' };
    }

    function rollback() {
        if ( operation !== null ) { return Promise.reject(updateBusyError()); }
        const promise = performRollback().finally(( ) => {
            operation = null;
        });
        operation = { kind: 'rollback', promise };
        return promise;
    }

    /**************************************************************************/

    const retryAfterFrom = response => {
        const retryAfter = Number(response.headers.get('retry-after'));
        if ( Number.isFinite(retryAfter) && retryAfter > 0 ) { return retryAfter * 1000; }
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if ( Number.isFinite(reset) && reset > 0 ) { return Math.max(0, reset * 1000 - now()); }
        return 0;
    };

    const readBoundedJSON = async response => {
        const length = Number(response.headers.get('content-length'));
        if ( Number.isFinite(length) && length > UPDATE_MAX_RESPONSE_BYTES ) {
            throw new UpdateError('response-too-large', 'The release list is too large.');
        }
        const text = await response.text();
        if ( text.length > UPDATE_MAX_RESPONSE_BYTES ) {
            throw new UpdateError('response-too-large', 'The release list is too large.');
        }
        return JSON.parse(text);
    };

    // Install the offered version automatically unless the settings, a
    // rollback hold or a running operation say otherwise. Returns whether an
    // install started.
    async function installAutomatically(state, settings) {
        const offered = state.available?.version;
        if ( settings.install !== 'auto' || parseVersion(offered) === null ) { return false; }
        if ( state.heldVersion !== null && compareVersions(offered, state.heldVersion) <= 0 ) {
            return false;
        }
        if ( operation !== null ) {
            log('Auto-update install/update-busy');
            return false;
        }
        if ( await installEligibility() !== '' ) { return false; }
        // A failed automatic install is recorded in state; the next check retries.
        install(offered, { automatic: true }).catch(reason => {
            log(`Auto-update install/${reason?.code || reason}`);
        });
        return true;
    }

    // The retry alarm after an automatic install refused with 'filters-busy'
    // tries the install again without another request to GitHub. Returns
    // false when the alarm was the retry of a failed check instead.
    async function retryDeferredInstall() {
        if ( inIncognito ) { return false; }
        const [ { settings }, state ] = await Promise.all([ readSettingsAndPolicy(), readState() ]);
        if ( state.failures !== 0 || state.lastError?.code !== 'filters-busy' ||
            state.lastError.during !== 'install' ) {
            return false;
        }
        if ( await installAutomatically(state, settings) ) { return true; }
        // Nothing is waiting any more (for example the user chose "Only
        // notify me"): the refusal is no longer worth showing.
        await updateState(state => {
            if ( state.lastError?.code === 'filters-busy' ) { state.lastError = null; }
        });
        notify();
        return true;
    }

    async function performCheck(manual) {
        const { settings, policy } = await readSettingsAndPolicy();
        if ( inIncognito || policy === 'off' ) {
            if ( manual === false ) { return getStatus(); }
            const code = inIncognito ? 'incognito' : 'disabled-by-policy';
            throw new UpdateError(code, code);
        }
        // Development builds never look outdated: no scheduled requests.
        if ( manual === false && (settings.check === false || devBuild) ) {
            return getStatus();
        }
        const state = await readState();
        const t = now();
        if ( manual ) {
            // After a failed check (other than a rate limit) or a channel
            // change, checking again at once is useful.
            const repeat = channelChanged ||
                state.lastError?.during === 'check' && state.lastError.code !== 'rate-limited';
            if ( repeat === false && state.lastCheck <= t &&
                t - state.lastCheck < UPDATE_MIN_MANUAL_INTERVAL_MS ) {
                return {
                    ...await getStatus(),
                    throttled: true,
                    retryAt: state.lastCheck + UPDATE_MIN_MANUAL_INTERVAL_MS,
                };
            }
            channelChanged = false;
        } else {
            // After a failure the backoff delay decides (the retry alarm
            // fires when it ends); otherwise checks are 30 minutes apart.
            // Times recorded while the clock was ahead must not postpone
            // checks until it catches up: a last check "in the future" is
            // due, and no wait is longer than the longest backoff.
            const wait = state.lastCheck <= t && (state.failures !== 0
                ? t < Math.min(state.nextCheckAfter, state.lastCheck + UPDATE_MAX_BACKOFF_MS)
                : t - state.lastCheck < UPDATE_MIN_AUTOMATIC_INTERVAL_MS);
            if ( wait ) { return getStatus(); }
        }
        const hadFailures = state.failures !== 0;

        let releases = null;
        let etag = state.etag;
        let failure = null;
        let retryAfter = 0;
        try {
            const headers = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if ( etag !== '' && state.releases.length !== 0 ) { headers['If-None-Match'] = etag; }
            const options = {
                headers,
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            };
            if ( typeof globalThis.AbortSignal?.timeout === 'function' ) {
                options.signal = globalThis.AbortSignal.timeout(15000);
            }
            const response = await fetch(UPDATE_RELEASES_API, options);
            if ( response.status === 304 ) {
                releases = state.releases;
            } else if ( response.ok ) {
                releases = compactReleases(await readBoundedJSON(response));
                etag = String(response.headers.get('etag') || '').slice(0, 200);
            } else if ( response.status === 403 || response.status === 429 ) {
                retryAfter = retryAfterFrom(response);
                failure = errorRecord('rate-limited', `GitHub rate limit (HTTP ${response.status})`, 'check', t);
            } else {
                failure = errorRecord('http-error', `HTTP ${response.status}`, 'check', t);
            }
        } catch (reason) {
            // Fetch rejections (TypeError, TimeoutError, AbortError) carry no
            // string code: the network failed.
            const code = typeof reason?.code === 'string' ? reason.code : 'network-error';
            failure = errorRecord(code, reason?.message || reason, 'check', t);
        }

        const next = await updateState(async state => {
            state.lastCheck = t;
            if ( failure !== null ) {
                state.failures += 1;
                state.nextCheckAfter = t + nextRetryDelay(state.failures, retryAfter);
                state.lastError = failure;
                return;
            }
            state.failures = 0;
            state.nextCheckAfter = 0;
            state.lastSuccess = t;
            state.etag = etag;
            state.releases = releases;
            // The channel may have changed while the request was running.
            const { channel } = await readSettings();
            state.available = selectUpdate(releases, { currentVersion, channel, edition });
            // A release newer than the one the user rolled back from ends
            // the hold.
            if ( state.heldVersion !== null && state.available !== null &&
                compareVersions(state.available.version, state.heldVersion) > 0 ) {
                state.heldVersion = null;
            }
            if ( state.lastError?.during === 'check' ) { state.lastError = null; }
        });
        notify();

        if ( alarms !== undefined && settings.check && devBuild === false ) {
            try {
                if ( failure !== null ) {
                    await alarms.create(UPDATE_RETRY_ALARM, { when: next.nextCheckAfter });
                } else if ( hadFailures ) {
                    await alarms.clear(UPDATE_RETRY_ALARM);
                }
            } catch (reason) {
                log(`Auto-update retry alarm/${reason}`);
            }
        }

        if ( failure === null ) {
            await installAutomatically(next, settings);
        }
        return getStatus();
    }

    function check({ manual = false } = {}) {
        if ( checkPromise !== null ) { return checkPromise; }
        checkPromise = performCheck(manual).finally(( ) => { checkPromise = null; });
        return checkPromise;
    }

    /**************************************************************************/

    async function ensureAlarm(settings) {
        // The regular worker owns the alarms; in split incognito mode the
        // incognito worker must neither clear nor duplicate them.
        if ( alarms === undefined || inIncognito ) { return; }
        if ( settings.check === false || devBuild ) {
            await alarms.clear(UPDATE_ALARM);
            await alarms.clear(UPDATE_RETRY_ALARM);
            return;
        }
        const state = await readState();
        // Schedule again a retry lost with the browser session.
        if ( state.failures !== 0 && state.nextCheckAfter > now() ) {
            const retry = await alarms.get(UPDATE_RETRY_ALARM);
            if ( Boolean(retry) === false ) {
                await alarms.create(UPDATE_RETRY_ALARM, { when: state.nextCheckAfter });
            }
        }
        const existing = await alarms.get(UPDATE_ALARM);
        if ( existing ) { return; }
        const periodMs = UPDATE_CHECK_PERIOD_MINUTES * 60000;
        const due = Math.max(state.lastCheck + periodMs, state.nextCheckAfter);
        // Spread first checks a little so a browser restart does not always
        // hit the network immediately.
        const delayInMinutes = Math.max(2, Math.ceil((due - now()) / 60000));
        await alarms.create(UPDATE_ALARM, {
            delayInMinutes: Math.min(delayInMinutes, UPDATE_CHECK_PERIOD_MINUTES),
            periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES,
        });
    }

    // Called after the user granted the permission from the dashboard. When the
    // running worker lacks the native messaging binding, restart once and
    // bring the user back to the Updates section.
    async function activateUpdater() {
        // The incognito worker neither writes the shared state nor reloads
        // the extension under an install of the regular worker.
        if ( inIncognito ) { throw new UpdateError('incognito', 'incognito'); }
        if ( await permissionGranted() === false ) {
            throw new UpdateError('permission-required', 'permission-required');
        }
        if ( hasBinding() ) {
            await probeUpdater();
            notify();
            return { reloading: false };
        }
        // Do not restart in the middle of a filter-list transaction.
        if ( await isBusy() ) { throw filtersBusyError(); }
        await updateState(state => { state.reopenSettings = true; });
        log('Auto-update: restarting to enable the updater connection');
        setTimer(( ) => runtime.reload(), reloadDelay);
        return { reloading: true };
    }

    async function initialize() {
        // The regular worker owns the shared update state. The incognito
        // worker (split mode) would take over markers and flags written by
        // a running regular worker.
        if ( inIncognito ) { return; }
        const t = now();
        const policy = await readPolicy();
        let reopenSettings = false;
        await updateState(state => {
            reopenSettings = state.reopenSettings === true;
            delete state.reopenSettings;
            if ( state.pendingReload !== null ) {
                const pending = state.pendingReload;
                if ( pending.to === currentVersion ) {
                    const rollback = pending.rollback === true;
                    state.lastUpdate = { from: pending.from, to: pending.to, at: t, rollback };
                    state.lastError = null;
                    if ( state.available?.version === currentVersion ) { state.available = null; }
                    // Automatic installs skip the version the user rolled
                    // back from, until a newer release or "Install now".
                    if ( rollback && parseVersion(pending.from) !== null ) {
                        state.heldVersion = pending.from;
                    }
                } else {
                    state.lastError = errorRecord('reload-mismatch',
                        `Expected ${pending.to} after reloading, found ${currentVersion}.`, 'install', t);
                }
                state.pendingReload = null;
            }
            // Installs run inside one worker lifetime (a native port keeps the
            // worker alive), so a marker found by a fresh worker is orphaned.
            if ( state.install !== null && operation === null ) {
                state.install = null;
                // A reload mismatch recorded above is the more useful report.
                if ( state.lastError?.at !== t ) {
                    state.lastError = errorRecord('interrupted', 'The previous update was interrupted.', 'install', t);
                }
            }
            // A cached "available" entry that is no longer newer is stale, as
            // is any entry once the administrator turned checks off.
            if ( state.available !== null ) {
                const parts = parseVersion(state.available.version);
                if ( parts === null || compareVersions(parts, currentVersion) <= 0 || policy === 'off' ) {
                    state.available = null;
                }
            }
            if ( state.heldVersion !== null && compareVersions(state.heldVersion, currentVersion) <= 0 ) {
                state.heldVersion = null;
            }
        });
        await ensureAlarm(applyUpdatePolicy(await readSettings(), policy));
        if ( reopenSettings ) {
            // Not awaited: the page opens once the worker has started.
            openSettingsPage().catch(( ) => {});
        }
    }

    async function onAlarm(alarm) {
        if ( alarm?.name !== UPDATE_ALARM && alarm?.name !== UPDATE_RETRY_ALARM ) { return false; }
        if ( alarm.name === UPDATE_RETRY_ALARM && await retryDeferredInstall() ) { return true; }
        await check({ manual: false });
        return true;
    }

    async function setSettings(value) {
        if ( inIncognito ) { throw new UpdateError('incognito', 'incognito'); }
        const [ current, policy ] = await Promise.all([ readSettings(), readPolicy() ]);
        const settings = normalizeUpdateSettings({ ...current, ...value }, { strict: true });
        const effective = applyUpdatePolicy(settings, policy);
        for ( const key of [ 'check', 'install' ] ) {
            if ( value?.[key] !== undefined && effective[key] !== settings[key] ) {
                throw new UpdateError('disabled-by-policy', `The administrator manages "${key}".`);
            }
        }
        await localWrite(UPDATE_SETTINGS_KEY, settings);
        if ( settings.channel !== current.channel ) {
            // Offer only what the new channel allows.
            channelChanged = true;
            await updateState(state => {
                state.available = selectUpdate(state.releases, {
                    currentVersion,
                    channel: settings.channel,
                    edition,
                });
            });
        }
        await ensureAlarm(effective);
        notify();
        return effective;
    }

    async function getStatus({ probe = false } = {}) {
        const [ { settings, policy }, installType, granted, os ] = await Promise.all([
            readSettingsAndPolicy(),
            getInstallType(),
            permissionGranted(),
            getOS(),
        ]);
        const permission = granted && hasBinding();
        let updater;
        if ( probe && permission && operation === null ) {
            updater = await probeUpdater().catch(( ) => null);
        }
        const state = await readState();
        const eligibility = await installEligibility();
        return {
            currentVersion,
            edition,
            devBuild,
            installType,
            os,
            policy,
            incognito: inIncognito,
            permission,
            restartRequired: granted && permission === false,
            settings,
            available: state.available,
            heldVersion: state.heldVersion,
            lastCheck: state.lastCheck,
            lastSuccess: state.lastSuccess,
            nextCheckAfter: state.nextCheckAfter,
            lastError: state.lastError,
            install: state.install,
            lastUpdate: state.lastUpdate,
            updater: updater ?? state.updater,
            installBlockedBy: eligibility,
            installing: operation !== null,
            extensionId: runtime.id,
        };
    }

    return {
        activateUpdater,
        check,
        getStatus,
        initialize,
        install: (version, options) => install(version, options),
        onAlarm,
        probeUpdater,
        rollback,
        setSettings,
    };
}
