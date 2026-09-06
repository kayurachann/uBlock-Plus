/* uBlock Plus+ — shared scriptlet registration data. GPL-3.0-or-later. */

import { browser, localRead, runtime } from './ext.js';
import {
    collectScriptletExceptions,
    nativeScriptletExclusions,
    scriptletExceptionPayload,
} from './scriptlet-exceptions.js';
import { intersectHostnameIters, matchesFromHostnames } from './utils.js';
import { compiledStorageKey } from './compiled-storage.js';
import { getEnabledRulesetsDetails } from './ruleset-manager.js';

async function readPackagedJSON(path) {
    const response = await fetch(runtime.getURL(path));
    if ( response.ok !== true ) { throw new Error(`Missing packaged scriptlet data: ${path}`); }
    return response.json();
}

export async function sharedScriptletContext(generation, modes) {
    const [ enabled, metadataEntries, scriptEntries, sandbox, imported, schema ] = await Promise.all([
        getEnabledRulesetsDetails(true),
        readPackagedJSON('/rulesets/scriptlet-exceptions.json'),
        readPackagedJSON('/rulesets/scriptlet-details.json'),
        localRead(compiledStorageKey(generation, 'sandboxFilters.scriptletExceptions')),
        localRead(compiledStorageKey(generation, 'importedFilters.scriptletExceptions')),
        localRead(compiledStorageKey(generation, 'scriptletExceptions.schema')),
    ]);
    const metadata = new Map(metadataEntries);
    const scripts = new Map(scriptEntries);
    const sources = [ [ 'sandbox', sandbox ], [ 'imported', imported ] ];
    for ( const { id } of enabled ) {
        sources.push([ id, metadata.get(id)?.exceptions ]);
    }
    const exceptions = collectScriptletExceptions(sources);
    const nativeExclusions = new Map(enabled.map(({ id }) => [ id,
        nativeScriptletExclusions(id, metadata.get(id)?.tokens || [], exceptions),
    ]));
    return {
        schema,
        payload: scriptletExceptionPayload(exceptions, modes),
        nativeExclusions,
        stock: enabled.filter(({ id }) => scripts.has(id)).map(({ id }) => ({
            id, worlds: scripts.get(id),
        })),
    };
}

export async function stockScriptletSources(context) {
    const output = { MAIN: [], ISOLATED: [] };
    for ( const { id, worlds } of context.stock ) {
        for ( const world of Object.keys(worlds) ) {
            const path = `/rulesets/scripting/scriptlet/${world.toLowerCase()}/${id}.js`;
            const response = await fetch(runtime.getURL(path));
            if ( response.ok !== true ) { throw new Error(`Missing packaged scriptlet: ${id}`); }
            output[world].push({
                id: `stock-${id}-${world.toLowerCase()}-scriptlets`,
                code: await response.text(),
                hostnames: worlds[world],
            });
        }
    }
    return output;
}

export function prepareNativeStockScriptlets(context, modes, originOnly = false) {
    const included = [ ...modes.optimal, ...modes.complete ];
    const excluded = [ ...modes.none, ...modes.basic ].filter(hn => hn !== 'all-urls');
    const directives = [];
    for ( const { id, worlds } of context.stock ) {
        const exceptionHostnames = context.nativeExclusions.get(id) || [];
        if ( exceptionHostnames.includes('*') ) { continue; }
        for ( const [ world, hostnames ] of Object.entries(worlds) ) {
            const scoped = included.includes('all-urls') ? hostnames : [
                ...intersectHostnameIters(hostnames, included),
                ...intersectHostnameIters(included, hostnames),
            ];
            const matches = matchesFromHostnames(new Set(scoped));
            if ( matches.length === 0 ) { continue; }
            const directive = {
                id: `${id}.${originOnly ? 'origin.' : ''}${world.toLowerCase()}`,
                js: [ `/rulesets/scripting/scriptlet/${originOnly ? 'origin/' : ''}${world.toLowerCase()}/${id}.js` ],
                matches,
                allFrames: true,
                matchOriginAsFallback: true,
                runAt: 'document_start',
                world,
            };
            const excludeMatches = matchesFromHostnames(new Set([ ...excluded, ...exceptionHostnames ]));
            if ( excludeMatches.length ) { directive.excludeMatches = excludeMatches; }
            directives.push(directive);
        }
    }
    return directives;
}

export async function removeNativeStockScriptlets(affectedIds) {
    if ( browser.scripting === undefined ) { return []; }
    const scripts = await browser.scripting.getRegisteredContentScripts();
    const previous = scripts.filter(script => script.js?.some(path =>
        /(?:^|\/)rulesets\/scripting\/scriptlet\//.test(path)
    ) && (affectedIds === undefined || affectedIds.some(id =>
            script.id === `${id}.main` || script.id === `${id}.isolated`
        )));
    if ( previous.length ) {
        await browser.scripting.unregisterContentScripts({ ids: previous.map(script => script.id) });
    }
    return previous;
}

export async function restoreNativeStockScriptlets(previous) {
    if ( Array.isArray(previous) === false ) { return; }
    await removeNativeStockScriptlets();
    if ( previous.length ) {
        await browser.scripting.registerContentScripts(previous);
    }
}
