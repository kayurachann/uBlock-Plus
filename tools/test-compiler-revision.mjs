/* uBlock Plus+ — durable compiler upgrade regressions. GPL-3.0-or-later. */
import { COMPILED_FILTERS_REVISION } from '../platform/mv3/extension/js/compiled-cache.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('async function markCompiledFilterSourcesDirty(');
const end = source.indexOf('async function mutateCompiledFilterSources(', start);
assert.ok(start >= 0 && end > start);
assert.match(source, /await ensureCompiledFilterRevision\(\);\s*await retryDirtyCompiledFilterSourcesNow\(\);/);
const values = new Map();
let failActivation = false;
let failRegistration = false;
let failRevisionWrite = false;
let activations = 0;
let registrations = 0;
const revisionKey = 'compiledFilters.compilerRevision';
const dirtyKey = 'compiledFilters.dirtySources';
const context = vm.createContext({
    Number, Date, Object,
    COMPILED_FILTERS_REVISION,
    COMPILED_FILTERS_REVISION_KEY: revisionKey,
    COMPILED_FILTERS_DIRTY_KEY: dirtyKey,
    COMPILED_FILTERS_RETRY_JOB: 'retry',
    localRead: async key => values.get(key),
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
    registerJob: async () => {},
    removeJob: async () => {},
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
console.log('Durable compiler revision migration tests passed.');
