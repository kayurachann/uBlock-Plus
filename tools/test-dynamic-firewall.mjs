/* uBlock Plus+ - differential firewall and lifecycle regressions. GPL-3.0-or-later. */
import {
    FIREWALL_RULE_BASE,
    compileFirewall,
    evaluateFirewall,
    parseFirewall,
    within,
} from '../platform/mv3/extension/js/firewall-core.js';
import DynamicHostRuleFiltering from '../src/js/dynamic-net-filtering.js';
import assert from 'node:assert/strict';
import { createFirewallManager } from '../platform/mv3/extension/js/firewall-manager.js';
import psl from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFile } from 'node:fs/promises';

psl.parse(JSON.parse(await readFile(new URL(
    '../platform/mv3/extension/firewall-public-suffix.json', import.meta.url
), 'utf8')).text, name => new URL(`https://${name}`).hostname);
const domainFromHostname = name => name.startsWith('[') ? name : psl.getDomain(name) || '';
const modes = { none: [], basic: [], optimal: [ 'all-urls' ], complete: [] };
const background = await readFile(new URL('../platform/mv3/extension/js/background.js', import.meta.url), 'utf8');
assert.doesNotMatch(background, /\bimport\s*\(/,
    'Chrome module service workers require static imports, including the PSL resolver');
const nativeDecision = (plan, source, destination, type) => {
    const matches = plan.rules.filter(({ condition: c }) =>
        (!c.topDomains || c.topDomains.some(h => within(source, h))) &&
        !c.excludedTopDomains?.some(h => within(source, h)) &&
        (!c.requestDomains || c.requestDomains.some(h => within(destination, h))) &&
        !c.excludedRequestDomains?.some(h => within(destination, h)) &&
        c.resourceTypes.includes(type)
    );
    assert.ok(matches.length <= 1, 'Native cells must be disjoint');
    return matches[0]?.action.type || 'noop';
};
const compile = (text, options = {}) => compileFirewall({
    ...parseFirewall(text), modes, domains: [ 'example.com', 'other.net', 'alice.github.io' ],
    domainFromHostname, ...options,
});

for ( const text of [
    '* * inline-script block', '* ads.example image block',
    'example.com:8080 * * allow', 'https://example.com * * block',
    '* * * block\n* * * noop', '*.example.com * * block', '* * * BLOCK',
    'example.com * * allow broken', '::1 * * block',
    '[::1]:443 * * block', '[fe80::1%eth0] * * block', '[fe80::1%25eth0] * * block',
    '[::1 * * block', '[:::1] * * block', '[127.0.0.1] * * block',
    '[::1]/ * * block', '[::1] * * allow\n[0:0:0:0:0:0:0:1] * * block',
] ) { assert.throws(() => parseFirewall(text), /Line/); }
assert.equal(parseFirewall('BÜCHER.example * * noop').text, 'xn--bcher-kva.example * * noop');
assert.equal(parseFirewall('[2001:0DB8:0000:0000:0000:0000:0000:0001] [0:0:0:0:0:0:0:1] * noop').text,
    '[2001:db8::1] [::1] * noop');
assert.equal(parseFirewall('[::ffff:192.0.2.1] * 3p-script block').text,
    '[::ffff:c000:201] * 3p-script block');
assert.equal(domainFromHostname('a.b.co.uk'), 'b.co.uk');
assert.equal(domainFromHostname('alice.github.io'), 'alice.github.io');
assert.equal(domainFromHostname('co.uk'), '');

const noopPlan = compile('* * * block\nexample.com * * noop');
assert.equal(nativeDecision(noopPlan, 'example.com', 'ads.net', 'image'), 'noop');
assert.equal(nativeDecision(noopPlan, 'other.net', 'ads.net', 'image'), 'block');
assert.equal(noopPlan.rules.some(rule => rule.action.type === 'allow'), false);
// Since noop emits no matching native rule, static blocks and static allows
// retain their ordinary outcomes instead of being overridden by an allow.
const inherited = compile('* ads.net * block\nexample.com ads.net * noop\n* deep.ads.net * allow');
assert.equal(nativeDecision(inherited, 'example.com', 'ads.net', 'script'), 'noop');
assert.equal(nativeDecision(inherited, 'example.com', 'deep.ads.net', 'script'), 'allow');
assert.equal(nativeDecision(inherited, 'unseen.org', 'ads.net', 'script'), 'block');
assert.throws(() => compile('* * * block', { maximum: 0 }), /available native rules/);
const unknown = compile('* * 3p-script noop\n* * * block', { domains: [] });
assert.equal(nativeDecision(unknown, 'new.org', 'ads.net', 'script'), 'noop');
assert.ok(unknown.deferredCells > 0, 'Unknown party scope never falls through to a broader block');
const largeModes = { ...modes,
    none: Array.from({ length: 100000 }, (_, index) => `off-${index}.example`),
};
assert.deepEqual(compile('', { modes: largeModes }),
    { rules: [], provenance: {}, deferredCells: 0 },
    'Existing large Site Rules imports cannot make a disabled firewall expand partitions');
assert.throws(() => compile('* * * block', { modes: largeModes }), /partition budget/,
    'An active firewall rejects oversized source partitions before expanding them');

// Independent oracle: the full uBO engine present in this repository.
let seed = 17;
const random = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
const sources = [ '*', 'example.com', 'child.example.com', 'other.net', 'alice.github.io' ];
const destinations = [ '*', 'ads.net', 'deep.ads.net', 'example.com', 'alice.github.io' ];
const types = [ '*', 'image', '3p', '3p-script', '1p-script', '3p-frame' ];
const actions = [ 'block', 'allow', 'noop' ];
let comparisons = 0;
for ( let trial = 0; trial < 80; trial++ ) {
    const entries = new Map();
    for ( let n = 0; n < 14; n++ ) {
        const source = sources[random(sources.length)];
        const destination = destinations[random(destinations.length)];
        const type = destination === '*' ? types[random(types.length)] : '*';
        entries.set(`${source} ${destination} ${type}`, actions[random(3)]);
    }
    const text = [ ...entries ].map(([ key, action ]) => `${key} ${action}`).join('\n');
    const oracle = new DynamicHostRuleFiltering(); oracle.fromString(text);
    const plan = compile(text);
    for ( const source of [ 'example.com', 'child.example.com', 'other.net', 'alice.github.io' ] ) {
        for ( const destination of [ 'example.com', 'cdn.example.com', 'ads.net', 'deep.ads.net', 'alice.github.io', 'bob.github.io' ] ) {
            for ( const type of [ 'script', 'image', 'sub_frame', 'object', 'font' ] ) {
                const expected = [ 'noop', 'block', 'allow', 'noop' ][oracle.evaluateCellZY(source, destination, type)];
                assert.equal(nativeDecision(plan, source, destination, type), expected,
                    `${text}\nRequest: ${source} -> ${destination} ${type}`);
                comparisons++;
            }
        }
    }
}
const ipv6Domains = [ '[::1]', '[2001:db8::1]', '[::ffff:c000:201]', 'example.com' ];
for ( const text of [
    '* * 3p-script block\n* * 1p-script allow',
    '[::1] * 3p block\n[::1] * 1p-script allow',
    '* [::1] * block\n[2001:db8::1] [::1] * noop\n* * * allow',
    '[::1] * * block\n[::1] [::1] * noop',
    '[2001:db8::1] * 3p-frame block\n* * image allow',
    '[::ffff:c000:201] * 3p block\n* [::ffff:c000:201] * allow',
] ) {
    const oracle = new DynamicHostRuleFiltering(); oracle.fromString(text);
    const plan = compile(text, { domains: ipv6Domains });
    for ( const source of [ ...ipv6Domains, 'child.example.com' ] ) {
        for ( const destination of [ ...ipv6Domains, 'cdn.example.com', 'ads.net' ] ) {
            for ( const type of [ 'script', 'image', 'sub_frame', 'object', 'font' ] ) {
                const expected = [ 'noop', 'block', 'allow', 'noop' ][oracle.evaluateCellZY(source, destination, type)];
                assert.equal(nativeDecision(plan, source, destination, type), expected,
                    `${text}\nIPv6 request: ${source} -> ${destination} ${type}`);
                comparisons++;
            }
        }
    }
}
const ipv6Off = compile('* * * block', { domains: ipv6Domains,
    modes: { ...modes, none: [ '[::1]' ] },
});
assert.equal(nativeDecision(ipv6Off, '[::1]', 'ads.net', 'script'), 'noop');
assert.equal(nativeDecision(ipv6Off, '[2001:db8::1]', '[::1]', 'script'), 'block');
const onlyIpv6 = compile('* * * block', { domains: ipv6Domains,
    modes: { none: [ 'all-urls' ], basic: [], optimal: [ '[::1]' ], complete: [] },
});
assert.equal(nativeDecision(onlyIpv6, '[::1]', 'ads.net', 'script'), 'block');
assert.equal(nativeDecision(onlyIpv6, '[2001:db8::1]', '[::1]', 'script'), 'noop');
assert.equal(nativeDecision(onlyIpv6, 'example.com', '[::1]', 'script'), 'noop');
const off = compile('* * * block', { modes: {
    none: [ 'all-urls' ], basic: [], optimal: [ 'example.com' ], complete: [],
} });
assert.equal(nativeDecision(off, 'example.com', 'ads.net', 'script'), 'block');
assert.equal(nativeDecision(off, 'other.net', 'ads.net', 'script'), 'noop');

const local = new Map(), session = new Map();
let sessionRules = [ { id: 42, action: { type: 'allow' }, condition: {} } ];
let rejectNative = false, rejectStorage = '';
let openTabs = [ { url: 'https://example.com/' } ];
const deps = {
    dnr: {
        RuleConditionKeys: { TOP_DOMAINS: 'topDomains' }, MAX_NUMBER_OF_SESSION_RULES: 5000,
        getSessionRules: async () => structuredClone(sessionRules),
        async updateSessionRules({ removeRuleIds, addRules }) {
            if ( rejectNative ) { throw new Error('native quota rejection'); }
            sessionRules = sessionRules.filter(r => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
        },
    },
    localRead: async key => local.get(key),
    localWrite: async (key, value) => {
        if ( rejectStorage === key ) { rejectStorage = ''; throw new Error('storage failure'); }
        local.set(key, value);
    },
    sessionRead: async key => structuredClone(session.get(key)),
    sessionWrite: async (key, value) => { session.set(key, structuredClone(value)); },
    sessionRemove: async key => session.delete(key),
    getModes: async () => modes, getTabs: async () => openTabs,
    loadDomainResolver: async () => domainFromHostname,
};
let manager = createFirewallManager(deps);
await manager.initialize();
await manager.apply('* * 3p-script block', true);
assert.ok(manager.getState().ruleCount > 0);
assert.ok(sessionRules.some(rule => rule.id === 42), 'Other session-rule owners survive');
openTabs.push({ url: 'https://new.org/' });
const beforePreview = structuredClone(sessionRules);
const learnedBeforePreview = manager.getState().learnedDomains;
await manager.preview('* * 3p-script block');
assert.deepEqual(sessionRules, beforePreview, 'Preview never activates rules');
assert.equal(manager.getState().learnedDomains, learnedBeforePreview, 'Preview cannot claim native coverage');
await manager.observe('https://new.org/');
assert.equal(nativeDecision({ rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) },
    'new.org', 'ads.net', 'script'), 'block', 'Navigation after preview still activates its party scope');
const previous = structuredClone(sessionRules);
rejectNative = true;
await assert.rejects(manager.apply('* * * block'), /native quota/);
rejectNative = false;
assert.deepEqual(sessionRules, previous);
assert.equal(manager.getState().sessionText, '* * 3p-script block');
rejectStorage = 'firewall.permanent';
await assert.rejects(manager.apply('* * * block', true), /storage failure/);
assert.deepEqual(sessionRules, previous);
await manager.apply('example.com * * noop');
assert.equal(manager.getState().temporary, true);
manager = createFirewallManager(deps); await manager.initialize();
assert.equal(manager.getState().sessionText, 'example.com * * noop', 'Worker restart retains temporary rules');
session.delete('firewall.session');
manager = createFirewallManager(deps); await manager.initialize();
assert.equal(manager.getState().sessionText, '* * 3p-script block', 'Browser restart restores permanent rules');
session.set('firewall.pending', { permanentText: '* * image block', sessionText: '* * image block' });
manager = createFirewallManager(deps); await manager.initialize();
assert.equal(manager.getState().sessionText, '* * image block', 'Interrupted transaction restores previous config');
assert.equal(session.has('firewall.pending'), false);
// IPv6 observed in tabs and navigations is its own party scope, including
// canonicalized mapped addresses; it is never looked up as a DNS suffix.
openTabs = [ { url: 'http://[::1]/' } ];
await manager.apply('* * 3p-script block\n* * 1p-script allow');
let active = { rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) };
assert.equal(nativeDecision(active, '[::1]', '[::1]', 'script'), 'allow');
assert.equal(nativeDecision(active, '[::1]', '[2001:db8::1]', 'script'), 'block');
assert.equal(nativeDecision(active, '[::1]', 'example.com', 'script'), 'block');
await manager.observe('https://[::ffff:192.0.2.1]/');
active = { rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) };
assert.equal(nativeDecision(active, '[::ffff:c000:201]', '[::ffff:c000:201]', 'script'), 'allow');
assert.equal(nativeDecision(active, '[::ffff:c000:201]', '[::1]', 'script'), 'block');
assert.ok(active.rules.some(rule => rule.condition.topDomains?.includes('[::ffff:c000:201]')));
await manager.apply('', true);
assert.equal(sessionRules.some(rule => rule.id >= FIREWALL_RULE_BASE), false);
deps.dnr.RuleConditionKeys = undefined;
manager = createFirewallManager(deps); await manager.initialize();
await assert.rejects(manager.apply('* * * block'), /Chrome 145/);
deps.dnr.RuleConditionKeys = { TOP_DOMAINS: 'topDomains' };

// Learned domains and Site-rules hosts add native rules only where their
// decision differs from the enclosing scope, so the budget does not scale
// with (domains x destination cells).
const hostnameCells = Array.from({ length: 64 }, (_, i) => `* ad${i}.net * block`).join('\n');
const manyDomains = Array.from({ length: 128 }, (_, i) => `site${i}.com`);
const scaled = compile(hostnameCells, { domains: manyDomains });
assert.equal(scaled.rules.length, 64, 'Party-independent cells are emitted once');
const partyCells = '* * 3p-script block\n* * 3p-frame block\n' +
    Array.from({ length: 60 }, (_, i) => `* tracker${i}.example * block`).join('\n');
const partyScaled = compile(partyCells, { domains: manyDomains });
assert.ok(partyScaled.rules.length <= 60 + 2 * 128, 'Each learned domain adds only its party cells');
for ( const [ plan, text ] of [ [ scaled, hostnameCells ], [ partyScaled, partyCells ] ] ) {
    const rules = parseFirewall(text).rules;
    for ( const source of [ 'www.site3.com', 'site127.com', 'unseen.net' ] ) {
        const domain = domainFromHostname(source);
        const decide = (destination, type, thirdParty) =>
            evaluateFirewall(rules, source, destination, type, thirdParty)?.action ?? 'noop';
        for ( const destination of [ 'tracker7.example', 'ad9.net', 'cdn.other.net', domain ] ) {
            for ( const type of [ 'script', 'sub_frame', 'image' ] ) {
                const thirdParty = decide(destination, type, true);
                const expected = manyDomains.includes(domain)
                    ? decide(destination, type, within(destination, domain) === false)
                    : thirdParty === decide(destination, type, false) ? thirdParty : 'noop';
                assert.equal(nativeDecision(plan, source, destination, type), expected,
                    `Scaled plan: ${source} -> ${destination} ${type}`);
            }
        }
    }
}
const modeScaled = compile(Array.from({ length: 41 }, (_, i) => `* dest${i}.net * block`).join('\n'), {
    modes: { ...modes, complete: Array.from({ length: 100 }, (_, i) => `mode${i}.example`) },
});
assert.equal(modeScaled.rules.length, 41, 'Site-rules hosts with inherited decisions add no rules');

const scopeDeps = { ...deps, dnr: { ...deps.dnr } };
sessionRules = [];
local.clear(); session.clear();
openTabs = Array.from({ length: 70 }, (_, i) => ({ url: `https://www.restored${i}.com/` }));
local.set('firewall.permanent', hostnameCells);
manager = createFirewallManager(scopeDeps);
await manager.initialize();
assert.equal(manager.getState().error, '', 'Browser restart with many tabs keeps the firewall active');
assert.equal(sessionRules.filter(rule => rule.id >= FIREWALL_RULE_BASE).length, 64);
assert.equal(manager.getState().learnedDomains, 70);

openTabs = [ { url: 'https://www.bank.example/' } ];
await manager.apply(partyCells);
for ( let i = 0; i < 140; i++ ) { await manager.observe(`http://10.0.0.${i}/`); }
await manager.observe('https://www.bank.example/');
await manager.observe('https://news.example.org/');
active = { rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) };
assert.ok(active.rules.some(rule => rule.condition.topDomains?.includes('example.org') &&
    rule.action.type === 'block' && rule.condition.resourceTypes.includes('script')),
'Learning never stalls after many visited sites');
assert.equal(nativeDecision(active, 'news.example.org', 'cdn.other.net', 'script'), 'block');
assert.equal(nativeDecision(active, 'www.bank.example', 'cdn.other.net', 'sub_frame'), 'block');
assert.ok(manager.getState().learnedDomains <= 128);
assert.deepEqual([ manager.getState().error, manager.getState().omittedDomains ], [ '', 0 ]);
await manager.refresh();

// When learned party scopes still exceed the native budget, the oldest are
// evicted first and open tabs and the observed page are kept longest.
const perSite = '* * 3p-script block\n' +
    Array.from({ length: 30 }, (_, i) => `blog.example ads${i}.net * block`).join('\n');
scopeDeps.dnr.MAX_NUMBER_OF_SESSION_RULES = 200;
let compiles = 0;
scopeDeps.compileFirewall = options => { compiles += 1; return compileFirewall(options); };
sessionRules = [];
openTabs = [ { url: 'https://first.example/' } ];
manager = createFirewallManager(scopeDeps);
await manager.initialize();
await manager.apply(perSite);
for ( let i = 0; i < 12; i++ ) { await manager.observe(`https://visit${i}.org/`); }
let state = manager.getState();
assert.equal(state.error, '');
assert.ok(state.omittedDomains > 0 && state.learnedDomains < 13, 'The learned scope shrinks to fit');
assert.ok(state.ruleCount <= 200);
active = { rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) };
for ( const source of [ 'first.example', 'visit11.org' ] ) {
    assert.equal(nativeDecision(active, source, 'ads3.net', 'script'), 'block',
        `${source} keeps its party scope`);
}
assert.equal(nativeDecision(active, 'visit0.org', 'ads3.net', 'script'), 'noop',
    'The oldest learned domain is evicted first and fails open');
// At saturation each new site displaces one old domain. That common case
// costs the failed full compile plus one retry, not a whole search.
for ( let i = 12; i < 20; i++ ) {
    compiles = 0;
    await manager.observe(`https://visit${i}.org/`);
    assert.ok(compiles > 0 && compiles <= 2, `Saturated learning compiled ${compiles} times`);
    assert.deepEqual([ manager.getState().learnedDomains, manager.getState().omittedDomains ],
        [ state.learnedDomains, 1 ], 'The largest fitting scope is still kept');
}
active = { rules: sessionRules.filter(r => r.id >= FIREWALL_RULE_BASE) };
assert.equal(nativeDecision(active, 'visit19.org', 'ads3.net', 'script'), 'block');
assert.equal(nativeDecision(active, 'first.example', 'ads3.net', 'script'), 'block');
const tooLarge = Array.from({ length: 250 }, (_, i) => `* big${i}.net * block`).join('\n');
const beforeOverflow = structuredClone(sessionRules);
await assert.rejects(manager.apply(tooLarge), /available native rules/);
assert.deepEqual(sessionRules, beforeOverflow, 'A configuration too large by itself keeps previous rules');

// A failed scope update is reported without marking the active firewall
// as failed, which would disable the synchronous supplement.
rejectNative = true;
await assert.rejects(manager.observe('https://late.example/'), /native quota/);
rejectNative = false;
state = manager.getState();
assert.equal(state.error, '');
assert.match(state.scopeError, /native quota/);
await manager.observe('https://later.example/');
assert.equal(manager.getState().scopeError, '', 'A later successful update clears the scope warning');
console.log(`Dynamic firewall: ${comparisons} full-uBO differential cases plus scope, noop, quota, rollback and restart regressions passed`);
