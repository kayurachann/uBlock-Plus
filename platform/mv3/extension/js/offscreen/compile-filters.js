/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2026-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import * as makeScriptlets from './make-scriptlets.js';
import * as s14e from '../../lib/s14e-serializer.js';
import * as sfp from '../static-filtering-parser.js';

import {
    NetworkFilterCompiler,
    minimizeRules,
    minimizeRuleset,
    validateRules,
} from '../ubo-parser.js';

import {
    POPUP_DEFERRED_ROUTE_CODE,
    POPUP_RUNTIME_ROUTE_CODE,
} from '../compiled-popup-matcher.js';
import {
    compiledStorageKey,
    newCompiledGeneration,
} from '../compiled-storage.js';
import { createCompilerStorageClient } from '../offscreen-storage.js';
import { deserializeCompiledListOr } from '../compiled-cache.js';
import { fetchList } from './fetch-list.js';
import { isCredentialFreeHTTPS } from '../imported-fetch-policy.js';
import { isVerifiedSourceKey } from '../verified-source-handoff.js';
import { makeCosmeticScripts } from './make-cosmetic-filters.js';
import { pendingImportedMetadataKey } from '../imported-list-metadata.js';
import { safeReplace } from './safe-replace.js';

/******************************************************************************/

const browser = (self.browser || self.chrome);

let resourceTypes;
const compilationErrors = [];
const compiledIntegrityUpdates = [];
const importedListUpdates = [];
const requestedGeneration = new URL(self.location.href)
    .searchParams.get('generation');
const compiledGeneration = /^[a-f0-9]{32}$/.test(requestedGeneration)
    ? requestedGeneration
    : newCompiledGeneration();
const compilerStorage = createCompilerStorageClient(
    browser.runtime, compiledGeneration
);

function reportProgress(stage, listid = '') {
    const pending = browser.runtime.sendMessage({
        what: 'compileFilters:progress',
        generation: compiledGeneration,
        stage,
        listid,
    });
    pending?.catch?.(( ) => { });
}

function stageImportedListUpdate(update) {
    if ( typeof update?.listid !== 'string' ) { return; }
    if ( /^[a-f0-9]{32}$/.test(update.metadataToken) === false ) { return; }
    const index = importedListUpdates.findIndex(
        candidate => candidate.listid === update.listid
    );
    if ( index === -1 ) {
        importedListUpdates.push(update);
    } else {
        importedListUpdates[index] = update;
    }
}

function stageCompiledIntegrity(list) {
    if ( list.sourceIntegrity === undefined ) { return; }
    if ( compiledIntegrityUpdates.some(update => update.listid === list.id) ) {
        return;
    }
    compiledIntegrityUpdates.push({
        listid: list.id,
        compiledIntegrity: list.sourceIntegrity,
    });
}

/******************************************************************************/

function parseExpires(s) {
    const matches = s.match(/(\d+)\s*([wdhm]?)/i);
    if ( matches === null ) { return; }
    let updateAfter = parseInt(matches[1], 10);
    if ( updateAfter === 0 ) { return; }
    if ( matches[2] === 'w' ) {
        updateAfter *= 7 * 24;
    } else if ( matches[2] === 'h' ) {
        updateAfter = Math.max(updateAfter, 4) / 24;
    } else if ( matches[2] === 'm' ) {
        updateAfter = Math.max(updateAfter, 240) / 1440;
    }
    return updateAfter;
}

/******************************************************************************/

function extractMetadataFromList(content, fields) {
    const out = {};
    const head = content.slice(0, 1024);
    for ( let field of fields ) {
        field = field.replace(/\s+/g, '-');
        const re = new RegExp(`^(?:! *|# +)${field.replace(/-/g, '(?: +|-)')}: *(.+)$`, 'im');
        const match = re.exec(head);
        let value = match && match[1].trim() || undefined;
        if ( value !== undefined && value.startsWith('%') ) {
            value = undefined;
        }
        field = field.toLowerCase().replace(
            /-[a-z]/g, s => s.charAt(1).toUpperCase()
        );
        out[field] = value;
    }
    // Pre-process known fields
    if ( out.lastModified ) {
        out.lastModified = (new Date(out.lastModified)).getTime() || 0;
    }
    if ( out.expires ) {
        out.expires = parseExpires(out.expires);
    }
    return out;
}

/******************************************************************************/

function compileScriptletFilter(parser, output) {
    if ( parser.hasOptions() === false ) { return; }
    const exception = parser.isException();
    const args = parser.getScriptletArgs();
    const argsToken = JSON.stringify(args);
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( exception ) { continue; }
        const details = output.get(argsToken) ?? {};
        if ( details.args === undefined ) {
            details.args = args;
            details.trustedSource = parser.options.trustedSource;
            output.set(argsToken, details);
        }
        if ( not ) {
            details.excludeMatches ??= [];
            details.excludeMatches.push(hn);
            continue;
        }
        details.matches ??= [];
        if ( details.matches[0] === '*' ) { continue; }
        if ( hn !== '*' ) {
            details.matches.push(hn);
        } else if ( parser.options.trustedSource ) {
            details.matches = [ '*' ];
        }
    }
}

/******************************************************************************/

export function compileCosmeticFilter(parser, output) {
    const { compiled, exception } = parser.result;
    if ( compiled === undefined ) { return; }
    const sanitized = sanitizeCompiledCosmeticFilter(compiled);
    const matches = [];
    const excludeMatches = [];
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( not && exception ) { continue; }
        if ( not || exception ) {
            excludeMatches.push(hn);
        } else if ( hn === '*' ) {
            if ( parser.options.trustedSource !== true ) { continue; }
            matches.length = 0;
            matches.push('*');
        } else {
            if ( matches[0] === '*' ) { continue; }
            matches.push(hn);
        }
    }
    // This should not happen
    if ( matches.length === 0 && excludeMatches.length === 0 ) { return; }
    // Only negated hostnames => generic cosmetic filter
    if ( exception === false ) {
        if ( matches.length === 0 && excludeMatches.length !== 0 ) { return; }
    }
    const details = output.get(sanitized) ?? {};
    if ( details.matches === undefined ) {
        details.matches = [];
        details.excludeMatches = [];
        output.set(sanitized, details);
    }
    if ( matches.length ) {
        if ( matches.includes('*') ) {
            details.matches = [ '*' ];
        } else if ( details.matches.includes('*') === false ) {
            details.matches.push(...matches);
        }
    }
    if ( excludeMatches.length ) {
        details.excludeMatches.push(...excludeMatches);
    }
}

function sanitizeCompiledCosmeticFilter(compiled) {
    if ( compiled.startsWith('{') === false ) { return compiled; }
    const parsed = JSON.parse(compiled);
    parsed.raw = undefined;
    return JSON.stringify(parsed);
}

/******************************************************************************/

export function compileFilters(listid, text, context = {}) {
    if ( Boolean(text) === false ) { return; }

    const parser = new sfp.AstFilterParser(context);

    const networkCompiler = new NetworkFilterCompiler({
        listid,
        resourceTypes,
    });
    const specificCosmeticDetails = new Map();
    const scriptletDetails = new Map();

    let lineBeg = 0;
    let lineNumber = 0;
    while ( lineBeg <= text.length ) {
        let lineEnd = text.indexOf('\n', lineBeg);
        if ( lineEnd === -1 ) { lineEnd = text.length; }
        const line = text.slice(lineBeg, lineEnd).trim();
        lineBeg = lineEnd + 1;
        lineNumber += 1;
        parser.parse(line);
        if ( parser.isNetworkFilter() ) {
            networkCompiler.add(parser, lineNumber);
            continue;
        }
        if ( parser.hasError() ) { continue; }
        if ( parser.isScriptletFilter() ) {
            if ( parser.hasOptions() === false ) { continue; }
            compileScriptletFilter(parser, scriptletDetails);
            continue;
        }
        if ( parser.isCosmeticFilter() ) {
            if ( parser.hasOptions() === false ) { continue; }
            compileCosmeticFilter(parser, specificCosmeticDetails);
            continue;
        }
    }

    const networkCompiled = networkCompiler.finish();
    const minimizedRules = networkCompiled.dnrRules;
    const regexRuleCount = minimizedRules.reduce((a, b) => {
        return b.condition.regexFilter ? a+1 : a;
    }, 0);

    return {
        filterStats: networkCompiled.filterStats,
        ruleStats: {
            total: minimizedRules.length,
            plain: minimizedRules.length - regexRuleCount,
            regex: regexRuleCount,
        },
        dnrRules: minimizedRules,
        popupFilters: networkCompiled.popupFilters,
        rejections: networkCompiled.rejections,
        specificCosmeticDetails,
        scriptletDetails,
    };
}

/******************************************************************************/

export async function toMv3Data(rulesetid, compiledData) {
    const isolated = [];
    const main = [];

    if ( Boolean(compiledData) === false ) { return; }

    if ( compiledData.scriptletDetails.size !== 0 ) {
        for ( const details of compiledData.scriptletDetails.values() ) {
            makeScriptlets.compile(rulesetid, details);
        }
        const template = await fetch('./scriptlet.template.js').then(response =>
            response.text()
        );
        const result = makeScriptlets.commit(rulesetid, template);
        if ( result.ISOLATED ) {
            const { hasRegexes, hasAncestors, hasEntities } = result.ISOLATED;
            const hostnames = hasRegexes || hasAncestors || hasEntities ||
                result.ISOLATED.hostnames.includes('*')
                ? '*'
                : result.ISOLATED.hostnames;
            isolated.push({
                id: `${rulesetid}-isolated-scriptlets`,
                code: result.ISOLATED.code,
                hostnames,
            });
        }
        if ( result.MAIN ) {
            const { hasRegexes, hasAncestors, hasEntities } = result.MAIN;
            const hostnames = hasRegexes || hasAncestors || hasEntities ||
                result.MAIN.hostnames.includes('*')
                ? '*'
                : result.MAIN.hostnames;
            main.push({
                id: `${rulesetid}-main-scriptlets`,
                code: result.MAIN.code,
                hostnames,
            });
        }
        makeScriptlets.reset();
    }

    if ( compiledData.specificCosmeticDetails.size ) {
        const result = makeCosmeticScripts(rulesetid, compiledData.specificCosmeticDetails);
        if ( result ) {
            const [
                cssAPI,
                isolatedAPI,
                proceduralAPI,
                template,
            ] = await Promise.all([
                fetch('../scripting/css-api.js').then(response => response.text()),
                fetch('../scripting/isolated-api.js').then(response => response.text()),
                fetch('../scripting/css-procedural-api.js').then(response => response.text()),
                fetch('./css-compiled.template.js').then(response => response.text()),
            ]);
            const code = [
                cssAPI,
                isolatedAPI,
                proceduralAPI,
                safeReplace(template, 'self.$cssSpecificData$', JSON.stringify(result.data)),
            ].join('\n');
            const hostnames = result.data.hasEntities || result.data.regexes.length
                ? '*'
                : result.data.hostnames;
            isolated.push({
                id: `${rulesetid}-css-specific`,
                code,
                hostnames,
            });
        }
    }

    const output = {}
    if ( compiledData.dnrRules.length ) {
        output.dnrRules = minimizeRuleset(compiledData.dnrRules);
        output.dnrRules = minimizeRules(output.dnrRules);
        const rejections = [];
        output.dnrRules = validateRules(output.dnrRules, rejections);
        if ( rejections.length !== 0 ) {
            const reasons = Array.from(new Set(
                rejections.map(a => a.reasonCode)
            )).sort();
            throw new TypeError(
                `Merged DNR validation failed: ${reasons.join(',')}`
            );
        }
    }
    if ( compiledData.popupFilters?.length ) {
        output.popupFilters = compiledData.popupFilters;
    }
    if ( isolated.length ) {
        output.isolated = isolated;
    }
    if ( main.length ) {
        output.main = main;
    }

    return output;
}

/******************************************************************************/

async function sha256Hex(bytes) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

async function verifyPinnedText(text, integrity) {
    const bytes = new TextEncoder().encode(text);
    if ( bytes.byteLength !== integrity.bytes ) {
        throw new Error('Pinned filter data has an unexpected size');
    }
    if ( await sha256Hex(bytes) !== integrity.digest ) {
        throw new Error('Pinned filter data failed SHA-256 verification');
    }
    if ( /^\s*!#include\b/im.test(text) ) {
        throw new Error(
            'Pinned Filter Store sources must be self-contained and ' +
            'cannot use !#include'
        );
    }
    return text;
}

async function readPinnedResponse(response, maximumBytes) {
    const reader = response.body?.getReader?.();
    if ( reader === undefined ) {
        throw new Error('Pinned filter response is not stream-readable');
    }
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if ( done ) { break; }
        total += value.byteLength;
        if ( total > maximumBytes ) {
            await reader.cancel();
            throw new Error('Pinned filter response exceeds its size limit');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for ( const chunk of chunks ) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function fetchPinnedText(list) {
    const { sourceIntegrity: integrity } = list;
    if ( isCredentialFreeHTTPS(list.id) === false ) {
        throw new Error('Pinned filter source must use credential-free HTTPS');
    }
    if ( isVerifiedSourceKey(
        list.verifiedSourceKey,
        integrity.digest
    ) ) {
        const bin = await compilerStorage.get(list.verifiedSourceKey);
        const cached = bin?.[list.verifiedSourceKey];
        await compilerStorage.remove(list.verifiedSourceKey);
        if ( cached !== undefined ) {
            const metadataMatches = cached.sourceURL === list.id &&
                cached.digest === integrity.digest &&
                cached.bytes === integrity.bytes &&
                typeof cached.text === 'string';
            if ( metadataMatches ) {
                try {
                    return await verifyPinnedText(cached.text, integrity);
                } catch {
                }
            }
            // Fall through to a credential-free network refetch. The handoff
            // is one-shot and cannot be trusted after any mismatch.
        }
    }

    const options = {
        cache: 'no-store',
        credentials: 'omit',
        // Pinned sources must name their final HTTPS resource directly. This
        // prevents an otherwise invisible HTTPS -> HTTP -> HTTPS redirect.
        redirect: 'error',
        referrerPolicy: 'no-referrer',
    };
    if ( typeof globalThis.AbortSignal?.timeout === 'function' ) {
        options.signal = globalThis.AbortSignal.timeout(30000);
    }
    const response = await fetch(list.id, options);
    if ( response.ok === false ||
        isCredentialFreeHTTPS(response.url) === false ) {
        throw new Error('Pinned filter source could not be fetched over HTTPS');
    }
    const contentLength = response.headers.get('content-length');
    if ( contentLength !== null ) {
        const declaredSize = Number(contentLength);
        if ( Number.isFinite(declaredSize) && declaredSize !== integrity.bytes ) {
            throw new Error('Pinned filter response has an unexpected size');
        }
    }
    const bytes = await readPinnedResponse(response, integrity.bytes);
    if ( bytes.byteLength !== integrity.bytes ) {
        throw new Error('Pinned filter response has an unexpected size');
    }
    if ( await sha256Hex(bytes) !== integrity.digest ) {
        throw new Error('Pinned filter response failed SHA-256 verification');
    }
    try {
        return verifyPinnedText(
            new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(bytes),
            integrity
        );
    } catch {
        throw new Error('Pinned filter response is not valid UTF-8 text');
    }
}

/******************************************************************************/

async function updateList(list) {
    const context = {
        env: [
            'chromium',
            'native_css_has',
            'mv3',
            'ublock',
            'ubol',
        ],
    };
    let text;
    try {
        if ( list.sourceIntegrity ) {
            text = await fetchPinnedText(list);
        } else {
            const asset = {
                urls: [ list.id ],
                maxBytes: list.maxSourceBytes,
                maxFetches: list.maxSourceFetches,
                requireHTTPS: true,
            };
            text = await fetchList(context, asset, ( ) => {
                browser.runtime.sendMessage({ what: 'keepAlive' });
            });
        }
        if ( Boolean(text) === false ) {
            throw new Error('Filter source returned no usable data');
        }
    } catch ( reason ) {
        compilationErrors.push({
            listid: list.id,
            message: reason?.message || `${reason}`,
        });
        return;
    }

    const metadata = extractMetadataFromList(text, [
        'Expires',
        'Homepage',
        'Title',
    ])
    if ( /^https?:\/\/\S+/.test(metadata.homepage) === false ) {
        metadata.homepage = undefined;
    }

    const compiled = compileFilters(list.id, text, {
        nativeCssHas: true,
    });
    if ( Boolean(compiled) === false ) { return; }

    const cacheKey = `rulesets.imported.compiled.${list.id}`;
    const pendingMetadata = {
        listid: list.id,
        metadataToken: newCompiledGeneration(),
        title: metadata.title,
        homeURL: metadata.homepage,
        expires: metadata.expires || 7,
        verifiedSourceKey: '',
        filterStats: compiled.filterStats,
        ruleStats: compiled.ruleStats,
        rejections: compiled.rejections,
    };
    const metadataKey = pendingImportedMetadataKey(list.id);
    await compilerStorage.set({
        [cacheKey]: {
            serialized: s14e.serialize(compiled, { compress: true }),
            sourceDigest: list.sourceIntegrity?.digest || '',
            sourceBytes: list.sourceIntegrity?.bytes ?? null,
            // A compile can fail after this individual list was refreshed.
            // The envelope points to a small metadata sidecar so the next
            // attempt can stage it without fetching again. Keeping the
            // sidecar separate avoids rewriting a multi-MiB cache entry when
            // the service worker commits metadata.
            pendingMetadataToken: pendingMetadata.metadataToken,
        },
        [metadataKey]: pendingMetadata,
    });
    stageImportedListUpdate(pendingMetadata);
    if ( list.sourceIntegrity ) {
        stageCompiledIntegrity(list);
    }

    return compiled;
}

/******************************************************************************/

async function getCompiledListData(list) {
    const cacheKey = `rulesets.imported.compiled.${list.id}`;
    const metadataKey = pendingImportedMetadataKey(list.id);
    const bin = await compilerStorage.get(cacheKey);
    const cached = bin?.[cacheKey];
    const serialized = typeof cached === 'string'
        ? cached
        : cached?.serialized;
    if ( Boolean(serialized) === false ) {
        return updateList(list);
    }
    if ( list.sourceIntegrity ) {
        if ( cached?.sourceDigest !== list.sourceIntegrity.digest ||
            cached?.sourceBytes !== list.sourceIntegrity.bytes ) {
            return updateList(list);
        }
    }
    const compiled = await deserializeCompiledListOr(
        serialized,
        s14e.deserialize,
        async ( ) => {
            await compilerStorage.remove([ cacheKey, metadataKey ]);
            return updateList(list);
        }
    );
    if ( Boolean(compiled) === false ) { return; }
    if ( list.sourceIntegrity ) { stageCompiledIntegrity(list); }
    const pendingMetadataToken = cached?.pendingMetadataToken;
    if ( pendingMetadataToken !== list.compiledMetadataToken &&
        /^[a-f0-9]{32}$/.test(pendingMetadataToken) ) {
        const metadataBin = await compilerStorage.get(metadataKey);
        const pendingMetadata = metadataBin?.[metadataKey];
        if ( pendingMetadata?.metadataToken === pendingMetadataToken ) {
            stageImportedListUpdate(pendingMetadata);
        }
    }
    return compiled;
}

/******************************************************************************/

function mergeCompiledData(to, from) {
    if ( from.dnrRules ) {
        if ( to.dnrRules ) {
            for ( const rule of from.dnrRules ) {
                to.dnrRules.push(rule);
            }
        } else {
            to.dnrRules = from.dnrRules;
        }
    }
    if ( from.specificCosmeticDetails ) {
        if ( to.specificCosmeticDetails ) {
            for ( const [ fromSelector, fromDetails ] of from.specificCosmeticDetails ) {
                const toDetails = to.specificCosmeticDetails.get(fromSelector);
                if ( toDetails ) {
                    if ( fromDetails.matches?.length ) {
                        if ( toDetails.matches?.length ) {
                            for ( const hostname of fromDetails.matches ) {
                                toDetails.matches.push(hostname);
                            }
                        } else {
                            toDetails.matches = fromDetails.matches;
                        }
                    }
                    if ( fromDetails.excludeMatches?.length ) {
                        if ( toDetails.excludeMatches?.length ) {
                            for ( const hostname of fromDetails.excludeMatches ) {
                                toDetails.excludeMatches.push(hostname);
                            }
                        } else {
                            toDetails.excludeMatches = fromDetails.excludeMatches;
                        }
                    }
                } else {
                    to.specificCosmeticDetails.set(fromSelector, fromDetails);
                }
            }
        } else {
            to.specificCosmeticDetails = from.specificCosmeticDetails;
        }
    }
    if ( from.scriptletDetails ) {
        if ( to.scriptletDetails ) {
            for ( const [ fromKey, fromDetails ] of from.scriptletDetails ) {
                const toDetails = to.scriptletDetails.get(fromKey);
                if ( toDetails ) {
                    toDetails.trustedSource ||= fromDetails.trustedSource;
                    if ( fromDetails.matches?.length ) {
                        if ( toDetails.matches?.length ) {
                            for ( const hostname of fromDetails.matches ) {
                                toDetails.matches.push(hostname);
                            }
                        } else {
                            toDetails.matches = fromDetails.matches;
                        }
                    }
                    if ( fromDetails.excludeMatches?.length ) {
                        if ( toDetails.excludeMatches?.length ) {
                            for ( const hostname of fromDetails.excludeMatches ) {
                                toDetails.excludeMatches.push(hostname);
                            }
                        } else {
                            toDetails.excludeMatches = fromDetails.excludeMatches;
                        }
                    }
                } else {
                    to.scriptletDetails.set(fromKey, fromDetails);
                }
            }
        } else {
            to.scriptletDetails = from.scriptletDetails;
        }
    }
    if ( from.popupFilters?.length ) {
        if ( to.popupFilters ) {
            to.popupFilters.push(...from.popupFilters);
        } else {
            to.popupFilters = from.popupFilters;
        }
    }
    if ( from.rejections?.length ) {
        if ( to.rejections ) {
            to.rejections.push(...from.rejections);
        } else {
            to.rejections = from.rejections;
        }
    }
}

/******************************************************************************/

async function compileImportedList(memoryProfile) {
    const lists = await browser.runtime.sendMessage({
        what: 'compileFilters:getEnabledImportedLists'
    });
    if ( Boolean(lists?.length) === false ) { return; }
    const enabledLists = lists.filter(a => a.enabled === true);
    const concurrency = Math.max(
        1,
        Math.min(memoryProfile?.importCompileConcurrency ?? 1, enabledLists.length)
    );
    let merged;
    for ( let i = 0; i < enabledLists.length; i += concurrency ) {
        const batch = enabledLists.slice(i, i + concurrency);
        const compiledData = await Promise.all(
            batch.map(async list => {
                reportProgress('list-start', list.id);
                const compiled = await getCompiledListData(list);
                reportProgress('list-complete', list.id);
                return compiled;
            })
        );
        for ( const compiled of compiledData ) {
            if ( Boolean(compiled) === false ) { continue; }
            if ( merged === undefined ) {
                merged = compiled;
            } else {
                mergeCompiledData(merged, compiled);
            }
        }
    }
    return merged;
}

/******************************************************************************/

async function compileSandboxFilters() {
    const text = await browser.runtime.sendMessage({
        what: 'compileFilters:getUserList'
    });
    if ( Boolean(text) === false ) { return; }
    return compileFilters('sandbox', text, {
        localSource: true,
        nativeCssHas: true,
        trustedSource: true,
    });
}

/******************************************************************************/

async function runCompiler() {
    reportProgress('compiler-start');
    resourceTypes = await browser.runtime.sendMessage({
        what: 'compileFilters:getResourceTypes'
    });
    const memoryProfile = await browser.runtime.sendMessage({
        what: 'compileFilters:getMemoryProfile',
        deviceMemoryGiB: globalThis.navigator?.deviceMemory,
    });
    let sandboxResult;
    let importedResult;
    if ( memoryProfile?.importCompileConcurrency === 1 ) {
        sandboxResult = await compileSandboxFilters();
        importedResult = await compileImportedList(memoryProfile);
    } else {
        [ sandboxResult, importedResult ] = await Promise.all([
            compileSandboxFilters(),
            compileImportedList(memoryProfile),
        ]);
    }
    reportProgress('source-compilation-complete');
    const sandboxCompiled = await toMv3Data('sandbox', sandboxResult) ?? {};
    reportProgress('sandbox-conversion-complete');
    const importedCompiled = await toMv3Data('imported', importedResult) ?? {};
    reportProgress('imported-conversion-complete');
    if ( compilationErrors.length ) {
        await browser.runtime.sendMessage({
            what: 'compileFilters:result',
            generation: compiledGeneration,
            persisted: false,
            errors: compilationErrors,
        });
        return;
    }
    const values = {};
    const toRemove = [];
    for ( const [ id, compiled ] of [
        [ 'sandbox', sandboxCompiled ],
        [ 'imported', importedCompiled ],
    ] ) {
        const dnrKey = compiledStorageKey(
            compiledGeneration,
            `${id}Filters.dnrRules`
        );
        if ( compiled.dnrRules?.length ) {
            values[dnrKey] = compiled.dnrRules;
        } else {
            toRemove.push(dnrKey);
        }
        const scriptsKey = compiledStorageKey(
            compiledGeneration,
            `${id}Filters.userScripts`
        );
        if ( compiled.isolated?.length || compiled.main?.length ) {
            values[scriptsKey] = {
                ISOLATED: compiled.isolated ?? [],
                MAIN: compiled.main ?? [],
            };
        } else {
            toRemove.push(scriptsKey);
        }
        const popupFiltersKey = compiledStorageKey(
            compiledGeneration,
            `${id}Filters.popupFilters`
        );
        // Keep only exact runtime filters plus deferred allow guards. The
        // latter are not executable allows: the observer evaluates their
        // supported condition projection and fails open whenever an omitted
        // predicate could hide an exception. Deferred blocks remain in cached
        // metadata only, avoiding diagnostics-only heap growth.
        const runtimePopupFilters = compiled.popupFilters?.filter(filter =>
            filter.routeCode === POPUP_RUNTIME_ROUTE_CODE ||
            (filter.routeCode === POPUP_DEFERRED_ROUTE_CODE &&
                filter.action === 'allow')
        ) || [];
        if ( runtimePopupFilters.length ) {
            values[popupFiltersKey] = {
                schemaVersion: 1,
                filters: runtimePopupFilters,
            };
        } else {
            toRemove.push(popupFiltersKey);
        }
    }
    if ( Object.keys(values).length !== 0 ) {
        await compilerStorage.set(values);
    }
    if ( toRemove.length !== 0 ) {
        await compilerStorage.remove(toRemove);
    }
    reportProgress('generation-persisted');
    await browser.runtime.sendMessage({
        what: 'compileFilters:result',
        persisted: true,
        generation: compiledGeneration,
        // The service worker commits these provenance markers only after the
        // corresponding DNR rules and user scripts have activated. Keeping
        // them out of this staging phase prevents the UI from reporting a
        // newly compiled digest while Chrome is still enforcing older rules.
        compiledIntegrityUpdates,
        importedListUpdates,
    });
}

runCompiler().catch(reason => {
    const errors = compilationErrors.slice();
    errors.push({
        listid: 'compiler',
        message: reason?.message || `${reason}`,
    });
    const pending = browser.runtime.sendMessage({
        what: 'compileFilters:result',
        generation: compiledGeneration,
        persisted: false,
        errors,
    });
    pending?.catch?.(( ) => { });
});

/******************************************************************************/
