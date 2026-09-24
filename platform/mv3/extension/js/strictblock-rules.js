/*******************************************************************************
    uBlock Plus+ - strict-block rule shapes and the session rule plan
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later

    Pure module: no browser API and no import from ext.js. It is imported by
    the ruleset build (Node), the offscreen compiler and the service worker.

    Strict blocking redirects a blocked top-level document to the extension's
    strictblock.html page instead of letting the browser show its error page
    (classic uBO: traffic.js onBeforeRootFrameRequest). The redirects carry no
    URL: the page learns the blocked address from strictblock-tracker.js, or
    from the fragment of the legacy regexSubstitution shape (Firefox builds).
******************************************************************************/

import {
    STOCK_STRICTBLOCK_PRIORITY,
    STRICTBLOCK_SESSION_ID_LIMIT,
    USER_RULES_PRIORITY,
    isStrictBlockSessionRule,
} from './dnr-namespaces.js';

export {
    STOCK_STRICTBLOCK_PRIORITY,
    STRICTBLOCK_SESSION_ID_LIMIT,
    USER_RULES_PRIORITY,
    isStrictBlockSessionRule,
};

export const STRICTBLOCK_PAGE_PATH = '/strictblock.html';

/******************************************************************************/

// Conditions which make a block rule narrower than "this document": such a
// rule stays a plain block and never redirects to the strict-block page.
const nonCandidateConditions = [
    'domainType',
    'excludedResourceTypes',
    'requestMethods',
    'excludedRequestMethods',
    'requestHeaders',
    'responseHeaders',
    'excludedResponseHeaders',
    'initiatorDomains',
    'excludedInitiatorDomains',
    'domains',
    'excludedDomains',
    'topDomains',
    'excludedTopDomains',
    'tabIds',
    'excludedTabIds',
];

const rePatternIsHostname = /^\|\|[^*/?|^]+\^$/;
const reRequestDomain = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

// `||host^` matches exactly what requestDomains:[host] matches, as long as
// the host is a plain lower-case name that DNR accepts as a request domain.
const hostnameFromUrlFilter = urlFilter => {
    if ( rePatternIsHostname.test(urlFilter) === false ) { return ''; }
    const hostname = urlFilter.slice(2, -1);
    return reRequestDomain.test(hostname) ? hostname : '';
};

// Chrome rejects rules with unknown properties; the compilers use `_`-prefixed
// properties for provenance. Returns a deep copy without them.
export function stripPrivateProperties(value) {
    if ( value === undefined ) { return; }
    return JSON.parse(JSON.stringify(value, (k, v) =>
        k.startsWith('_') ? undefined : v
    ));
}

const basePriority = priority =>
    Number.isSafeInteger(priority) && priority >= 1 ? priority : 1;

const sortedUnion = (...lists) => {
    const out = new Set();
    for ( const list of lists ) {
        if ( Array.isArray(list) === false ) { continue; }
        for ( const item of list ) { out.add(item); }
    }
    return Array.from(out).sort();
};

// Exclusions come from the strict-block page (URL.hostname) and from storage.
// One malformed entry would make Chrome reject the whole session update.
const normalizeHostnames = list => {
    const out = new Set();
    for ( const raw of Array.isArray(list) ? list : [] ) {
        if ( typeof raw !== 'string' ) { continue; }
        const hostname = raw.trim().toLowerCase();
        if ( /^[\x21-\x7e]+$/.test(hostname) === false ) { continue; }
        if ( /[/?#@\\*^|%]/.test(hostname) ) { continue; }
        out.add(hostname);
    }
    return Array.from(out).sort();
};

const toBudget = value => Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : Number.POSITIVE_INFINITY;

/******************************************************************************/

// A block rule which blocks whole documents. The explicit main_frame case is
// the runtime (My filters, imported lists) semantics. With hostnameOnly, a
// rule without resource types whose only URL predicate is a hostname also
// qualifies: stock lists strict-block `||host^` like classic uBO does
// (make-rulesets.js strips main_frame from such rules' plain copy).
export function isStrictBlockCandidate(rule, { hostnameOnly = false } = {}) {
    if ( rule?.action?.type !== 'block' ) { return false; }
    const { condition } = rule;
    if ( typeof condition !== 'object' || condition === null ) { return false; }
    for ( const prop of nonCandidateConditions ) {
        if ( condition[prop] ) { return false; }
    }
    const { resourceTypes } = condition;
    if ( resourceTypes ) {
        return Array.isArray(resourceTypes) && resourceTypes.includes('main_frame');
    }
    if ( hostnameOnly !== true ) { return false; }
    if ( condition.requestDomains ) {
        return condition.urlFilter === undefined &&
            condition.regexFilter === undefined;
    }
    return typeof condition.urlFilter === 'string' &&
        rePatternIsHostname.test(condition.urlFilter);
}

/******************************************************************************/

// Build only: fold the stock strict-block candidates of one list into
// extensionPath redirects. The original URL predicate is kept, so only
// regex-sourced filters use a regex rule. Rules are grouped by predicate,
// case sensitivity and exact exclusions; groups with different
// excludedRequestDomains are never merged, since a union of exclusions would
// narrow the rules. requestDomains are unioned within a group, and a member
// without requestDomains makes the whole group unrestricted.
// `_sourceFilters` and `_sourceKeys` are unioned and carried for provenance;
// toJSONRuleset strips them on write.
export function foldStockStrictBlockRules(candidates) {
    const groups = new Map();
    for ( const rule of Array.isArray(candidates) ? candidates : [] ) {
        const condition = rule?.condition;
        if ( typeof condition !== 'object' || condition === null ) { continue; }
        let domains = condition.requestDomains;
        if ( domains !== undefined ) {
            // An empty list matches nothing, never everything.
            if ( Array.isArray(domains) === false || domains.length === 0 ) {
                continue;
            }
        }
        const caseSensitive = condition.isUrlFilterCaseSensitive === true;
        let kind, pattern = '';
        if ( typeof condition.regexFilter === 'string' ) {
            kind = 're';
            pattern = condition.regexFilter;
        } else if ( typeof condition.urlFilter === 'string' ) {
            const hostname = domains === undefined
                ? hostnameFromUrlFilter(condition.urlFilter)
                : '';
            if ( hostname !== '' ) {
                kind = 'hn';
                domains = [ hostname ];
            } else {
                kind = 'uf';
                pattern = condition.urlFilter;
            }
        } else if ( domains !== undefined ) {
            kind = 'hn';
        } else {
            kind = '*';
        }
        const excluded = sortedUnion(condition.excludedRequestDomains);
        const hasPattern = kind === 're' || kind === 'uf';
        const key = [
            hasPattern ? `${kind}:${pattern}` : kind,
            hasPattern && caseSensitive,
            JSON.stringify(excluded),
        ].join('\t');
        let group = groups.get(key);
        if ( group === undefined ) {
            group = {
                kind, pattern, caseSensitive: hasPattern && caseSensitive,
                excluded,
                domains: domains !== undefined ? new Set() : null,
                sourceFilters: new Set(),
                sourceKeys: new Set(),
            };
            groups.set(key, group);
        }
        if ( domains === undefined ) {
            group.domains = null;
        } else if ( group.domains !== null ) {
            for ( const hn of domains ) { group.domains.add(hn); }
        }
        for ( const filter of rule._sourceFilters ?? [] ) {
            group.sourceFilters.add(filter);
        }
        for ( const sourceKey of rule._sourceKeys ?? [] ) {
            group.sourceKeys.add(sourceKey);
        }
    }
    const out = [];
    for ( const group of groups.values() ) {
        const condition = {};
        if ( group.kind === 're' ) {
            condition.regexFilter = group.pattern;
        } else if ( group.kind === 'uf' ) {
            condition.urlFilter = group.pattern;
        }
        if ( group.caseSensitive ) {
            condition.isUrlFilterCaseSensitive = true;
        }
        if ( group.domains !== null ) {
            condition.requestDomains = Array.from(group.domains).sort();
        }
        if ( group.excluded.length !== 0 ) {
            condition.excludedRequestDomains = group.excluded;
        }
        condition.resourceTypes = [ 'main_frame' ];
        const rule = {
            action: {
                type: 'redirect',
                redirect: { extensionPath: STRICTBLOCK_PAGE_PATH },
            },
            condition,
            priority: STOCK_STRICTBLOCK_PRIORITY,
        };
        if ( group.sourceFilters.size !== 0 ) {
            rule._sourceFilters = Array.from(group.sourceFilters);
        }
        if ( group.sourceKeys.size !== 0 ) {
            rule._sourceKeys = Array.from(group.sourceKeys);
        }
        out.push(rule);
    }
    return out;
}

/******************************************************************************/

// Runtime compiler output (My filters, imported lists): one redirect template
// per document-blocking rule, stored next to the generation's dnrRules. The
// dynamic block rule itself is not modified and stays the fallback whenever
// the redirect is not installed.
//
// A template keeps the block's condition (main_frame only) and priority; the
// planner adds 1, and USER_RULES_PRIORITY for My filters. Its `id` is not a
// DNR rule ID: it is the 1-based position of the source rule in `dnrRules`,
// which the planner records in the plan owners before assigning session IDs.
export function deriveUserStrictBlockRules(dnrRules) {
    const out = [];
    if ( Array.isArray(dnrRules) === false ) { return out; }
    for ( let i = 0; i < dnrRules.length; i++ ) {
        const rule = dnrRules[i];
        if ( isStrictBlockCandidate(rule) === false ) { continue; }
        const { condition } = stripPrivateProperties(rule);
        condition.resourceTypes = [ 'main_frame' ];
        out.push({
            id: i + 1,
            action: {
                type: 'redirect',
                redirect: { extensionPath: STRICTBLOCK_PAGE_PATH },
            },
            condition,
            priority: basePriority(rule.priority),
        });
    }
    return out;
}

/******************************************************************************/

const emptyPlan = excludedCount => ({
    rules: [],
    owners: [],
    counts: {
        rules: 0, regex: 0, redirects: 0,
        stock: 0, sandbox: 0, imported: 0,
        allows: 0, exclusions: excludedCount,
    },
    dropped: {
        stockSessionLimit: 0, stockRegexPool: 0,
        userSessionLimit: 0, userRegexPool: 0,
        stockMalformed: 0, userMalformed: 0,
    },
    redirectCount: 0,
});

const isRegexRule = rule => typeof rule.condition.regexFilter === 'string';

const toUserRedirect = (stored, realm, excluded) => {
    if ( stored?.action?.type !== 'redirect' ) { return; }
    if ( typeof stored.condition !== 'object' || stored.condition === null ) {
        return;
    }
    const { condition } = stripPrivateProperties(stored);
    condition.resourceTypes = [ 'main_frame' ];
    const excludedRequestDomains = sortedUnion(
        condition.excludedRequestDomains, excluded
    );
    if ( excludedRequestDomains.length !== 0 ) {
        condition.excludedRequestDomains = excludedRequestDomains;
    }
    const base = basePriority(stored.priority) +
        (realm === 'sandbox' ? USER_RULES_PRIORITY : 0);
    const source = Number.isSafeInteger(stored.id) && stored.id > 0
        ? stored.id
        : null;
    return {
        owner: realm,
        action: 'redirect',
        base,
        source,
        rule: {
            action: {
                type: 'redirect',
                redirect: { extensionPath: STRICTBLOCK_PAGE_PATH },
            },
            condition,
            priority: base + 1,
        },
    };
};

const toStockRedirect = (packaged, rulesetId, excluded, extensionPageURL) => {
    const redirect = packaged?.action?.redirect;
    if ( packaged?.action?.type !== 'redirect' ) { return; }
    if ( typeof redirect !== 'object' || redirect === null ) { return; }
    if ( typeof packaged.condition !== 'object' || packaged.condition === null ) {
        return;
    }
    const rule = stripPrivateProperties(packaged);
    delete rule.id;
    rule.priority = STOCK_STRICTBLOCK_PRIORITY;
    rule.condition.resourceTypes = [ 'main_frame' ];
    if ( typeof redirect.extensionPath === 'string' ) {
        const excludedRequestDomains = sortedUnion(
            rule.condition.excludedRequestDomains, excluded
        );
        if ( excludedRequestDomains.length !== 0 ) {
            rule.condition.excludedRequestDomains = excludedRequestDomains;
        }
    } else if (
        typeof redirect.regexSubstitution === 'string' &&
        typeof rule.condition.regexFilter === 'string' &&
        typeof extensionPageURL === 'string' && extensionPageURL !== ''
    ) {
        // Firefox builds: the fragment carries the blocked URL. Exclusions
        // are enforced by the allow rule at the same priority, as before.
        rule.action.redirect = {
            regexSubstitution: `${extensionPageURL}#\\0`,
        };
    } else {
        return;
    }
    const source = Number.isSafeInteger(packaged.id) && packaged.id > 0
        ? packaged.id
        : null;
    return {
        owner: `stock:${rulesetId}`,
        action: 'redirect',
        source,
        rule,
    };
};

const exclusionAllow = (priority, excluded) => ({
    action: { type: 'allow' },
    condition: {
        requestDomains: excluded.slice(),
        resourceTypes: [ 'main_frame' ],
    },
    priority,
});

// The strict-block session plan. Input:
// - flavor: 'chromium' | 'firefox' | 'safari';
// - strictBlockMode, hasOmnipotence, exactUrlSource: booleans;
// - extensionPageURL: runtime.getURL('/strictblock.html'), for the legacy
//   regexSubstitution shape;
// - stock: [{ rulesetId, rules }] in enabled order (rulesets/strictblock/);
// - user: [{ realm: 'sandbox' | 'imported', rules }] (derived templates);
// - excludedHostnames: permanent and temporary exclusions;
// - sessionRuleBudget, regexRuleBudget: what the other owners left.
//
// User redirects exist only on Chromium with broad host access and an exact
// URL source: a redirect lacking host access shadows the lower-priority
// block and the page loads (measured), and without an exact source the page
// could not name the blocked address. They sit one above their own block, so
// allow rules of the same list still win; excluded hosts are carved out with
// excludedRequestDomains, plus one allow per user base priority that defeats
// the dynamic fallback block. Stock redirects keep priority 29; while any is
// installed, one main_frame allow at 29 for excluded hosts also unblocks the
// stock main_frame blocks which are not strict-block candidates, so Proceed
// never ends on the browser's error page.
//
// Rules which exceed the session or regex budget are dropped from the end,
// stock first. A dropped user redirect is safe: its dynamic block still
// applies. IDs are 1..N, below STRICTBLOCK_SESSION_ID_LIMIT. owners lists
// [firstId, lastId, owner, 'redirect' | 'allow', sources?] ranges, where
// owner is 'stock:<rulesetId>', 'stock', 'imported' or 'sandbox' and sources
// holds, per ID, the 1-based source rule number (packaged strict-block rule
// ID, or position in the realm's compiled dnrRules), or null.
export function planStrictBlockSessionRules(input = {}) {
    const excluded = normalizeHostnames(input.excludedHostnames);
    const plan = emptyPlan(excluded.length);
    if ( input.flavor === 'safari' ) { return plan; }
    if ( Boolean(input.strictBlockMode) === false ) { return plan; }
    if ( input.hasOmnipotence !== true ) { return plan; }
    const { counts, dropped } = plan;

    const userCandidates = [];
    if ( input.flavor === 'chromium' && input.exactUrlSource === true ) {
        const userInput = Array.isArray(input.user) ? input.user : [];
        for ( const realm of [ 'sandbox', 'imported' ] ) {
            for ( const entry of userInput ) {
                if ( entry?.realm !== realm ) { continue; }
                if ( Array.isArray(entry.rules) === false ) { continue; }
                for ( const stored of entry.rules ) {
                    const candidate = toUserRedirect(stored, realm, excluded);
                    if ( candidate === undefined ) {
                        dropped.userMalformed += 1;
                        continue;
                    }
                    userCandidates.push(candidate);
                }
            }
        }
    }

    const stockCandidates = [];
    for ( const entry of Array.isArray(input.stock) ? input.stock : [] ) {
        if ( typeof entry?.rulesetId !== 'string' ) { continue; }
        if ( Array.isArray(entry.rules) === false ) { continue; }
        for ( const packaged of entry.rules ) {
            const candidate = toStockRedirect(packaged, entry.rulesetId,
                excluded, input.extensionPageURL
            );
            if ( candidate === undefined ) {
                dropped.stockMalformed += 1;
                continue;
            }
            stockCandidates.push(candidate);
        }
    }

    // Budgets: an exclusion allow is reserved together with the first
    // redirect which needs it, so a kept redirect never lacks its allow.
    const sessionCap = Math.min(
        toBudget(input.sessionRuleBudget),
        STRICTBLOCK_SESSION_ID_LIMIT - 1
    );
    const regexCap = toBudget(input.regexRuleBudget);
    let used = 0;
    let regexUsed = 0;
    const admit = (candidate, extra) => {
        if ( used + 1 + extra > sessionCap ) { return 'SessionLimit'; }
        const isRegex = isRegexRule(candidate.rule);
        if ( isRegex && regexUsed >= regexCap ) { return 'RegexPool'; }
        used += 1 + extra;
        if ( isRegex ) { regexUsed += 1; }
        return '';
    };

    const keptUser = [];
    const userAllows = new Map();
    for ( const candidate of userCandidates ) {
        const extra = excluded.length !== 0 &&
            userAllows.has(candidate.base) === false ? 1 : 0;
        const reason = admit(candidate, extra);
        if ( reason !== '' ) {
            dropped[`user${reason}`] += 1;
            continue;
        }
        if ( extra !== 0 ) {
            userAllows.set(candidate.base, candidate.owner);
        }
        keptUser.push(candidate);
    }

    const keptStock = [];
    let stockAllow = false;
    for ( const candidate of stockCandidates ) {
        const extra = excluded.length !== 0 && stockAllow === false ? 1 : 0;
        const reason = admit(candidate, extra);
        if ( reason !== '' ) {
            dropped[`stock${reason}`] += 1;
            continue;
        }
        if ( extra !== 0 ) { stockAllow = true; }
        keptStock.push(candidate);
    }

    const ordered = [ ...keptUser ];
    for ( const [ base, owner ] of userAllows ) {
        ordered.push({
            owner, action: 'allow', source: null,
            rule: exclusionAllow(base, excluded),
        });
    }
    ordered.push(...keptStock);
    if ( stockAllow ) {
        ordered.push({
            owner: 'stock', action: 'allow', source: null,
            rule: exclusionAllow(STOCK_STRICTBLOCK_PRIORITY, excluded),
        });
    }

    let range;
    for ( const entry of ordered ) {
        const id = plan.rules.length + 1;
        plan.rules.push({ id, ...entry.rule });
        if (
            range === undefined ||
            range[2] !== entry.owner || range[3] !== entry.action
        ) {
            range = [ id, id, entry.owner, entry.action, [] ];
            plan.owners.push(range);
        }
        range[1] = id;
        range[4].push(entry.source);
        if ( entry.action === 'redirect' ) {
            plan.redirectCount += 1;
            if ( entry.owner === 'sandbox' || entry.owner === 'imported' ) {
                counts[entry.owner] += 1;
            } else {
                counts.stock += 1;
            }
        } else {
            counts.allows += 1;
        }
        if ( isRegexRule(entry.rule) ) { counts.regex += 1; }
    }
    for ( const owner of plan.owners ) {
        if ( owner[4].every(source => source === null) ) { owner.length = 4; }
    }
    counts.rules = plan.rules.length;
    counts.redirects = plan.redirectCount;
    return plan;
}

/******************************************************************************/

// Who installed a strict-block session redirect: { kind: 'stock', rulesetId }
// | { kind: 'imported' } | { kind: 'sandbox' }, plus `source` (the 1-based
// source rule number) when the plan recorded it. Allow rules and unknown IDs
// give undefined.
export function ownerForRuleId(owners, ruleId) {
    if ( Array.isArray(owners) === false ) { return; }
    if ( Number.isInteger(ruleId) === false ) { return; }
    for ( const entry of owners ) {
        if ( Array.isArray(entry) === false ) { continue; }
        const [ firstId, lastId, owner, action, sources ] = entry;
        if ( ruleId < firstId || ruleId > lastId ) { continue; }
        if ( action !== 'redirect' || typeof owner !== 'string' ) { return; }
        let out;
        if ( owner === 'imported' || owner === 'sandbox' ) {
            out = { kind: owner };
        } else if ( owner.startsWith('stock:') && owner.length > 6 ) {
            out = { kind: 'stock', rulesetId: owner.slice(6) };
        } else {
            return;
        }
        const source = Array.isArray(sources)
            ? sources[ruleId - firstId]
            : undefined;
        if ( Number.isSafeInteger(source) ) { out.source = source; }
        return out;
    }
}
