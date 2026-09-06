/* uBlock Plus+ — real message-handler retry regressions. GPL-3.0-or-later. */
import {
    hostnameFromMatch, matchFromHostname,
} from '../platform/mv3/extension/js/utils.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';

// Exercise the actual handler with browser effects replaced by controllable
// adapters, without starting a service worker or the unrelated list compiler.
// Git may check out JavaScript with CRLF on Windows; normalize before slicing
// function boundaries so the same handlers are exercised on every platform.
const source = (await fs.readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const functionSource = (name, nextName) => {
    const start = source.indexOf(`async function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
};
const refreshStart = source.indexOf('async function refreshFilteringScripts(');
const refreshEnd = source.indexOf('\n}\n', refreshStart) + 3;
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
let mode = 2;
let defaultMode = 2;
let stockCalls = 0;
let userCalls = 0;
let firewallCalls = 0;
let failStock = true;
let userGate;
let customFilterCount = 0;
let supplementalMutations = 0;
const context = vm.createContext({
    AggregateError, Promise,
    pendingFilteringMutation: Promise.resolve(),
    webRequestFirewall: {
        beginMutation: () => { supplementalMutations++; },
        endMutation: () => {
            assert.ok(supplementalMutations > 0);
            supplementalMutations--;
        },
    },
    isFullyInitialized: Promise.resolve(),
    firewall: { refresh: async () => { firewallCalls++; } },
    UBLOCK_PLUS_ORIGIN: 'chrome-extension://test',
    hasBroadHostPermissions: async () => true,
    adminReadEx: async () => [],
    hasCustomFilters: async () => customFilterCount,
    popupBlocker: {
        getPolicies: async () => ({ effective: { mode: 'default' } }),
        getDiagnostics: async () => [],
    },
    getFilteringModeRestoreLevel: async () => mode,
    countSitePopupBlocks: () => 0,
    rulesetConfig: { enabledRulesets: [], popupBlockMode: true },
    isSideloaded: true,
    getFilteringMode: async () => mode,
    setFilteringMode: async (_hostname, level) => { mode = level; return level; },
    getDefaultFilteringMode: async () => defaultMode,
    setDefaultFilteringMode: async level => { defaultMode = level; return level; },
    registerContentScripts: async () => {
        stockCalls += 1;
        // The actual content manager now owns shared user/native scriptlet
        // registration; the background must not run a duplicate beside it.
        await context.registerUserScripts();
        if ( failStock ) { throw new Error('registration failed'); }
    },
    registerUserScripts: async () => {
        userCalls += 1;
        if ( userGate ) { await userGate; }
    },
});
const queueStart = source.indexOf('function enqueueFilteringMutation(');
const queueEnd = source.indexOf('\n}\n', queueStart) + 3;
vm.runInContext(source.slice(queueStart, queueEnd) + '\n' +
    source.slice(refreshStart, refreshEnd) + '\n' +
    functionSource('onMessage', 'onCommand'), context);
const send = request => context.onMessage(request, {
    origin: 'chrome-extension://test',
});
let release;
userGate = new Promise(resolve => { release = resolve; });
let settled = false;
const failed = send({ what: 'setFilteringMode', hostname: 'site.test', level: 1 });
const checked = assert.rejects(failed, /registration failed/).then(() => { settled = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(mode, 1);
assert.equal(settled, false, 'Do not leave the queue while user registration is pending');
assert.equal(supplementalMutations, 1, 'blocking supplement stays suspended while native registration is pending');
release();
await checked;
assert.equal(supplementalMutations, 0, 'rejected mutations also release their suspension lease');
userGate = undefined;
failStock = false;
assert.equal(await send({ what: 'setFilteringMode', hostname: 'site.test', level: 1 }), 1);
assert.equal(stockCalls, 2, 'Retry must repair scripts even after mode persistence');
assert.equal(userCalls, 2);

failStock = true;
await assert.rejects(send({ what: 'setDefaultFilteringMode', level: 3 }), /registration failed/);
failStock = false;
assert.equal(await send({ what: 'setDefaultFilteringMode', level: 3 }), 3);
assert.equal(stockCalls, 4);
assert.equal(userCalls, 4);
assert.equal(firewallCalls, 4, 'Mode changes and retries also repair native firewall scope');
assert.equal(supplementalMutations, 0);
for ( const count of [ 0, 1, 3 ] ) {
    customFilterCount = count;
    const data = await send({ what: 'popupPanelData', hostname: 'site.test' });
    assert.equal(data.hasCustomFilters, count > 0,
        'Unpicker receives a boolean for actual saved selector counts');
}
for ( const [ hostname, expected ] of [
    [ 'example.test', '*://*.example.test/*' ],
    [ '127.0.0.1', '*://127.0.0.1/*' ],
    [ '[::1]', '*://[::1]/*' ],
    [ '[2001:db8::1]', '*://[2001:db8::1]/*' ],
    [ 'all-urls', '<all_urls>' ],
] ) {
    assert.equal(matchFromHostname(hostname), expected);
    assert.equal(hostnameFromMatch(expected), hostname);
}
console.log('Filtering-mode retry and IP scope tests passed');
