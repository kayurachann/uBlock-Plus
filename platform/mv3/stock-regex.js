/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

// Build-time helpers for the stock regex rules of Chromium packages
// (make-rulesets.js), kept here so that they can be unit-tested:
// - verdict annotation: a regexFilter outside the portable RE2 subset, or
//   one which Chrome's RE2 rejects, is marked unsupported (`_error`) and
//   counted like any other filter DNR cannot express;
// - placement: the valid regex rules of a list are packaged in the list's
//   static ruleset as long as all static rulesets together stay within
//   Chrome's static regex limit, else they stay on the dynamic path;
// - rulesets/regex-details.json and its digest;
// - toJSONRuleset(), which writes a ruleset file.

import { createHash } from 'crypto';
import { re2PortableReason } from './re2-portable.js';

/******************************************************************************/

// Chrome: MAX_NUMBER_OF_REGEX_RULES applies to the static rulesets of an
// extension as a whole (enabled or not), separately from the regex rules
// shared by the dynamic and session rules.
export const STATIC_REGEX_BUDGET = 1000;

export const REGEX_DETAILS_SCHEMA_VERSION = 1;

// Chrome's isRegexSupported() reasons, and the verdicts of
// regex-verdicts.mjs when no Chrome answered.
export const REGEX_VERDICT_OK = 'ok';
export const REGEX_VERDICT_UNVERIFIED = 'unverified';

/******************************************************************************/

// The `_error` message of a regex rule which cannot be packaged, or ''.
// src/js/static-dnr-filtering.js maps these messages to the reason codes
// 'unsupported-regex-syntax' and 'unsupported-regex-memory'.
export function regexVerdictError(regex, portableReason, verdict) {
    if ( portableReason !== '' ) {
        return `regexFilter outside the portable RE2 subset (${portableReason}): ${regex}`;
    }
    if ( verdict === REGEX_VERDICT_OK ) { return ''; }
    if ( verdict === REGEX_VERDICT_UNVERIFIED ) { return ''; }
    return `regexFilter rejected by Chrome RE2 (${verdict}): ${regex}`;
}

export const regexVerdictOptions = rule => ({
    regex: rule.condition.regexFilter,
    isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
    requireCapturing: typeof rule.action?.redirect?.regexSubstitution === 'string',
});

// Marks the regex rules of `rules` which cannot be packaged: the same
// objects are annotated, so that the filter counters of the compiler output
// see them. `resolver` is a regex-verdicts.mjs resolver (or a stand-in with
// its `resolve()`). Returns what was found.
export async function annotateRegexRules(rules, resolver) {
    const candidates = rules.filter(rule =>
        rule._error === undefined &&
        typeof rule.condition?.regexFilter === 'string'
    );
    const portable = candidates.map(rule =>
        re2PortableReason(rule.condition.regexFilter)
    );
    const toResolve = [];
    for ( let i = 0; i < candidates.length; i++ ) {
        if ( portable[i] !== '' ) { continue; }
        toResolve.push(regexVerdictOptions(candidates[i]));
    }
    const verdicts = toResolve.length !== 0
        ? await resolver.resolve(toResolve)
        : [];
    const stats = {
        checked: candidates.length,
        ok: 0,
        unverified: 0,
        rejected: 0,
        portable: 0,
        syntax: 0,
        memory: 0,
        other: 0,
    };
    let j = 0;
    for ( let i = 0; i < candidates.length; i++ ) {
        const rule = candidates[i];
        const verdict = portable[i] === '' ? verdicts[j++] : '';
        const message = regexVerdictError(rule.condition.regexFilter,
            portable[i], verdict
        );
        if ( message === '' ) {
            stats[verdict === REGEX_VERDICT_OK ? 'ok' : 'unverified'] += 1;
            continue;
        }
        rule._error = [ message ];
        stats.rejected += 1;
        if ( portable[i] !== '' ) {
            stats.portable += 1;
        } else if ( verdict === 'syntaxError' ) {
            stats.syntax += 1;
        } else if ( verdict === 'memoryLimitExceeded' ) {
            stats.memory += 1;
        } else {
            stats.other += 1;
        }
    }
    return stats;
}

/******************************************************************************/

// First fit, in the order the lists are built (rulesets.json, defaults
// first): a list whose regex rules do not all fit keeps them on the dynamic
// path, where they are validated at runtime as before, and later lists may
// still fit.
export function createStaticRegexPlacement(budget = STATIC_REGEX_BUDGET) {
    let used = 0;
    const overflow = [];
    return {
        place(rulesetId, count) {
            if ( count === 0 ) { return true; }
            if ( used + count > budget ) {
                overflow.push({ rulesetId, count });
                return false;
            }
            used += count;
            return true;
        },
        get used() { return used; },
        get budget() { return budget; },
        get overflow() { return overflow.slice(); },
    };
}

/******************************************************************************/

export const staticRegexEntries = (rulesetId, rules) => rules.map(rule => [
    rulesetId,
    rule.condition.regexFilter,
    rule.condition.isUrlFilterCaseSensitive === true,
]);

const compareEntries = (a, b) => {
    for ( let i = 0; i < 3; i++ ) {
        const x = String(a[i]);
        const y = String(b[i]);
        if ( x !== y ) { return x < y ? -1 : 1; }
    }
    return 0;
};

// sha256 of the JSON of the sorted [ rulesetId, regex, caseSensitive ]
// entries of every static regex rule. The order of the lists and of the
// rules does not matter.
export function regexDetailsDigest(entries) {
    const sorted = entries.map(([ rulesetId, regex, caseSensitive ]) =>
        [ `${rulesetId}`, `${regex}`, caseSensitive === true ]
    ).sort(compareEntries);
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// rulesets/regex-details.json. `verifiedWith` is the browser which checked
// every static regex ('Chrome/<version>'), or '' when some were not checked.
export function makeRegexDetails({
    verifiedWith = '',
    entries = [],
    limit = STATIC_REGEX_BUDGET,
} = {}) {
    return {
        schemaVersion: REGEX_DETAILS_SCHEMA_VERSION,
        verifiedWith: typeof verifiedWith === 'string' ? verifiedWith : '',
        staticRegexLimit: limit,
        staticRegexCount: entries.length,
        digest: regexDetailsDigest(entries),
    };
}

/*******************************************************************************
 *
 * For large rulesets, one rule per line for compromise between size and
 * readability. This also means that the number of lines in resulting file
 * representative of the number of rules in the ruleset.
 *
 * `tail`: rules appended after the sorted ruleset, numbered after it, so
 * that the IDs of the ruleset's own rules are those of a file without them.
 * Rule IDs are assigned to the rule objects.
 *
 * */

export function toJSONRuleset(ruleset, { tail = [] } = {}) {
    const nodupProps = [
        'domains',
        'excludedDomains',
        'requestDomains',
        'excludedRequestDomains',
        'initiatorDomains',
        'excludedInitiatorDomains',
        'topDomains',
        'excludedTopDomains',
    ];
    const sortProps = [ 'requestDomains', 'initiatorDomains', 'domains' ];
    const prepare = rules => {
        for ( const { condition } of rules ) {
            if ( condition === undefined ) { continue; }
            for ( const prop of nodupProps ) {
                if ( condition[prop] === undefined ) { continue; }
                condition[prop] = Array.from(new Set(condition[prop]));
            }
        }
        rules.sort((a, b) => {
            let aLen = 0, bLen = 0;
            for ( const prop of sortProps ) {
                aLen += a.condition[prop]?.length ?? 0;
                bLen += b.condition[prop]?.length ?? 0;
            }
            return bLen - aLen;
        });
    };
    prepare(ruleset);
    prepare(tail);
    const replacer = (k, v) => {
        if ( k.startsWith('_') ) { return; }
        if ( Array.isArray(v) ) {
            return v.sort();
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
    const all = [ ...ruleset, ...tail ];
    const indent = all.length > 10 ? undefined : 1;
    const out = [];
    let id = 1;
    for ( const rule of all ) {
        rule.id = id++;
        out.push(JSON.stringify(rule, replacer, indent));
    }
    return `[\n${out.join(',\n')}\n]\n`;
}
