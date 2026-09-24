/* uBlock Plus+ — message sender trust tiers of the service worker. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

// Runs the actual background.js message handlers with browser effects
// replaced by recording adapters. Firefox does not set sender.origin: there
// a content script or a user script must not reach what only extension pages
// may do. The strict-block page may ask for the address its own tab was
// redirected from, and only that page.

const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const slice = (marker, end) => {
    const start = background.indexOf(marker);
    assert.ok(start >= 0, `Actual background code must include ${marker}`);
    const stop = background.indexOf(end, start);
    assert.ok(stop > start, `Actual background code must end ${marker} with ${JSON.stringify(end)}`);
    return background.slice(start, stop + end.length);
};
const extract = (name, prefix = 'function') => slice(`${prefix} ${name}(`, '\n}\n');

// onMessage() and the sender helpers which follow it, up to onCommand().
const onMessageStart = background.indexOf('async function onMessage(');
const onMessageEnd = background.indexOf('function onCommand(', onMessageStart);
assert.ok(onMessageStart >= 0 && onMessageEnd > onMessageStart);
const messageCode = [
    slice('const COMPILED_FILTERS_RETRY_JOB = ', ';\n'),
    slice('const DEFERRED_JOB_MESSAGES = new Set([', '\n]);\n'),
    extract('strictBlockUrlSource'),
    extract('followStrictBlockMemoryProfile'),
    extract('onStrictBlockMemoryProfile'),
    background.slice(onMessageStart, onMessageEnd),
].join('\n');
const userScriptCode = slice('if ( supportsUserScripts() && runtime.onUserScriptMessage ) {', '\n}\n');

const flavors = {
    chromium: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        setsOrigin: true,
    },
    firefox: {
        id: 'ublock-plus@kayurachann.github.io',
        origin: 'moz-extension://2f1c6a4e-7b1d-4c57-9d0b-5c7e2d9a1f00',
        setsOrigin: false,
    },
};

// Any identifier the tested paths do not provide resolves to a recording
// stub, so a privileged path which is reached shows up in `calls`.
function messageContext(flavor, overrides = {}) {
    const { id, origin } = flavors[flavor];
    const calls = [];
    const record = (name, value) => (...args) => {
        calls.push([ name, ...args ]);
        return value;
    };
    const target = {
        webextFlavor: flavor,
        runtime: { id },
        UBLOCK_PLUS_ORIGIN: origin,
        UPDATE_MESSAGES: new Set([ 'getUpdateStatus' ]),
        onUpdateMessage: record('onUpdateMessage', 'update'),
        isFullyInitialized: Promise.resolve(),
        strictBlockTracker: {
            getDetails: record('getDetails', { url: 'https://blocked.example/path', source: 'rule-match' }),
            urlSource: ( ) => 'rule-match',
        },
        STRICTBLOCK_PAGE_PATH: '/strictblock.html',
        isLoggerCapturing: record('isLoggerCapturing', true),
        enqueueFilteringMutation: record('enqueueFilteringMutation', 'queued'),
        pruneCSSCache: record('pruneCSSCache', 'pruned'),
        getRegexCapacity: record('getRegexCapacity', 'capacity'),
        getRuntimeCapabilities: record('getRuntimeCapabilities', 'capabilities'),
        firewall: { getState: record('firewall.getState', 'state') },
        ...overrides,
    };
    const builtins = new Set([
        'Array', 'Error', 'JSON', 'Number', 'Object', 'Promise', 'Set', 'String', 'URL',
    ]);
    const context = vm.createContext(new Proxy(target, {
        has: ( ) => true,
        get: (object, key) => {
            if ( key in object ) { return object[key]; }
            if ( typeof key !== 'string' ) { return; }
            if ( builtins.has(key) ) { return globalThis[key]; }
            return record(`unexpected:${key}`);
        },
        set: (object, key, value) => {
            object[key] = value;
            return true;
        },
    }));
    vm.runInContext(messageCode, context);
    return { context, calls, id, origin };
}

// Senders, as each browser reports them.
function senders(flavor) {
    const { id, origin, setsOrigin } = flavors[flavor];
    const page = (path, extra = {}) => ({
        id, url: `${origin}${path}`, ...(setsOrigin ? { origin } : {}), ...extra,
    });
    const web = (url, extra = {}) => ({
        id, url, ...(setsOrigin ? { origin: new URL(url).origin } : {}), ...extra,
    });
    return {
        dashboard: page('/dashboard.html', { tab: { id: 3 }, frameId: 0 }),
        popup: page('/popup.html'),
        pickerFrame: page('/picker-ui.html', { tab: { id: 5 }, frameId: 4 }),
        strictBlockPage: page('/strictblock.html#https://blocked.example/path', { tab: { id: 7 }, frameId: 0 }),
        strictBlockFrame: page('/strictblock.html', { tab: { id: 7 }, frameId: 2 }),
        strictBlockNoTab: page('/strictblock.html'),
        contentScript: web('https://www.example.com/page', { tab: { id: 5 }, frameId: 0 }),
        contentSubframe: web('https://ads.example.net/frame', { tab: { id: 5 }, frameId: 9 }),
        lookalike: { id, url: `${origin}.evil.example/dashboard.html` },
        otherExtension: { ...page('/dashboard.html'), id: 'other-extension' },
        empty: {},
    };
}

const trustedPages = [ 'dashboard', 'popup', 'pickerFrame', 'strictBlockPage', 'strictBlockFrame', 'strictBlockNoTab' ];
const untrusted = [ 'contentScript', 'contentSubframe', 'lookalike', 'empty' ];
const settle = async ( ) => { for ( let i = 0; i < 5; i++ ) { await turn(); } };

for ( const flavor of Object.keys(flavors) ) {
    const all = senders(flavor);

    // Trusted tier: a setting only extension pages may change.
    for ( const name of [ ...trustedPages, ...untrusted, 'otherExtension' ] ) {
        const { context, calls } = messageContext(flavor);
        const result = await context.onMessage({ what: 'setStrictBlockMode', state: false }, all[name]);
        // Chromium trusts the document origin it reports, as before.
        const expected = trustedPages.includes(name) ||
            name === 'otherExtension' && flavors[flavor].setsOrigin;
        if ( expected ) {
            assert.equal(result, 'queued', `${flavor}/${name}: an extension page is trusted`);
        } else {
            assert.equal(result, undefined, `${flavor}/${name}: must not be trusted`);
            assert.deepEqual(calls, [], `${flavor}/${name}: nothing privileged may run`);
        }
    }

    // Content scripts keep the messages they need.
    {
        const { context, calls } = messageContext(flavor);
        assert.equal(await context.onMessage({ what: 'getLoggerCapture' }, all.contentScript), true);
        assert.deepEqual(calls, [ [ 'isLoggerCapturing', 5 ] ]);
    }

    // Deferred jobs are dispatched by the worker itself, without a sender;
    // nothing else is accepted without one, and a job name missing from the
    // list is reported rather than dropped silently.
    {
        const { context, calls } = messageContext(flavor);
        assert.equal(await context.onMessage({ what: 'updateImportedLists' }, undefined), 'queued');
        assert.equal(await context.onMessage({ what: 'retryCompiledFilters' }, undefined), 'queued');
        assert.equal(await context.onMessage({ what: 'pruneCSSCache' }, undefined), 'pruned');
        assert.deepEqual(calls.map(([ name ]) => name),
            [ 'enqueueFilteringMutation', 'enqueueFilteringMutation', 'pruneCSSCache' ]);
        for ( const what of [ 'setStrictBlockMode', 'getRegexCapacity', 'excludeFromStrictBlock' ] ) {
            const other = messageContext(flavor);
            assert.equal(await other.context.onMessage({ what, state: false }, undefined), undefined,
                `${flavor}: ${what} without a sender`);
            assert.deepEqual(other.calls, [
                [ 'unexpected:ublockPlusErr', `Deferred job ${what} is not in DEFERRED_JOB_MESSAGES` ],
            ]);
        }
        // The jobs alarms.js can run today are all listed.
        for ( const [ file, pattern ] of [
            [ 'background.js', /registerJob\(\s*(COMPILED_FILTERS_RETRY_JOB|'[^']+')/g ],
            [ 'imported-lists.js', /registerJob\(\s*('[^']+')/g ],
            [ 'scripting-manager.js', /registerJob\(\s*('[^']+')/g ],
        ] ) {
            const text = file === 'background.js' ? background : await readFile(new URL(
                `../platform/mv3/extension/js/${file}`, import.meta.url
            ), 'utf8');
            for ( const [ , token ] of text.matchAll(pattern) ) {
                const what = token === 'COMPILED_FILTERS_RETRY_JOB'
                    ? 'retryCompiledFilters'
                    : token.slice(1, -1);
                const job = messageContext(flavor);
                await job.context.onMessage({ what }, undefined);
                assert.equal(job.calls.some(([ name ]) => name === 'unexpected:ublockPlusErr'), false,
                    `${file}: deferred job ${what} must be dispatchable`);
            }
        }
    }

    // Extension-page tier: the regex capacity report (its 'Check now' asks
    // the browser about every packaged regex rule).
    for ( const name of [ ...trustedPages, ...untrusted, 'otherExtension' ] ) {
        const { context, calls } = messageContext(flavor);
        const result = await context.onMessage({ what: 'getRegexCapacity', verifyStatic: true }, all[name]);
        if ( trustedPages.includes(name) ) {
            assert.equal(result, 'capacity', `${flavor}/${name}`);
            assert.deepEqual(JSON.parse(JSON.stringify(calls)),
                [ [ 'getRegexCapacity', { verifyStatic: true } ] ]);
        } else {
            assert.equal(result, undefined, `${flavor}/${name}: the capacity report is for extension pages`);
            assert.deepEqual(calls, []);
        }
    }
    for ( const verifyStatic of [ 'true', 1, undefined ] ) {
        const { context, calls } = messageContext(flavor);
        await context.onMessage({ what: 'getRegexCapacity', verifyStatic }, all.dashboard);
        assert.deepEqual(JSON.parse(JSON.stringify(calls)),
            [ [ 'getRegexCapacity', { verifyStatic: false } ] ], 'only a literal true checks now');
    }

    // Firewall messages keep the same extension-page tier.
    {
        const page = messageContext(flavor);
        assert.equal(await page.context.onMessage({ what: 'getFirewallState' }, all.dashboard), 'state');
        const other = messageContext(flavor);
        assert.equal(await other.context.onMessage({ what: 'getFirewallState' }, all.otherExtension), undefined);
        assert.deepEqual(other.calls, []);
    }

    // The strict-block page asks for the address of its own tab. It is
    // answered before initialization completes.
    {
        let resolveStartup;
        const pending = new Promise(resolve => { resolveStartup = resolve; });
        const { context, calls } = messageContext(flavor, { isFullyInitialized: pending });
        const answer = context.onMessage({ what: 'getStrictBlockDetails', timeOrigin: 1234.5 },
            all.strictBlockPage);
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(resolve, 1000, 'timeout'); });
        const details = await Promise.race([ answer, timeout ]);
        clearTimeout(timer);
        assert.deepEqual(details,
            { url: 'https://blocked.example/path', source: 'rule-match' },
            `${flavor}: getStrictBlockDetails must not wait for startup`);
        assert.deepEqual(calls, [ [ 'getDetails', 7, 1234.5 ] ]);
        resolveStartup();
    }
    for ( const name of [ 'strictBlockFrame', 'strictBlockNoTab', 'dashboard', 'popup', 'pickerFrame',
        ...untrusted, 'otherExtension' ] ) {
        const { context, calls } = messageContext(flavor);
        const result = await context.onMessage({ what: 'getStrictBlockDetails', timeOrigin: 1 }, all[name]);
        assert.equal(result, undefined, `${flavor}/${name} may not ask for a strict-block address`);
        assert.deepEqual(calls, []);
    }
    {
        const { context } = messageContext(flavor);
        const spoofed = { ...all.contentScript, url: `https://www.example.com/strictblock.html` };
        assert.equal(await context.onMessage({ what: 'getStrictBlockDetails', timeOrigin: 1 }, spoofed),
            undefined, 'a web page named strictblock.html is not the strict-block page');
    }

    // The update messages check the same extension-page tier inline.
    {
        const updateCode = extract('onUpdateMessage', 'async function');
        const pageCode = extract('isExtensionPageSender');
        const context = vm.createContext({
            runtime: { id: flavors[flavor].id },
            UBLOCK_PLUS_ORIGIN: flavors[flavor].origin,
            updateReady: Promise.resolve(),
            updateManager: { getStatus: async ( ) => 'status' },
        });
        vm.runInContext(`${updateCode}\n${pageCode}`, context);
        const matrix = { ...all,
            originMismatch: { ...all.dashboard, origin: 'https://www.example.com' } };
        for ( const [ name, sender ] of Object.entries(matrix) ) {
            const updateAllowed = await context.onUpdateMessage({ what: 'getUpdateStatus' }, sender) === 'status';
            assert.equal(context.isExtensionPageSender(sender), updateAllowed,
                `${flavor}/${name}: isExtensionPageSender and onUpdateMessage must agree`);
        }
    }
}

// Runtime capabilities report how the strict-block page learns the address:
// the tracker on Chromium, the redirect itself on Firefox, nothing on Safari.
for ( const [ flavor, expected ] of [
    [ 'chromium', 'rule-match' ], [ 'firefox', 'regex-substitution' ], [ 'safari', 'unavailable' ],
] ) {
    const { context, calls } = messageContext(flavor === 'safari' ? 'chromium' : flavor,
        { webextFlavor: flavor });
    const sender = senders(flavor === 'safari' ? 'chromium' : flavor).dashboard;
    assert.equal(await context.onMessage({ what: 'getRuntimeCapabilities' }, sender), 'capabilities');
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),
        [ [ 'getRuntimeCapabilities', { strictBlockUrlSource: expected } ] ], flavor);
}

// User scripts run in a less trusted world than content scripts: only the
// logger's two messages reach onMessage().
{
    let listener;
    const dispatched = [];
    const context = vm.createContext({
        supportsUserScripts: ( ) => true,
        runtime: { onUserScriptMessage: { addListener: fn => { listener = fn; } } },
        browser: { userScripts: { configureWorld: async ( ) => { } } },
        onMessage: async request => { dispatched.push(request.what); return 'reply'; },
        messageErrorReply: reason => ({ error: `${reason}` }),
        ublockPlusErr: ( ) => { },
    });
    vm.runInContext(`${slice('const USER_SCRIPT_MESSAGES = new Set([', '\n]);\n')}\n${userScriptCode}`, context);
    assert.equal(typeof listener, 'function');
    const sender = senders('chromium').contentScript;
    for ( const what of [ 'setStrictBlockMode', 'excludeFromStrictBlock', 'getRegexCapacity',
        'getStrictBlockDetails', 'insertCSS', 'removeCSS', 'injectCSSProceduralAPI',
        'startCustomFilters', 'updateImportedLists', 'getFirewallState', 'keepAlive' ] ) {
        const replies = [];
        assert.notEqual(listener({ what }, sender, reply => replies.push(reply)), true, what);
        await settle();
        assert.deepEqual(replies, [], what);
    }
    assert.deepEqual(dispatched, [], 'no other message may reach onMessage from a user script');
    for ( const what of [ 'getLoggerCapture', 'recordContentDiagnostic' ] ) {
        const replies = [];
        assert.equal(listener({ what }, sender, reply => replies.push(reply)), true);
        await settle();
        assert.deepEqual(replies, [ 'reply' ], what);
    }
    assert.deepEqual(dispatched, [ 'getLoggerCapture', 'recordContentDiagnostic' ]);
}

// The memory profile decides whether the onRuleMatchedDebug source is used:
// a profile which changes the URL source rebuilds the session plan, once the
// worker is initialized; one which does not leaves it alone.
for ( const [ what, effective, changed ] of [
    [ 'setMemoryProfile', 'low-memory', true ],
    [ 'getMemoryProfile', 'low-memory', true ],
    [ 'setMemoryProfile', 'balanced', false ],
] ) {
    const lowMemory = [];
    let rebuilt = 0;
    const profile = { effective, retainScriptingMetadata: true };
    const { context } = messageContext('chromium', {
        strictBlockTracker: {
            setLowMemory: state => { lowMemory.push(state); return changed; },
            urlSource: ( ) => 'rule-match',
        },
        setMemoryProfile: async ( ) => profile,
        getMemoryProfileConfig: async ( ) => profile,
        releaseScriptingMetadata: ( ) => { },
        pruneCSSCache: async ( ) => { },
        updateSessionRules: async ( ) => { rebuilt += 1; return {}; },
    });
    const result = await context.onMessage({ what, profile: effective }, senders('chromium').dashboard);
    await settle();
    assert.equal(result, profile, what);
    assert.deepEqual(lowMemory, [ effective === 'low-memory' ], `${what} ${effective}`);
    assert.equal(rebuilt, changed ? 1 : 0, `${what} ${effective}: session plan rebuilt`);
}

console.log('Sender trust: Firefox senders without origin, deferred jobs, extension-page tier, strict-block page, capabilities and user-script allowlist passed.');
