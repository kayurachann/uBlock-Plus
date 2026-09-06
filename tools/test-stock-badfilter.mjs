import {
    STOCK_BADFILTER_JOURNAL,
    STOCK_BADFILTER_STATE,
    createStockBadfilterManager,
    isStockBadfilterResidualGroup,
    selectStockBadfilterRules,
} from '../platform/mv3/extension/js/stock-badfilter.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const [ a, b, c, d, e ] = [ 'a', 'b', 'c', 'd', 'e' ].map(hash);
const corpus = [ {
    id: 'one', digest: hash('one'), deferredKeys: [ d ], rules: [
        { id: 1, keys: [ a ], complete: true },
        { id: 2, keys: [ b, c ], complete: true },
        { id: 3, keys: [ d ], complete: true },
        { id: 4, keys: [ e ], complete: true },
    ],
}, {
    id: 'two', digest: hash('two'), deferredKeys: [], rules: [
        { id: 1, keys: [ a ], complete: true },
        { id: 2, keys: [ e, c ], complete: true },
    ],
} ];
const exact = selectStockBadfilterRules(corpus, new Set([ a ]));
assert.deepEqual(exact.selected.one.ids, [ 1 ]);
assert.deepEqual(exact.selected.two.ids, [ 1 ]);
assert.equal(exact.status.deferredSourceCount, 0);
const partial = selectStockBadfilterRules(corpus, new Set([ b, d, e ]));
assert.deepEqual(partial.selected.one.ids, []);
assert.deepEqual(partial.selected.two.ids, []);
assert.equal(partial.status.deferredSourceCount, 3,
    'Partial merges and secondary corpora defer complete source identities');
assert.equal(partial.status.warnings[0].rulesetId, 'one');
assert.equal(partial.status.deferredRuleCount, 4);
const covered = selectStockBadfilterRules(corpus, new Set([ b, c, e ]));
assert.deepEqual(covered.selected.one.ids, [ 2, 4 ]);
assert.deepEqual(covered.selected.two.ids, [ 2 ]);
const incomplete = selectStockBadfilterRules([ { id: 'native', digest: hash('native'),
    deferredKeys: [], rules: [ { id: 1, keys: [ a ], complete: false } ],
} ], new Set([ a ]));
assert.deepEqual(incomplete.selected.native.ids, []);

const group = (resourceType, domains) => ({ property: 'requestDomains',
    template: { action: { type: 'block' }, priority: 10,
        condition: { resourceTypes: [ resourceType ] } }, domains });
const residualCorpus = [ { id: 'residual', digest: hash('residual'), deferredKeys: [], rules: [ {
    id: 1, complete: true, keys: [ a, b, c ], residual: [
        group('script', [ [ 'a.test', [ a ] ], [ 'b.test', [ b ] ] ]),
        group('image', [ [ 'a.test', [ c ] ] ]),
    ],
} ] } ];
assert.equal(isStockBadfilterResidualGroup(residualCorpus[0].rules[0].residual[0]), true);
const residual = selectStockBadfilterRules(residualCorpus, new Set([ a ]));
assert.deepEqual(residual.selected.residual.ids, [ 1 ]);
assert.equal(residual.status.deferredSourceCount, 0);
assert.deepEqual(residual.residualRules.map(rule => rule.condition), [
    { resourceTypes: [ 'script' ], requestDomains: [ 'b.test' ] },
    { resourceTypes: [ 'image' ], requestDomains: [ 'a.test' ] },
], 'Cancelling a script source retains the independent image source on the same hostname');
const residualAlias = structuredClone(residualCorpus);
residualAlias[0].rules[0].keys.push(d);
residualAlias[0].rules[0].residual[0].domains[0][1].push(d);
assert.deepEqual(selectStockBadfilterRules(residualAlias, new Set([ a ])).residualRules[0].condition.requestDomains,
    [ 'a.test', 'b.test' ], 'An independent source with the same native predicate remains active');
const unsafeResidual = structuredClone(residualCorpus);
unsafeResidual[0].rules[0].residual[0].template.condition.topDomains = [ 'sensitive.test' ];
const refusedResidual = selectStockBadfilterRules(unsafeResidual, new Set([ a ]));
assert.deepEqual(refusedResidual.selected.residual.ids, []);
assert.equal(refusedResidual.status.deferredSourceCount, 1);

const storage = new Map();
let currentDynamic = [ { id: 9000000, action: { type: 'block' },
    condition: { urlFilter: 'last-good' } }, { id: 42, action: { type: 'block' },
    condition: { urlFilter: 'other-realm' } } ];
let currentSession = [];
let regexLimit = 1000;
const regexCount = rules => rules.filter(rule => rule.condition?.regexFilter).length;
const disabled = new Map([ [ 'one', [ 99 ] ], [ 'two', [] ] ]);
const operations = [];
let rejectStaticOnce = '';
let rejectStateOnce = false;
let packageChanged = false;
const index = { schemaVersion: 1, rulesets: Object.fromEntries(corpus.map(source =>
    [ source.id, { digest: source.digest, badfilterKeys: [] } ])) };
const dependencies = {
    dnr: {
        async getEnabledRulesets() { return [ 'one', 'two' ]; },
        async getDynamicRules() { return structuredClone(currentDynamic); },
        async getSessionRules() { return structuredClone(currentSession); },
        async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
            const next = [ ...currentSession.filter(rule => removeRuleIds.includes(rule.id) === false),
                ...structuredClone(addRules) ];
            if ( regexCount(next) + regexCount(currentDynamic) > regexLimit ) {
                throw new Error('shared regex quota exceeded');
            }
            currentSession = next;
        },
        async updateDynamicRules({ removeRuleIds, addRules }) {
            operations.push('dynamic');
            const next = [ ...currentDynamic.filter(rule => removeRuleIds.includes(rule.id) === false),
                ...structuredClone(addRules) ];
            if ( regexCount(next) + regexCount(currentSession) > regexLimit ) {
                throw new Error('shared regex quota exceeded');
            }
            currentDynamic = next;
        },
        async getDisabledRuleIds({ rulesetId }) { return disabled.get(rulesetId).slice(); },
        async updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds }) {
            if ( rejectStaticOnce === rulesetId ) {
                rejectStaticOnce = '';
                throw new Error('mock Chrome static quota rejection');
            }
            operations.push(rulesetId);
            disabled.set(rulesetId, Array.from(new Set([
                ...disabled.get(rulesetId).filter(id => enableRuleIds.includes(id) === false),
                ...disableRuleIds,
            ])));
        },
    },
    async read(key) { return structuredClone(storage.get(key)); },
    async write(key, value) {
        if ( key === STOCK_BADFILTER_STATE && rejectStateOnce ) {
            rejectStateOnce = false;
            throw new Error('mock storage rejection');
        }
        storage.set(key, structuredClone(value));
    },
    async remove(key) { storage.delete(key); },
    async fetchJSON(url) {
        if ( url === '/rulesets/badfilter-details' ) {
            const result = structuredClone(index);
            if ( packageChanged ) { result.rulesets.one.digest = hash('new package'); }
            return result;
        }
        const source = corpus.find(source => url === `/rulesets/badfilter/${source.id}`);
        return source && { schemaVersion: 1, ...structuredClone(source) };
    },
};
const manager = createStockBadfilterManager(dependencies);
const externallyDisabledResidual = createStockBadfilterManager({
    ...dependencies,
    dnr: { ...dependencies.dnr,
        async getEnabledRulesets() { return [ 'residual' ]; },
        async getDisabledRuleIds() { return [ 1 ]; },
    },
    async fetchJSON(url) {
        if ( url === '/rulesets/badfilter-details' ) {
            return { schemaVersion: 1, rulesets: { residual: {
                digest: residualCorpus[0].digest, badfilterKeys: [],
            } } };
        }
        return { schemaVersion: 1, ...structuredClone(residualCorpus[0]) };
    },
});
const externallyDisabledPlan = await externallyDisabledResidual.prepare([ 'a' ]);
assert.equal(externallyDisabledPlan.changed, false);
assert.deepEqual(externallyDisabledPlan.managed, {});
assert.deepEqual(externallyDisabledPlan.next[0].ids, [ 1 ]);
assert.deepEqual(externallyDisabledPlan.residualRules, [],
    'Residual reconstruction must not resurrect a static predicate disabled by another owner');
let plan = await manager.prepare([ 'a' ]);
assert.equal(plan.changed, true);
const previousDynamic = structuredClone(currentDynamic);
await manager.begin(plan);
assert.equal(storage.has(STOCK_BADFILTER_JOURNAL), true);
assert.deepEqual(operations, [], 'Write-ahead journal must precede browser mutation');
await manager.apply(plan);
await manager.commit(plan);
assert.deepEqual(disabled.get('one'), [ 99, 1 ]);
assert.deepEqual(disabled.get('two'), [ 1 ]);
assert.equal(storage.has(STOCK_BADFILTER_JOURNAL), false);
assert.deepEqual(storage.get(STOCK_BADFILTER_STATE).one.ids, [ 1 ]);

plan = await manager.prepare([]);
await manager.begin(plan);
await manager.apply(plan);
await manager.commit(plan);
assert.deepEqual(disabled.get('one'), [ 99 ], 'Removing badfilter restores managed rules only');
assert.deepEqual(disabled.get('two'), []);

// Simulate failure after the atomic dynamic replacement and first static API.
plan = await manager.prepare([ 'a' ]);
await manager.begin(plan);
currentDynamic = [ { id: 9000001, action: { type: 'block' },
    condition: { urlFilter: 'replacement' } }, previousDynamic[1] ];
rejectStaticOnce = 'two';
await assert.rejects(manager.apply(plan), /quota rejection/);
assert.deepEqual(disabled.get('one'), [ 99, 1 ]);
await createStockBadfilterManager(dependencies).recover();
assert.deepEqual(disabled.get('one'), [ 99 ]);
assert.deepEqual(disabled.get('two'), []);
assert.deepEqual(currentDynamic.slice().sort((a, b) => a.id - b.id),
    previousDynamic.slice().sort((a, b) => a.id - b.id));
assert.equal(storage.has(STOCK_BADFILTER_JOURNAL), false);

// A failed stock update must also restore the previous shared regex budget.
// The new smaller dynamic plan let session rules grow into the freed slots.
const makeRegex = (id, regexFilter) => ({ id, action: { type: 'block' }, condition: { regexFilter } });
const nonRegexSession = { id: 7000000, action: { type: 'block' }, condition: { urlFilter: 'firewall' } };
currentDynamic = [ makeRegex(9000000, 'old-user-1'), makeRegex(9000001, 'old-user-2') ];
currentSession = [ nonRegexSession, makeRegex(5000000, 'old-stock') ];
regexLimit = 3;
plan = await manager.prepare([ 'a' ]);
await manager.begin(plan);
currentDynamic = [ makeRegex(9000000, 'new-user') ];
currentSession = [ nonRegexSession, makeRegex(5000000, 'new-stock-1'), makeRegex(5000001, 'new-stock-2') ];
await manager.apply(plan);
await createStockBadfilterManager(dependencies).recover();
assert.deepEqual(currentDynamic.map(rule => rule.condition.regexFilter), [ 'old-user-1', 'old-user-2' ]);
assert.deepEqual(currentSession, [ nonRegexSession, makeRegex(5000000, 'old-stock') ]);
assert.deepEqual(disabled.get('one'), [ 99 ]);
currentDynamic = structuredClone(previousDynamic);
currentSession = [];
regexLimit = 1000;

// Worker termination after both browser calls but before durable commit rolls
// back on restart. A committed journal instead completes housekeeping.
plan = await manager.prepare([ 'a' ]);
await manager.begin(plan);
await manager.apply(plan);
await createStockBadfilterManager(dependencies).recover();
assert.deepEqual(disabled.get('one'), [ 99 ]);
await manager.begin(plan);
await manager.apply(plan);
rejectStateOnce = true;
await manager.commit(plan);
assert.equal(storage.get(STOCK_BADFILTER_JOURNAL).committed, true);
await createStockBadfilterManager(dependencies).recover();
assert.deepEqual(disabled.get('one'), [ 99, 1 ]);
assert.deepEqual(storage.get(STOCK_BADFILTER_STATE).one.ids, [ 1 ]);

// Numeric static IDs cannot be replayed into an extension with new rule data.
plan = await manager.prepare([]);
await manager.begin(plan);
packageChanged = true;
const operationCount = operations.length;
await createStockBadfilterManager(dependencies).recover();
assert.equal(operations.length, operationCount);
assert.equal(storage.has(STOCK_BADFILTER_JOURNAL), false);
assert.equal(storage.has(STOCK_BADFILTER_STATE), false);
packageChanged = false;
storage.set(STOCK_BADFILTER_STATE, { one: { digest: hash('one'), ids: [ 1 ] } });
disabled.set('one', [ 99 ]);
plan = await manager.prepare([]);
assert.equal(plan.changed, false);
await manager.report(plan);
assert.deepEqual(storage.get(STOCK_BADFILTER_STATE), {},
    'Ownership is retired when Chrome already restored a static rule');

// A packaged badfilter directive participates without a personal directive.
index.rulesets.one.badfilterKeys = [ 'a' ];
plan = await manager.prepare([]);
assert.equal(plan.status.deferredSourceCount, 0);
index.rulesets.one.badfilterKeys = [];
index.rulesets.one.digest = 'corrupt';
await assert.rejects(manager.prepare([ 'a' ]), /Invalid packaged badfilter provenance/);

// Release builds which reuse previous numeric rule IDs must update source
// provenance and both package digests in the same salvage pass.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-badfilter-salvage-'));
try {
    const before = path.join(temporary, 'before');
    const after = path.join(temporary, 'after');
    for ( const directory of [ path.join(before, 'rulesets/main'),
        path.join(after, 'rulesets/main'), path.join(after, 'rulesets/badfilter') ] ) {
        await fs.mkdir(directory, { recursive: true });
    }
    const rule = (id, urlFilter) => ({ id, action: { type: 'block' }, condition: { urlFilter } });
    await fs.writeFile(path.join(before, 'rulesets/main/sample.json'),
        JSON.stringify([ rule(40, 'a'), rule(41, 'b') ]));
    await fs.writeFile(path.join(after, 'rulesets/main/sample.json'),
        JSON.stringify([ rule(1, 'b'), rule(2, 'a') ]));
    await fs.writeFile(path.join(after, 'rulesets/badfilter/sample.json'), JSON.stringify({
        schemaVersion: 1, digest: hash('old'), rules: [
            { id: 1, keys: [ b ], complete: true }, { id: 2, keys: [ a ], complete: true },
        ], badfilterKeys: [], deferredKeys: [],
    }));
    await fs.writeFile(path.join(after, 'rulesets/badfilter-details.json'), JSON.stringify({
        schemaVersion: 1, rulesets: { sample: { digest: hash('old'), badfilterKeys: [] } },
    }));
    await promisify(execFile)(process.execPath, [
        path.resolve(import.meta.dirname, '../platform/mv3/salvage-ruleids.mjs'),
        `before=${before}`, `after=${after}`,
    ]);
    const mapped = JSON.parse(await fs.readFile(path.join(after,
        'rulesets/badfilter/sample.json'), 'utf8'));
    const mappedIndex = JSON.parse(await fs.readFile(path.join(after,
        'rulesets/badfilter-details.json'), 'utf8'));
    const actualDigest = hash(await fs.readFile(path.join(after, 'rulesets/main/sample.json')));
    assert.deepEqual(mapped.rules.map(row => row.id), [ 41, 40 ]);
    assert.equal(mapped.digest, actualDigest);
    assert.equal(mappedIndex.rulesets.sample.digest, actualDigest);
} finally {
    assert.equal(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    await fs.rm(temporary, { recursive: true, force: true });
}
console.log('Stock badfilter provenance, planning and crash-recovery checks passed.');
