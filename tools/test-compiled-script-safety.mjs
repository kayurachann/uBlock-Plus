/* uBlock Plus+ — compiled script scope and exception regressions. GPL-3.0-or-later. */
import * as sfp from '../src/js/static-filtering-parser.js';
import { hostnameCompare, isHnRegexOrPath } from '../platform/mv3/extension/js/offscreen/make-utils.js';
import { intersectHostnameIters, isScriptlet, matchesFromHostnames, subtractHostnameIters } from '../platform/mv3/extension/js/utils.js';
import { COMPILED_FILTERS_REVISION } from '../platform/mv3/extension/js/compiled-cache.js';
import assert from 'node:assert/strict';
import { compiledStorageKey } from '../platform/mv3/extension/js/compiled-storage.js';
import fs from 'node:fs/promises';
import { literalStrFromRegex } from '../src/js/regex-analyzer.js';
import vm from 'node:vm';

const readSource = async name => (await fs.readFile(new URL(
    `../platform/mv3/extension/js/${name}`, import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
const [ registration, compiler, cosmeticMaker, cosmeticTemplate, filterManager, toolbar ] = await Promise.all([
    readSource('compiled-filters.js'), readSource('offscreen/compile-filters.js'),
    readSource('offscreen/make-cosmetic-filters.js'),
    readSource('offscreen/css-compiled.template.js'),
    readSource('filter-manager.js'),
    readSource('action.js'),
]);

// Evaluate the real functions with browser effects replaced by small adapters.
// Compiler imports are build-time copies, so no generated dist tree is needed.
function section(source, marker) {
    const start = source.indexOf(marker);
    const end = source.indexOf('\n/******************************************************************************', start);
    assert.ok(start >= 0 && end > start, `Missing source section ${marker}`);
    return source.slice(start, end).replace(/^export /, '');
}

const failures = [];
async function check(name, task) {
    try { await task(); }
    catch ( error ) { failures.push(new Error(`${name}: ${error.message}`, { cause: error })); }
}

function patternApplies(pattern, hostname) {
    if ( pattern === '<all_urls>' ) { return true; }
    const match = /^\*:\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern);
    assert.ok(match, `Invalid match pattern ${pattern}`);
    return hostname === match[2] || Boolean(match[1]) && hostname.endsWith(`.${match[2]}`);
}
function applies(directive, hostname) {
    return directive.matches.some(pattern => patternApplies(pattern, hostname)) &&
        !(directive.excludeMatches || []).some(pattern => patternApplies(pattern, hostname));
}

await check('Compiled registrations respect filtering levels', async () => {
    let modes;
    let scripts = [];
    const makeStored = realm => ({
        ISOLATED: [ { id: `${realm}-css`, code: 'void 0;', hostnames: [ '*' ] } ],
        MAIN: [ { id: `${realm}-js`, code: 'void 0;', hostnames: [ 'parent.test' ] } ],
    });
    const context = vm.createContext({
        Set, intersectHostnameIters, matchesFromHostnames, compiledStorageKey,
        supportsUserScripts: () => true,
        getFilteringModeDetails: async () => modes,
        localRead: async key => makeStored(key.includes('sandboxFilters') ? 'sandbox' : 'imported'),
        ublockPlusLog: () => {},
        browser: { userScripts: {
            getScripts: async () => structuredClone(scripts),
            unregister: async () => { scripts = []; },
            register: async value => { scripts = structuredClone(value); },
        } },
    });
    vm.runInContext(section(registration, 'function prepareUserScripts(') + '\n' +
        section(registration, 'async function register('), context);
    for ( const defaultMode of [ 'none', 'basic', 'optimal', 'complete' ] ) {
        modes = Object.fromEntries([ 'none', 'basic', 'optimal', 'complete' ]
            .map(name => [ name, new Set(name === defaultMode ? [ 'all-urls' ] : []) ]));
        await context.register('test');
        const sandbox = scripts.filter(script => script.id.startsWith('sandbox'));
        const imported = scripts.filter(script => script.id.startsWith('imported'));
        assert.equal(sandbox.length !== 0, defaultMode !== 'none', defaultMode);
        assert.equal(imported.length !== 0,
            defaultMode === 'optimal' || defaultMode === 'complete', defaultMode);

        modes.none.add('off.parent.test');
        modes.basic.add('basic.parent.test');
        modes.complete.add('parent.test');
        await context.register('test');
        for ( const script of scripts ) {
            assert.equal(applies(script, 'off.parent.test'), false, `${defaultMode}: Off child`);
            assert.equal(applies(script, 'sub.off.parent.test'), false, `${defaultMode}: Off descendant`);
            assert.equal(applies(script, 'active.parent.test'), true, `${defaultMode}: Complete parent`);
            if ( script.id.startsWith('imported') ) {
                assert.equal(applies(script, 'basic.parent.test'), false, `${defaultMode}: Basic child`);
            }
            if ( defaultMode === 'none' ||
                defaultMode === 'basic' && script.id.startsWith('imported') ) {
                assert.equal(applies(script, 'unrelated.test'), false, `${defaultMode}: unrelated`);
            }
        }
    }
    // A filter scoped to a parent still applies on its explicitly enabled child.
    modes = { none: new Set([ 'all-urls' ]), basic: new Set(),
        optimal: new Set([ 'child.parent.test' ]), complete: new Set() };
    await context.register('test');
    assert.ok(scripts.length > 0);
    for ( const script of scripts ) {
        assert.equal(applies(script, 'child.parent.test'), true);
        assert.equal(applies(script, 'parent.test'), false);
        assert.equal(applies(script, 'other.parent.test'), false);
    }
});

await check('Saved cosmetic registrations preserve Off children', async () => {
    const context = vm.createContext({
        Map, intersectHostnameIters, subtractHostnameIters, matchesFromHostnames, isScriptlet,
        getAllCustomFilters: async () => [ [ 'parent.test', [ '.ad' ] ],
            [ 'script-only.test', [ '+js(set-constant, test, true)' ] ] ],
    });
    vm.runInContext(section(filterManager, 'const isProcedural =') + '\n' +
        section(filterManager, 'export async function registerCustomFilters('), context);
    for ( const enabled of [ 'parent.test', 'child.parent.test' ] ) {
        const target = { toAdd: [], filteringModeDetails: {
            none: new Set([ 'all-urls', `off.${enabled}` ]), basic: new Set(),
            optimal: new Set([ enabled ]), complete: new Set(),
        } };
        await context.registerCustomFilters(target);
        assert.equal(target.toAdd.length, 1, enabled);
        const directive = target.toAdd[0];
        assert.equal(applies(directive, enabled), true);
        assert.equal(applies(directive, `off.${enabled}`), false);
        assert.equal(applies(directive, `sub.off.${enabled}`), false);
        assert.equal(applies(directive, 'unrelated.test'), false);
        assert.equal(applies(directive, 'script-only.test'), false);
        if ( enabled !== 'parent.test' ) {
            assert.equal(applies(directive, 'parent.test'), false);
        }
    }
});

await check('Concurrent toolbar registration cannot broaden saved cosmetics', async () => {
    const savedFilters = Promise.withResolvers();
    const context = vm.createContext({
        Map, Set, intersectHostnameIters, subtractHostnameIters,
        matchesFromHostnames, isScriptlet,
        getAllCustomFilters: () => savedFilters.promise,
        disableToolbarIcon: () => {},
        enableToolbarIcon: () => {},
    });
    vm.runInContext('let reverseMode = false;\n' +
        section(filterManager, 'const isProcedural =') + '\n' +
        section(filterManager, 'export async function registerCustomFilters(') + '\n' +
        toolbar.slice(toolbar.indexOf('export async function registerToolbarIconToggler('))
            .replace(/^export /, ''), context);
    const target = { toAdd: [], filteringModeDetails: {
        none: new Set([ 'all-urls', 'off.child.parent.test' ]),
        basic: new Set(), optimal: new Set(),
        complete: new Set([ 'child.parent.test' ]),
    } };
    const before = structuredClone(target.filteringModeDetails);
    // scripting-manager starts these together. Custom filters await storage,
    // giving the toolbar registrar time to consume the same mode snapshot.
    const registered = Promise.all([
        context.registerCustomFilters(target),
        context.registerToolbarIconToggler(target),
    ]);
    savedFilters.resolve([ [ 'parent.test', [ '#personal-filter' ] ] ]);
    await registered;
    const directive = target.toAdd.find(item => item.id === 'css-user');
    assert.ok(directive);
    assert.equal(applies(directive, 'parent.test'), false, 'Off parent');
    assert.equal(applies(directive, 'child.parent.test'), true, 'Complete child');
    assert.equal(applies(directive, 'sibling.parent.test'), false, 'Off sibling');
    assert.equal(applies(directive, 'off.child.parent.test'), false, 'Off descendant');
    assert.deepEqual(target.filteringModeDetails, before);
});

const compilerContext = vm.createContext({ Map, JSON, hostnameCompare, isHnRegexOrPath, literalStrFromRegex });
vm.runInContext(section(compiler, 'function compileScriptletFilter(') + '\n' +
    section(compiler, 'function parseExpires(') + '\n' +
    section(compiler, 'function mergeCompiledData(') + '\n' +
    section(compiler, 'export function compileCosmeticFilter(') + '\n' +
    cosmeticMaker.slice(cosmeticMaker.indexOf('export function makeCosmeticScripts('))
        .replace(/^export /, ''), compilerContext);

function compileScriptletLines(lines) {
    const parser = new sfp.AstFilterParser({ nativeCssHas: true });
    const output = new Map();
    for ( const line of lines ) {
        parser.parse(line);
        assert.equal(parser.hasError(), false, line);
        assert.equal(parser.isScriptletFilter(), true, line);
        compilerContext.compileScriptletFilter(parser, output);
    }
    return output;
}
await check('Exact scriptlet exceptions survive compilation', () => {
    const block = 'parent.test##+js(set-constant, auditProbe, true)';
    const exception = 'child.parent.test#@#+js(set-constant, auditProbe, true)';
    for ( const lines of [ [ block, exception ], [ exception, block ] ] ) {
        const output = compileScriptletLines(lines);
        assert.equal(output.size, 1);
        const details = [ ...output.values() ][0];
        assert.deepEqual(Array.from(details.matches), [ 'parent.test' ]);
        assert.deepEqual(Array.from(details.excludeMatches || []), [ 'child.parent.test' ]);
    }
    const broad = compileScriptletLines([ block, '#@#+js()' ]).get('[]');
    assert.deepEqual(Array.from(broad?.excludeMatches || []), [ '*' ]);
    const negated = compileScriptletLines([ block, '~child.parent.test#@#+js(set-constant, auditProbe, true)' ]);
    assert.equal([ ...negated.values() ][0].excludeMatches, undefined);

    // Separate imported sources are merged before generating their scripts.
    for ( const reverse of [ false, true ] ) {
        const sources = [ block, exception ].map(line => ({
            scriptletDetails: compileScriptletLines([ line ]),
        }));
        if ( reverse ) { sources.reverse(); }
        compilerContext.mergeCompiledData(sources[0], sources[1]);
        const details = [ ...sources[0].scriptletDetails.values() ][0];
        assert.deepEqual(Array.from(details.matches), [ 'parent.test' ]);
        assert.deepEqual(Array.from(details.excludeMatches), [ 'child.parent.test' ]);
    }
});

await check('Imported expiry values are days and unit casing is equivalent', () => {
    for ( const [ text, days ] of [
        [ '1w', 7 ], [ '1W', 7 ], [ '2 weeks', 14 ], [ '7d', 7 ],
        [ '4h', 1 / 6 ], [ '4H', 1 / 6 ], [ '240m', 1 / 6 ],
        [ '240M', 1 / 6 ], [ '1h', 1 / 6 ], [ '3', 3 ],
        [ '0', undefined ], [ 'invalid', undefined ],
    ] ) {
        assert.equal(compilerContext.parseExpires(text), days, text);
    }
});

await check('Old imported compiler caches are refreshed', async () => {
    let cached;
    let refreshes = 0;
    const fresh = { source: 'new compilation' };
    const current = { source: 'current cached compilation' };
    const context = vm.createContext({
        COMPILED_FILTERS_REVISION,
        compilerStorage: { get: async key => ({ [key]: cached }) },
        pendingImportedMetadataKey: id => `metadata.${id}`,
        updateList: async () => { refreshes += 1; return fresh; },
        deserializeCompiledListOr: async () => current,
        s14e: { deserialize: () => current },
    });
    vm.runInContext(section(compiler, 'async function getCompiledListData('), context);
    for ( const envelope of [ 'old serialized data', { serialized: 'old' },
        { serialized: 'old', compilerRevision: COMPILED_FILTERS_REVISION - 1 } ] ) {
        cached = envelope;
        assert.equal(await context.getCompiledListData({ id: 'https://test/list' }), fresh);
    }
    assert.equal(refreshes, 3);
    cached = { serialized: 'current', compilerRevision: COMPILED_FILTERS_REVISION };
    assert.equal(await context.getCompiledListData({ id: 'https://test/list' }), current);
    assert.equal(refreshes, 3);
    assert.match(compiler, /compilerRevision:\s*COMPILED_FILTERS_REVISION/,
        'Fresh compiler envelopes must persist the semantic revision');
});

await check('Regex-host cosmetic filtering runs and honors exceptions', async () => {
    const parser = new sfp.AstFilterParser({ nativeCssHas: true });
    async function run(lines) {
        const output = new Map();
        for ( const line of lines ) {
            parser.parse(line);
            assert.equal(parser.hasError(), false, line);
            assert.equal(parser.isCosmeticFilter(), true, line);
            compilerContext.compileCosmeticFilter(parser, output);
        }
        const data = compilerContext.makeCosmeticScripts('test', output).data;
        const inserted = [];
        const context = vm.createContext({
            document: { location: { hostname: 'site.test' } },
            self: { $cssSpecificData$: data,
                isolatedAPI: { contexts: { hostnames: [ 'site.test' ], entities: [] }, binarySearch: () => -1 },
                cssAPI: { insert: css => inserted.push(css) } },
        });
        const executable = cosmeticTemplate.slice(cosmeticTemplate.indexOf('(async function'),
            cosmeticTemplate.lastIndexOf('void 0;'));
        await vm.runInContext(executable, context);
        return inserted;
    }
    const block = '/^site\\.test$/##.ad';
    const exception = '/^site\\.test$/#@#.ad';
    assert.match((await run([ block ]))[0], /\.ad\{display:none!important;\}/);
    assert.deepEqual(await run([ block, exception ]), []);
    assert.deepEqual(await run([ '/^other\\.test$/##.ad' ]), []);
});

if ( failures.length ) { throw new AggregateError(failures, 'Compiled-script safety checks failed'); }
console.log('Compiled-script scope, exception and cosmetic runtime tests passed.');
