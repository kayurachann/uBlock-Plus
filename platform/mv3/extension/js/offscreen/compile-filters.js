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
    COMPILED_FILTERS_REVISION,
    deserializeCompiledListOr,
} from '../compiled-cache.js';

import {
    NetworkFilterCompiler,
    minimizeRules,
    minimizeRuleset,
    resolveNetworkBadfilters,
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
import {
    isImportedListRefreshDue,
    isPendingImportedRefreshStale,
    pendingImportedMetadataKey,
} from '../imported-list-metadata.js';
import { createCompilerStorageClient } from '../offscreen-storage.js';
import { deriveUserStrictBlockRules } from '../strictblock-rules.js';
import { fetchList } from './fetch-list.js';
import { isCredentialFreeHTTPS } from '../imported-fetch-policy.js';
import { isVerifiedSourceKey } from '../verified-source-handoff.js';
import { makeCosmeticScripts } from './make-cosmetic-filters.js';
import { safeReplace } from './safe-replace.js';
import { sanitizeUntrustedScriptletDetails } from './scriptlet-regex-safety.js';
import { validateFilterConditionalStructure } from './filter-conditional-structure.js';

/******************************************************************************/

const browser = (self.browser || self.chrome);
const filterEnvironment = [
    'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol',
];

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

function stageImportedListUpdate(pendingMetadata) {
    if ( typeof pendingMetadata?.listid !== 'string' ) { return; }
    if ( /^[a-f0-9]{32}$/.test(pendingMetadata.metadataToken) === false ) { return; }
    // The previously activated compilation stays in storage.
    const update = { ...pendingMetadata };
    delete update.previous;
    const index = importedListUpdates.findIndex(
        candidate => candidate.listid === update.listid
    );
    if ( index === -1 ) {
        importedListUpdates.push(update);
    } else {
        importedListUpdates[index] = update;
    }
}

// The cached compilation stays active. The service worker backs off the next
// attempt once this generation has activated.
function stageImportedListRefreshFailure(list, reason) {
    importedListUpdates.push({
        listid: list.id,
        refreshFailed: true,
        failedAt: Date.now(),
        message: reason?.message || `${reason}`,
    });
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
    const unit = matches[2].toLowerCase();
    if ( unit === 'w' ) {
        updateAfter *= 7;
    } else if ( unit === 'h' ) {
        updateAfter = Math.max(updateAfter, 4) / 24;
    } else if ( unit === 'm' ) {
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
    const exception = parser.isException();
    if ( parser.hasOptions() === false && exception === false ) { return; }
    const args = parser.getScriptletArgs();
    const argsToken = JSON.stringify(args);
    if ( parser.hasOptions() === false ) {
        const details = output.get(argsToken) ?? { args };
        details.excludeMatches ??= [];
        details.excludeMatches.push('*');
        output.set(argsToken, details);
        return;
    }
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( exception && not ) { continue; }
        const details = output.get(argsToken) ?? {};
        if ( details.args === undefined ) {
            details.args = args;
            output.set(argsToken, details);
        }
        if ( not || exception ) {
            details.excludeMatches ??= [];
            details.excludeMatches.push(hn);
            continue;
        }
        details.trustedSource ||= parser.options.trustedSource;
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

function preprocessFilterSource(text) {
    // Fetched lists are expanded by fetchList, but pinned bytes and personal
    // filters enter the compiler directly. All three must select the same
    // branches before network rules, scriptlets or exceptions are collected.
    const slices = sfp.utils.preparser.splitter(text, filterEnvironment);
    const parts = [];
    for ( let i = 0; i < slices.length; i += 2 ) {
        const part = text.slice(slices[i], slices[i + 1]);
        for ( const match of part.matchAll(/^!#if\b([^\r\n]*)/gm) ) {
            if ( sfp.utils.preparser.evaluateExpr(
                match[1].trim(), filterEnvironment
            ) !== undefined ) { continue; }
            const line = text.slice(0, slices[i] + match.index).split('\n').length;
            // An unknown active condition cannot safely select a branch.
            // Keep the last complete generation rather than activate both.
            throw new TypeError(`Unsupported filter condition at line ${line}`);
        }
        parts.push(part);
        const end = slices[i + 2] ?? text.length;
        // Pinned source digests are verified before this transformation.
        // Preserve line numbers for diagnostics and badfilter provenance.
        parts.push(text.slice(slices[i + 1], end).replace(/[^\r\n]/g, ''));
    }
    return parts.join('');
}

export function compileFilters(listid, text, context = {}) {
    if ( Boolean(text) === false ) { return; }
    const { sourceIsExpanded = false, ...parserOptions } = context;
    // fetchList validates each raw include before pruning. Its joined output
    // can legitimately lack delimiters, so only direct inputs need this check.
    if ( sourceIsExpanded !== true ) {
        validateFilterConditionalStructure(text, {
            preparser: sfp.utils.preparser, env: filterEnvironment,
        });
    }
    text = preprocessFilterSource(text);

    const parser = new sfp.AstFilterParser(parserOptions);

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
        networkUnits: networkCompiled.networkUnits,
        badfilterKeys: networkCompiled.badfilterKeys,
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
            // Runtime exception lookups can need entities, ancestors or regexes
            // while positive filters still have a finite registration scope.
            const hostnames = result.ISOLATED.hostnames.includes('*')
                ? '*'
                : result.ISOLATED.hostnames;
            isolated.push({
                id: `${rulesetid}-isolated-scriptlets`,
                code: result.ISOLATED.code,
                hostnames,
            });
        }
        if ( result.MAIN ) {
            const hostnames = result.MAIN.hostnames.includes('*')
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

    const output = {
        badfilterKeys: compiledData.badfilterKeys ?? [],
        scriptletExceptions: makeScriptlets.exceptionDetails(compiledData.scriptletDetails),
    };
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
        // Strict-block redirect templates for the $doc filters. The service
        // worker installs them only while it can do so safely; the blocks
        // above stay the fallback.
        output.strictBlockRules = deriveUserStrictBlockRules(output.dnrRules);
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
    // Content-Length counts encoded bytes: a gzip response declares less
    // than its decoded body. The streamed cap, byte count and digest below
    // are the authoritative checks.
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

// Throws on any fetch or compile failure. Callers decide whether the list's
// cached compilation can stand in for it. `previous` is the envelope of the
// compilation which last activated, kept until the refresh activates.
async function updateList(list, previous) {
    const context = {
        env: filterEnvironment,
    };
    let text;
    if ( list.sourceIntegrity ) {
        text = await fetchPinnedText(list);
    } else {
        const asset = {
            urls: [ list.id ],
            // A Filter Store batch share bounds the first fetch of a list.
            // Refreshes use the per-list limit, so a list which grows after
            // installation keeps updating.
            maxBytes: list.time?.updated > 0 ? undefined : list.maxSourceBytes,
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
        sourceIsExpanded: list.sourceIntegrity === undefined,
    });
    if ( Boolean(compiled) === false ) {
        throw new Error('Filter source returned no usable data');
    }

    const cacheKey = `rulesets.imported.compiled.${list.id}`;
    const pendingMetadata = {
        listid: list.id,
        metadataToken: newCompiledGeneration(),
        fetchedAt: Date.now(),
        title: metadata.title,
        homeURL: metadata.homepage,
        expires: metadata.expires || 7,
        verifiedSourceKey: '',
        filterStats: compiled.filterStats,
        ruleStats: compiled.ruleStats,
        rejections: compiled.rejections,
    };
    if ( previous !== undefined ) { pendingMetadata.previous = previous; }
    const metadataKey = pendingImportedMetadataKey(list.id);
    await compilerStorage.set({
        [cacheKey]: {
            compilerRevision: COMPILED_FILTERS_REVISION,
            serialized: s14e.serialize(compiled, { compress: true }),
            sourceDigest: list.sourceIntegrity?.digest || '',
            sourceBytes: list.sourceIntegrity?.bytes ?? null,
            // A compile can fail after this individual list was refreshed.
            // The envelope points to a metadata sidecar so the next attempt
            // can stage it without fetching again. The sidecar also holds the
            // envelope which last activated, if any. Committing only removes
            // the sidecar and never rewrites a multi-MiB cache entry.
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

function reportListError(list, reason) {
    compilationErrors.push({
        listid: list.id,
        message: reason?.message || `${reason}`,
    });
}

async function updateListOrReport(list) {
    try {
        return await updateList(list);
    } catch ( reason ) {
        reportListError(list, reason);
    }
}

/******************************************************************************/

async function getCompiledListData(list) {
    const cacheKey = `rulesets.imported.compiled.${list.id}`;
    const metadataKey = pendingImportedMetadataKey(list.id);
    const bin = await compilerStorage.get(cacheKey);
    let cached = bin?.[cacheKey];
    if ( isCurrentListEnvelope(list, cached) === false ) {
        return updateListOrReport(list);
    }
    let pendingMetadata;
    const pendingMetadataToken = cached.pendingMetadataToken;
    if ( pendingMetadataToken !== list.compiledMetadataToken &&
        /^[a-f0-9]{32}$/.test(pendingMetadataToken) ) {
        const metadataBin = await compilerStorage.get(metadataKey);
        if ( metadataBin?.[metadataKey]?.metadataToken === pendingMetadataToken ) {
            pendingMetadata = metadataBin[metadataKey];
        }
    }
    // An expired list keeps its last complete compilation until a
    // replacement has been fetched and compiled. A refresh which is still
    // waiting for its metadata commit is current, unless generations with it
    // have not activated for a while: it may be what prevents activation,
    // for example by exceeding a DNR quota.
    let refreshFailure;
    let restored = false;
    if ( pendingMetadata === undefined ) {
        if ( isImportedListRefreshDue(list) ) {
            const committed = cached.pendingMetadataToken === list.compiledMetadataToken;
            try {
                return await updateList(list, committed ? cached : undefined);
            } catch ( reason ) {
                refreshFailure = reason;
            }
        }
    } else if ( isPendingImportedRefreshStale(pendingMetadata) ) {
        const { previous } = pendingMetadata;
        if ( isCurrentListEnvelope(list, previous) ) {
            // Restore the compilation which last activated. The refresh is
            // retried after the usual backoff, once this generation commits.
            await compilerStorage.set({ [cacheKey]: previous });
            await compilerStorage.remove(metadataKey);
            cached = previous;
            pendingMetadata = undefined;
            restored = true;
            refreshFailure = new Error(
                'The updated list could not be activated; the previous version stays active'
            );
        } else if ( list.sourceIntegrity === undefined ) {
            // Nothing activated before it. Pinned bytes cannot change, but
            // a newer upstream version may activate.
            try {
                return await updateList(list);
            } catch {
                // Keep trying the version fetched before.
            }
        }
    }
    let cacheUsed = true;
    const compiled = await deserializeCompiledListOr(
        cached.serialized,
        s14e.deserialize,
        async ( ) => {
            cacheUsed = false;
            await compilerStorage.remove([ cacheKey, metadataKey ]);
            if ( refreshFailure === undefined || restored ) {
                return updateListOrReport(list);
            }
            reportListError(list, refreshFailure);
        }
    );
    if ( cacheUsed === false || Boolean(compiled) === false ) {
        return compiled;
    }
    if ( refreshFailure !== undefined ) {
        stageImportedListRefreshFailure(list, refreshFailure);
    }
    if ( list.sourceIntegrity ) { stageCompiledIntegrity(list); }
    if ( pendingMetadata !== undefined ) {
        stageImportedListUpdate(pendingMetadata);
    }
    return compiled;
}

// A cache envelope holds either the compilation which last activated, or a
// refresh whose sidecar keeps that compilation until the refresh activates.
function isCurrentListEnvelope(list, envelope) {
    if ( envelope?.compilerRevision !== COMPILED_FILTERS_REVISION ) { return false; }
    if ( Boolean(envelope.serialized) === false ) { return false; }
    if ( list.sourceIntegrity === undefined ) { return true; }
    return envelope.sourceDigest === list.sourceIntegrity.digest &&
        envelope.sourceBytes === list.sourceIntegrity.bytes;
}

/******************************************************************************/

function mergeCompiledData(to, from) {
    if ( from.networkUnits ) {
        to.networkUnits = [ ...(to.networkUnits ?? []), ...from.networkUnits ];
    }
    if ( from.badfilterKeys ) {
        to.badfilterKeys = [ ...(to.badfilterKeys ?? []), ...from.badfilterKeys ];
    }
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
    const stockIds = await browser.runtime.sendMessage({
        what: 'compileFilters:getEnabledStockRulesets',
    });
    const stockBadfilterKeys = [];
    if ( stockIds?.length ) {
        const response = await fetch('/rulesets/badfilter-details.json');
        const index = await response.json();
        if ( response.ok === false || index?.schemaVersion !== 1 ) {
            throw new Error('Missing stock badfilter index');
        }
        for ( const id of stockIds ) {
            const keys = index.rulesets?.[id]?.badfilterKeys;
            if ( Array.isArray(keys) === false ) {
                throw new Error(`Invalid stock badfilter metadata: ${id}`);
            }
            stockBadfilterKeys.push(...keys);
        }
    }
    resolveNetworkBadfilters([ sandboxResult, importedResult,
        { badfilterKeys: stockBadfilterKeys } ]);
    const sandboxCompiled = await toMv3Data('sandbox', sandboxResult) ?? {};
    reportProgress('sandbox-conversion-complete');
    // Cached compilations predate this check, so it runs on every compile.
    const unsafeScriptletRegexes = sanitizeUntrustedScriptletDetails(
        importedResult?.scriptletDetails
    );
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
    const values = {
        [compiledStorageKey(compiledGeneration, 'scriptletExceptions.schema')]: 1,
    };
    const toRemove = [];
    const scriptletWarningsKey = compiledStorageKey(
        compiledGeneration, 'importedFilters.scriptletWarnings'
    );
    if ( unsafeScriptletRegexes.length !== 0 ) {
        const shown = unsafeScriptletRegexes.slice(0, 3)
            .map(pattern => pattern.length > 80 ? `${pattern.slice(0, 79)}…` : pattern);
        values[scriptletWarningsKey] = [
            `Imported lists contain ${unsafeScriptletRegexes.length} scriptlet ` +
            `regex hostname(s) which could stall pages: ${shown.join(' ')}. ` +
            'Scriptlets scoped by them are skipped, and exceptions using ' +
            'them apply to a broader scope.',
        ];
    } else {
        toRemove.push(scriptletWarningsKey);
    }
    for ( const [ id, compiled ] of [
        [ 'sandbox', sandboxCompiled ],
        [ 'imported', importedCompiled ],
    ] ) {
        const badfilterKey = compiledStorageKey(compiledGeneration, `${id}Filters.badfilterKeys`);
        if ( compiled.badfilterKeys?.length ) {
            values[badfilterKey] = compiled.badfilterKeys;
        } else {
            toRemove.push(badfilterKey);
        }
        const exceptionsKey = compiledStorageKey(
            compiledGeneration, `${id}Filters.scriptletExceptions`
        );
        if ( compiled.scriptletExceptions?.length ) {
            values[exceptionsKey] = compiled.scriptletExceptions;
        } else {
            toRemove.push(exceptionsKey);
        }
        const dnrKey = compiledStorageKey(
            compiledGeneration,
            `${id}Filters.dnrRules`
        );
        if ( compiled.dnrRules?.length ) {
            values[dnrKey] = compiled.dnrRules;
        } else {
            toRemove.push(dnrKey);
        }
        const strictBlockKey = compiledStorageKey(
            compiledGeneration,
            `${id}Filters.strictBlockRules`
        );
        if ( compiled.strictBlockRules?.length ) {
            values[strictBlockKey] = compiled.strictBlockRules;
        } else {
            toRemove.push(strictBlockKey);
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
