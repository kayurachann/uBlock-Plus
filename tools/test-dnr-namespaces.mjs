/* uBlock Plus+ - DNR rule-ID ranges and priority bands. GPL-3.0-or-later. */
//
// Every owner of dynamic or session rules and every priority band is declared
// once in dnr-namespaces.js. Overlapping ranges would let one owner remove or
// shadow another owner's rules (tmp/design/integrator/dnr-namespaces.mjs found
// two such collisions in the roadmap designs).

import * as ns from '../platform/mv3/extension/js/dnr-namespaces.js';
import {
    FIREWALL_PRIORITY,
    FIREWALL_RULE_BASE,
    FIREWALL_RULE_LIMIT,
} from '../platform/mv3/extension/js/firewall-core.js';
import assert from 'node:assert/strict';
import { dnrRulesetFromRawLists } from '../src/js/static-dnr-filtering.js';
import { readFile } from 'node:fs/promises';

const overlaps = list => {
    const out = [];
    for ( let i = 0; i < list.length; i++ ) {
        for ( let j = i + 1; j < list.length; j++ ) {
            const a = list[i], b = list[j];
            if ( a.min <= b.max && b.min <= a.max ) { out.push(`${a.owner} <-> ${b.owner}`); }
        }
    }
    return out;
};

// Ranges are well formed, frozen and pairwise disjoint within a namespace.
for ( const [ name, list, maximum ] of [
    [ 'dynamic', ns.DYNAMIC_RULE_ID_RANGES, ns.MAX_RULE_ID ],
    [ 'session', ns.SESSION_RULE_ID_RANGES, ns.MAX_RULE_ID ],
    [ 'priority', ns.PRIORITY_BANDS, ns.MAX_RULE_ID ],
] ) {
    assert.ok(Object.isFrozen(list), name);
    assert.ok(list.length > 0, name);
    const owners = new Set();
    for ( const entry of list ) {
        assert.ok(Object.isFrozen(entry), `${name} ${entry.owner}`);
        assert.match(entry.owner, /^[a-z][A-Za-z]+$/, name);
        assert.equal(owners.has(entry.owner), false, `${name}: duplicate ${entry.owner}`);
        owners.add(entry.owner);
        assert.ok(Number.isSafeInteger(entry.min) && Number.isSafeInteger(entry.max), entry.owner);
        assert.ok(entry.min >= 1 && entry.min <= entry.max && entry.max <= maximum, entry.owner);
        assert.equal(typeof entry.note, 'string');
    }
    assert.deepEqual(overlaps(list), [], `${name} ranges overlap`);
}

// The two collisions found by the integrator are resolved: site switches no
// longer share 6,000,000 with the engine profile, and the switch priority
// sits above the whole URL-rule band.
{
    const dynamic = new Map(ns.DYNAMIC_RULE_ID_RANGES.map(entry => [ entry.owner, entry ]));
    assert.ok(dynamic.get('siteSwitches').max < dynamic.get('engineProfile').min);
    assert.ok(ns.SITE_SWITCH_PRIORITY > ns.URL_RULE_PRIORITY_MAX);
    assert.ok(ns.LARGE_MEDIA_ALLOWANCE_PRIORITY > ns.SITE_SWITCH_PRIORITY);
    assert.ok(ns.TRUSTED_DIRECTIVE_PRIORITY > ns.LARGE_MEDIA_ALLOWANCE_PRIORITY);
    // Step 7's URL rule priority: 1,600,000 + depth x 2 x 1025 + typed x 1025
    // + URL length (at most 1,024); the depth is clamped.
    const urlPriority = (depth, typed, length) =>
        ns.URL_RULE_PRIORITY_MIN + depth * 2 * 1025 + (typed ? 1025 : 0) + length;
    assert.ok(urlPriority(ns.URL_RULE_MAX_DEPTH, true, 1024) <= ns.URL_RULE_PRIORITY_MAX);
    assert.ok(urlPriority(127, true, 1024) > ns.URL_RULE_PRIORITY_MAX,
        'an unclamped depth would leave the band');
}

// Owner lookup, at every boundary.
for ( const [ id, owner ] of [
    [ 1, 'stockRegexFallback' ], [ 4999999, 'stockRegexFallback' ],
    [ ns.SPECIAL_RULES_REALM, '' ], [ 5999999, '' ],
    [ 6000000, 'siteSwitches' ], [ 6000999, 'siteSwitches' ], [ 6001000, '' ],
    [ 6100000, 'engineProfile' ], [ 6199999, 'engineProfile' ], [ 6200000, '' ],
    [ 7000000, '' ], [ 8000000, 'trustedDirective' ], [ 8000001, '' ],
    [ 8999999, '' ], [ 9000000, 'user' ], [ 2 ** 31 - 1, 'user' ],
    [ 0, '' ], [ -1, '' ], [ 1.5, '' ], [ '1', '' ], [ undefined, '' ],
] ) {
    assert.equal(ns.dynamicRuleOwner(id), owner, `dynamic ${id}`);
    if ( typeof id === 'number' ) {
        assert.equal(ns.dynamicRuleOwner({ id }), owner, `dynamic { id: ${id} }`);
    }
}
for ( const [ id, owner ] of [
    [ 1, 'strictBlock' ], [ 826, 'strictBlock' ], [ 999999, 'strictBlock' ],
    [ 1000000, '' ], [ 6000000, '' ], [ 6001000, 'largeMedia' ],
    [ 6001063, 'largeMedia' ], [ 6001064, '' ], [ 7000000, 'firewall' ],
    [ 7049999, 'firewall' ], [ 7050000, 'urlRules' ], [ 7099999, 'urlRules' ],
    [ 7100000, '' ], [ 8000000, '' ], [ 8000001, 'trustedDirective' ],
    [ 9000000, '' ], [ 0, '' ],
] ) {
    assert.equal(ns.sessionRuleOwner(id), owner, `session ${id}`);
    assert.equal(ns.sessionRuleOwner({ id }), owner, `session { id: ${id} }`);
    assert.equal(ns.isStrictBlockSessionRule({ id }), owner === 'strictBlock', `${id}`);
}
assert.equal(ns.sessionRuleOwner(null), '');
assert.equal(ns.isStrictBlockSessionRule(null), false);
assert.equal(ns.isStockRegexFallbackRule({ id: 4999999 }), true);
assert.equal(ns.isStockRegexFallbackRule({ id: 5000000 }), false);
assert.equal(ns.isUserDynamicRule({ id: 9000000 }), true);
assert.equal(ns.isUserDynamicRule({ id: 8000000 }), false);

// Today's owners fit their registered ranges and bands.
{
    const firewall = ns.SESSION_RULE_ID_RANGES.find(entry => entry.owner === 'firewall');
    assert.ok(FIREWALL_RULE_BASE >= firewall.min);
    assert.ok(FIREWALL_RULE_BASE + FIREWALL_RULE_LIMIT - 1 <= firewall.max);
    assert.equal(FIREWALL_PRIORITY, ns.FIREWALL_PRIORITY);
    assert.equal(ns.priorityBand(FIREWALL_PRIORITY), 'firewall');
    // dnr.setAllowAllRules(id) writes dynamic id + 0 and session id + 1.
    assert.equal(ns.dynamicRuleOwner(ns.TRUSTED_DIRECTIVE_BASE_RULE_ID), 'trustedDirective');
    assert.equal(ns.sessionRuleOwner(ns.TRUSTED_DIRECTIVE_BASE_RULE_ID + 1), 'trustedDirective');
    assert.equal(ns.priorityBand(ns.TRUSTED_DIRECTIVE_PRIORITY), 'trustedDirective');
    // Literal copies still present in older modules must agree with the
    // registry until they import it.
    const sources = {
        'ruleset-manager.js': await readFile(new URL(
            '../platform/mv3/extension/js/ruleset-manager.js', import.meta.url), 'utf8'),
    };
    for ( const [ name, value ] of [
        [ 'SPECIAL_RULES_REALM', ns.SPECIAL_RULES_REALM ],
        [ 'USER_RULES_BASE_RULE_ID', ns.USER_RULES_BASE_RULE_ID ],
        [ 'USER_RULES_PRIORITY', ns.USER_RULES_PRIORITY ],
        [ 'TRUSTED_DIRECTIVE_BASE_RULE_ID', ns.TRUSTED_DIRECTIVE_BASE_RULE_ID ],
        [ 'STRICTBLOCK_PRIORITY', ns.STOCK_STRICTBLOCK_PRIORITY ],
    ] ) {
        for ( const [ file, text ] of Object.entries(sources) ) {
            const match = new RegExp(`\\bconst ${name} = (\\d+);`).exec(text);
            if ( match === null ) { continue; }
            assert.equal(Number(match[1]), value, `${file} ${name}`);
        }
    }
    assert.equal(ns.USER_RULES_PRIORITY + ns.USER_RULES_PRIORITY, ns.TRUSTED_DIRECTIVE_PRIORITY,
        'ruleset-manager derives the trusted priority from the user offset');
}

// Every priority the stock compiler emits lies in a stock band; imported
// lists use the same compiler priorities. Strict-block user redirects (one
// above their block) stay in the bands of their realm.
{
    const lines = [
        '||a.test^', '@@||b.test^', '||c.test^$important', '||d.test^$script,redirect=noop.js',
        '||e.test^$script,redirect=noop.js:5', '@@||f.test^$redirect-rule',
        '||g.test^$removeparam=x', '||h.test^$doc', '||i.test^$doc,important',
    ];
    const result = await dnrRulesetFromRawLists(
        [ { name: 'namespaces-test', text: [ '!#trusted on namespaces-test', ...lines ].join('\n') } ],
        { env: [ 'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol' ],
            extensionPaths: [ [ 'noop.js', '/web_accessible_resources/noop.js' ] ],
            secret: 'namespaces-test' }
    );
    const priorities = new Set(result.network.ruleset
        .filter(rule => rule._error === undefined)
        .map(rule => rule.priority ?? 1));
    for ( const priority of [ 1, 10, 30, 40, 11, 16 ] ) {
        assert.ok(priorities.has(priority), `fixture covers priority ${priority}`);
    }
    for ( const priority of priorities ) {
        assert.match(ns.priorityBand(priority), /^stock/, `priority ${priority}`);
    }
    for ( const block of [ ns.STOCK_BLOCK_PRIORITY, 40 ] ) {
        assert.match(ns.priorityBand(block + 1), /^stock/);
        assert.equal(ns.priorityBand(ns.USER_RULES_PRIORITY + block), 'user');
        assert.equal(ns.priorityBand(ns.USER_RULES_PRIORITY + block + 1), 'user');
    }
    assert.equal(ns.priorityBand(ns.STOCK_STRICTBLOCK_PRIORITY), 'stockExceptedRedirect');
    assert.equal(ns.priorityBand(ns.ENGINE_SUPPRESSION_PRIORITY), 'engineSuppression');
    assert.equal(ns.priorityBand(ns.USER_RULES_PRIORITY), '', 'user priorities start at +1');
}

// The single DNR mutation queue: strictly sequential, a failure reaches its
// caller and the reporter but never blocks later tasks.
{
    const events = [];
    const reported = [];
    ns.setDNRMutationErrorReporter(reason => reported.push(`${reason}`));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const first = ns.enqueueDNRMutation(async ( ) => {
        events.push('first:start');
        await delay(20);
        events.push('first:end');
        return 1;
    });
    const second = ns.enqueueDNRMutation(async ( ) => {
        events.push('second');
        throw new Error('quota');
    });
    const third = ns.enqueueDNRMutation(( ) => {
        events.push('third');
        return 3;
    });
    assert.equal(await first, 1);
    await assert.rejects(second, /quota/);
    assert.equal(await third, 3);
    assert.deepEqual(events, [ 'first:start', 'first:end', 'second', 'third' ]);
    assert.deepEqual(reported, [ 'Error: quota' ]);
    // A throwing reporter, or none, does not break the chain.
    ns.setDNRMutationErrorReporter(( ) => { throw new Error('reporter'); });
    await assert.rejects(ns.enqueueDNRMutation(( ) => { throw new Error('again'); }), /again/);
    ns.setDNRMutationErrorReporter('not a function');
    await assert.rejects(ns.enqueueDNRMutation(( ) => Promise.reject(new Error('silent'))), /silent/);
    assert.equal(await ns.enqueueDNRMutation(( ) => 'next'), 'next');
    assert.deepEqual(reported, [ 'Error: quota' ]);
}

console.log('dnr-namespaces: all tests passed');
