/* uBlock Plus+ — cross-source scriptlet exception regressions. GPL-3.0-or-later. */
import * as sfp from '../src/js/static-filtering-parser.js';
import {
    SCRIPTLET_EXCEPTION_SLOT,
    SCRIPTLET_WARNINGS_KEY,
    bindScriptletExceptions,
    collectScriptletExceptions,
    nativeScriptletExclusions,
    scriptletExceptionPayload,
} from '../platform/mv3/extension/js/scriptlet-exceptions.js';
import { hostnameCompare, isHnRegexOrPath } from '../platform/mv3/extension/js/offscreen/make-utils.js';
import { intersectHostnameIters, matchesFromHostnames } from '../platform/mv3/extension/js/utils.js';
import assert from 'node:assert/strict';
import { builtinScriptlets } from '../src/js/resources/scriptlets.js';
import { compiledStorageKey } from '../platform/mv3/extension/js/compiled-storage.js';
import fs from 'node:fs/promises';
import { literalStrFromRegex } from '../src/js/regex-analyzer.js';
import path from 'node:path';
import { safeReplace } from '../platform/mv3/extension/js/offscreen/safe-replace.js';
import vm from 'node:vm';

const read = async path => (await fs.readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const makerSource = await read('../platform/mv3/extension/js/offscreen/make-scriptlets.js');
const template = await read('../platform/mv3/extension/js/offscreen/scriptlet.template.js');
const registrySource = await read('../platform/mv3/extension/js/compiled-filters.js');
const stockRegistrySource = await read('../platform/mv3/extension/js/scriptlet-registration.js');
const compilerSource = await read('../platform/mv3/extension/js/offscreen/compile-filters.js');
const sourceBody = makerSource.slice(makerSource.indexOf('const resourceDetails ='))
    .replaceAll('export function ', 'function ');

function makeCompiler(resources) {
    const context = vm.createContext({ builtinScriptlets: resources, Map, Set, JSON,
        structuredClone, hostnameCompare, isHnRegexOrPath, literalStrFromRegex, safeReplace,
        console });
    vm.runInContext(sourceBody, context);
    return context;
}

// Check the real packaged alias table, including trusted scriptlet aliases.
const realCompiler = makeCompiler(builtinScriptlets);
for ( const entry of builtinScriptlets ) {
    for ( const alias of entry.aliases || [] ) {
        const input = alias.endsWith('.js') ? alias.slice(0, -3) : alias;
        assert.equal(realCompiler.normalizeScriptletArgs([ input, 'exact argument' ])[0], entry.name);
    }
}

// Execute actual generated code using a small observable packaged function.
// This isolates selection/exception semantics from each scriptlet's DOM API.
const resources = [ 'MAIN', 'ISOLATED' ].map((world, index) => ({
    name: `probe-${index}.js`, aliases: [ `alias-${index}.js` ], world,
    fn: function probe(name, value) { globalThis.probes.push([ name, value ]); },
}));
const maker = makeCompiler(resources);
const mv3Compiler = vm.createContext({
    makeScriptlets: maker,
    fetch: async () => ({ text: async () => template }),
});
vm.runInContext(section(compilerSource, 'export async function toMv3Data('), mv3Compiler);
const toMv3Scriptlets = async details => {
    maker.reset();
    return mv3Compiler.toMv3Data('native-stock', {
        scriptletDetails: new Map(details.map((entry, index) => [ index, structuredClone(entry) ])),
        specificCosmeticDetails: new Map(), dnrRules: [],
    });
};
const registrationScopes = [];
const optimal = { none: new Set(), basic: new Set(), optimal: new Set([ 'all-urls' ]), complete: new Set() };
const basic = { none: new Set(), basic: new Set([ 'all-urls' ]), optimal: new Set(), complete: new Set() };
// Stock and imported filters use this same maker. Native stock registration
// relies on exceptions in its own generated code, even without userScripts
// or a bound cross-source payload. Exception-only scopes must enable lookup.
for ( const [ index, { world } ] of resources.entries() ) {
    for ( const scope of [ 'example.*', 'parent.test>>', 'parent.*>>', '/^child\\.example\\.test$/' ] ) {
        for ( const exceptionFirst of [ false, true ] ) {
            maker.reset();
            const details = [
                { args: [ `probe-${index}`, 'target', 'yes' ],
                    matches: [ 'child.example.test', 'unrelated.test' ] },
                { args: [ `alias-${index}`, 'target', 'yes' ], excludeMatches: [ scope ] },
            ];
            if ( exceptionFirst ) { details.reverse(); }
            details.forEach(entry => maker.compile('native-stock', entry));
            const result = maker.commit('native-stock', template)[world];
            assert.deepEqual(Array.from(result.hostnames), [ 'child.example.test', 'unrelated.test' ],
                `${world} ${scope}: an exception-only alias must not broaden positive registration`);
            registrationScopes.push({ world, hostnames: result.hostnames });
            const imported = await toMv3Scriptlets(details);
            assert.deepEqual(Array.from(imported[world.toLowerCase()][0].hostnames),
                [ 'child.example.test', 'unrelated.test' ],
                'Imported conversion must preserve the same finite positive scope');
            const nativeRun = (hostname, ancestors) => {
                const probes = [];
                const context = vm.createContext({ probes, URL,
                    document: { location: { origin: `https://${hostname}`,
                        ancestorOrigins: ancestors.map(hn => `https://${hn}`) } } });
                context.self = context;
                vm.runInContext(result.code, context);
                return probes.length;
            };
            assert.equal(nativeRun('child.example.test', [ 'parent.test' ]), 0,
                `${world} ${scope}: matching native exception must suppress invocation`);
            assert.equal(nativeRun('unrelated.test', [ 'other.test' ]), 1,
                `${world} ${scope}: an unrelated page must retain the invocation`);
            if ( scope.endsWith('>>') ) {
                assert.equal(nativeRun('child.example.test', []), 1,
                    'A missing ancestor does not match an ancestor-only exception');
            }
        }
    }
}
// A merged invocation/exception entry must keep the same narrow scope, while
// positive entity, ancestor and regex filters still require broad injection.
for ( const [ index, { world } ] of resources.entries() ) {
    for ( const scope of [ 'example.*', 'parent.test>>', '/^child\\.example\\.test$/' ] ) {
        const result = await toMv3Scriptlets([ {
            args: [ `probe-${index}`, 'target', 'yes' ],
            matches: [ 'child.example.test' ], excludeMatches: [ scope ],
        } ]);
        assert.deepEqual(Array.from(result[world.toLowerCase()][0].hostnames), [ 'child.example.test' ],
            `${world} ${scope}: merged exceptions must not broaden positive registration`);
    }
    for ( const scope of [ '*', 'example.*', 'parent.test>>', 'parent.*>>', '/^child\\.example\\.test$/' ] ) {
        const result = await toMv3Scriptlets([ {
            args: [ `probe-${index}`, 'target', 'yes' ], matches: [ scope ],
        } ]);
        const script = result[world.toLowerCase()][0];
        assert.equal(script.hostnames, '*', `${world} ${scope}: broad positive scopes still register broadly`);
        assert.deepEqual(run(script.code, [], 'child.example.test', undefined, [ 'parent.test' ]),
            [ [ 'target', 'yes' ] ], 'Broad positive scopes still execute on matching pages');
    }
    const onlyException = await toMv3Scriptlets([ {
        args: [ `probe-${index}`, 'target', 'yes' ], excludeMatches: [ 'example.*' ],
    } ]);
    assert.deepEqual(Array.from(onlyException[world.toLowerCase()][0].hostnames), [],
        'An exception alone must not create any registration target');
}
function compile(worldIndex, realm = 'stock-test') {
    maker.reset();
    maker.compile(realm, { args: [ `probe-${worldIndex}`, 'target', 'yes' ],
        trustedSource: true, matches: [ '*' ] });
    maker.compile(realm, { args: [ `probe-${worldIndex}`, 'other', 'no' ],
        trustedSource: true, matches: [ '*' ] });
    return maker.commit(realm, template)[resources[worldIndex].world].code;
}
function exception(source, worldIndex, hostnames, broad = false) {
    const details = new Map([ [ 'fixture', { args: broad ? [] : [ `alias-${worldIndex}`, 'target', 'yes' ],
        excludeMatches: hostnames } ] ]);
    return collectScriptletExceptions([ [ source, maker.exceptionDetails(details) ] ]);
}
function run(code, exceptions, hostname = 'child.example.test', modes = optimal, ancestors = []) {
    const probes = [];
    const context = vm.createContext({ probes, URL, document: { location: {
        origin: `https://${hostname}`, ancestorOrigins: ancestors.map(hn => `https://${hn}`),
    } } });
    context.self = context;
    vm.runInContext(bindScriptletExceptions(code, scriptletExceptionPayload(exceptions, modes)), context);
    return probes.map(args => Array.from(args));
}
for ( const index of [ 0, 1 ] ) {
    for ( const realm of [ 'stock-test', 'imported', 'sandbox' ] ) {
        const code = compile(index, realm);
        assert.deepEqual(run(code, []), [ [ 'target', 'yes' ], [ 'other', 'no' ] ]);
        for ( const source of [ 'stock-other', 'imported', 'sandbox' ] ) {
            assert.deepEqual(run(code, exception(source, index, [ 'example.test' ])), [ [ 'other', 'no' ] ]);
            assert.equal(run(code, exception(source, index, [ 'unrelated.test' ])).length, 2);
            assert.deepEqual(run(code, exception(source, index, [ '*' ], true)), []);
        }
        for ( const scope of [ '/^child\\.example\\.test$/', 'example.*', 'parent.test>>' ] ) {
            assert.deepEqual(run(code, exception('sandbox', index, [ scope ]),
                'child.example.test', optimal, [ 'parent.test' ]), [ [ 'other', 'no' ] ]);
        }
        assert.equal(run(code, exception('sandbox', index, [ 'parent.test>>' ])).length, 2);
        assert.equal(run(code, exception('stock-other', index, [ '*' ]), 'example.test', basic).length, 2);
        assert.equal(run(code, exception('imported', index, [ '*' ]), 'example.test', basic).length, 2);
        assert.equal(run(code, exception('sandbox', index, [ '*' ]), 'example.test', basic).length, 1);
        assert.equal(run(code, exception('sandbox', index, [ '[::1]' ]), '[::1]').length, 1);
    }
}
for ( const protocol of [ 'http:', 'https:', 'file:', 'about:', 'data:', 'blob:' ] ) {
    const probes = [];
    const document = { location: { protocol,
        origin: protocol === 'about:' || protocol === 'data:' ? 'null' : 'https://example.test',
        ancestorOrigins: [ 'https://example.test' ],
    } };
    const context = vm.createContext({ probes, document, URL }); context.self = context;
    vm.runInContext(maker.originOnlyCode(compile(0)), context);
    assert.equal(probes.length, [ 'http:', 'https:', 'file:' ].includes(protocol) ? 0 : 2,
        `Origin wrapper ${protocol} preserves special-frame injection without web-frame duplication`);
}
// Binding is data, including strings which have special replacement meaning.
const dangerous = [ { source: 'sandbox', args: [ 'probe-0.js', '$&"; globalThis.bad = true; //', '</script>' ], hostnames: [ '*' ] } ];
assert.equal(run(compile(0), dangerous).length, 2);
assert.throws(() => bindScriptletExceptions('old compiler output', {}), /recompilation/);
assert.throws(() => collectScriptletExceptions([ [ 'sandbox', [ { args: 'bad', hostnames: [] } ] ] ]), /Invalid/);
const targetToken = JSON.stringify([ 'probe-0.js', 'target', 'yes' ]);
assert.deepEqual(nativeScriptletExclusions('stock-test', [ targetToken ], exception('sandbox', 0, [ 'example.test' ])), [ 'example.test' ]);
assert.deepEqual(nativeScriptletExclusions('stock-test', [], exception('sandbox', 0, [ 'example.test' ])), []);
assert.deepEqual(nativeScriptletExclusions('stock-test', [ targetToken ], exception('stock-test', 0, [ 'example.test' ])), []);
assert.deepEqual(nativeScriptletExclusions('stock-test', [ targetToken ], exception('sandbox', 0, [ '/example/' ])), [ '*' ]);

function section(source, marker) {
    const start = source.indexOf(marker);
    const end = source.indexOf('\n/******************************************************************************', start);
    return source.slice(start, end === -1 ? undefined : end).replace(/^export /, '');
}

// Registration order and rollback: remove native programs before any new
// stock program can execute; API failure restores the previous complete set.
let registered = [ { id: 'old-user-script', js: [ { code: 'void 0;' } ] } ];
let nativeRemoved = false;
let apiEnabled = true;
let failRegistration = false;
const operations = [];
const storage = new Map();
const shared = { schema: 1, payload: scriptletExceptionPayload(exception('sandbox', 0, [ 'example.test' ]), optimal),
    stock: [], nativeExclusions: new Map([ [ 'stock-test', [ 'example.test' ] ] ]) };
const registration = vm.createContext({
    Map, Set, Array, SCRIPTLET_EXCEPTION_SLOT, SCRIPTLET_WARNINGS_KEY, bindScriptletExceptions,
    compiledStorageKey, matchesFromHostnames, intersectHostnameIters,
    supportsUserScripts: () => apiEnabled,
    getFilteringModeDetails: async () => optimal,
    sharedScriptletContext: async () => shared,
    stockScriptletSources: async () => ({ MAIN: [ { id: 'stock-test-main-scriptlets', code: compile(0), hostnames: [ '*' ] } ] }),
    prepareNativeStockScriptlets: () => [],
    removeNativeStockScriptlets: async () => { nativeRemoved = true; operations.push('remove-native'); return [ { id: 'stock-test.main' } ]; },
    restoreNativeStockScriptlets: async () => { nativeRemoved = false; operations.push('restore-native'); },
    localRead: async key => structuredClone(storage.get(key)),
    localWrite: async (key, value) => { storage.set(key, value); },
    ublockPlusLog: () => {}, recordLoggerEvent: () => {},
    browser: { userScripts: {
        getScripts: async () => structuredClone(registered),
        configureWorld: async () => operations.push('configure'),
        unregister: async () => { registered = []; operations.push('unregister'); },
        register: async value => {
            operations.push('register');
            assert.equal(nativeRemoved, true);
            if ( failRegistration ) { failRegistration = false; throw new Error('native API failure'); }
            registered = structuredClone(value);
        },
    } },
});
vm.runInContext(section(registrySource, 'function prepareUserScripts(') + '\n' +
    section(registrySource, 'async function register(') + '\n' + section(registrySource, 'async function restore('), registration);
const previous = structuredClone(registered);
failRegistration = true;
await assert.rejects(registration.register('generation'), /native API failure/);
assert.deepEqual(registered, previous);
assert.equal(nativeRemoved, false);
operations.length = 0;
const snapshot = await registration.register('generation');
assert.equal(snapshot.stockScriptlets, true);
assert.equal(operations[0], 'remove-native');
assert.equal(registered.length, 1);
assert.equal(registered[0].world, 'MAIN');
assert.equal(run(registered[0].js[0].code.replace(JSON.stringify(shared.payload), '/* $scriptletExceptionData$ */ null'), shared.payload.exceptions).length, 1);
await registration.restore(snapshot);
assert.deepEqual(registered, previous);
assert.equal(nativeRemoved, false);
apiEnabled = false;
const fallback = await registration.register('generation');
assert.equal(fallback.stockScriptlets, false);
assert.equal(fallback.warnings.length, 1);
assert.match(storage.get(SCRIPTLET_WARNINGS_KEY)[0], /Allow User Scripts/);
await registration.restore(fallback);
assert.equal(nativeRemoved, false);
apiEnabled = true;
shared.schema = undefined;
const legacySnapshot = await registration.register('legacy-generation');
assert.equal(registered.length, 0, 'Unknown legacy exceptions defer every scriptlet source');
assert.match(storage.get(SCRIPTLET_WARNINGS_KEY)[0], /predates shared exceptions/);
await registration.restore(legacySnapshot);
assert.deepEqual(registered, previous, 'Legacy source/cache data and rollback snapshot remain available');
shared.schema = 1;

// Disabled stock sources do not contribute exceptions to another source.
const context = vm.createContext({
    Map, Set, Array, collectScriptletExceptions, nativeScriptletExclusions,
    scriptletExceptionPayload, compiledStorageKey,
    localRead: async () => [],
    getEnabledRulesetsDetails: async () => [ { id: 'enabled' } ],
    readPackagedJSON: async path => path.includes('exceptions') ? [
        [ 'enabled', { exceptions: [], tokens: [] } ],
        [ 'disabled', { exceptions: exception('disabled', 0, [ '*' ]), tokens: [] } ],
    ] : [],
});
const sharedStart = stockRegistrySource.indexOf('export async function sharedScriptletContext(');
const sharedEnd = stockRegistrySource.indexOf('\nexport async function stockScriptletSources', sharedStart);
vm.runInContext(stockRegistrySource.slice(sharedStart, sharedEnd).replace(/^export /, ''), context);
assert.equal((await context.sharedScriptletContext('generation', optimal)).payload.exceptions.length, 0);
const nativePreparation = vm.createContext({ Set, Object, intersectHostnameIters, matchesFromHostnames });
const prepareStart = stockRegistrySource.indexOf('export function prepareNativeStockScriptlets(');
const prepareEnd = stockRegistrySource.indexOf('\nexport async function removeNativeStockScriptlets', prepareStart);
vm.runInContext(stockRegistrySource.slice(prepareStart, prepareEnd).replace(/^export /, ''), nativePreparation);
for ( const { world, hostnames } of registrationScopes ) {
    const directives = nativePreparation.prepareNativeStockScriptlets({
        stock: [ { id: 'native-stock', worlds: { [world]: hostnames } } ], nativeExclusions: new Map(),
    }, { none: new Set(), basic: new Set(), optimal: new Set(), complete: new Set([ 'all-urls' ]) });
    assert.equal(directives.length, 1);
    assert.deepEqual(Array.from(directives[0].matches),
        [ '*://*.child.example.test/*', '*://*.unrelated.test/*' ],
        'Native packaged registration must not inject on unrelated origins for exception lookup');
}
const scopedOrigin = nativePreparation.prepareNativeStockScriptlets({
    stock: [ { id: 'stock-test', worlds: { MAIN: [ '*' ] } } ],
    nativeExclusions: new Map([ [ 'stock-test', [ 'except.example.test' ] ] ]),
}, { none: new Set([ 'off.example.test' ]), basic: new Set(),
    optimal: new Set([ 'example.test' ]), complete: new Set() }, true);
assert.equal(scopedOrigin.length, 1);
assert.equal(scopedOrigin[0].id, 'stock-test.origin.main');
assert.equal(scopedOrigin[0].matchOriginAsFallback, true);
assert.deepEqual(Array.from(scopedOrigin[0].excludeMatches),
    [ '*://*.off.example.test/*', '*://*.except.example.test/*' ]);

// Compile the reviewed inline site filters from the release configuration and
// execute the real bundled set-constant implementation. The fixture models the
// site's later var assignment; it does not execute downloaded website code.
const siteRuleset = JSON.parse(await read('../platform/mv3/rulesets.json'))
    .find(entry => entry.id === 'ublock-filters');
const sourceCompiler = vm.createContext({ Map, JSON });
vm.runInContext(section(compilerSource, 'function compileScriptletFilter('), sourceCompiler);
const compileSiteFixes = (extra = []) => {
    const details = new Map();
    const parser = new sfp.AstFilterParser({ trustedSource: true });
    for ( const line of [ ...(siteRuleset.filters || []), ...extra ] ) {
        parser.parse(line);
        assert.equal(parser.hasError(), false, line);
        if ( parser.isScriptletFilter() ) {
            sourceCompiler.compileScriptletFilter(parser, details);
        }
    }
    realCompiler.reset();
    for ( const entry of details.values() ) { realCompiler.compile(siteRuleset.id, entry); }
    return realCompiler.commit(siteRuleset.id, template).MAIN;
};
const sampletteFix = compileSiteFixes();
assert.ok(sampletteFix, 'Reviewed site filters must produce a MAIN-world program');
const runSiteFix = (program, hostname) => {
    const page = vm.createContext({ URL, Request, EventTarget, console,
        document: { location: { origin: `https://${hostname}` },
            readyState: 'loading', currentScript: {} } });
    vm.runInContext('self = globalThis; window = globalThis;', page);
    vm.runInContext(program.code, page);
    page.document.currentScript = {};
    vm.runInContext('var pwAdsForceDisabled = false; var isPro = false; ' +
        'var detectorPolling = !pwAdsForceDisabled;', page);
    return { flag: page.pwAdsForceDisabled, polling: page.detectorPolling, isPro: page.isPro };
};
for ( const hostname of [ 'samplette.io', 'child.samplette.io' ] ) {
    assert.deepEqual(runSiteFix(sampletteFix, hostname),
        { flag: true, polling: false, isPro: false });
}
for ( const hostname of [ 'unrelated.test', 'notsamplette.io', 'samplette.io.example' ] ) {
    assert.deepEqual(runSiteFix(sampletteFix, hostname),
        { flag: false, polling: true, isPro: false });
}
const exceptedSiteFix = compileSiteFixes([
    'samplette.io#@#+js(set-constant, pwAdsForceDisabled, true)',
]);
assert.deepEqual(runSiteFix(exceptedSiteFix, 'samplette.io'),
    { flag: false, polling: true, isPro: false }, 'Ordinary scriptlet exceptions preserve the page state');
const sampletteRegistration = { stock: [ {
    id: siteRuleset.id, worlds: { MAIN: sampletteFix.hostnames },
} ], nativeExclusions: new Map() };
assert.equal(nativePreparation.prepareNativeStockScriptlets(sampletteRegistration, {
    none: new Set([ 'all-urls' ]), basic: new Set(), optimal: new Set(), complete: new Set(),
}).length, 0, 'Off cannot register the packaged site fix');
const sampletteDirectives = nativePreparation.prepareNativeStockScriptlets(sampletteRegistration, {
    none: new Set([ 'child.samplette.io' ]), basic: new Set(),
    optimal: new Set(), complete: new Set([ 'all-urls' ]),
});
assert.equal(sampletteDirectives.length, 1);
assert.deepEqual(Array.from(sampletteDirectives[0].excludeMatches), [ '*://*.child.samplette.io/*' ],
    'An Off child is excluded while its parent keeps protection');

let nativeScripts = [
    { id: 'cosmetic-unrelated', js: [ '/js/scripting/css-api.js' ] },
    { id: 'new-stock.main', js: [ '/rulesets/scripting/scriptlet/main/new-stock.js' ] },
];
const nativeContext = vm.createContext({
    Array, Set, browser: { scripting: {
        getRegisteredContentScripts: async () => structuredClone(nativeScripts),
        unregisterContentScripts: async ({ ids }) => { nativeScripts = nativeScripts.filter(s => !ids.includes(s.id)); },
        registerContentScripts: async scripts => { nativeScripts.push(...structuredClone(scripts)); },
    } },
});
vm.runInContext(stockRegistrySource.slice(stockRegistrySource.indexOf('export async function removeNativeStockScriptlets('))
    .replaceAll('export async function ', 'async function '), nativeContext);
await nativeContext.restoreNativeStockScriptlets([]);
assert.deepEqual(nativeScripts.map(s => s.id), [ 'cosmetic-unrelated' ], 'Empty snapshot removes replacement stock programs');
nativeScripts.push({ id: 'new-stock.main', js: [ '/rulesets/scripting/scriptlet/main/new-stock.js' ] });
await nativeContext.restoreNativeStockScriptlets([ { id: 'old-stock.main', js: [ '/rulesets/scripting/scriptlet/main/old-stock.js' ] } ]);
assert.deepEqual(nativeScripts.map(s => s.id), [ 'cosmetic-unrelated', 'old-stock.main' ], 'Rollback removes newly enabled stock IDs');

const validator = await read('./validate-mv3.mjs');
const validationStart = validator.indexOf('const validateSharedScriptletData =');
const validationEnd = validator.indexOf('\nconst rootStat =', validationStart);
assert.ok(validationStart > 0 && validationEnd > validationStart);
const packaged = new Map([
    [ 'scriptlet-details.json', JSON.stringify([ [ 'test', { MAIN: [ '*' ] } ] ]) ],
    [ 'scriptlet-exceptions.json', JSON.stringify([ [ 'test', { exceptions: [], tokens: [] } ] ]) ],
    [ 'main/test.js', compile(0) ],
    [ 'origin/main/test.js', maker.originOnlyCode(compile(0)) ],
]);
const validationErrors = [];
const validationContext = vm.createContext({
    Map, Set, Array, JSON, path, extensionDir: '/fixture',
    fs: { readFile: async filename => {
        const relative = filename.replaceAll('\\', '/');
        const key = [ ...packaged.keys() ].sort((a, b) => b.length - a.length).find(k => relative.endsWith('/' + k));
        if ( key === undefined ) { throw new Error('Missing fixture file'); }
        return packaged.get(key);
    } },
    reportError: message => validationErrors.push(message),
    isPlainObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
});
vm.runInContext(validator.slice(validationStart, validationEnd) + '\nglobalThis.validate = validateSharedScriptletData;', validationContext);
await validationContext.validate(); assert.deepEqual(validationErrors, []);
packaged.set('origin/main/test.js', compile(0));
await validationContext.validate(); assert.ok(validationErrors.some(error => error.includes('unsafe guard')));
validationErrors.length = 0;
packaged.set('origin/main/test.js', maker.originOnlyCode(compile(0)));
packaged.delete('scriptlet-exceptions.json');
await validationContext.validate(); assert.ok(validationErrors.some(error => error.includes('metadata is missing')));

console.log('Cross-source scriptlet exceptions: aliases, worlds, scopes, Basic/Off policy, native fallback and rollback passed.');
