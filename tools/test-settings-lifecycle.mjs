/* uBlock Plus+ — durable settings and retry regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';

function storage(initial = {}) {
    let values = structuredClone(initial);
    return {
        failRead: false, failWrite: false, writes: [],
        async get() {
            if ( this.failRead ) { throw new Error('read failed'); }
            return structuredClone(values);
        },
        async set(entries) {
            if ( this.failWrite ) { throw new Error('write failed'); }
            this.writes.push(structuredClone(entries));
            Object.assign(values, structuredClone(entries));
        },
        async remove(key) { delete values[key]; },
    };
}
const local = storage();
const session = storage();
globalThis.self = globalThis;
globalThis.chrome = {
    runtime: { getURL: () => 'chrome-extension://test/' },
    storage: { local, session },
};
let generation = 0;
const restart = () => import(
    `../platform/mv3/extension/js/config.js?settings-test=${++generation}`
);
let config = await restart();
await config.loadRulesetConfig();
config.rulesetConfig.autoReload = false;
local.failWrite = true;
await assert.rejects(config.saveRulesetConfig(), /write failed/);
local.failWrite = false;
config.rulesetConfig.showBlockedCount = false;
await config.saveRulesetConfig();
assert.equal((await local.get()).rulesetConfig.showBlockedCount, false,
    'A rejected save must not poison later saves');

// Each queued save owns a snapshot, including array values.
local.writes.length = 0;
config.rulesetConfig.enabledRulesets = [ 'first' ];
const first = config.saveRulesetConfig();
config.rulesetConfig.enabledRulesets.push('second');
const second = config.saveRulesetConfig();
await Promise.all([ first, second ]);
assert.deepEqual(local.writes.map(entry => entry.rulesetConfig.enabledRulesets),
    [ [ 'first' ], [ 'first', 'second' ] ]);

// Session is a cache. A failed cache update cannot turn a committed local save
// into an unhandled rejection, or resurrect stale settings after worker wakeup.
session.failWrite = true;
config.rulesetConfig.autoReload = true;
await config.saveRulesetConfig();
config = await restart();
await config.loadRulesetConfig();
assert.equal(config.rulesetConfig.autoReload, true);
assert.deepEqual(config.rulesetConfig.enabledRulesets, [ 'first', 'second' ]);
session.failWrite = false;

// A failed authoritative read is not a fresh install and must never overwrite
// existing settings with defaults. It must also remain retryable.
local.failRead = true;
const writeCount = local.writes.length;
config = await restart();
await assert.rejects(config.loadRulesetConfig(), /read failed/);
assert.equal(local.writes.length, writeCount);
assert.equal(config.process.firstRun, false);
local.failRead = false;
await config.loadRulesetConfig();
assert.deepEqual(config.rulesetConfig.enabledRulesets, [ 'first', 'second' ]);
console.log('Durable settings lifecycle tests passed');
