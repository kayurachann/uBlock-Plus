/* uBlock Plus+ — split-incognito ownership of shared deferred jobs. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';

// With "incognito": "split", both workers share storage.local, but each has
// its own alarms.js state and filtering-mutation queue. Load the real job
// store twice to model the two processes, and run the actual alarm listener.
const values = new Map();
const alarmOperations = [];
globalThis.self = globalThis;
globalThis.chrome = {
    alarms: {
        async clear(name) { alarmOperations.push({ op: 'clear', name }); },
        async create(name, details) { alarmOperations.push({ op: 'create', name, ...details }); },
    },
    i18n: { getMessage: ( ) => '' },
    runtime: {
        getManifest: ( ) => ({ permissions: [] }),
        getURL: (value = '') => `chrome-extension://test/${value}`,
    },
    storage: {
        local: {
            async get(key) {
                return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {};
            },
            async set(entries) {
                for ( const [ key, value ] of Object.entries(entries) ) {
                    values.set(key, structuredClone(value));
                }
            },
            async remove(keys) {
                for ( const key of [ keys ].flat() ) { values.delete(key); }
            },
        },
        session: { get: async ( ) => ({}), set: async ( ) => {} },
    },
};
const alarmsURL = new URL('../platform/mv3/extension/js/alarms.js', import.meta.url);
const regularJobs = await import(`${alarmsURL}?worker=regular`);
const incognitoJobs = await import(`${alarmsURL}?worker=incognito`);

const background = (await readFile(new URL(
    '../platform/mv3/extension/js/background.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const slice = (marker, end) => {
    const start = background.indexOf(marker);
    assert.ok(start >= 0, `Actual background code must include ${marker}`);
    return background.slice(start, background.indexOf(end, start) + end.length);
};
const alarmCode = [
    slice('async function processIncognitoJobs(', '\n}\n'),
    slice('browser.alarms.onAlarm.addListener(', '\n});\n'),
].join('\n');

const PRUNE_DELAY = 30 * 60 * 1000;
const dispatched = [];
const errors = [];
let gate = Promise.resolve();

function worker(name, jobs, incognito) {
    let listener;
    const prune = async ( ) => {
        dispatched.push(`${name}:pruneCSSCache`);
        await jobs.registerJob('pruneCSSCache', Date.now() + PRUNE_DELAY);
    };
    const context = vm.createContext({
        Date,
        isIncognitoWorker: incognito,
        process: { wakeupRun: true },
        isFullyInitialized: Promise.resolve(),
        browser: { alarms: { onAlarm: { addListener: fn => { listener = fn; } } } },
        localRead: async key => structuredClone(values.get(key)),
        processDueJobs: jobs.processDueJobs,
        resetJobsAlarm: jobs.resetJobsAlarm,
        pruneCSSCache: prune,
        onMessage: async request => {
            if ( request.what === 'pruneCSSCache' ) { return prune(); }
            dispatched.push(`${name}:${request.what}`);
            await gate;
        },
        ublockPlusErr: message => { errors.push(`${name}:${message}`); },
    });
    vm.runInContext(alarmCode, context);
    assert.equal(typeof listener, 'function');
    return ( ) => listener({ name: 'deferredJobs' });
}
const fireRegular = worker('regular', regularJobs, false);
const fireIncognito = worker('incognito', incognitoJobs, true);

const settle = async ( ) => {
    for ( let i = 0; i < 50; i++ ) { await turn(); }
};
const seed = pruneTime => {
    const now = Date.now();
    const jobs = [
        { name: 'updateImportedLists', time: now - 3000 },
        { name: 'retryCompiledFilters', time: now - 2000 },
        { name: 'pruneCSSCache', time: pruneTime },
    ].sort((a, b) => a.time - b.time);
    values.set('deferredJobs', jobs);
    dispatched.length = 0;
    return structuredClone(jobs);
};
const job = name => values.get('deferredJobs')?.find(a => a.name === name);
const MUTATING = [ 'updateImportedLists', 'retryCompiledFilters' ];

// The incognito worker only trims its own CSS cache: it neither leases,
// re-times nor runs the filtering jobs, which remain due for the regular one.
{
    const seeded = seed(Date.now() - 1000);
    fireIncognito();
    await settle();
    assert.deepEqual(dispatched, [ 'incognito:pruneCSSCache' ]);
    for ( const name of MUTATING ) {
        assert.deepEqual(job(name), seeded.find(a => a.name === name),
            `the incognito worker must leave ${name} untouched`);
    }
    assert.ok(job('pruneCSSCache').time > Date.now(), 'its own housekeeping job is re-timed');

    fireRegular();
    await settle();
    assert.deepEqual(dispatched.slice(1).sort(),
        MUTATING.map(name => `regular:${name}`).sort());
    assert.deepEqual(values.get('deferredJobs').map(a => a.name), [ 'pruneCSSCache' ],
        'the regular worker completes the filtering jobs');
}

// Both workers woken by the same alarm: each filtering job runs exactly once,
// in the regular worker, even while that run is still in progress.
{
    const seeded = seed(Date.now() + PRUNE_DELAY);
    let release;
    gate = new Promise(resolve => { release = resolve; });
    fireRegular();
    fireIncognito();
    await settle();
    assert.deepEqual(dispatched.slice().sort(), MUTATING.map(name => `regular:${name}`).sort());
    for ( const name of MUTATING ) {
        assert.equal(typeof job(name).runToken, 'string', `${name} stays leased by the regular worker`);
    }
    fireIncognito();
    await settle();
    assert.equal(dispatched.some(entry => entry.startsWith('incognito:')), false);
    release();
    await settle();
    assert.deepEqual(values.get('deferredJobs'), seeded.filter(a => a.name === 'pruneCSSCache'));
    gate = Promise.resolve();
}

// Nothing due, or no job list at all: the incognito worker writes nothing.
{
    const later = Date.now() + PRUNE_DELAY;
    values.set('deferredJobs', [ ...MUTATING, 'pruneCSSCache' ].map(name => ({ name, time: later })));
    dispatched.length = 0;
    const before = structuredClone(values.get('deferredJobs'));
    const operations = alarmOperations.length;
    fireIncognito();
    await settle();
    assert.deepEqual(values.get('deferredJobs'), before);
    assert.equal(alarmOperations.length, operations);
    values.delete('deferredJobs');
    fireIncognito();
    await settle();
    assert.equal(values.has('deferredJobs'), false);
    assert.deepEqual(dispatched, []);
}

assert.deepEqual(errors, []);
console.log('Split incognito jobs: filtering jobs stay with the regular worker, CSS cache pruning stays per worker.');
