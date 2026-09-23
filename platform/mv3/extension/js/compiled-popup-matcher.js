/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
    GNU General Public License for more details.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export const POPUP_RUNTIME_ROUTE_CODE = 'popup-observer-runtime';
export const POPUP_DEFERRED_ROUTE_CODE = 'popup-compiler-required';

const MATCH_REASON = 'compiled-popup-filter';
const MAX_FILTER_LENGTH = 2048;
const MAX_REGEX_LENGTH = 1024;
const MAX_URL_LENGTH = 8192;
const MAX_ALTERNATIONS = 16;
const MAX_REGEX_BRANCHES = 256;
const MAX_VARIABLE_QUANTIFIERS = 16;
// These are per-rule validation caps; the lower aggregate limits below bound
// a whole popup event even when every individual rule is otherwise valid.
const MAX_DOMAINS_PER_LIST = 128;
const MAX_DOMAINS_PER_CONDITION = 256;
const MAX_REALMS_PER_EVALUATION = 16;
const MAX_FILTERS_PER_EVALUATION = 4096;
// Sized for every stock popup filter against a maximal 8 KB URL. The
// aggregate bounds worst-case work; it must not be reachable by ordinary
// long landing URLs, or padding a URL would switch off popup protection.
const MAX_MATCH_STEPS_PER_EVALUATION = 8_000_000;
// One glob comparison scans each character a small constant number of times
// unless the pattern overlaps itself (the classic `*aaaa...b` case). That
// comparison is abandoned once it exceeds this linear allowance.
const MATCH_STEPS_PER_FILTER_CHARACTER = 4;
const MATCH_STEPS_PER_FILTER_BASE = 64;

const BUDGET_EXHAUSTED_REASON =
    'compiled-popup-evaluation-budget-exhausted';
const TARGET_TRUNCATED_REASON = 'compiled-popup-target-truncated';
const invalidRuntimeFilter = Symbol('invalid-runtime-filter');
const runtimeFilterCache = new WeakMap();

const supportedConditionKeys = new Set([
    'excludedInitiatorDomains',
    'excludedRequestDomains',
    'excludedTopDomains',
    'initiatorDomains',
    'isUrlFilterCaseSensitive',
    'regexFilter',
    'requestDomains',
    'topDomains',
    'urlFilter',
]);

const unsupportedConditionKeys = new Map([
    [ 'domainType', 'unsupported-domain-type' ],
    [ 'excludedRequestMethods', 'unsupported-excluded-request-methods' ],
    [ 'excludedResourceTypes', 'unsupported-excluded-resource-types' ],
    [ 'excludedResponseHeaders', 'unsupported-excluded-response-headers' ],
    [ 'excludedTabIds', 'unsupported-excluded-tab-ids' ],
    [ 'requestMethods', 'unsupported-request-methods' ],
    [ 'resourceTypes', 'unsupported-resource-types' ],
    [ 'responseHeaders', 'unsupported-response-headers' ],
    [ 'tabIds', 'unsupported-tab-ids' ],
]);

const domainListKeys = [
    'excludedInitiatorDomains',
    'excludedRequestDomains',
    'excludedTopDomains',
    'initiatorDomains',
    'requestDomains',
    'topDomains',
];

/******************************************************************************/

function unsupported(reasonCode) {
    return { supported: false, reasonCode };
}

function isPlainObject(value) {
    if ( typeof value !== 'object' || value === null ) { return false; }
    if ( Array.isArray(value) ) { return false; }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isValidDomain(value) {
    if ( typeof value !== 'string' || value === '' || value.length > 253 ) {
        return false;
    }
    if ( value === '*' ) { return true; }
    if ( /^[\x21-\x7E]+$/.test(value) === false ) { return false; }
    if ( /[/@?#]/.test(value) ) { return false; }
    if ( value.startsWith('.') || value.endsWith('.') ) { return false; }
    try {
        const url = new URL(`https://${value}/`);
        return url.hostname.toLowerCase() === value.toLowerCase();
    } catch {
        return false;
    }
}

function isValidDomainList(value) {
    return Array.isArray(value) && value.length !== 0 &&
        value.every(isValidDomain);
}

function classifyUrlFilter(value) {
    if ( typeof value !== 'string' || value === '' ||
        value.length > MAX_FILTER_LENGTH ) {
        return unsupported('invalid-url-filter');
    }
    if ( /^[\x20-\x7E]+$/.test(value) === false ) {
        return unsupported('invalid-url-filter');
    }
    let pattern = value;
    if ( pattern.startsWith('||') ) {
        pattern = pattern.slice(2);
    } else if ( pattern.startsWith('|') ) {
        pattern = pattern.slice(1);
    }
    if ( pattern.endsWith('|') ) {
        pattern = pattern.slice(0, -1);
    }
    if ( pattern === '' || pattern.includes('|') ) {
        return unsupported('invalid-url-filter');
    }
    return { supported: true };
}

function isSupportedRegexEscape(pattern, index, inCharacterClass) {
    const char = pattern[index];
    if ( /[1-9]/.test(char) || char === 'k' ||
        char === 'p' || char === 'P' ) {
        return false;
    }
    if ( char === '0' ) { return /\d/.test(pattern[index+1]) === false; }
    if ( char === 'x' ) {
        return /^[\da-f]{2}/i.test(pattern.slice(index+1));
    }
    if ( char === 'u' ) {
        return /^[\da-f]{4}/i.test(pattern.slice(index+1));
    }
    const supportedLetters = inCharacterClass
        ? 'bdfnrstvwDSSW'
        : 'bBdfnrstvwDSW';
    if ( /[a-z]/i.test(char) ) {
        return supportedLetters.includes(char);
    }
    return true;
}

function scanRegexSafety(pattern) {
    const groups = [];
    const closedGroups = new Map();
    let escaped = false;
    let inCharacterClass = false;
    let variableQuantifiers = 0;
    let unboundedQuantifiers = 0;
    let alternations = 0;
    let branchBudget = 1;
    let lastWasQuantifier = false;
    let hasTopLevelAlternation = false;

    const markQuantifier = (unbounded, minimum, maximum) => {
        variableQuantifiers += 1;
        if ( unbounded ) { unboundedQuantifiers += 1; }
        if ( unbounded === false ) {
            branchBudget *= maximum - minimum + 1;
        }
        if ( variableQuantifiers > MAX_VARIABLE_QUANTIFIERS ||
            unboundedQuantifiers > 1 ||
            branchBudget > MAX_REGEX_BRANCHES ||
            (unbounded === false && maximum > 100) ) {
            return false;
        }
        for ( const group of groups ) {
            group.hasQuantifier = true;
        }
        return true;
    };

    for ( let i = 0; i < pattern.length; i++ ) {
        const char = pattern[i];
        if ( escaped ) {
            if ( isSupportedRegexEscape(
                pattern,
                i,
                inCharacterClass
            ) === false ) {
                return unsupported('unsupported-regex-syntax');
            }
            escaped = false;
            lastWasQuantifier = false;
            continue;
        }
        if ( char === '\\' ) {
            escaped = true;
            continue;
        }
        if ( inCharacterClass ) {
            if ( char === ']' ) { inCharacterClass = false; }
            continue;
        }
        if ( char === '[' ) {
            inCharacterClass = true;
            lastWasQuantifier = false;
            continue;
        }
        if ( char === '(' ) {
            if ( pattern[i+1] === '?' && pattern[i+2] !== ':' ) {
                return unsupported('unsupported-regex-syntax');
            }
            groups.push({ hasAlternation: false, hasQuantifier: false });
            if ( pattern[i+1] === '?' ) { i += 2; }
            lastWasQuantifier = false;
            continue;
        }
        if ( char === '|' ) {
            alternations += 1;
            if ( groups.length === 0 ) { hasTopLevelAlternation = true; }
            if ( alternations > MAX_ALTERNATIONS ) {
                return unsupported('unsafe-regex-filter');
            }
            // A repeated outer group is just as dangerous when an ambiguous
            // alternation lives inside a nested group. Mark every open
            // ancestor instead of recording only the innermost group.
            for ( const group of groups ) {
                group.hasAlternation = true;
            }
            lastWasQuantifier = false;
            continue;
        }
        if ( char === ')' ) {
            closedGroups.set(i, groups.pop());
            lastWasQuantifier = false;
            continue;
        }

        let unbounded = false;
        let minimum = 0;
        let maximum = 1;
        let quantifierEnd = i;
        if ( char === '*' ) {
            unbounded = true;
            maximum = Infinity;
        } else if ( char === '+' ) {
            unbounded = true;
            minimum = 1;
            maximum = Infinity;
        } else if ( char === '?' ) {
            if ( lastWasQuantifier ) {
                lastWasQuantifier = false;
                continue;
            }
        } else if ( char === '{' ) {
            const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(i));
            if ( match === null ) {
                lastWasQuantifier = false;
                continue;
            }
            quantifierEnd = i + match[0].length - 1;
            minimum = Number(match[1]);
            if ( match[2] === '' ) {
                unbounded = true;
                maximum = Infinity;
            } else {
                maximum = Number(match[2] ?? match[1]);
            }
        } else {
            lastWasQuantifier = false;
            continue;
        }

        const previousGroup = closedGroups.get(i - 1);
        if ( previousGroup?.hasAlternation || previousGroup?.hasQuantifier ) {
            return unsupported('unsafe-regex-filter');
        }
        if ( markQuantifier(unbounded, minimum, maximum) === false ) {
            return unsupported('unsafe-regex-filter');
        }
        i = quantifierEnd;
        lastWasQuantifier = true;
    }
    // An unanchored expression containing an unbounded quantifier is retried
    // at each input offset by JavaScript regexp engines. Innocent-looking
    // patterns such as `a.*b` consequently become quadratic when `b` is
    // absent. Top-level alternatives are rejected too because a leading `^`
    // would not necessarily anchor every branch.
    if ( unboundedQuantifiers !== 0 &&
        (pattern.startsWith('^') === false || hasTopLevelAlternation) ) {
        return unsupported('unsafe-regex-filter');
    }
    return { supported: true };
}

function classifyRegexFilter(value) {
    if ( typeof value !== 'string' || value === '' ) {
        return unsupported('invalid-regex-filter');
    }
    if ( value.length > MAX_REGEX_LENGTH ) {
        return unsupported('regex-filter-too-long');
    }
    try {
        new RegExp(value);
    } catch {
        return unsupported('invalid-regex-filter');
    }
    return scanRegexSafety(value);
}

/******************************************************************************/

export function classifyPopupCondition(condition) {
    if ( isPlainObject(condition) === false ) {
        return unsupported('invalid-popup-condition');
    }
    for ( const key of Object.keys(condition) ) {
        const reasonCode = unsupportedConditionKeys.get(key);
        if ( reasonCode !== undefined ) { return unsupported(reasonCode); }
        if ( supportedConditionKeys.has(key) === false ) {
            return unsupported('unsupported-condition-key');
        }
    }
    let domainCount = 0;
    for ( const key of domainListKeys ) {
        if ( condition[key] === undefined ) { continue; }
        if ( isValidDomainList(condition[key]) === false ||
            condition[key].length > MAX_DOMAINS_PER_LIST ) {
            return unsupported('invalid-domain-list');
        }
        domainCount += condition[key].length;
        if ( domainCount > MAX_DOMAINS_PER_CONDITION ) {
            return unsupported('invalid-domain-list');
        }
    }
    if ( condition.isUrlFilterCaseSensitive !== undefined &&
        typeof condition.isUrlFilterCaseSensitive !== 'boolean' ) {
        return unsupported('invalid-match-case');
    }
    if ( condition.urlFilter !== undefined &&
        condition.regexFilter !== undefined ) {
        return unsupported('conflicting-url-patterns');
    }
    if ( condition.urlFilter !== undefined ) {
        return classifyUrlFilter(condition.urlFilter);
    }
    if ( condition.regexFilter !== undefined ) {
        return classifyRegexFilter(condition.regexFilter);
    }
    return { supported: true };
}

// Build a conservative superset for an allow whose full condition cannot be
// represented by the observer. Unsupported predicates are removed, never
// guessed: if the remaining supported predicates match, the runtime defers
// instead of allowing an ordinary block or heuristic to erase a possible
// exception. This is a guard, not an executable allow rule.
function projectDeferredAllowCondition(condition) {
    if ( isPlainObject(condition) === false ) { return {}; }
    const projection = {};
    let domainCount = 0;
    for ( const key of domainListKeys ) {
        const value = condition[key];
        if ( value === undefined || isValidDomainList(value) === false ||
            value.length > MAX_DOMAINS_PER_LIST ||
            domainCount + value.length > MAX_DOMAINS_PER_CONDITION ) {
            continue;
        }
        projection[key] = value;
        domainCount += value.length;
    }
    if ( typeof condition.isUrlFilterCaseSensitive === 'boolean' ) {
        projection.isUrlFilterCaseSensitive =
            condition.isUrlFilterCaseSensitive;
    }
    if ( condition.regexFilter === undefined &&
        classifyUrlFilter(condition.urlFilter).supported ) {
        projection.urlFilter = condition.urlFilter;
    } else if ( condition.urlFilter === undefined &&
        classifyRegexFilter(condition.regexFilter).supported ) {
        projection.regexFilter = condition.regexFilter;
    }
    return classifyPopupCondition(projection).supported ? projection : {};
}

/******************************************************************************/

function parsedURL(value) {
    if ( value === '' ) { return; }
    try {
        return new URL(value);
    } catch {
    }
}

function urlContext(value, explicitlyComplete = true) {
    if ( typeof value !== 'string' || value === '' ) {
        return { complete: false, pending: false };
    }
    const oversized = value.length > MAX_URL_LENGTH;
    const parseValue = oversized ? value.slice(0, MAX_URL_LENGTH) : value;
    const url = parsedURL(parseValue);
    if ( url === undefined ) {
        return {
            complete: false,
            pending: oversized || explicitlyComplete === false,
        };
    }
    return {
        complete: oversized === false && explicitlyComplete !== false,
        pending: oversized || explicitlyComplete === false,
        url,
        value: parseValue,
    };
}

function hostnameFromParsedURL(url, depth = 0) {
    if ( url === undefined || depth > 2 ) { return ''; }
    if ( url.protocol === 'blob:' ) {
        return hostnameFromParsedURL(parsedURL(url.pathname), depth + 1);
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
}

function isIPAddress(hostname) {
    return hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname);
}

function matchesDomain(hostname, domain) {
    if ( domain === '*' ) { return hostname !== ''; }
    if ( hostname === domain ) { return true; }
    if ( hostname === '' || isIPAddress(hostname) || isIPAddress(domain) ) {
        return false;
    }
    return hostname.endsWith(`.${domain}`);
}

function consumeMatchSteps(budget, count = 1) {
    if ( budget.matchSteps + count > MAX_MATCH_STEPS_PER_EVALUATION ) {
        budget.exhausted = true;
        return false;
    }
    budget.matchSteps += count;
    return true;
}

function matchesDomainList(hostname, domains, budget) {
    if ( domains === undefined ) { return false; }
    for ( const domain of domains ) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        if ( matchesDomain(hostname, domain) ) { return true; }
    }
    return false;
}

function matchesDomainConditions(hostname, included, excluded, budget) {
    if ( matchesDomainList(hostname, excluded, budget) ) { return false; }
    if ( budget.exhausted ) { return false; }
    return included === undefined ||
        matchesDomainList(hostname, included, budget);
}

function urlFilterDetails(rawPattern) {
    let pattern = rawPattern;
    let leftAnchor = false;
    let domainAnchor = false;
    let rightAnchor = false;
    if ( pattern.startsWith('||') ) {
        domainAnchor = true;
        pattern = pattern.slice(2);
    } else if ( pattern.startsWith('|') ) {
        leftAnchor = true;
        pattern = pattern.slice(1);
    }
    if ( pattern.endsWith('|') ) {
        rightAnchor = true;
        pattern = pattern.slice(0, -1);
    }
    const tokens = [];
    for ( const char of pattern ) {
        const type = char === '*' ? 'star' : char === '^' ? 'separator' : 'text';
        if ( type === 'star' && tokens.at(-1)?.type === 'star' ) { continue; }
        tokens.push({
            type,
            value: char,
            valueLower: type === 'text' ? char.toLowerCase() : char,
        });
    }
    if ( leftAnchor === false && domainAnchor === false ) {
        tokens.unshift({ type: 'star', value: '*' });
    }
    if ( rightAnchor === false ) {
        tokens.push({ type: 'star', value: '*' });
    }
    // The hostname characters a domain-anchored pattern starts with. None of
    // them can match the `:`, `/`, `?` or `#` which follows a hostname.
    let hostLiteral = '';
    if ( domainAnchor ) {
        for ( const token of tokens ) {
            if ( token.type !== 'text' || /^[\w.-]$/.test(token.value) === false ) {
                break;
            }
            hostLiteral += token.valueLower;
        }
    }
    return { domainAnchor, hostLiteral, tokens };
}

function isSeparator(char) {
    return char !== undefined && /[^%.0-9a-z_-]/i.test(char);
}

// `text` is already lowercased by the caller for case-insensitive filters.
function matchUrlFilterTokens(text, start, tokens, caseSensitive, budget) {
    const stepLimit = budget.matchSteps + MATCH_STEPS_PER_FILTER_BASE +
        MATCH_STEPS_PER_FILTER_CHARACTER * (text.length - start + tokens.length);
    let inputIndex = start;
    let tokenIndex = 0;
    let starIndex = -1;
    let starInputIndex = -1;
    while ( inputIndex < text.length ) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        if ( budget.matchSteps > stepLimit ) {
            budget.filterOverrun = true;
            return false;
        }
        const token = tokens[tokenIndex];
        if ( token?.type === 'star' ) {
            starIndex = tokenIndex++;
            starInputIndex = inputIndex;
            continue;
        }
        const tokenMatches = token?.type === 'separator'
            ? isSeparator(text[inputIndex])
            : token?.type === 'text' &&
                (caseSensitive ? token.value : token.valueLower) ===
                    text[inputIndex];
        if ( tokenMatches ) {
            inputIndex += 1;
            tokenIndex += 1;
            continue;
        }
        if ( starIndex === -1 ) { return false; }
        tokenIndex = starIndex + 1;
        starInputIndex += 1;
        inputIndex = starInputIndex;
    }
    while ( tokens[tokenIndex]?.type === 'star' ||
        tokens[tokenIndex]?.type === 'separator' ) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        tokenIndex += 1;
    }
    return tokenIndex === tokens.length;
}

function matchesUrlFilter(target, details, caseSensitive, budget) {
    const { domainAnchor, tokens } = details;
    if ( domainAnchor === false ) {
        return matchUrlFilterTokens(
            caseSensitive ? target.value : target.valueLower,
            0,
            tokens,
            caseSensitive,
            budget
        );
    }
    const startsWithDot = tokens[0]?.type === 'text' &&
        tokens[0].value === '.';
    const hostname = target.url.hostname;
    if ( hostname === '' ) { return false; }
    const text = caseSensitive ? target.hostTail : target.hostTailLower;
    let index = 0;
    for (;;) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        // Each suffix starts after a label dot, which a dot-prefixed pattern
        // must also see; hostTail keeps that dot at index - 1.
        if ( matchUrlFilterTokens(
            text,
            startsWithDot && index !== 0 ? index - 1 : index,
            tokens,
            caseSensitive,
            budget
        ) ) {
            return true;
        }
        if ( budget.exhausted || budget.filterOverrun ||
            isIPAddress(hostname) ) {
            return false;
        }
        const dot = hostname.indexOf('.', index);
        if ( dot === -1 ) { return false; }
        index = dot + 1;
    }
}

// A truncated target keeps its hostname but not its path. A domain-anchored
// pattern starts at a label of that hostname, so a pattern whose leading
// hostname characters cannot start at any label is decided without the path.
function hostCanBeginUrlFilter(target, details, budget) {
    const { hostLiteral } = details;
    if ( hostLiteral === '' ) { return true; }
    const hostname = target.url.hostname.toLowerCase();
    if ( hostname === '' ) { return false; }
    const startsWithDot = hostLiteral.startsWith('.');
    let index = 0;
    for (;;) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        if ( hostname.startsWith(
            hostLiteral,
            startsWithDot && index !== 0 ? index - 1 : index
        ) ) {
            return true;
        }
        const dot = hostname.indexOf('.', index);
        if ( dot === -1 ) { return false; }
        index = dot + 1;
    }
}

function matchesRegexFilter(url, regex, budget) {
    // Safe regexps admitted by scanRegexSafety() are linear/bounded, but the
    // engine is not interruptible. Charge their whole input to the aggregate
    // budget before entering RegExp.prototype.test().
    if ( consumeMatchSteps(budget, url.length + regex.source.length) === false ) {
        return false;
    }
    return regex.test(url);
}

// Parse and lowercase the event URLs once. Every filter of every realm is
// matched against the same immutable values.
function evaluationContext(input) {
    const target = urlContext(
        input.targetURL,
        input.targetURLComplete !== false
    );
    if ( target.url !== undefined ) {
        const { url } = target;
        target.hostname = hostnameFromParsedURL(url);
        target.valueLower = target.value.toLowerCase();
        target.hostTail = `${url.hostname}` +
            `${url.port === '' ? '' : `:${url.port}`}` +
            `${url.pathname}${url.search}${url.hash}`;
        target.hostTailLower = target.hostTail.toLowerCase();
    }
    // The caller replaced a URL too long to keep by its origin. Unlike a
    // context which is still being resolved, the dropped path never arrives.
    // The matcher's own cut of an oversized value is not trusted for this: a
    // prefix of a URL can name another host.
    target.truncated = input.targetURLTruncated === true &&
        target.url !== undefined && target.pending &&
        target.value === input.targetURL;
    const initiator = urlContext(input.initiatorURL);
    const top = urlContext(input.topURL);
    return {
        target,
        initiatorHostname: initiator.url !== undefined
            ? hostnameFromParsedURL(initiator.url)
            : undefined,
        topHostname: top.url !== undefined
            ? hostnameFromParsedURL(top.url)
            : undefined,
    };
}

function matchesCondition(condition, input, context, budget) {
    const { target } = context;
    if ( target.url === undefined ) {
        return target.pending ? 'context-pending' : 'no-match';
    }

    if ( matchesDomainConditions(
        target.hostname,
        condition.requestDomains,
        condition.excludedRequestDomains,
        budget
    ) === false ) {
        if ( budget.exhausted ) { return 'budget-exhausted'; }
        return 'no-match';
    }
    let hasTargetHostnameEvidence = condition.requestDomains !== undefined;
    if ( input.requireTargetHostnameMatch === true &&
        hasTargetHostnameEvidence === false &&
        condition.urlFilterDetails?.domainAnchor !== true ) {
        return 'no-match';
    }
    let initiatorPending = false;
    if ( condition.initiatorDomains !== undefined ||
        condition.excludedInitiatorDomains !== undefined ) {
        if ( input.initiatorContextComplete !== true ) {
            initiatorPending = true;
        } else {
            if ( context.initiatorHostname === undefined ) {
                return 'no-match';
            }
            if ( matchesDomainConditions(
                context.initiatorHostname,
                condition.initiatorDomains,
                condition.excludedInitiatorDomains,
                budget
            ) === false ) {
                if ( budget.exhausted ) { return 'budget-exhausted'; }
                return 'no-match';
            }
        }
    }
    if ( condition.topDomains !== undefined ||
        condition.excludedTopDomains !== undefined ) {
        if ( context.topHostname === undefined ) { return 'no-match'; }
        if ( matchesDomainConditions(
            context.topHostname,
            condition.topDomains,
            condition.excludedTopDomains,
            budget
        ) === false ) {
            if ( budget.exhausted ) { return 'budget-exhausted'; }
            return 'no-match';
        }
    }
    const caseSensitive = condition.isUrlFilterCaseSensitive === true;
    let targetPending = false;
    if ( condition.urlFilterDetails !== undefined ) {
        if ( target.complete === false ) {
            if ( target.truncated && hostCanBeginUrlFilter(
                target,
                condition.urlFilterDetails,
                budget
            ) === false ) {
                if ( budget.exhausted ) { return 'budget-exhausted'; }
                return 'no-match';
            }
            targetPending = true;
        } else if ( matchesUrlFilter(
            target,
            condition.urlFilterDetails,
            caseSensitive,
            budget
        ) === false ) {
            if ( budget.exhausted || budget.filterOverrun ) {
                return 'budget-exhausted';
            }
            return 'no-match';
        } else if ( condition.urlFilterDetails.domainAnchor ) {
            hasTargetHostnameEvidence = true;
        }
    }
    if ( condition.regex !== undefined ) {
        if ( target.complete === false ) {
            targetPending = true;
        } else if ( matchesRegexFilter(
            target.value,
            condition.regex,
            budget
        ) === false ) {
            if ( budget.exhausted ) { return 'budget-exhausted'; }
            return 'no-match';
        }
    }
    let pending;
    if ( initiatorPending ) {
        pending = 'context-pending';
    } else if ( targetPending ) {
        pending = target.truncated ? 'target-truncated' : 'context-pending';
    }
    if ( input.requireTargetHostnameMatch === true &&
        hasTargetHostnameEvidence === false ) {
        return pending ?? 'no-match';
    }
    return pending ?? 'match';
}

function filterPriority(filter) {
    if ( filter.action === 'allow' ) { return 30; }
    return filter.important === true ? 40 : 10;
}

function compileRuntimeFilter(filter) {
    if ( isPlainObject(filter) === false ) { return invalidRuntimeFilter; }
    const cached = runtimeFilterCache.get(filter);
    if ( cached !== undefined ) { return cached; }
    let compiled = invalidRuntimeFilter;
    const deferredAllow =
        filter.routeCode === POPUP_DEFERRED_ROUTE_CODE &&
        filter.action === 'allow';
    const runtimeRoute = filter.routeCode === POPUP_RUNTIME_ROUTE_CODE;
    const projectedCondition = deferredAllow
        ? projectDeferredAllowCondition(filter.condition)
        : filter.condition;
    if ( filter.schemaVersion === 1 &&
        (runtimeRoute || deferredAllow) &&
        (filter.kind === 'popup' || filter.kind === 'popunder') &&
        (filter.action === 'allow' || filter.action === 'block') &&
        typeof filter.important === 'boolean' &&
        Number.isSafeInteger(filter.lineNumber) && filter.lineNumber > 0 &&
        classifyPopupCondition(projectedCondition).supported ) {
        const condition = { ...projectedCondition };
        for ( const key of domainListKeys ) {
            if ( condition[key] === undefined ) { continue; }
            condition[key] = condition[key].map(domain =>
                domain.toLowerCase()
            );
        }
        if ( condition.urlFilter !== undefined ) {
            condition.urlFilterDetails = urlFilterDetails(
                condition.urlFilter
            );
            delete condition.urlFilter;
        }
        if ( condition.regexFilter !== undefined ) {
            condition.regex = new RegExp(
                condition.regexFilter,
                condition.isUrlFilterCaseSensitive === true ? '' : 'i'
            );
            delete condition.regexFilter;
        }
        compiled = {
            action: filter.action,
            condition,
            important: filter.important,
            kind: filter.kind,
            lineNumber: filter.lineNumber,
            uncertainAllow: deferredAllow,
        };
    }
    runtimeFilterCache.set(filter, compiled);
    return compiled;
}

function preferredMatch(candidate, current) {
    if ( current === undefined ) { return true; }
    if ( candidate.priority !== current.priority ) {
        return candidate.priority > current.priority;
    }
    if ( candidate.filter.action !== current.filter.action ) {
        return candidate.filter.action === 'allow';
    }
    return candidate.filter.lineNumber < current.filter.lineNumber;
}

function evaluateRealm(realms, realmIds, input, context, budget) {
    let best;
    let pendingAllow;
    let pendingBlock;
    let uncertainAllow;
    // The highest-ranked block which cannot be decided: the work budget ran
    // out, or only the dropped path of a truncated target could match it.
    let unresolvedBlock;
    const selectedRealms = realms.filter(realm =>
        realmIds.includes(realm?.id) && Array.isArray(realm.filters)
    );
    // Exceptions are evaluated first. Running out of budget while one of them
    // may still match defers the decision. Once every exception is ruled out,
    // an unevaluated block can only fail to close the popup, so it must not
    // also switch off the contextual policy: otherwise padding a URL would
    // bypass every popup protection.
    for ( const action of [ 'allow', 'block' ] ) {
        for ( const realm of selectedRealms ) {
            for ( const filter of realm.filters ) {
                if ( action === 'allow' ) {
                    budget.filterCount += 1;
                    if ( budget.filterCount > MAX_FILTERS_PER_EVALUATION ) {
                        budget.exhausted = true;
                        break;
                    }
                }
                const compiled = compileRuntimeFilter(filter);
                if ( compiled === invalidRuntimeFilter ||
                    compiled.kind !== input.kind ||
                    compiled.action !== action ) {
                    continue;
                }
                const candidate = {
                    filter: compiled,
                    priority: filterPriority(compiled),
                    realmId: realm.id,
                };
                // Once the aggregate budget is gone, the remaining blocks
                // are still ranked, but no longer matched.
                let conditionMatch = 'budget-exhausted';
                if ( budget.exhausted === false ) {
                    budget.filterOverrun = false;
                    conditionMatch = matchesCondition(
                        compiled.condition,
                        input,
                        context,
                        budget
                    );
                }
                if ( conditionMatch === 'budget-exhausted' ) {
                    if ( action === 'allow' ) {
                        budget.exhausted = true;
                        break;
                    }
                    // A single self-overlapping pattern only forfeits its own
                    // verdict; the remaining blocks still run.
                    candidate.reason = BUDGET_EXHAUSTED_REASON;
                    if ( preferredMatch(candidate, unresolvedBlock) ) {
                        unresolvedBlock = candidate;
                    }
                    continue;
                }
                if ( conditionMatch === 'no-match' ) {
                    continue;
                }
                if ( compiled.uncertainAllow ) {
                    if ( preferredMatch(candidate, uncertainAllow) ) {
                        uncertainAllow = candidate;
                    }
                    continue;
                }
                // The dropped path of a truncated target never arrives, so a
                // block which only that path could match is undecided rather
                // than pending. An exception keeps deferring below.
                if ( conditionMatch === 'target-truncated' &&
                    compiled.action === 'block' &&
                    input.initiatorContextComplete === true ) {
                    candidate.reason = TARGET_TRUNCATED_REASON;
                    if ( preferredMatch(candidate, unresolvedBlock) ) {
                        unresolvedBlock = candidate;
                    }
                    continue;
                }
                // A missing opener/frame context can hide a matching exception.
                // Keep the candidate pending until webNavigation supplies that
                // context; otherwise the heuristic layer could close a popup
                // before a constrained compiled allow rule gets evaluated.
                if ( conditionMatch !== 'match' ||
                    (compiled.action === 'block' &&
                    input.initiatorContextComplete !== true) ) {
                    if ( compiled.action === 'allow' ) {
                        if ( preferredMatch(candidate, pendingAllow) ) {
                            pendingAllow = candidate;
                        }
                    } else if ( preferredMatch(candidate, pendingBlock) ) {
                        pendingBlock = candidate;
                    }
                    continue;
                }
                if ( preferredMatch(candidate, best) ) { best = candidate; }
            }
            if ( budget.exhausted && action === 'allow' ) { break; }
        }
        if ( budget.exhausted && action === 'allow' ) {
            return { action: 'defer', reason: BUDGET_EXHAUSTED_REASON };
        }
    }
    // An undecided block can only add a block. Against a matching exception
    // it matters only when it would outrank it, i.e. an important block.
    if ( best?.filter.action === 'allow' && unresolvedBlock !== undefined &&
        preferredMatch(unresolvedBlock, best) ) {
        return { action: 'defer', reason: unresolvedBlock.reason };
    }
    if ( best === undefined ) {
        if ( uncertainAllow !== undefined ) {
            return {
                action: 'defer',
                reason: 'compiled-popup-allow-condition-deferred',
            };
        }
        if ( pendingAllow !== undefined || pendingBlock !== undefined ) {
            return {
                action: 'defer',
                reason: 'compiled-popup-context-pending',
            };
        }
        // No exception can apply: the contextual policy still judges.
        if ( unresolvedBlock !== undefined ) {
            budget.unresolvedBlockReason = unresolvedBlock.reason;
        }
        return;
    }
    if ( best.filter.action === 'block' &&
        uncertainAllow !== undefined &&
        preferredMatch(uncertainAllow, best) ) {
        return {
            action: 'defer',
            reason: 'compiled-popup-allow-condition-deferred',
        };
    }
    const oppositePending = best.filter.action === 'allow'
        ? pendingBlock
        : pendingAllow;
    if ( oppositePending !== undefined &&
        preferredMatch(oppositePending, best) ) {
        return {
            action: 'defer',
            reason: 'compiled-popup-context-pending',
        };
    }
    return {
        action: best.filter.action,
        reason: MATCH_REASON,
        matchedRealm: best.realmId,
        lineNumber: best.filter.lineNumber,
        kind: best.filter.kind,
    };
}

/******************************************************************************/

export function evaluateCompiledPopupFilters(realms, input) {
    const noMatch = { action: 'none', reason: MATCH_REASON };
    if ( Array.isArray(realms) === false || isPlainObject(input) === false ) {
        return noMatch;
    }
    if ( input.kind !== 'popup' && input.kind !== 'popunder' ) {
        return noMatch;
    }
    if ( realms.length > MAX_REALMS_PER_EVALUATION ) {
        return { action: 'defer', reason: BUDGET_EXHAUSTED_REASON };
    }
    const budget = {
        exhausted: false,
        filterCount: 0,
        filterOverrun: false,
        matchSteps: 0,
        unresolvedBlockReason: undefined,
    };
    const context = evaluationContext(input);
    const filteringMode = Number.isFinite(input.filteringMode)
        ? input.filteringMode
        : 0;
    if ( filteringMode >= 1 ) {
        const sandboxMatch = evaluateRealm(
            realms,
            [ 'sandbox' ],
            input,
            context,
            budget
        );
        if ( sandboxMatch !== undefined ) { return sandboxMatch; }
    }
    if ( filteringMode >= 2 ) {
        const importedMatch = evaluateRealm(
            realms,
            [ 'imported', 'stock' ],
            input,
            context,
            budget
        );
        if ( importedMatch !== undefined ) { return importedMatch; }
    } else if ( filteringMode >= 1 ) {
        const stockMatch = evaluateRealm(
            realms,
            [ 'stock' ],
            input,
            context,
            budget
        );
        if ( stockMatch !== undefined ) { return stockMatch; }
    }
    // Some blocks could not be decided, but no exception can apply: report
    // no compiled decision so the contextual policy still judges the popup.
    if ( budget.unresolvedBlockReason !== undefined ) {
        return { action: 'none', reason: budget.unresolvedBlockReason };
    }
    return noMatch;
}

/******************************************************************************/
