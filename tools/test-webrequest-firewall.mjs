/* uBlock Plus+ optional blocking firewall regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { createWebRequestFirewall } from '../platform/mv3/extension/js/webrequest-firewall.js';
import psl from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

psl.parse(JSON.parse(await readFile(new URL(
    '../platform/mv3/extension/firewall-public-suffix.json', import.meta.url
), 'utf8')).text, name => new URL(`https://${name}`).hostname);
const resolve = host => host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) ||
    host.includes('.') === false ? host : psl.getDomain(host);
const modes = { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] };
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function harness(options = {}) {
    let listener;
    let permission = true;
    let data = { text: '* * 3p-script block', modes, domainFromHostname: resolve };
    let getter = () => structuredClone({ text: data.text, modes: data.modes, error: data.error });
    const logs = [];
    const service = createWebRequestFirewall({
        manifest: { permissions: options.declared === false
            ? [ 'declarativeNetRequest' ] : [ 'webRequest', 'webRequestBlocking' ] },
        permissions: { contains: async input => {
            assert.deepEqual(input.permissions, [ 'webRequest', 'webRequestBlocking' ]);
            if ( options.permissionError ) { throw new Error('permission failed'); }
            return permission;
        } },
        webRequest: { onBeforeRequest: { addListener: (callback, filter, extra) => {
            if ( options.registrationError ) { throw new Error('registration failed'); }
            assert.deepEqual(extra, [ 'blocking' ]);
            assert.deepEqual(filter.urls, [ 'http://*/*', 'https://*/*' ]);
            listener = callback;
        } } },
        getSnapshot: async () => ({ ...await getter(), domainFromHostname: data.domainFromHostname }),
        getTabs: options.getTabs,
        getFrames: options.getFrames,
        record: event => logs.push(event),
    });
    const commit = (url = 'https://alice.github.io/', extra = {}) => service.observeNavigation({
        tabId: 1, frameId: 0, documentId: 'root', timeStamp: 100, url, ...extra,
    }, true);
    const request = (extra = {}) => listener?.({ tabId: 1, frameId: 0,
        documentId: 'root', documentLifecycle: 'active', type: 'script',
        url: 'https://bob.github.io/script.js', timeStamp: 110, ...extra });
    return { service, commit, request, logs,
        registered: () => typeof listener === 'function',
        setPermission: value => { permission = value; },
        setData: value => { data = { ...data, ...value }; },
        setGetter: value => { getter = value; },
    };
}

const hydratedRoot = { frameId: 0, parentFrameId: -1, documentId: 'root',
    documentLifecycle: 'active', url: 'https://alice.github.io/', errorOccurred: false };
const hydratedChild = { frameId: 7, parentFrameId: 0, parentDocumentId: 'root',
    documentId: 'child', documentLifecycle: 'active', url: 'https://bob.github.io/' };
const restored = harness({
    getTabs: async () => [ { id: 1, url: 'https://stale.invalid/' } ],
    getFrames: async () => [ { ...hydratedChild, frameId: 8, parentFrameId: 7,
        parentDocumentId: 'child', documentId: 'grandchild' }, hydratedChild, hydratedRoot,
    { ...hydratedChild, frameId: 9, parentDocumentId: 'old-root', documentId: 'stale-child' },
    { ...hydratedChild, frameId: 10, documentLifecycle: 'cached', documentId: 'cached-child' } ],
});
await restored.service.initialize();
assert.deepEqual(restored.request(), { cancel: true }, 'worker wakeup restores current root without page reload');
assert.deepEqual(restored.request({ frameId: 8, documentId: 'grandchild' }), { cancel: true }, 'unordered valid child graph restores');
assert.deepEqual(restored.request({ frameId: 9, documentId: 'stale-child' }), {});
assert.deepEqual(restored.request({ frameId: 10, documentId: 'cached-child' }), {});
for ( const change of [ 'navigation', 'removed' ] ) {
    const framesReady = deferred();
    const framesRead = deferred();
    const restoring = harness({ getTabs: async () => [ { id: 1 } ],
        getFrames: () => { framesRead.resolve(); return framesReady.promise; } });
    const initialization = restoring.service.initialize();
    await framesRead.promise;
    if ( change === 'navigation' ) {
        restoring.commit('https://new.example/', { documentId: 'new-root', timeStamp: 500 });
    } else { restoring.service.forgetTab(1); }
    framesReady.resolve([ hydratedRoot, hydratedChild ]);
    await initialization;
    assert.deepEqual(restoring.request(), {}, `${change} invalidates stale async hydration`);
    if ( change === 'navigation' ) {
        assert.deepEqual(restoring.request({ documentId: 'new-root' }), { cancel: true });
    }
}
const failedHydration = harness({ getTabs: async () => [ { id: 1 } ],
    getFrames: async () => { throw new Error('tab gone'); } });
await failedHydration.service.initialize();
assert.deepEqual(failedHydration.request(), {});
const deniedHydration = harness({ getTabs: async () => { throw new Error('must not query without permission'); } });
deniedHydration.setPermission(false);
await deniedHydration.service.initialize();
assert.equal(deniedHydration.service.getStatus().state, 'permission-required');

const basic = harness();
assert.equal(basic.registered(), true, 'listener registers before asynchronous initialization');
basic.commit();
assert.deepEqual(basic.request(), {}, 'startup is fail-open');
await basic.service.initialize();
assert.equal(basic.service.getStatus().state, 'active');
assert.deepEqual(basic.request(), { cancel: true }, 'PSL private suffix makes separate github.io sites third-party');
assert.equal(basic.logs[0].source, 'browser.webRequest (firewall supplement)');
assert.equal(basic.logs[0].detail, '* * 3p-script block');
assert.deepEqual(basic.request({ url: 'https://cdn.alice.github.io/code.js' }), {}, 'first-party script passes');
assert.deepEqual(basic.request({ type: 'image' }), {}, 'unmatched resource type passes');
assert.equal(basic.request() instanceof Promise, false, 'callback never returns a Promise');
for ( const extra of [
    { tabId: -1 }, { tabId: 2 }, { tabId: undefined },
    { url: 'chrome://settings/' }, { url: 'not a URL' },
    { documentId: 'old-root' }, { documentLifecycle: 'cached' },
    { documentId: undefined }, { frameId: -1, documentId: undefined },
    { frameId: -1, documentId: 'old-root' },
] ) { assert.deepEqual(basic.request(extra), {}); }
assert.deepEqual(basic.request({ frameId: -1 }), { cancel: true },
    'a worker is evaluated only when its current document identity is proven');

basic.service.observeNavigation({ tabId: 1, frameId: 0, timeStamp: 200,
    url: 'https://other.example/' });
assert.deepEqual(basic.request(), {}, 'in-flight root navigation never uses old or speculative source');
basic.commit('https://other.example/', { timeStamp: 210, documentId: 'new-root' });
assert.deepEqual(basic.request(), {}, 'old document fails open after commit');
assert.deepEqual(basic.request({ documentId: 'new-root' }), { cancel: true });
basic.commit('https://alice.github.io/', { timeStamp: 150 });
assert.deepEqual(basic.request({ documentId: 'new-root' }), { cancel: true }, 'late commit cannot replace newer context');
basic.service.observeNavigation({ tabId: 1, frameId: 0, timeStamp: 220, url: 'chrome://settings/' });
basic.commit('https://alice.github.io/', { timeStamp: 215 });
assert.deepEqual(basic.request(), {}, 'restricted navigation leaves a timestamp tombstone');

const frames = harness();
frames.commit();
await frames.service.initialize();
assert.deepEqual(frames.request({ frameId: 7, documentId: 'iframe' }), {}, 'unknown iframe fails open');
frames.service.observeNavigation({ tabId: 1, frameId: 7, parentFrameId: 0,
    parentDocumentId: 'root', documentId: 'iframe', timeStamp: 101,
    url: 'https://bob.github.io/' }, true);
assert.deepEqual(frames.request({ frameId: 7, documentId: 'iframe',
    url: 'https://bob.github.io/code.js' }), { cancel: true }, 'iframe uses top page party, not iframe initiator');
frames.service.observeNavigation({ tabId: 1, frameId: 70, parentFrameId: 7,
    parentDocumentId: 'iframe', documentId: 'grandchild', timeStamp: 102,
    url: 'https://bob.github.io/' }, true);
assert.deepEqual(frames.request({ frameId: 70, documentId: 'grandchild' }), { cancel: true });
frames.service.observeNavigation({ tabId: 1, frameId: 7, timeStamp: 110,
    url: 'https://new.example/' });
assert.deepEqual(frames.request({ frameId: 7, documentId: 'iframe' }), {}, 'navigating child loses its prior identity immediately');
assert.deepEqual(frames.request({ frameId: 70, documentId: 'grandchild' }), {}, 'navigating child invalidates its descendants');
assert.deepEqual(frames.request({ frameId: -1, documentId: 'grandchild' }), {}, 'old descendant worker loses attribution');
frames.service.observeNavigation({ tabId: 1, frameId: 7, parentFrameId: 0,
    parentDocumentId: 'root', documentId: 'late-old', timeStamp: 105,
    url: 'https://old.example/' }, true);
assert.deepEqual(frames.request({ frameId: 7, documentId: 'late-old' }), {}, 'child timestamp tombstone rejects a delayed old commit');
frames.service.observeNavigation({ tabId: 1, frameId: 7, parentFrameId: 0,
    parentDocumentId: 'root', documentId: 'new-child', timeStamp: 115,
    url: 'https://new.example/' }, true);
assert.deepEqual(frames.request({ frameId: 7, documentId: 'new-child' }), { cancel: true });
assert.deepEqual(frames.request({ frameId: 70, documentId: 'grandchild' }), {});
frames.service.observeNavigation({ tabId: 1, frameId: 8, parentFrameId: 0,
    parentDocumentId: 'old-root', documentId: 'stale', timeStamp: 102,
    url: 'https://bob.github.io/' }, true);
assert.deepEqual(frames.request({ frameId: 8, documentId: 'stale' }), {}, 'stale child commit rejected');
for ( let frameId = 1000; frameId < 1300; frameId++ ) {
    frames.service.observeNavigation({ tabId: 1, frameId, parentFrameId: 0,
        parentDocumentId: 'root', documentId: `bounded-${frameId}`, timeStamp: frameId,
        url: 'https://bob.github.io/' }, true);
}
assert.deepEqual(frames.request({ frameId: 1000, documentId: 'bounded-1000' }), {}, 'old frame history is bounded and evicted contexts fail open');
assert.deepEqual(frames.request({ frameId: 1299, documentId: 'bounded-1299' }), { cancel: true });
frames.service.beginMutation();
frames.setData({ text: '* * 3p-frame block' });
await frames.service.endMutation();
assert.deepEqual(frames.request({ type: 'sub_frame', frameId: 9,
    parentFrameId: 0, parentDocumentId: 'root', documentId: undefined }), { cancel: true });
frames.service.forgetTab(1);
assert.deepEqual(frames.request(), {}, 'removed tabs lose provenance');

for ( const action of [ 'allow', 'noop' ] ) {
    const control = harness();
    control.setData({ text: `* * * block\nalice.github.io * * ${action}` });
    control.commit();
    await control.service.initialize();
    assert.deepEqual(control.request(), {}, `${action} must not cancel or suppress DNR filtering`);
}
for ( const none of [ [ 'all-urls' ], [ 'github.io' ], [ 'alice.github.io' ] ] ) {
    const off = harness();
    off.setData({ modes: { none, basic: [], optimal: [ 'all-urls' ], complete: [] } });
    off.commit();
    await off.service.initialize();
    assert.deepEqual(off.request(), {}, 'Off and inherited Off always pass');
}
for ( const host of [ '[::1]', '127.0.0.1', 'localhost' ] ) {
    const local = harness();
    local.commit(`http://${host}/`);
    await local.service.initialize();
    assert.deepEqual(local.request({ url: `http://${host}/script.js` }), {});
    assert.deepEqual(local.request(), { cancel: true });
}

const absent = harness({ declared: false });
await absent.service.initialize();
assert.equal(absent.registered(), false);
assert.equal(absent.service.getStatus().state, 'not-configured');
const denied = harness();
denied.setPermission(false);
denied.commit();
await denied.service.initialize();
assert.equal(denied.registered(), true, 'registration success does not prove permission');
assert.equal(denied.service.getStatus().state, 'permission-required');
assert.deepEqual(denied.request(), {});
for ( const options of [ { permissionError: true }, { registrationError: true } ] ) {
    const broken = harness(options);
    await broken.service.initialize();
    assert.equal(broken.service.getStatus().state, 'error');
    assert.equal(broken.service.getStatus().ready, false);
}

const queue = harness();
queue.commit();
await queue.service.initialize();
queue.service.beginMutation();
queue.service.beginMutation();
queue.setData({ text: '* * * block' });
assert.deepEqual(queue.request(), {});
await queue.service.endMutation();
assert.equal(queue.service.getStatus().ready, false, 'first completion cannot resume while another mutation is queued');
await queue.service.endMutation();
assert.deepEqual(queue.request({ type: 'image' }), { cancel: true });
queue.service.beginMutation();
const loading = deferred();
queue.setGetter(() => loading.promise);
const oldRefresh = queue.service.endMutation();
await Promise.resolve();
queue.service.beginMutation();
queue.setData({ text: '* * * allow' });
loading.resolve({ text: '* * * block', modes });
await oldRefresh;
assert.deepEqual(queue.request(), {}, 'stale asynchronous snapshot cannot reactivate filtering');
queue.setGetter(() => ({ text: '* * * allow', modes }));
await queue.service.endMutation();
assert.deepEqual(queue.request(), {});
queue.setPermission(false);
queue.service.permissionsChanged();
assert.equal(queue.service.getStatus().ready, false, 'permission removal suspends synchronously');
queue.service.beginMutation();
await queue.service.endMutation();
assert.equal(queue.service.getStatus().permissionGranted, false);
queue.service.fail(new Error('startup recovery failed'));
queue.setPermission(true);
queue.service.beginMutation();
await queue.service.endMutation();
assert.equal(queue.service.getStatus().ready, false, 'startup recovery failure remains unavailable');

const badSnapshot = harness();
badSnapshot.setData({ error: 'native firewall recovery pending' });
await badSnapshot.service.initialize();
assert.equal(badSnapshot.service.getStatus().state, 'error');
const badPSL = harness();
badPSL.commit();
badPSL.setData({ domainFromHostname: () => { throw new Error('PSL failure'); } });
await badPSL.service.initialize();
assert.deepEqual(badPSL.request(), {}, 'request evaluation exceptions fail open');

const background = (await readFile(new URL('../platform/mv3/extension/js/background.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
assert.match(background, /permissions\.onRemoved\.addListener\([^]*?webRequestFirewall\.permissionsChanged\(\)/);
const globalQueue = harness();
globalQueue.commit();
await globalQueue.service.initialize();
const context = vm.createContext({ pendingFilteringMutation: Promise.resolve(),
    webRequestFirewall: globalQueue.service });
const start = background.indexOf('function enqueueFilteringMutation(');
const end = background.indexOf('\n}\n', start) + 3;
assert.ok(start >= 0 && end > start);
vm.runInContext(background.slice(start, end), context);
const learningGate = deferred();
const configurationGate = deferred();
const learned = context.enqueueFilteringMutation(() => learningGate.promise, false);
assert.deepEqual(globalQueue.request(), { cancel: true },
    'domain learning only changes DNR partitions; current firewall policy stays usable during its native update');
let configurationStarted = false;
const configured = context.enqueueFilteringMutation(async () => {
    configurationStarted = true;
    await configurationGate.promise;
    globalQueue.setData({ text: '* * * allow' });
});
assert.deepEqual(globalQueue.request(), {}, 'queuing a real configuration edit suspends immediately even behind domain learning');
assert.equal(configurationStarted, false);
learningGate.resolve();
await learned;
assert.deepEqual(globalQueue.request(), {}, 'completion of domain learning cannot rearm a pending configuration edit');
configurationGate.resolve();
await configured;
assert.equal(globalQueue.service.getStatus().ready, true);
assert.deepEqual(globalQueue.request(), {}, 'last committed configuration becomes active after the queue settles');
console.log('Optional synchronous webRequest firewall: permission, PSL, modes, provenance, mutation and recovery checks passed');
