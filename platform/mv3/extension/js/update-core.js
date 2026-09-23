/*******************************************************************************

    uBlock Plus+ - automatic update policy (pure functions)
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

// Release metadata from GitHub is untrusted data. These helpers only parse
// and compare it; nothing here downloads or executes a package. The native
// updater downloads, verifies and installs packages on its own terms.

export const UPDATE_REPOSITORY = 'kayurachann/uBlock-Plus';
export const UPDATE_RELEASES_API =
    `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;
export const UPDATE_RELEASES_PAGE =
    `https://github.com/${UPDATE_REPOSITORY}/releases`;
export const UPDATE_HOST_NAME = 'io.github.kayurachann.ublock_plus.updater';
export const UPDATE_PROTOCOL = 1;

export const UPDATE_SETTINGS_KEY = 'autoUpdate.settings';
export const UPDATE_STATE_KEY = 'autoUpdate.state';
export const UPDATE_ALARM = 'autoUpdateCheck';
// One-shot alarm retrying a failed check when its backoff delay ends.
export const UPDATE_RETRY_ALARM = 'autoUpdateRetry';

// Six hours between scheduled checks keeps well under GitHub's anonymous API
// limit (60 requests per hour per address) while releases arrive promptly.
export const UPDATE_CHECK_PERIOD_MINUTES = 360;
export const UPDATE_MIN_AUTOMATIC_INTERVAL_MS = 30 * 60 * 1000;
export const UPDATE_MIN_MANUAL_INTERVAL_MS = 60 * 1000;
export const UPDATE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const UPDATE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
// An automatic install which filtering work kept from starting is tried again
// after this delay (through UPDATE_RETRY_ALARM), without asking GitHub again.
export const UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;

export const UPDATE_DEFAULTS = Object.freeze({
    schemaVersion: 1,
    // Look for new releases.
    check: true,
    // 'auto' installs through the updater when it is available;
    // 'notify' only reports a new version.
    install: 'auto',
    // 'preview' includes pre-releases; 'stable' ignores them.
    channel: 'preview',
});

const SETTING_ENUMS = Object.freeze({
    install: Object.freeze([ 'auto', 'notify' ]),
    channel: Object.freeze([ 'preview', 'stable' ]),
});

export function normalizeUpdateSettings(value, options = {}) {
    const strict = options.strict === true;
    const out = { ...UPDATE_DEFAULTS };
    if ( value === undefined || value === null ) { return out; }
    if ( typeof value !== 'object' || Array.isArray(value) ) {
        if ( strict ) { throw new TypeError('Update settings must be an object'); }
        return out;
    }
    if ( value.check !== undefined ) {
        if ( typeof value.check !== 'boolean' ) {
            if ( strict ) { throw new TypeError('Update settings: check must be a boolean'); }
        } else {
            out.check = value.check;
        }
    }
    for ( const [ key, allowed ] of Object.entries(SETTING_ENUMS) ) {
        if ( value[key] === undefined ) { continue; }
        if ( allowed.includes(value[key]) === false ) {
            if ( strict ) { throw new TypeError(`Update settings: ${key} is invalid`); }
            continue;
        }
        out[key] = value[key];
    }
    return out;
}

// Managed storage "autoUpdate" ("off" | "notify" | "auto") caps what the
// user settings may do: '' (no cap), 'notify' or 'off'. A dashboard lock
// hides the Updates section, so the extension must not replace itself
// silently either. An unrecognized value (a typo such as "Off") fails closed
// for silent installs: it caps at 'notify'.
export function updatePolicyFrom(admin) {
    const value = admin?.autoUpdate;
    if ( value === 'off' ) { return 'off'; }
    const disabledFeatures = Array.isArray(admin?.disabledFeatures)
        ? admin.disabledFeatures
        : [];
    if ( value === 'notify' || disabledFeatures.includes('dashboard') ) {
        return 'notify';
    }
    if ( value !== undefined && value !== null && value !== '' && value !== 'auto' ) {
        return 'notify';
    }
    return '';
}

export function applyUpdatePolicy(settings, policy) {
    if ( policy === 'off' ) { return { ...settings, check: false, install: 'notify' }; }
    if ( policy === 'notify' ) { return { ...settings, install: 'notify' }; }
    return settings;
}

/******************************************************************************/

// Chromium extension versions: one to four dot-separated integers, each at
// most 65535, without leading zeros. A leading "v" (release tags) is accepted.
export function parseVersion(text) {
    if ( typeof text !== 'string' ) { return null; }
    const match = /^v?((?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3})$/.exec(text);
    if ( match === null ) { return null; }
    const parts = match[1].split('.').map(Number);
    if ( parts.some(part => part > 65535) ) { return null; }
    return parts;
}

export function compareVersions(a, b) {
    const left = Array.isArray(a) ? a : parseVersion(a);
    const right = Array.isArray(b) ? b : parseVersion(b);
    if ( left === null || right === null ) {
        throw new TypeError('Invalid version');
    }
    for ( let i = 0; i < 4; i++ ) {
        const x = left[i] ?? 0;
        const y = right[i] ?? 0;
        if ( x !== y ) { return x < y ? -1 : 1; }
    }
    return 0;
}

// Local builds without an explicit -Version receive a timestamp version such
// as 2026.923.1530, which would always look newer than any release.
export function isDevelopmentVersion(version) {
    const parts = parseVersion(version);
    return parts === null || parts[0] >= 2000;
}

export function editionFromManifest(manifest) {
    if ( manifest?.name === 'uBlock Plus+ Experimental' ||
        typeof manifest?.key === 'string' && manifest.key !== '' ) {
        return 'experimental';
    }
    return 'standard';
}

export function assetNameFor(version, edition) {
    return edition === 'experimental'
        ? `uBlock-Plus_${version}.experimental.chromium.zip`
        : `uBlock-Plus_${version}.chromium.zip`;
}

export function releasePageFor(version) {
    return `${UPDATE_RELEASES_PAGE}/tag/v${version}`;
}

const MAX_TEXT = 240;

function plainText(value, limit = MAX_TEXT) {
    if ( typeof value !== 'string' ) { return ''; }
    // Collapse whitespace and strip control characters; the UI renders this
    // with textContent only.
    const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// Reduce the GitHub release list to what update selection needs so it can be
// cached cheaply and reused after an HTTP 304 response.
export function compactReleases(releases) {
    if ( Array.isArray(releases) === false ) { return []; }
    const out = [];
    for ( const release of releases.slice(0, 100) ) {
        if ( release === null || typeof release !== 'object' ) { continue; }
        const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
        if ( parseVersion(tag) === null || tag.startsWith('v') === false ) { continue; }
        const assets = Array.isArray(release.assets)
            ? release.assets
                .map(asset => typeof asset?.name === 'string' ? asset.name : '')
                .filter(name => name !== '' && name.length <= 200)
                .slice(0, 50)
            : [];
        out.push({
            tag,
            draft: release.draft === true,
            prerelease: release.prerelease === true,
            name: plainText(release.name, 120),
            publishedAt: typeof release.published_at === 'string'
                ? release.published_at.slice(0, 40)
                : '',
            assets,
        });
    }
    return out;
}

// Pick the newest release newer than `currentVersion` that ships the package
// and checksum for this edition.
export function selectUpdate(releases, details) {
    const { currentVersion, channel = 'preview', edition = 'standard' } = details;
    const current = parseVersion(currentVersion);
    if ( current === null ) { return null; }
    let best = null;
    let bestParts = null;
    for ( const release of releases ) {
        if ( release.draft ) { continue; }
        if ( release.prerelease && channel !== 'preview' ) { continue; }
        const parts = parseVersion(release.tag);
        if ( parts === null ) { continue; }
        if ( compareVersions(parts, current) <= 0 ) { continue; }
        const version = release.tag.slice(1);
        const asset = assetNameFor(version, edition);
        if ( release.assets.includes(asset) === false ||
            release.assets.includes(`${asset}.sha256`) === false ) {
            continue;
        }
        if ( best !== null && compareVersions(parts, bestParts) <= 0 ) { continue; }
        best = {
            version,
            prerelease: release.prerelease,
            name: release.name,
            publishedAt: release.publishedAt,
            asset,
            page: releasePageFor(version),
        };
        bestParts = parts;
    }
    return best;
}

// Exponential backoff for failed checks, capped at one day. A server-provided
// retry time (rate limit) wins when it is later.
export function nextRetryDelay(failures, retryAfterMs = 0) {
    const count = Math.max(1, Math.min(failures | 0, 16));
    const exponential = Math.min(UPDATE_MAX_BACKOFF_MS, 15 * 60 * 1000 * 2 ** (count - 1));
    const server = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, UPDATE_MAX_BACKOFF_MS)
        : 0;
    return Math.max(exponential, server);
}

// Validate a native updater reply before any field is used.
export function normalizeUpdaterReply(reply) {
    if ( reply === null || typeof reply !== 'object' || Array.isArray(reply) ) {
        return { ok: false, error: { code: 'invalid-reply', message: 'The updater sent an invalid reply.' } };
    }
    if ( reply.v !== UPDATE_PROTOCOL ) {
        return { ok: false, error: { code: 'unsupported-protocol', message: 'The updater uses an unsupported protocol.' } };
    }
    if ( reply.ok !== true ) {
        let code = typeof reply.error?.code === 'string' && /^[a-z-]{1,40}$/.test(reply.error.code)
            ? reply.error.code
            : 'updater-error';
        // The updater reports its own lock as 'busy'; in the extension that
        // is another update, not a filter-list transaction.
        if ( code === 'busy' ) { code = 'update-busy'; }
        return { ok: false, error: { code, message: plainText(reply.error?.message, 300) } };
    }
    const out = { ok: true };
    for ( const key of [ 'updaterVersion', 'installedVersion', 'stagedVersion', 'backupVersion', 'version', 'edition' ] ) {
        if ( typeof reply[key] === 'string' && reply[key].length <= 40 ) {
            out[key] = reply[key];
        }
    }
    if ( reply.applied !== null && typeof reply.applied === 'object' ) {
        out.applied = {
            from: typeof reply.applied.from === 'string' ? reply.applied.from : null,
            to: typeof reply.applied.to === 'string' ? reply.applied.to : null,
        };
    }
    // The updater undid an interrupted apply by restoring its backup.
    if ( reply.recovered !== null && typeof reply.recovered === 'object' &&
        parseVersion(reply.recovered.restored) !== null ) {
        out.recovered = {
            restored: reply.recovered.restored,
            interrupted: parseVersion(reply.recovered.interrupted) !== null ? reply.recovered.interrupted : '',
        };
    }
    return out;
}

// Map chrome.runtime.lastError messages from native messaging to stable codes.
export function classifyNativeError(message) {
    const text = String(message || '');
    if ( /not found/i.test(text) ) { return 'updater-missing'; }
    if ( /forbidden/i.test(text) ) { return 'updater-forbidden'; }
    if ( /exited|disconnected|failed to start|Error when communicating/i.test(text) ) {
        return 'updater-failed';
    }
    return 'updater-error';
}
