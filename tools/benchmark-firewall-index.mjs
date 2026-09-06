/* uBlock Plus+ - deterministic firewall microbenchmark. GPL-3.0-or-later.
 * Run with the release Node version; JSON reports matching time, not browser RAM.
 * Timings are observations and never a correctness-test threshold.
 */
import { evaluateFirewall, parseFirewall } from '../platform/mv3/extension/js/firewall-core.js';
import assert from 'node:assert/strict';
import { createFirewallIndex } from '../platform/mv3/extension/js/firewall-index.js';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const report = {
    node: process.version, platform: process.platform, architecture: process.arch,
    seed: 73129, samples: 9, lookupsPerSample: 102400,
    description: 'Same seeded hits/misses; alternating measurement order; median elapsed matching time. Excludes index construction, native Chrome and network latency.',
    cases: [],
};
let seed = report.seed;
const random = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
const hosts = [
    '*', 'example.com', 'child.example.com', 'ads.net', 'deep.ads.net',
    ...Array.from({ length: 16 }, (_, i) => `host${i}.test`),
];
const types = [ '*', 'image', '3p', '3p-script', '1p-script', '3p-frame' ];
const requestTypes = [ 'script', 'image', 'sub_frame', 'object', 'font', 'xmlhttprequest' ];
const actions = [ 'block', 'allow', 'noop' ];
const median = values => [ ...values ].sort((a, b) => a - b)[values.length >>> 1];

for ( const count of [ 0, 1, 16, 64, 256 ] ) {
    const cells = new Map();
    if ( count !== 0 ) { cells.set('* ads.net *', 'block'); }
    while ( cells.size < count ) {
        const source = hosts[random(hosts.length)];
        const destination = random(3) === 0 ? '*' : hosts[random(hosts.length)];
        const type = destination === '*' ? types[random(types.length)] : '*';
        if ( source === '*' && destination === '*' && type === '*' ) { continue; }
        cells.set(`${source} ${destination} ${type}`, actions[random(actions.length)]);
    }
    const { rules } = parseFirewall([ ...cells ].map(([ key, action ]) =>
        `${key} ${action}`).join('\n'));
    const started = performance.now();
    const index = createFirewallIndex(rules);
    const constructionMs = performance.now() - started;
    const workload = Array.from({ length: 2048 }, (_, i) => {
        if ( i % 4 === 0 ) {
            return [ `unseen-${i}.invalid`, `tracker-${i}.invalid`, 'font', false ];
        }
        if ( i % 4 === 1 ) {
            return [ 'example.com', 'deep.ads.net', 'script', true ];
        }
        return [ hosts[random(hosts.length)], hosts[random(hosts.length)],
            requestTypes[random(requestTypes.length)], random(2) === 1 ];
    });
    const reference = evaluateFirewall.bind(undefined, rules);
    let matched = 0;
    for ( const request of workload ) {
        const expected = reference(...request);
        assert.deepEqual(index.evaluate(...request), expected);
        if ( expected !== undefined ) { matched++; }
    }
    const run = (evaluate, repeats) => {
        let checksum = 0;
        const start = performance.now();
        for ( let n = 0; n < repeats; n++ ) {
            for ( const request of workload ) {
                const decision = evaluate(...request);
                if ( decision !== undefined ) { checksum += decision.raw.length; }
            }
        }
        return { ms: performance.now() - start, checksum };
    };
    run(reference, 50);
    run(index.evaluate, 50);
    const before = [], after = [];
    for ( let sample = 0; sample < report.samples; sample++ ) {
        let referenceResult, indexedResult;
        if ( sample % 2 === 0 ) {
            referenceResult = run(reference, 50);
            indexedResult = run(index.evaluate, 50);
        } else {
            indexedResult = run(index.evaluate, 50);
            referenceResult = run(reference, 50);
        }
        assert.equal(indexedResult.checksum, referenceResult.checksum);
        before.push(referenceResult.ms);
        after.push(indexedResult.ms);
    }
    const referenceMedianMs = median(before);
    const indexedMedianMs = median(after);
    report.cases.push({
        ruleCount: count, matchedRequests: matched, totalDistinctRequests: workload.length,
        constructionMs, referenceMedianMs, indexedMedianMs,
        speedup: referenceMedianMs / indexedMedianMs,
        referenceSamplesMs: before, indexedSamplesMs: after,
    });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
