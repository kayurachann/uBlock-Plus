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
const MAX_MATCH_STEPS_PER_EVALUATION = 65536;

const BUDGET_EXHAUSTED_REASON =
    'compiled-popup-evaluation-budget-exhausted';
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
    return { domainAnchor, tokens };
}

function isSeparator(char) {
    return char !== undefined && /[^%.0-9a-z_-]/i.test(char);
}

function matchUrlFilterTokens(input, tokens, caseSensitive, budget) {
    const text = caseSensitive ? input : input.toLowerCase();
    let inputIndex = 0;
    let tokenIndex = 0;
    let starIndex = -1;
    let starInputIndex = -1;
    while ( inputIndex < text.length ) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
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

function matchesUrlFilter(urlString, url, details, caseSensitive, budget) {
    const { domainAnchor, tokens } = details;
    if ( domainAnchor === false ) {
        return matchUrlFilterTokens(
            urlString,
            tokens,
            caseSensitive,
            budget
        );
    }
    if ( url === undefined ) { return false; }
    const startsWithDot = tokens[0]?.type === 'text' &&
        tokens[0].value === '.';
    const hostname = url.hostname;
    if ( hostname === '' ) { return false; }
    const tail = `${url.port === '' ? '' : `:${url.port}`}` +
        `${url.pathname}${url.search}${url.hash}`;
    let index = 0;
    for (;;) {
        if ( consumeMatchSteps(budget) === false ) { return false; }
        const candidate =
            `${startsWithDot && index !== 0 ? '.' : ''}` +
            `${hostname.slice(index)}${tail}`;
        if ( matchUrlFilterTokens(
            candidate,
            tokens,
            caseSensitive,
            budget
        ) ) {
            return true;
        }
        if ( budget.exhausted || isIPAddress(hostname) ) { return false; }
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

function matchesCondition(condition, input, budget) {
    const target = urlContext(
        input.targetURL,
        input.targetURLComplete !== false
    );
    if ( target.url === undefined ) {
        return target.pending ? 'context-pending' : 'no-match';
    }
    const targetHostname = hostnameFromParsedURL(target.url);

    if ( matchesDomainConditions(
        targetHostname,
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
            const initiator = urlContext(input.initiatorURL);
            if ( initiator.url === undefined ) { return 'no-match'; }
            if ( matchesDomainConditions(
                hostnameFromParsedURL(initiator.url),
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
        const top = urlContext(input.topURL);
        if ( top.url === undefined ) { return 'no-match'; }
        if ( matchesDomainConditions(
            hostnameFromParsedURL(top.url),
            condition.topDomains,
            condition.excludedTopDomains,
            budget
        ) === false ) {
            if ( budget.exhausted ) { return 'budget-exhausted'; }
            return 'no-match';
        }
    }
    const caseSensitive = condition.isUrlFilterCaseSensitive === true;
    if ( condition.urlFilterDetails !== undefined ) {
        if ( target.complete === false ) {
            initiatorPending = true;
        } else if ( matchesUrlFilter(
            target.value,
            target.url,
            condition.urlFilterDetails,
            caseSensitive,
            budget
        ) === false ) {
            if ( budget.exhausted ) { return 'budget-exhausted'; }
            return 'no-match';
        } else if ( condition.urlFilterDetails.domainAnchor ) {
            hasTargetHostnameEvidence = true;
        }
    }
    if ( condition.regex !== undefined ) {
        if ( target.complete === false ) {
            initiatorPending = true;
        } else if ( matchesRegexFilter(
            target.value,
            condition.regex,
            budget
        ) === false ) {
            if ( budget.exhausted ) { return 'budget-exhausted'; }
            return 'no-match';
        }
    }
    if ( input.requireTargetHostnameMatch === true &&
        hasTargetHostnameEvidence === false ) {
        return initiatorPending ? 'context-pending' : 'no-match';
    }
    return initiatorPending ? 'context-pending' : 'match';
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

function evaluateRealm(realms, realmIds, input, budget) {
    let best;
    let pendingAllow;
    let pendingBlock;
    let uncertainAllow;
    for ( const realm of realms ) {
        if ( realmIds.includes(realm?.id) === false ||
            Array.isArray(realm.filters) === false ) {
            continue;
        }
        for ( const filter of realm.filters ) {
            budget.filterCount += 1;
            if ( budget.filterCount > MAX_FILTERS_PER_EVALUATION ) {
                budget.exhausted = true;
                break;
            }
            const compiled = compileRuntimeFilter(filter);
            if ( compiled === invalidRuntimeFilter ||
                compiled.kind !== input.kind ) {
                continue;
            }
            const conditionMatch = matchesCondition(
                compiled.condition,
                input,
                budget
            );
            if ( conditionMatch === 'budget-exhausted' ) { break; }
            if ( conditionMatch === 'no-match' ) {
                continue;
            }
            if ( compiled.uncertainAllow ) {
                const candidate = {
                    filter: compiled,
                    priority: filterPriority(compiled),
                    realmId: realm.id,
                };
                if ( preferredMatch(candidate, uncertainAllow) ) {
                    uncertainAllow = candidate;
                }
                continue;
            }
            // A missing opener/frame context can hide a matching exception.
            // Keep the candidate pending until webNavigation supplies that
            // context; otherwise the heuristic layer could close a popup
            // before a constrained compiled allow rule gets evaluated.
            if ( conditionMatch === 'context-pending' ||
                (compiled.action === 'block' &&
                input.initiatorContextComplete !== true) ) {
                const candidate = {
                    filter: compiled,
                    priority: filterPriority(compiled),
                    realmId: realm.id,
                };
                if ( compiled.action === 'allow' ) {
                    if ( preferredMatch(candidate, pendingAllow) ) {
                        pendingAllow = candidate;
                    }
                } else if ( preferredMatch(candidate, pendingBlock) ) {
                    pendingBlock = candidate;
                }
                continue;
            }
            const candidate = {
                filter: compiled,
                priority: filterPriority(compiled),
                realmId: realm.id,
            };
            if ( preferredMatch(candidate, best) ) { best = candidate; }
        }
        if ( budget.exhausted ) { break; }
    }
    if ( budget.exhausted ) {
        return { action: 'defer', reason: BUDGET_EXHAUSTED_REASON };
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
        matchSteps: 0,
    };
    const filteringMode = Number.isFinite(input.filteringMode)
        ? input.filteringMode
        : 0;
    if ( filteringMode >= 1 ) {
        const sandboxMatch = evaluateRealm(
            realms,
            [ 'sandbox' ],
            input,
            budget
        );
        if ( sandboxMatch !== undefined ) { return sandboxMatch; }
    }
    if ( filteringMode >= 2 ) {
        const importedMatch = evaluateRealm(
            realms,
            [ 'imported', 'stock' ],
            input,
            budget
        );
        if ( importedMatch !== undefined ) { return importedMatch; }
    } else if ( filteringMode >= 1 ) {
        const stockMatch = evaluateRealm(realms, [ 'stock' ], input, budget);
        if ( stockMatch !== undefined ) { return stockMatch; }
    }
    return noMatch;
}

/******************************************************************************/
