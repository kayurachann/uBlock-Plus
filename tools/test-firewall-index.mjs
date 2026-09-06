/* uBlock Plus+ - indexed firewall differential tests. GPL-3.0-or-later. */
import { evaluateFirewall, parseFirewall, within } from '../platform/mv3/extension/js/firewall-core.js';
import DynamicHostRuleFiltering from '../src/js/dynamic-net-filtering.js';
import assert from 'node:assert/strict';
import { createFirewallIndex } from '../platform/mv3/extension/js/firewall-index.js';
import { domainFromHostname } from '../src/js/uri-utils.js';
import psl from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFile } from 'node:fs/promises';

psl.parse(JSON.parse(await readFile(new URL(
    '../platform/mv3/extension/firewall-public-suffix.json', import.meta.url
), 'utf8')).text, name => new URL(`https://${name}`).hostname);

const actions = [ 'block', 'allow', 'noop' ];
const resourceTypes = [
    'script', 'image', 'sub_frame', 'object', 'font', 'xmlhttprequest',
    'stylesheet', 'ping', 'media', 'websocket', 'other',
];
const party = (source, destination) => source !== '*' && source !== '' &&
    destination !== '*' && !within(destination, domainFromHostname(source) || source);
let comparisons = 0;
let upstreamComparisons = 0;
const compare = (text, sources, destinations, upstream = true) => {
    const { rules, text: canonicalText } = parseFirewall(text);
    const index = createFirewallIndex(rules);
    const oracle = new DynamicHostRuleFiltering();
    oracle.fromString(canonicalText);
    assert.equal(index.ruleCount, rules.length);
    for ( const source of sources ) {
        for ( const destination of destinations ) {
            for ( const type of resourceTypes ) {
                // The compiler evaluates both party possibilities for unknown
                // scopes, so compare both independently of PSL classification.
                for ( const thirdParty of [ false, true ] ) {
                    assert.deepEqual(index.evaluate(source, destination, type, thirdParty),
                        evaluateFirewall(rules, source, destination, type, thirdParty),
                        `${text}\n${source} -> ${destination} ${type} third-party=${thirdParty}`);
                    comparisons++;
                }
                if ( upstream === false || destination === '' ) { continue; }
                oracle.evaluateCellZY(source, destination, type);
                assert.equal(index.evaluate(source, destination, type,
                    party(source, destination))?.raw, oracle.toLogData()?.raw,
                    `Full uBO provenance: ${text}\n${source} -> ${destination} ${type}`);
                upstreamComparisons++;
            }
        }
    }
};

const hosts = [
    '*', 'example.com', 'child.example.com', 'deep.child.example.com',
    'otherexample.com', 'example.com.evil', 'alice.github.io', 'bob.github.io',
    'bücher.example', 'xn--bcher-kva.example', 'cdn.xn--bcher-kva.example',
    '192.0.2.1', '192.0.2.10', '[::1]', '[2001:db8::1]', '[::ffff:c000:201]',
];
for ( const text of [
    '', '* * * block', '* * 3p-script noop\n* * * block',
    '* * 3p allow\nexample.com * image block\n* * * noop',
    '* * 3p-frame block\nexample.com * * noop',
    '* ads.net * block\nexample.com ads.net * noop\n* deep.ads.net * allow',
    '* example.com * noop\nchild.example.com * * block\n* child.example.com * allow',
    'BÜCHER.example * * noop\n* bücher.example * allow\n* * * block',
    '192.0.2.1 * * block\n* 192.0.2.10 * noop\n* * 3p-script allow',
    '[::1] * * block\n* [::1] * noop\n[2001:db8::1] [::1] * allow',
    '[::ffff:192.0.2.1] * 1p-script allow\n* * 3p block',
] ) {
    // Rules and URL-derived request hosts use the same IDN canonical form.
    compare(text, hosts.filter(h => h !== 'bücher.example'),
        [ ...hosts.filter(h => h !== 'bücher.example'), 'ads.net', 'deep.ads.net' ]);
}

// A one-character hostname is more specific than '*', regardless of line
// order. Length-only sorting previously let a wildcard shadow these cells.
for ( const cells of [
    [ '* * * block', 'a * * noop' ],
    [ '* * 3p-script block', 'a * 3p-script allow' ],
    [ '* ads.net * block', 'a ads.net * noop' ],
] ) {
    for ( const order of [ cells, [ ...cells ].reverse() ] ) {
        compare(order.join('\n'), [ 'a', 'child.a', '*' ], [ 'ads.net', 'a', '*' ]);
    }
}

// Deterministic, overlapping 256-cell tables exercise misses, inheritance,
// terminal noop, every supported type, and provenance rather than action only.
let seed = 54321;
const random = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
const ruleHosts = [
    '*', 'example.com', 'child.example.com', 'ads.net', 'deep.ads.net',
    'other.net', 'alice.github.io', 'xn--bcher-kva.example',
    '[::1]', '[2001:db8::1]', '192.0.2.1',
    ...Array.from({ length: 16 }, (_, i) => `host${i}.test`),
];
const cellTypes = [ '*', 'image', '3p', '3p-script', '1p-script', '3p-frame' ];
for ( let trial = 0; trial < 12; trial++ ) {
    const cells = new Map();
    while ( cells.size < 256 ) {
        const source = ruleHosts[random(ruleHosts.length)];
        const destination = random(3) === 0 ? '*' : ruleHosts[random(ruleHosts.length)];
        const type = destination === '*' ? cellTypes[random(cellTypes.length)] : '*';
        cells.set(`${source} ${destination} ${type}`, actions[random(actions.length)]);
    }
    const text = [ ...cells ].map(([ cell, action ]) => `${cell} ${action}`).join('\n');
    compare(text, [ ...ruleHosts, 'unseen.invalid', 'cdn.child.example.com' ],
        [ ...ruleHosts, 'otherexample.com', 'ads.net.evil', 'unseen.invalid' ]);
}

// The factory owns its snapshot; draft edits, returned decisions and property
// writes cannot modify subsequent decisions. No request hostname is retained.
const input = parseFirewall('* * * block\nexample.com * * noop').rules;
const snapshot = createFirewallIndex(input);
const decision = snapshot.evaluate('example.com', 'ads.net', 'script', true);
assert.ok(Object.isFrozen(snapshot));
assert.ok(Object.isFrozen(decision));
assert.notEqual(decision, input[1]);
assert.throws(() => { decision.action = 'block'; }, TypeError);
assert.throws(() => { snapshot.ruleCount = 1000; }, TypeError);
input[1].action = 'allow';
input[1].raw = 'changed';
input.reverse();
input.length = 0;
assert.equal(snapshot.ruleCount, 2);
assert.equal(snapshot.evaluate('example.com', 'ads.net', 'script', true).raw,
    'example.com * * noop');
for ( let i = 0; i < 10000; i++ ) {
    assert.equal(snapshot.evaluate(`unique-${i}.invalid`, `tracker-${i}.invalid`,
        'script', true).action, 'block');
}
assert.deepEqual(Object.keys(snapshot), [ 'ruleCount', 'evaluate' ]);
assert.equal(snapshot.ruleCount, 2);
assert.throws(() => createFirewallIndex(Array(257).fill({})), /256/);
assert.throws(() => createFirewallIndex(null), /parsed/);
const duplicate = parseFirewall('* * * block').rules[0];
assert.throws(() => createFirewallIndex([ duplicate, duplicate ]), /Duplicate/);

console.log(`Firewall index: ${comparisons} reference and ${upstreamComparisons} full-uBO provenance comparisons; 256-cell, immutable snapshot and hostname regressions passed`);
