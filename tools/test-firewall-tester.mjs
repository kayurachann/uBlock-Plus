/* uBlock Plus+ - draft tester decisions and read-only authority. GPL-3.0-or-later. */
import { explainFirewallRequest, requestHostname } from '../platform/mv3/extension/js/firewall-tester.js';
import assert from 'node:assert/strict';
import { createFirewallManager } from '../platform/mv3/extension/js/firewall-manager.js';
import psl from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

psl.parse(JSON.parse(await readFile(new URL(
    '../platform/mv3/extension/firewall-public-suffix.json', import.meta.url
), 'utf8')).text, name => new URL(`https://${name}`).hostname);
const domain = host => host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) ||
    host.includes('.') === false ? host : psl.getDomain(host);
const modes = { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] };
const input = { text: '* * 3p-script block', source: 'https://example.com/private?q=secret',
    destination: 'https://ads.net/script.js?token=private', type: 'script' };
const explain = (changes = {}, mode = modes) =>
    explainFirewallRequest({ ...input, ...changes }, mode, domain);
const blocked = explain();
assert.equal(blocked.action, 'block');
assert.equal(blocked.rule, '* * 3p-script block');
assert.equal(blocked.scope, 'draft');
assert.equal(blocked.source, 'example.com');
assert.equal(blocked.destination, 'ads.net');
assert.equal(blocked.thirdParty, true);
assert.doesNotMatch(JSON.stringify(blocked), /private|secret|token|https/);
assert.equal(explain({ destination: 'cdn.example.com' }).action, 'no-match');
assert.equal(explain({ source: 'alice.github.io', destination: 'bob.github.io' }).thirdParty, true);
assert.equal(explain({ source: 'alice.github.io', destination: 'cdn.alice.github.io' }).thirdParty, false);
assert.equal(explain({ source: '[::1]', destination: '[::1]' }).thirdParty, false);
assert.equal(explain({ source: '127.0.0.1', destination: '127.0.0.2' }).thirdParty, true);
assert.equal(explain({ source: 'co.uk' }).reason, 'party-unavailable');
for ( const action of [ 'noop', 'allow' ] ) {
    assert.equal(explain({ text: `* * 3p-script block\nexample.com ads.net * ${action}` }).action, action);
}
assert.equal(explain({ source: 'child.example.com' }, { ...modes, none: [ 'example.com' ] }).action, 'off');
assert.equal(explain({}, { none: [ 'all-urls' ], basic: [], optimal: [ 'example.com' ], complete: [] }).action,
    'block', 'Explicit active scopes override global Off');
assert.equal(explain({}, null).action, 'unknown');
assert.equal(explain({}, { ...modes, none: [ null ] }).action, 'unknown');
assert.equal(explain({ source: 'a', text: '* * * block\na * * noop' }).action, 'noop');
assert.equal(requestHostname(' HTTPS://BÜCHER.example/path?token=private '), 'xn--bcher-kva.example');
for ( const source of [ '', '*', 'chrome://flags', 'file:///tmp/a', 'javascript:alert(1)',
    'https://user:secret@example.com/', 'example.com:443', 'a'.repeat(4097) ] ) {
    assert.throws(() => explain({ source }));
}
assert.throws(() => explain({ type: 'main_frame' }), /subresource/);
assert.throws(() => explain({ type: 'inline-script' }), /subresource/);
assert.throws(() => explain({ text: '* * inline-script block' }), /Line/);

// Manager simulation neither queries tabs/native rules nor changes session,
// permanent state or storage, including when a tested draft differs from active.
let resolverLoads = 0;
const mutation = () => { throw new Error('Tester attempted mutation or native rule query'); };
const manager = createFirewallManager({
    dnr: { getSessionRules: mutation, updateSessionRules: mutation },
    localRead: mutation, localWrite: mutation, sessionRead: mutation,
    sessionWrite: mutation, sessionRemove: mutation, getTabs: mutation,
    getModes: async () => structuredClone(modes),
    loadDomainResolver: async () => { resolverLoads++; return domain; },
});
const before = manager.getState();
assert.deepEqual(await manager.testRequest(input), blocked);
assert.equal((await manager.testRequest({ ...input, text: '* * * noop' })).action, 'noop');
assert.equal(resolverLoads, 1, 'PSL helper is reused');
assert.deepEqual(manager.getState(), before);

// Exercise the real background handler's extension-page boundary. No filtering
// mutation queue is supplied: a tester entering it would fail this test.
const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const start = background.indexOf('async function onMessage(');
const end = background.indexOf('function onCommand(', start);
assert.ok(start !== -1 && end > start);
let tests = 0;
const origin = 'chrome-extension://test';
const context = vm.createContext({
    isFullyInitialized: Promise.resolve(),
    UBLOCK_PLUS_ORIGIN: origin, runtime: { id: 'test' },
    firewall: { testRequest: async () => { tests++; return 'tested'; } },
});
vm.runInContext(background.slice(start, end), context);
for ( const sender of [ {}, { id: 'test', url: 'https://example.com/' },
    { id: 'other', origin, url: `${origin}/dashboard.html` },
    { id: 'test', origin: 'https://example.com', url: `${origin}/dashboard.html` },
    { id: 'test', url: `${origin}.attacker/dashboard.html` },
] ) {
    assert.equal(await context.onMessage({ what: 'testFirewallRequest' }, sender), undefined);
}
assert.equal(tests, 0);
assert.equal(await context.onMessage({ what: 'testFirewallRequest' },
    { id: 'test', origin, url: `${origin}/dashboard.html` }), 'tested');
assert.equal(tests, 1);
console.log('Draft firewall tester: precedence, PSL, Off, privacy, read-only manager and message authority passed.');
