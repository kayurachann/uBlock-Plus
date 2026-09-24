/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

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

import * as sfp from './static-filtering-parser.js';

import {
    CompiledListReader,
    CompiledListWriter,
} from './static-filtering-io.js';

import { LineIterator } from './text-utils.js';
import staticNetFilteringEngine from './static-net-filtering.js';

/******************************************************************************/

const isRegexOrPath = hn => hn.includes('/');

/******************************************************************************/

// Copied from cosmetic-filter.js for the time being to avoid unwanted
// dependencies

const rePlainSelector = /^[#.][\w\\-]+/;
const rePlainSelectorEx = /^[^#.[(]+([#.][\w-]+)|([#.][\w-]+)$/;
const rePlainSelectorEscaped = /^[#.](?:\\[0-9A-Fa-f]+ |\\.|\w|-)+/;
const reEscapeSequence = /\\([0-9A-Fa-f]+ |.)/g;

const keyFromSelector = selector => {
    let key = '';
    let matches = rePlainSelector.exec(selector);
    if ( matches ) {
        key = matches[0];
    } else {
        matches = rePlainSelectorEx.exec(selector);
        if ( matches === null ) { return; }
        key = matches[1] || matches[2];
    }
    if ( key.indexOf('\\') === -1 ) { return key; }
    matches = rePlainSelectorEscaped.exec(selector);
    if ( matches === null ) { return; }
    key = '';
    const escaped = matches[0];
    let beg = 0;
    reEscapeSequence.lastIndex = 0;
    for (;;) {
        matches = reEscapeSequence.exec(escaped);
        if ( matches === null ) {
            return key + escaped.slice(beg);
        }
        key += escaped.slice(beg, matches.index);
        beg = reEscapeSequence.lastIndex;
        if ( matches[1].length === 1 ) {
            key += matches[1];
        } else {
            key += String.fromCharCode(parseInt(matches[1], 16));
        }
    }
};

/******************************************************************************/

function addGenericCosmeticFilter(context, selector, isException) {
    if ( selector === undefined ) { return; }
    if ( selector.length <= 1 ) { return; }
    if ( selector.charCodeAt(0) === 0x7B /* '{' */ ) { return; }
    const key = keyFromSelector(selector);
    if ( isException ) {
        if ( context.genericCosmeticExceptions === undefined ) {
            context.genericCosmeticExceptions = [];
        }
        context.genericCosmeticExceptions.push({ key, selector });
        return;
    }
    if ( context.genericCosmeticFilters === undefined ) {
        context.genericCosmeticFilters = [];
    }
    context.genericCosmeticFilters.push({ key, selector });
}

/******************************************************************************/

// Response header filtering
//
// Classic uBO (httpheader-filtering.js) removes the header from every
// response whose own hostname (or a parent domain, an entity or a regex)
// matches a filter, whatever the type of the request. Exceptions are keyed
// on header name and hostname, not on the filter:
// - `~hn` in `a.com,~hn##^responseheader(x)` excepts `hn` for every `x` filter
// - `hn#@#^responseheader(x)` excepts `hn` for every `x` filter
// - `#@#^responseheader(x)` and `*#@#^responseheader(x)` except `x` everywhere
// - an empty name, `hn#@#^responseheader()`, excepts every header on `hn`
//
// All filters for a header name are collected here, then compiled into one
// DNR rule per name: requestDomains for the hostnames, excludedRequestDomains
// for the exceptions. DNR excludes sub-domains and gives excluded domains
// precedence, which is what classic does. What DNR cannot express:
// - entity (`example.*`) and regex hostnames: a filter, or an exception, with
//   no other hostname is rejected, otherwise they are dropped with a warning
//   (for an exception, the header is then still removed there)
// - exceptions only apply within the same list, since each list is compiled
//   into its own ruleset
// - a matching DNR allow rule of higher priority (i.e. a network exception
//   filter) also cancels the header removal, classic ignores those

// Same set as the runtime compiler: DNR matches main_frame only when listed.
const responseHeaderResourceTypes = [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other',
];

const isEntity = hn => hn.endsWith('.*');

function responseHeaderDetails(context, name) {
    context.responseHeaders ??= new Map();
    let details = context.responseHeaders.get(name);
    if ( details === undefined ) {
        details = {
            generic: false,
            hostnames: new Set(),
            exceptions: new Set(),
            warnings: [],
        };
        context.responseHeaders.set(name, details);
    }
    return details;
}

function addResponseHeaderFilter(context, parser) {
    const name = parser.getResponseheaderName();
    const details = responseHeaderDetails(context, name);
    const unsupported = [];
    context.responseHeaderGlobalExceptions ??= new Set();
    if ( parser.isException() ) {
        if ( parser.hasOptions() === false ) {
            context.responseHeaderGlobalExceptions.add(name);
            return;
        }
        let supported = 0;
        for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
            if ( bad ) { continue; }
            // https://github.com/gorhill/uBlock/issues/3375
            //   There is no exception to an exception (classic's comment:
            //   its code turns such a hostname into a filter).
            if ( not ) { continue; }
            if ( hn === '*' ) {
                context.responseHeaderGlobalExceptions.add(name);
                supported += 1;
            } else if ( isEntity(hn) || isRegexOrPath(hn) ) {
                unsupported.push(hn);
            } else {
                details.exceptions.add(hn);
                supported += 1;
            }
        }
        if ( unsupported.length === 0 ) { return; }
        if ( supported === 0 ) {
            context.invalid.add(`Unsupported responseheader() hostname: ${parser.raw}`);
        } else {
            details.warnings.push(`Ignored unsupported responseheader() exception hostname: ${parser.raw}`);
        }
        return;
    }
    // Only exception filters are allowed to be global
    if ( parser.hasOptions() === false ) { return; }
    const hostnames = [];
    let generic = false;
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( isEntity(hn) || isRegexOrPath(hn) ) {
            unsupported.push(hn);
        } else if ( not ) {
            details.exceptions.add(hn);
        } else if ( hn === '*' ) {
            generic = true;
        } else {
            hostnames.push(hn);
        }
    }
    if ( generic ) {
        details.generic = true;
    } else if ( hostnames.length !== 0 ) {
        for ( const hn of hostnames ) {
            details.hostnames.add(hn);
        }
    } else if ( unsupported.length !== 0 ) {
        context.invalid.add(`Unsupported responseheader() hostname: ${parser.raw}`);
        return;
    }
    if ( unsupported.length !== 0 ) {
        details.warnings.push(`Ignored unsupported responseheader() hostname: ${parser.raw}`);
    }
}

function responseHeaderRulesFromContext(context) {
    const rules = [];
    if ( context.responseHeaders === undefined ) { return rules; }
    const globalExceptions = context.responseHeaderGlobalExceptions;
    if ( globalExceptions.has('') ) { return rules; }
    const allHeaderExceptions = context.responseHeaders.get('')?.exceptions ?? [];
    // The warnings of all-header exceptions are reported once, with the
    // first rule.
    let allHeaderWarnings = context.responseHeaders.get('')?.warnings ?? [];
    for ( const [ name, details ] of context.responseHeaders ) {
        if ( name === '' ) { continue; }
        if ( globalExceptions.has(name) ) { continue; }
        if ( details.generic === false && details.hostnames.size === 0 ) {
            continue;
        }
        const rule = {
            action: {
                responseHeaders: [
                    {
                        header: name,
                        operation: 'remove',
                    }
                ],
                type: 'modifyHeaders'
            },
            condition: {
                resourceTypes: responseHeaderResourceTypes.slice(),
            },
        };
        if ( details.generic === false ) {
            rule.condition.requestDomains = Array.from(details.hostnames).sort();
        }
        const excluded = new Set([ ...details.exceptions, ...allHeaderExceptions ]);
        if ( excluded.size !== 0 ) {
            rule.condition.excludedRequestDomains = Array.from(excluded).sort();
        }
        const warnings = [ ...details.warnings, ...allHeaderWarnings ];
        allHeaderWarnings = [];
        if ( warnings.length !== 0 ) {
            rule._warning = warnings;
        }
        rules.push(rule);
    }
    return rules;
}

/******************************************************************************/

function addExtendedToDNR(context, parser) {
    if ( parser.isExtendedFilter() === false ) { return false; }

    // Scriptlet injection
    if ( parser.isScriptletFilter() ) {
        if ( parser.hasOptions() === false ) { return; }
        if ( context.scriptletFilters === undefined ) {
            context.scriptletFilters = new Map();
        }
        const exception = parser.isException();
        const args = parser.getScriptletArgs() || [];
        const argsToken = JSON.stringify(args);
        for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
            if ( bad ) { continue; }
            if ( exception && not ) { continue; }
            const details = context.scriptletFilters.get(argsToken) ?? {};
            if ( details.args === undefined ) {
                context.scriptletFilters.set(argsToken, details);
                details.args = args;
                if ( context.trustedSource ) {
                    details.trustedSource = true;
                }
            }
            if ( exception || not ) {
                details.excludeMatches ??= [];
                details.excludeMatches.push(hn);
                continue;
            }
            details.matches ??= [];
            if ( details.matches.includes('*') ) { continue; }
            if ( hn === '*' ) {
                details.matches = [ '*' ];
                continue;
            }
            details.matches.push(hn);
        }
        return;
    }

    // Response header filtering
    if ( parser.isResponseheaderFilter() ) {
        if ( parser.hasError() ) { return; }
        addResponseHeaderFilter(context, parser);
        return;
    }

    // HTML filtering
    if ( (parser.flavorBits & parser.BITFlavorExtHTML) !== 0 ) {
        return;
    }

    // Cosmetic filtering

    // Generic cosmetic filtering
    if ( parser.hasOptions() === false ) {
        const { compiled, exception } = parser.result;
        addGenericCosmeticFilter(context, compiled, exception);
        return;
    }

    // Specific cosmetic filtering
    // https://github.com/chrisaljoudi/uBlock/issues/151
    //   Negated hostname means the filter applies to all non-negated hostnames
    //   of same filter OR globally if there is no non-negated hostnames.
    if ( context.specificCosmeticFilters === undefined ) {
        context.specificCosmeticFilters = new Map();
    }
    const { compiled, exception, raw } = parser.result;
    if ( compiled === undefined ) {
        context.specificCosmeticFilters.set(`Invalid filter: ...##${raw}`, {
            rejected: true
        });
        return;
    }
    const matches = [];
    const excludeMatches = [];
    for ( const { hn, not, bad } of parser.getExtFilterDomainIterator() ) {
        if ( bad ) { continue; }
        if ( not && exception ) { continue; }
        if ( not || exception ) {
            excludeMatches.push(hn);
        } else if ( hn === '*' ) {
            addGenericCosmeticFilter(context, compiled, false);
        } else {
            matches.push(hn);
        }
    }
    // This should not happen
    if ( matches.length === 0 && excludeMatches.length === 0 ) { return; }
    // Only negated hostnames => generic cosmetic filter
    if ( exception === false && matches.length === 0 && excludeMatches.length !== 0 ) {
        addGenericCosmeticFilter(context, compiled, false);
    }
    const key = compiled.startsWith('{') === false && keyFromSelector(compiled);
    let details = context.specificCosmeticFilters.get(compiled);
    if ( details === undefined ) {
        context.specificCosmeticFilters.set(compiled, details = {});
        if ( key ) {
            details.key = key;
        }
    }
    if ( matches.length ) {
        if ( details.matches === undefined ) {
            details.matches = [];
        }
        if ( matches.includes('*') ) {
            details.matches = [ '*' ];
        } else if ( details.matches.includes('*') === false ) {
            details.matches.push(...matches);
        }
    }
    if ( excludeMatches.length ) {
        if ( details.excludeMatches === undefined ) {
            details.excludeMatches = [];
        }
        details.excludeMatches.push(...excludeMatches);
    }
}

/******************************************************************************/

function addToDNR(context, list) {
    const env = context.env || [];
    const writer = new CompiledListWriter();
    const lineIter = new LineIterator(
        sfp.utils.preparser.prune(list.text, env)
    );
    const parser = new sfp.AstFilterParser({
        toDNR: true,
        nativeCssHas: env.includes('native_css_has'),
        badTypes: [ sfp.NODE_TYPE_NET_OPTION_NAME_REDIRECTRULE ],
        trustedSource: list.trustedSource || undefined,
    });
    const compiler = staticNetFilteringEngine.createCompiler();

    writer.properties.set('name', list.name);
    compiler.start(writer);

    while ( lineIter.eot() === false ) {
        let line = lineIter.next();
        while ( line.endsWith(' \\') ) {
            if ( lineIter.peek(4) !== '    ' ) { break; }
            line = line.slice(0, -2).trim() + lineIter.next().trim();
        }

        parser.parse(line);

        if ( parser.isComment() ) {
            if ( line === `!#trusted on ${context.secret}` ) {
                parser.options.trustedSource = true;
                context.trustedSource = true;
            } else if ( line === `!#trusted off ${context.secret}` ) {
                parser.options.trustedSource = false;
                context.trustedSource = false;
            }
            continue;
        }

        if ( parser.isFilter() === false ) { continue; }
        if ( parser.hasError() ) {
            if ( parser.astError === sfp.AST_ERROR_OPTION_EXCLUDED ) {
                context.invalid.add(`Incompatible with DNR: ${line}`);
            } else {
                context.invalid.add(`Rejected filter: ${line}`);
            }
            continue;
        }

        if ( parser.isExtendedFilter() ) {
            addExtendedToDNR(context, parser);
            continue;
        }
        if ( parser.isNetworkFilter() === false ) { continue; }

        const sourceStart = writer.blocks.get('NETWORK_FILTERS:GOOD')?.length ?? 0;
        if ( compiler.compile(parser, writer) ) {
            const lines = writer.blocks.get('NETWORK_FILTERS:GOOD') ?? [];
            // The source filters of each compiled line, which the rules
            // compiled from it carry as `_sourceFilters`: a filter compiles
            // into one line per type, and lines can merge into one rule, so
            // rule entries are not filters.
            context.networkFilterSources ??= new Map();
            for ( let i = sourceStart; i < lines.length; i++ ) {
                const sources = context.networkFilterSources.get(lines[i]);
                if ( sources === undefined ) {
                    context.networkFilterSources.set(lines[i], [ line ]);
                } else if ( sources.includes(line) === false ) {
                    sources.push(line);
                }
            }
            if ( typeof context.networkSourceIdentity === 'function' ) {
                context.networkSources ??= new Map();
                const identities = context.networkSourceIdentity(parser);
                if ( parser.getNodeTypes().includes(sfp.NODE_TYPE_NET_OPTION_NAME_BADFILTER) ) {
                    context.networkBadfilterKeys ??= new Set();
                    for ( const identity of identities ) {
                        context.networkBadfilterKeys.add(identity.rawKey ?? identity.key);
                    }
                }
                for ( let i = sourceStart; i < lines.length; i++ ) {
                    const compiledLine = lines[i];
                    const fragment = JSON.parse(compiledLine)[2];
                    const keys = identities.filter(identity =>
                        identity.hostname === undefined ||
                        identity.hostname === fragment
                    ).map(identity => identity.key);
                    const previous = context.networkSources.get(compiledLine) ?? [];
                    context.networkSources.set(compiledLine,
                        Array.from(new Set([ ...previous, ...keys ])));
                }
            }
            continue;
        }

        if ( compiler.error !== undefined ) {
            context.invalid.add(compiler.error);
        }
    }

    compiler.finish(writer);

    staticNetFilteringEngine.dnrFromCompiled(
        'add',
        context,
        new CompiledListReader(writer.toString())
    );
}

/******************************************************************************/

// Merge rules where possible by merging arrays of a specific property.
//
// https://github.com/uBlockOrigin/uBOL-home/issues/10#issuecomment-1304822579
//   Do not merge rules which have errors.

function mergeRules(rulesetMap, mergeTarget) {
    const sorter = (_, v) => {
        if ( Array.isArray(v) ) {
            return typeof v[0] === 'string' ? v.sort() : v;
        }
        if ( v instanceof Object ) {
            const sorted = {};
            for ( const kk of Object.keys(v).sort() ) {
                sorted[kk] = v[kk];
            }
            return sorted;
        }
        return v;
    };
    const ruleHasher = (rule, target) => {
        return JSON.stringify(rule, (k, v) => {
            if ( k.startsWith('_') ) { return; }
            if ( k === target ) { return; }
            return sorter(k, v);
        });
    };
    const extractTargetValue = (obj, target) => {
        for ( const [ k, v ] of Object.entries(obj) ) {
            if ( Array.isArray(v) && k === target ) { return v; }
            if ( v instanceof Object ) {
                const r = extractTargetValue(v, target);
                if ( r !== undefined ) { return r; }
            }
        }
    };
    const extractTargetOwner = (obj, target) => {
        for ( const [ k, v ] of Object.entries(obj) ) {
            if ( Array.isArray(v) && k === target ) { return obj; }
            if ( v instanceof Object ) {
                const r = extractTargetOwner(v, target);
                if ( r !== undefined ) { return r; }
            }
        }
    };
    const mergeMap = new Map();
    for ( const [ id, rule ] of rulesetMap ) {
        if ( rule._error !== undefined ) { continue; }
        const hash = ruleHasher(rule, mergeTarget);
        if ( mergeMap.has(hash) === false ) {
            mergeMap.set(hash, []);
        }
        mergeMap.get(hash).push(id);
    }
    for ( const ids of mergeMap.values() ) {
        if ( ids.length === 1 ) { continue; }
        const leftHand = rulesetMap.get(ids[0]);
        const leftHandSet = new Set(
            extractTargetValue(leftHand, mergeTarget) || []
        );
        for ( let i = 1; i < ids.length; i++ ) {
            const rightHandId = ids[i];
            const rightHand = rulesetMap.get(rightHandId);
            const rightHandArray =  extractTargetValue(rightHand, mergeTarget);
            if ( rightHandArray !== undefined ) {
                if ( leftHandSet.size !== 0 ) {
                    for ( const item of rightHandArray ) {
                        leftHandSet.add(item);
                    }
                }
            } else {
                leftHandSet.clear();
            }
            rulesetMap.delete(rightHandId);
        }
        const leftHandOwner = extractTargetOwner(leftHand, mergeTarget);
        if ( leftHandSet.size > 1 ) {
            //if ( leftHandOwner === undefined ) { debugger; }
            leftHandOwner[mergeTarget] = Array.from(leftHandSet).sort();
        } else if ( leftHandSet.size === 0 ) {
            if ( leftHandOwner !== undefined ) {
                leftHandOwner[mergeTarget] = undefined;
            }
        }
    }
}

/******************************************************************************/

function finalizeRuleset(context, network) {
    const ruleset = network.ruleset;

    // Assign rule ids
    const rulesetMap = new Map();
    {
        let ruleId = 1;
        for ( const rule of ruleset ) {
            rulesetMap.set(ruleId++, rule);
        }
    }

    // Patch id
    const rulesetFinal = [];
    {
        let ruleId = 1;
        for ( const rule of rulesetMap.values() ) {
            if ( rule._error === undefined ) {
                rule.id = ruleId++;
            } else {
                rule.id = 0;
            }
            rulesetFinal.push(rule);
        }
        for ( const invalid of context.invalid ) {
            rulesetFinal.push({ _error: [ invalid ] });
        }
    }

    network.ruleset = rulesetFinal;
}

/******************************************************************************/

// Stable reason codes for the `_error` messages of the entries which could
// not be converted into DNR rules, so that build reports can count them per
// reason. Codes shared with the runtime compiler (ubo-parser.js) are spelled
// the same. `invalid-*` filters are rejected by classic uBO too, the other
// ones only because DNR cannot express them.

const dnrErrorReasons = [
    [ /^Incompatible with DNR: uritransform=/, 'unsupported-urltransform-regex' ],
    [ /^Incompatible with DNR \(need regexFilter\): uritransform=/, 'unsupported-urltransform-pattern' ],
    // The DNR parser excludes the `redirect-rule` option (see `badTypes`)
    [ /^Incompatible with DNR: .*[$,]redirect-rule(?:[=,]|\s*$)/is, 'unsupported-redirect-rule' ],
    [ /^Incompatible with DNR: /, 'unsupported-option' ],
    [ /^Can't salvage rule with unsupported domain= option: /, 'unsupported-domain' ],
    [ /^regexFilter is not RE2-compatible: /, 'unsupported-regex' ],
    // Chromium builds: platform/mv3/stock-regex.js, from Chrome's own RE2
    // (isRegexSupported()) and the portable RE2 subset every supported
    // Chrome accepts (platform/mv3/re2-portable.js)
    [ /^regexFilter rejected by Chrome RE2 \(syntaxError\): /, 'unsupported-regex-syntax' ],
    [ /^regexFilter rejected by Chrome RE2 \(memoryLimitExceeded\): /, 'unsupported-regex-memory' ],
    [ /^regexFilter outside the portable RE2 subset/, 'unsupported-regex-syntax' ],
    [ /^Unsupported regex-based removeParam: /, 'unsupported-removeparam-regex' ],
    [ /^Unsupported negated removeParam: /, 'unsupported-removeparam-negated' ],
    [ /^strict1p not supported/, 'unsupported-strict-first-party' ],
    [ /^strict3p not supported/, 'unsupported-strict-third-party' ],
    [ /^"ipaddress=.*" not supported$/s, 'unsupported-ipaddress' ],
    [ /^responseheader=".*" not supported$/s, 'unsupported-header-value' ],
    [ /^requestheader=".*" not supported$/s, 'unsupported-requestheader' ],
    [ /^Unpatchable redirect filter: /, 'unsupported-redirect-resource' ],
    [ /^Unsupported responseheader\(\) hostname: /, 'unsupported-responseheader-hostname' ],
    [ /^urlFilter already defined: /, 'unsupported-pattern' ],
    [ /^Unsupported modifier /, 'unsupported-modifier' ],
    [ /^Rejected filter: /, 'invalid-filter' ],
    [ /^Invalid network filter in /, 'invalid-network-filter' ],
];

function dnrErrorReason(message) {
    if ( typeof message !== 'string' ) { return 'other'; }
    for ( const [ re, reason ] of dnrErrorReasons ) {
        if ( re.test(message) ) { return reason; }
    }
    return 'other';
}

// Count the filters which could not be converted, from the entries which
// carry `_error`, and how many per reason. Filters are counted, not entries:
// a filter compiles into one entry per type, and an entry can merge several
// filters (`_sourceFilters`). An entry without sources (a filter rejected
// before compilation) is one filter. A filter counts once, under the reason
// of the first error of its first rejected entry, so that the reason counts
// add up to the total.
function dnrErrorSummary(rules) {
    const reasons = new Map();
    const counted = new Set();
    let count = 0;
    for ( const rule of rules ) {
        if ( Boolean(rule._error) === false ) { continue; }
        let filterCount = 1;
        if ( rule._sourceFilters?.length ) {
            filterCount = 0;
            for ( const filter of rule._sourceFilters ) {
                if ( counted.has(filter) ) { continue; }
                counted.add(filter);
                filterCount += 1;
            }
            if ( filterCount === 0 ) { continue; }
        }
        count += filterCount;
        const reason = dnrErrorReason(rule._error[0]);
        reasons.set(reason, (reasons.get(reason) ?? 0) + filterCount);
    }
    const sorted = Array.from(reasons).sort((a, b) =>
        b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
    );
    return { count, reasons: Object.fromEntries(sorted) };
}

// Count the network filters which were converted: they are the source of at
// least one entry without `_error`, and of no entry with `_error` (those are
// counted by dnrErrorSummary()).
function dnrConvertedFilterCount(rules) {
    const converted = new Set();
    const rejected = new Set();
    for ( const rule of rules ) {
        const filters = rule._error ? rejected : converted;
        for ( const filter of rule._sourceFilters ?? [] ) {
            filters.add(filter);
        }
    }
    let count = 0;
    for ( const filter of converted ) {
        if ( rejected.has(filter) ) { continue; }
        count += 1;
    }
    return count;
}

/******************************************************************************/

async function dnrRulesetFromRawLists(lists, options = {}) {
    const context = Object.assign({}, options);
    context.bad = options.networkBad;
    staticNetFilteringEngine.dnrFromCompiled('begin', context);
    context.extensionPaths = new Map(context.extensionPaths || []);
    const toLoad = [];
    const toDNR = (context, list) => addToDNR(context, list);
    for ( const list of lists ) {
        if ( list instanceof Promise ) {
            toLoad.push(list.then(list => toDNR(context, list)));
        } else {
            toLoad.push(toDNR(context, list));
        }
    }
    await Promise.all(toLoad);
    const result = {
        network: staticNetFilteringEngine.dnrFromCompiled('end', context),
        networkBad: context.bad,
        networkBadfilterKeys: Array.from(context.networkBadfilterKeys ?? []),
        genericCosmeticFilters: context.genericCosmeticFilters,
        genericCosmeticExceptions: context.genericCosmeticExceptions,
        specificCosmetic: context.specificCosmeticFilters,
        scriptlet: context.scriptletFilters,
    };
    result.network.ruleset.push(...responseHeaderRulesFromContext(context));
    finalizeRuleset(context, result.network);
    return result;
}

/******************************************************************************/

export {
    dnrConvertedFilterCount,
    dnrErrorReason,
    dnrErrorSummary,
    dnrRulesetFromRawLists,
    mergeRules,
};
