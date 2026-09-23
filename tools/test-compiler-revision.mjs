/* uBlock Plus+ — durable compiler upgrade regressions. GPL-3.0-or-later. */
import { COMPILED_FILTERS_REVISION } from '../platform/mv3/extension/js/compiled-cache.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('async function markCompiledFilterSourcesDirty(');
const end = source.indexOf('async function recoverPendingCompiledActivation(', start);
assert.ok(start >= 0 && end > start);
const startupStart = source.indexOf('async function start(');
const startupSource = source.slice(startupStart, source.indexOf('\n}\n', startupStart) + 3);
assert.ok(startupStart >= 0);
assert.match(startupSource, /await ensureCompiledFilterRevision\(\);/);
assert.doesNotMatch(startupSource, /await retryDirtyCompiledFilterSourcesNow\(\)/,
    'a failed compiled-filter update must not be retried inside the startup path that gates every message');
assert.match(startupSource, /\n {8}resumeCompiledFilterRetry\(\)\.catch\(/,
    'startup queues a due retry without awaiting it');
const values = new Map();
let failActivation = false;
let failRegistration = false;
let failRevisionWrite = false;
let activations = 0;
let registrations = 0;
let clock = 1_000_000;
const jobs = new Map();
const queued = [];
const revisionKey = 'compiledFilters.compilerRevision';
const dirtyKey = 'compiledFilters.dirtySources';
const context = vm.createContext({
    Number, Object, Math,
    Date: { now: () => clock },
    COMPILED_FILTERS_REVISION,
    COMPILED_FILTERS_REVISION_KEY: revisionKey,
    COMPILED_FILTERS_DIRTY_KEY: dirtyKey,
    COMPILED_FILTERS_RETRY_JOB: 'retry',
    COMPILED_FILTERS_RETRY_DELAY: 5 * 60 * 1000,
    COMPILED_FILTERS_MAX_RETRY_DELAY: 6 * 60 * 60 * 1000,
    localRead: async key => structuredClone(values.get(key)),
    localWrite: async (key, value) => {
        if ( key === revisionKey && failRevisionWrite ) { throw new Error('revision write failed'); }
        values.set(key, structuredClone(value));
    },
    localRemove: async key => values.delete(key),
    activateCompiledFilterRulesNow: async () => {
        activations++;
        if ( failActivation ) { throw new Error('activation failed'); }
    },
    registerContentScripts: async () => {
        registrations++;
        if ( failRegistration ) { throw new Error('registration failed'); }
    },
    registerJob: async (name, time) => { jobs.set(name, time); },
    removeJob: async name => { jobs.delete(name); },
    enqueueFilteringMutation: task => {
        const result = task();
        queued.push(result);
        return result;
    },
    ublockPlusErr: () => {},
});
vm.runInContext(source.slice(start, end), context);
await context.ensureCompiledFilterRevision();
assert.equal(values.get(dirtyKey).compiled, true);
assert.equal(values.get(dirtyKey).contentScripts, true);
assert.equal(values.get(dirtyKey).compilerRevision, COMPILED_FILTERS_REVISION);
await context.markCompiledFilterSourcesDirty({ contentScripts: true });
assert.equal(values.get(dirtyKey).compilerRevision, COMPILED_FILTERS_REVISION,
    'a concurrent source edit must retain the pending upgrade');

for ( const fault of [ 'activation', 'registration', 'revision write' ] ) {
    failActivation = fault === 'activation';
    failRegistration = fault === 'registration';
    failRevisionWrite = fault === 'revision write';
    await assert.rejects(context.flushDirtyCompiledFilterSourcesNow(), new RegExp(fault));
    assert.equal(values.has(revisionKey), false, 'failed upgrades are not marked current');
    assert.equal(values.get(dirtyKey).compilerRevision, COMPILED_FILTERS_REVISION);
    await context.ensureCompiledFilterRevision();
    assert.equal(values.get(dirtyKey).compiled, true, 'a worker restart retains the retry');
}
failActivation = failRegistration = failRevisionWrite = false;
assert.equal(await context.flushDirtyCompiledFilterSourcesNow(), true);
assert.equal(values.get(revisionKey), COMPILED_FILTERS_REVISION);
assert.equal(values.has(dirtyKey), false);
const before = { activations, registrations };
await context.ensureCompiledFilterRevision();
assert.equal(await context.flushDirtyCompiledFilterSourcesNow(), false);
assert.deepEqual({ activations, registrations }, before,
    'an unchanged compiler must not recompile on every worker wake');

// A failing retry (offline, unreachable list host) backs off exponentially.
// Wakes inside the window neither compile again nor lose the durable job.
const minute = 60 * 1000;
failActivation = true;
await context.markCompiledFilterSourcesDirty({ compiled: true });
const failedAt = clock;
assert.equal(await context.retryDirtyCompiledFilterSourcesNow(), false);
assert.equal(activations, before.activations + 1);
assert.equal(values.get(dirtyKey).attempts, 1);
assert.equal(values.get(dirtyKey).lastAttemptAt, failedAt);
assert.equal(jobs.get('retry'), failedAt + 5 * minute);
clock += 4 * minute;
jobs.clear();
assert.equal(await context.resumeCompiledFilterRetry(), false,
    'a wake inside the backoff window does not queue a compile');
assert.equal(queued.length, 0);
assert.equal(await context.retryDirtyCompiledFilterSourcesNow(), false);
assert.equal(activations, before.activations + 1, 'a duplicate job run inside the window must not recompile');
assert.equal(jobs.get('retry'), failedAt + 5 * minute, 'the early run keeps the durable retry job');
clock = failedAt + 5 * minute;
assert.equal(await context.resumeCompiledFilterRetry(), false);
assert.equal(queued.length, 1, 'a due retry is queued as a filtering mutation');
assert.equal(activations, before.activations + 2);
assert.equal(values.get(dirtyKey).attempts, 2);
assert.equal(jobs.get('retry'), clock + 10 * minute, 'the delay doubles after each failure');
const attemptsBefore = activations;
for ( let i = 0; i < 12; i++ ) {
    clock = jobs.get('retry');
    await context.retryDirtyCompiledFilterSourcesNow();
}
assert.equal(activations, attemptsBefore + 12);
assert.equal(jobs.get('retry') - clock, 6 * 60 * minute, 'the delay is capped at six hours');
assert.equal(values.get(dirtyKey).attempts, 14);
// A compiler upgrade marks the sources once; restarts while that upgrade is
// still failing must not reset its backoff.
values.delete(revisionKey);
await context.ensureCompiledFilterRevision();
assert.equal(values.get(dirtyKey).compilerRevision, COMPILED_FILTERS_REVISION);
await context.retryDirtyCompiledFilterSourcesNow();
assert.equal(values.get(dirtyKey).attempts, 1);
await context.ensureCompiledFilterRevision();
assert.equal(values.get(dirtyKey).attempts, 1, 'a restart keeps the pending upgrade backoff');
assert.equal(values.get(dirtyKey).compiled, true);
assert.equal(values.get(dirtyKey).contentScripts, true);
// A clock moved backwards does not postpone the retry for the whole window.
clock = values.get(dirtyKey).lastAttemptAt - 60 * minute;
failActivation = false;
assert.equal(await context.retryDirtyCompiledFilterSourcesNow(), true);
assert.equal(values.has(dirtyKey), false);
assert.equal(jobs.has('retry'), false);
// A new source edit restarts the backoff from a fresh marker.
failActivation = true;
await context.markCompiledFilterSourcesDirty({ compiled: true });
await context.retryDirtyCompiledFilterSourcesNow();
await context.markCompiledFilterSourcesDirty({ contentScripts: true });
assert.equal(values.get(dirtyKey).attempts, undefined);
assert.equal(await context.resumeCompiledFilterRetry(), false);
assert.equal(queued.length, 2, 'a fresh source edit is retried without waiting for the old backoff');
console.log('Durable compiler revision migration and retry backoff tests passed.');
