/*******************************************************************************

    uBlock Plus+ - automatic updates: service-worker wiring regressions
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

    Runs the actual background.js functions with browser effects replaced by
    adapters: what blocks an update (running transactions; startup and the
    incognito worker's transactions within a bounded wait; not journals left
    by a failed recovery), when update messages and alarms run (after the
    update bookkeeping, not after start()), and how error codes reach pages.

*******************************************************************************/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

const read = async relativePath => (await readFile(new URL(
    `../platform/mv3/extension/${relativePath}`, import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const background = await read('js/background.js');
const extract = (name, prefix = 'function') => {
    const start = background.indexOf(`${prefix} ${name}(`);
    const end = background.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, `Actual background function ${name} must exist`);
    return background.slice(start, end);
};

// Only in-memory work blocks an update: queued or running filtering
// transactions and startup until it settles. Domain learning does not.
{
    let suspended = 0;
    const context = vm.createContext({
        Promise,
        pendingFilteringMutation: Promise.resolve(),
        startupSettled: false,
        webRequestFirewall: {
            beginMutation: ( ) => { suspended += 1; },
            endMutation: ( ) => { suspended -= 1; },
        },
    });
    assert.ok(background.includes('\nenqueueFilteringMutation.transactions = 0;\n'));
    vm.runInContext(`${extract('enqueueFilteringMutation')}\n${extract('isFilteringBusy')}\n` +
        'enqueueFilteringMutation.transactions = 0;', context);
    assert.equal(context.isFilteringBusy(), true, 'Startup blocks updates until it settles');
    context.startupSettled = true;
    assert.equal(context.isFilteringBusy(), false,
        'No journal is read: one left by a failed recovery does not block updates');
    let release;
    const running = context.enqueueFilteringMutation(( ) => new Promise(resolve => { release = resolve; }));
    const queued = context.enqueueFilteringMutation(async ( ) => { throw new Error('failed'); });
    assert.equal(context.isFilteringBusy(), true, 'A running transaction blocks updates');
    assert.equal(context.enqueueFilteringMutation.transactions, 2, 'So does a queued one');
    const learning = context.enqueueFilteringMutation(async ( ) => {}, false);
    assert.equal(context.enqueueFilteringMutation.transactions, 2, 'Domain learning is not a transaction');
    await turn();
    assert.equal(context.isFilteringBusy(), true);
    release();
    await running;
    await assert.rejects(queued, /failed/);
    await learning;
    assert.equal(context.isFilteringBusy(), false, 'A failed transaction releases the block');
    assert.equal(suspended, 0);
    assert.ok(background.includes('isBusy: ( ) => isUpdateBlocked(),'),
        'The update manager uses the in-memory state, through the startup wait');
    assert.ok(/const startupSettledPromise = isFullyInitialized\.catch\(\( \) => \{ \}\)\.then\(\( \) => \{\n {4}startupSettled = true;/.test(background),
        'Startup settles when isFullyInitialized does, even after a failure');
}

// An update action which woke the worker waits, within a bound, for startup
// and for this worker's queued transactions instead of failing at once (the
// permission grant which precedes the updater restart queues one). With
// incognito access, the incognito worker's
// transactions show only as journals: a live one blocks until it commits, a
// journal which outlives the bound (failed recovery) does not block.
{
    const journalKeys = [ 'rulesets.pendingTransaction', 'compiled.pending', 'compiled.staging', 'filteringModeTransaction' ];
    const storage = new Map();
    const reads = [];
    let settleStartup;
    let incognitoAllowed = false;
    const context = vm.createContext({
        Date, Promise, setTimeout,
        RULESET_TRANSACTION_KEY: journalKeys[0],
        PENDING_COMPILED_ACTIVATION_KEY: journalKeys[1],
        STAGING_COMPILED_GENERATION_KEY: journalKeys[2],
        pendingFilteringMutation: Promise.resolve(),
        startupSettled: false,
        startupSettledPromise: new Promise(resolve => { settleStartup = resolve; }),
        webRequestFirewall: { beginMutation() {}, endMutation() {} },
        browser: { extension: { isAllowedIncognitoAccess: async ( ) => incognitoAllowed } },
        localRead: async key => { reads.push(key); return storage.get(key); },
    });
    const constStart = background.indexOf('const FILTERING_JOURNAL_KEYS = [');
    const constEnd = background.indexOf('];\n', constStart) + 3;
    assert.ok(constStart !== -1);
    vm.runInContext(`${extract('enqueueFilteringMutation')}\n${extract('isFilteringBusy')}\n` +
        `enqueueFilteringMutation.transactions = 0;\n${background.slice(constStart, constEnd)}\n` +
        `${extract('isUpdateBlocked', 'async function')}\nthis.FILTERING_JOURNAL_KEYS = FILTERING_JOURNAL_KEYS;`, context);
    assert.deepEqual([ ...context.FILTERING_JOURNAL_KEYS ], journalKeys, 'Every filtering journal is watched');

    let answer;
    const waiting = context.isUpdateBlocked(5000).then(value => { answer = value; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(answer, undefined, 'An action during startup waits instead of failing');
    context.startupSettled = true;
    settleStartup();
    await waiting;
    assert.equal(answer, false, 'and proceeds once startup settled');
    assert.deepEqual(reads, [], 'Without incognito access no journal is read');

    context.startupSettled = false;
    context.startupSettledPromise = new Promise(( ) => {});
    const started = Date.now();
    assert.equal(await context.isUpdateBlocked(60), true, 'A startup which never settles blocks after the bound');
    assert.ok(Date.now() - started < 1000);
    context.startupSettled = true;

    storage.set('filteringModeTransaction', { version: 1 });
    assert.equal(await context.isUpdateBlocked(60), false, 'Without incognito access a journal does not block');
    incognitoAllowed = true;
    const commit = context.isUpdateBlocked(5000);
    setTimeout(( ) => { storage.delete('filteringModeTransaction'); }, 100);
    const t0 = Date.now();
    assert.equal(await commit, false);
    assert.ok(Date.now() - t0 >= 90, 'The update waits for an incognito transaction to commit');
    storage.set('rulesets.pendingTransaction', { version: 1 });
    const stuck = Date.now();
    assert.equal(await context.isUpdateBlocked(150), false, 'A journal which outlives the bound does not block');
    assert.ok(Date.now() - stuck >= 140);
    storage.clear();
    let release;
    context.enqueueFilteringMutation(( ) => new Promise(resolve => { release = resolve; }));
    const held = Date.now();
    assert.equal(await context.isUpdateBlocked(150), true, 'A transaction which outlives the bound blocks');
    assert.ok(Date.now() - held >= 140, 'after the update waited for it');
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await context.isUpdateBlocked(150), false);

    // A short transaction, then one queued while the update waits: the
    // update proceeds once both committed.
    let releaseFirst, releaseSecond;
    context.enqueueFilteringMutation(( ) => new Promise(resolve => { releaseFirst = resolve; }));
    let drained;
    const draining = context.isUpdateBlocked(5000).then(value => { drained = value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    context.enqueueFilteringMutation(( ) => new Promise(resolve => { releaseSecond = resolve; }));
    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(drained, undefined, 'The update waits for a transaction queued meanwhile');
    releaseSecond();
    await draining;
    assert.equal(drained, false, 'and proceeds once the queue drained');
    assert.equal(context.enqueueFilteringMutation.transactions, 0);
}

// Update messages wait for the update bookkeeping only, never for start().
{
    let releaseReady;
    const calls = [];
    const origin = 'chrome-extension://test';
    const context = vm.createContext({
        runtime: { id: 'test' },
        UBLOCK_PLUS_ORIGIN: origin,
        updateReady: new Promise(resolve => { releaseReady = resolve; }),
        updateManager: {
            getStatus: async options => { calls.push([ 'status', options ]); return 'status'; },
            install: async version => { calls.push([ 'install', version ]); },
            check: async options => { calls.push([ 'check', options ]); return 'checked'; },
        },
    });
    vm.runInContext(extract('onUpdateMessage', 'async function'), context);
    const page = { id: 'test', origin, url: `${origin}/dashboard.html` };
    assert.equal(await context.onUpdateMessage({ what: 'getUpdateStatus' },
        { id: 'test', url: 'https://example.com/' }), undefined, 'Web pages are refused at once');
    const status = context.onUpdateMessage({ what: 'getUpdateStatus', probe: true }, page);
    const check = context.onUpdateMessage({ what: 'checkForUpdatesNow' }, page);
    await turn();
    assert.deepEqual(calls, [], 'Nothing runs before initialize() finished');
    releaseReady();
    assert.equal(await status, 'status');
    assert.equal(await check, 'checked');
    // Objects from the vm realm compare by value through JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [ [ 'status', { probe: true } ], [ 'check', { manual: true } ] ]);
    assert.deepEqual({ ...await context.onUpdateMessage({ what: 'installUpdateNow', version: '1.2.0' }, page) },
        { started: true });
}

// Wiring: bookkeeping at worker start in the regular worker only; the alarm
// waits for it; the settings page opens after start() at the Updates section.
{
    const ready = background.indexOf('const updateReady = isIncognitoWorker');
    assert.ok(ready !== -1, 'updateReady is created at worker start, in the regular worker only');
    assert.ok(background.slice(ready, ready + 200).includes(': updateManager.initialize().catch('));
    assert.equal(background.includes('.then(( ) => updateManager.initialize())'), false,
        'initialize() does not wait for start()');
    assert.ok(background.includes('updateReady.then(( ) => updateManager.onAlarm(alarm))'),
        'The update alarm waits for the bookkeeping');
    const openSettings = "openSettingsPage: ( ) => isFullyInitialized.then(( ) => browser.tabs.create({\n" +
        "        url: runtime.getURL('/dashboard.html#settings/autoUpdate'),";
    assert.ok(background.includes(openSettings),
        'Only the settings page waits for start(), and it opens at the Updates section');
    assert.ok(background.includes("adminReadEx('autoUpdate'),"), 'The managed autoUpdate policy reaches the manager');
    const popup = await read('js/popup.js');
    assert.ok(popup.includes("openDashboard('settings/autoUpdate')"), 'The popup badge opens the Updates section');
}

// Error codes cross the message boundary so pages can localize them.
{
    const context = vm.createContext({});
    vm.runInContext(extract('messageErrorReply'), context);
    const reply = reason => ({ ...context.messageErrorReply(reason) });
    const coded = (message, code) => Object.assign(new Error(message), { code });
    assert.deepEqual(reply(coded('A filter list update is running.', 'filters-busy')),
        { __ublockPlusError: 'A filter list update is running.', __ublockPlusErrorCode: 'filters-busy' });
    assert.equal(reply(coded('scope', 'ERR_FILTERING_MODE_PARENT_SCOPE')).__ublockPlusErrorCode,
        'ERR_FILTERING_MODE_PARENT_SCOPE');
    for ( const code of [ 23, '<img onerror>', 'x'.repeat(41), '', undefined ] ) {
        assert.equal(reply(coded('m', code)).__ublockPlusErrorCode, undefined, `${code}`);
    }
    assert.equal(reply('plain').__ublockPlusError, 'plain');
}
{
    let messageReply;
    globalThis.self = {
        chrome: {
            runtime: {
                getURL: ( ) => 'chrome-extension://test/',
                async sendMessage() { return messageReply; },
            },
        },
    };
    const { sendMessage } = await import('../platform/mv3/extension/js/ext.js');
    for ( const [ code, expected ] of [
        [ 'filters-busy', 'filters-busy' ],
        [ 'update-busy', 'update-busy' ],
        [ 'ERR_FILTERING_MODE_PARENT_SCOPE', 'ERR_FILTERING_MODE_PARENT_SCOPE' ],
        [ 'UNRECOGNIZED', undefined ],
        [ '<img>', undefined ],
        [ 42, undefined ],
    ] ) {
        messageReply = { __ublockPlusError: 'failed', __ublockPlusErrorCode: code };
        await assert.rejects(sendMessage({ what: 'x' }), error => {
            assert.equal(error.message, 'failed');
            assert.equal(error.code, expected, `${code}`);
            return true;
        });
    }
    delete globalThis.self;
}

// Administrators can cap automatic updates through managed storage.
{
    const schema = JSON.parse(await read('managed_storage.json'));
    assert.equal(schema.properties.autoUpdate?.type, 'string');
    assert.match(schema.properties.autoUpdate.description, /"off".*"notify".*"auto"/);
    // Chrome validates managed values against the enum and reports a typo
    // on chrome://policy instead of passing it on.
    assert.deepEqual(schema.properties.autoUpdate.enum, [ 'off', 'notify', 'auto' ]);
}

console.log('Automatic updates, worker wiring: busy state, message timing, error codes and managed policy passed.');
