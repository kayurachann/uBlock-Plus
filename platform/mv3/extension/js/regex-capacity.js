/*******************************************************************************
    uBlock Plus+ - regex rule capacity: the shared pool and the static pool
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later

    Pure module: no browser API and no import from ext.js.

    Chrome counts regexFilter rules in two pools. Static rulesets have their
    own aggregate pool of 1,000 (stock regex packaged by make-rulesets.js).
    Dynamic and session rules share a second pool of
    MAX_NUMBER_OF_REGEX_RULES (1,000): the stock regex fallback, developer
    DNR rules, My filters, imported lists, stock badfilter residuals and the
    strict-block session plan, plus whatever later owners declare in
    dnr-namespaces.js. Firefox documents one limit per namespace; the plans
    keep the shared accounting there too, as before (Firefox is untested).
******************************************************************************/

import {
    dynamicRuleOwner,
    sessionRuleOwner,
} from './dnr-namespaces.js';

/******************************************************************************/

export const STATIC_REGEX_LIMIT = 1000;

// Owners of the rules in one user-realm dynamic update, in the order
// ruleset-manager.js assembles them.
export const USER_REGEX_OWNERS = Object.freeze([
    'developer', 'sandbox', 'imported', 'stock-residual',
]);

const ownerCountKey = owner => owner === 'stock-residual'
    ? 'stockResidual'
    : owner;

const isRegexRule = rule => Boolean(rule?.condition?.regexFilter);

const isException = rule =>
    rule?.action?.type === 'allow' || rule?.action?.type === 'allowAllRequests';

const toCount = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

const toLimit = value => Number.isSafeInteger(value) && value >= 0
    ? value
    : Number.MAX_SAFE_INTEGER;

/******************************************************************************/

// Regex overflow policy of one user-realm dynamic update. `owners[i]` tags
// `rules[i]`; `retainedRegexCount` is the regex usage the update does not
// replace (stock fallback, other owners' dynamic and session regex rules).
// Strict-block session regex rules are not counted: they have lower
// precedence and the session plan is rebuilt into whatever is left.
//
// When the update does not fit, imported regex rules which are not
// exceptions are dropped from the end. Dropping a block, redirect or header
// rule only loses that filter; dropping an exception could broaden other
// lists' blocks, so exceptions, My filters, developer rules and stock
// residuals are never dropped. If the update still does not fit, the result
// is fatal and the caller keeps the previous rules.
export function planUserRegexBudget({
    rules = [],
    owners = [],
    retainedRegexCount = 0,
    maxRegexCount,
} = {}) {
    const max = toLimit(maxRegexCount);
    const retained = toCount(retainedRegexCount);
    const input = Array.isArray(rules) ? rules : [];
    const keep = input.map(( ) => true);
    let regexCount = 0;
    for ( const rule of input ) {
        if ( isRegexRule(rule) ) { regexCount += 1; }
    }
    let excess = retained + regexCount - max;
    let droppedImported = 0;
    for ( let i = input.length - 1; i >= 0 && excess > 0; i-- ) {
        if ( owners[i] !== 'imported' ) { continue; }
        const rule = input[i];
        if ( isRegexRule(rule) === false || isException(rule) ) { continue; }
        keep[i] = false;
        droppedImported += 1;
        regexCount -= 1;
        excess -= 1;
    }
    const out = {
        rules: [],
        owners: [],
        counts: { developer: 0, sandbox: 0, imported: 0, stockResidual: 0 },
        droppedImported,
        required: retained + regexCount,
        maxRegexCount: max,
        fatal: retained + regexCount > max,
    };
    for ( let i = 0; i < input.length; i++ ) {
        if ( keep[i] === false ) { continue; }
        const rule = input[i];
        out.rules.push(rule);
        out.owners.push(owners[i]);
        if ( isRegexRule(rule) === false ) { continue; }
        const key = ownerCountKey(owners[i]);
        if ( Object.hasOwn(out.counts, key) ) { out.counts[key] += 1; }
    }
    return out;
}

/******************************************************************************/

const countRegexByOwner = (rules, ownerOf) => {
    const byOwner = {};
    let total = 0;
    for ( const rule of Array.isArray(rules) ? rules : [] ) {
        if ( isRegexRule(rule) === false ) { continue; }
        const owner = ownerOf(rule) || 'unknown';
        byOwner[owner] = (byOwner[owner] ?? 0) + 1;
        total += 1;
    }
    return { byOwner, total };
};

const sumOver = (entries, pick) => entries.reduce((sum, entry) =>
    sum + toCount(pick(entry)), 0
);

const truncate = (text, max = 160) => typeof text === 'string' && text.length > max
    ? `${text.slice(0, max)}…`
    : text;

// The static check ('Check now') applies to this package, this browser
// version and every enabled list with static regex rules; otherwise the
// number is unknown and reported as null, never as 0.
function staticCheckResult(check, enabledStock, extensionVersion, chromeMajor) {
    const unknown = { skipped: null, samples: [], checkedAt: null };
    if ( check?.schemaVersion !== 1 ) { return unknown; }
    if ( check.extensionVersion !== extensionVersion ) { return unknown; }
    if ( check.chromeMajor !== chromeMajor ) { return unknown; }
    const byRuleset = check.byRuleset ?? {};
    let skipped = 0;
    for ( const details of enabledStock ) {
        if ( toCount(details.rules?.regexStatic) === 0 ) { continue; }
        const entry = byRuleset[details.id];
        if ( Number.isSafeInteger(entry?.skipped) === false ) { return unknown; }
        skipped += entry.skipped;
    }
    const enabledIds = new Set(enabledStock.map(details => details.id));
    const samples = (Array.isArray(check.samples) ? check.samples : [])
        .filter(sample => enabledIds.has(sample?.rulesetId))
        .slice(0, 10)
        .map(sample => ({ ...sample, regex: truncate(sample.regex) }));
    return {
        skipped,
        samples,
        checkedAt: Number.isFinite(check.checkedAt) ? check.checkedAt : null,
    };
}

// The report behind Dashboard > Diagnostics > Regex rule capacity and the
// Filter Store estimate. Every number comes from what the browser reports
// as installed (dynamic and session rules, enabled rulesets) or from the
// package's own build reports; nothing is assumed.
export function summarizeRegexCapacity(input = {}) {
    const stockRulesets = Array.isArray(input.stockRulesets)
        ? input.stockRulesets.filter(details => typeof details?.id === 'string')
        : [];
    const enabledIds = new Set(Array.isArray(input.enabledRulesetIds)
        ? input.enabledRulesetIds
        : []);
    const enabledStock = stockRulesets.filter(details => enabledIds.has(details.id));
    const regexDetails = input.regexDetails?.schemaVersion === 1
        ? input.regexDetails
        : undefined;

    // Static pool
    const rejectedReason = (details, reason) =>
        details.rules?.rejectedReasons?.[reason];
    const memory = sumOver(enabledStock, details =>
        rejectedReason(details, 'unsupported-regex-memory'));
    const syntax = sumOver(enabledStock, details =>
        rejectedReason(details, 'unsupported-regex-syntax'));
    const check = staticCheckResult(input.staticCheck, enabledStock,
        input.extensionVersion, input.chromeMajor);
    const staticPool = {
        limit: toCount(regexDetails?.staticRegexLimit) || STATIC_REGEX_LIMIT,
        packaged: sumOver(stockRulesets, details => details.rules?.regexStatic),
        enabled: sumOver(enabledStock, details => details.rules?.regexStatic),
        verifiedWith: typeof regexDetails?.verifiedWith === 'string'
            ? regexDetails.verifiedWith
            : '',
        rejectedAtBuild: memory + syntax,
        rejectedAtBuildReasons: { memory, syntax },
        skippedByBrowser: check.skipped,
        skippedSamples: check.samples,
        checkedAt: check.checkedAt,
    };

    // Shared pool, per owner
    const dynamic = countRegexByOwner(input.dynamicRules, dynamicRuleOwner);
    const session = countRegexByOwner(input.sessionRules, sessionRuleOwner);
    const userTotal = dynamic.byOwner.user ?? 0;
    const record = input.userRecord;
    const recorded = record?.schemaVersion === 1
        ? {
            developer: toCount(record.developer),
            sandbox: toCount(record.sandbox),
            imported: toCount(record.imported),
            stockResidual: toCount(record.stockResidual),
        }
        : undefined;
    // The per-realm split is only known for the rules installed by the
    // update which wrote the record.
    const attributed = recorded !== undefined &&
        recorded.developer + recorded.sandbox + recorded.imported +
            recorded.stockResidual === userTotal;
    const stockFallback = dynamic.byOwner.stockRegexFallback ?? 0;
    const strictBlockRegex = session.byOwner.strictBlock ?? 0;
    const limit = toLimit(input.sharedLimit ?? 1000);
    const used = dynamic.total + session.total;
    const plan = input.plan?.schemaVersion === 1 ? input.plan : undefined;
    const shared = {
        limit,
        dynamic: {
            stockFallback,
            developer: attributed ? recorded.developer : null,
            sandbox: attributed ? recorded.sandbox : null,
            imported: attributed ? recorded.imported : null,
            stockResidual: attributed ? recorded.stockResidual : null,
            user: userTotal,
            other: dynamic.total - stockFallback - userTotal,
            byOwner: dynamic.byOwner,
        },
        session: {
            strictBlock: strictBlockRegex,
            other: session.total - strictBlockRegex,
            byOwner: session.byOwner,
        },
        used,
        free: Math.max(0, limit - used),
        droppedStrictBlock: plan
            ? toCount(plan.dropped?.stockRegexPool) +
                toCount(plan.dropped?.userRegexPool)
            : 0,
        droppedImported: record?.schemaVersion === 1
            ? toCount(record.droppedImported)
            : 0,
    };

    const exclusions = input.exclusions;
    return {
        schemaVersion: 1,
        static: staticPool,
        shared,
        rulesetsNotEnabled: Array.isArray(input.rulesetsNotEnabled)
            ? input.rulesetsNotEnabled.slice()
            : [],
        strictBlock: {
            redirectCount: toCount(plan?.redirectCount),
            userRedirects: toCount(plan?.counts?.sandbox) +
                toCount(plan?.counts?.imported),
            userCandidates: toCount(plan?.userCandidates),
            exclusions: Array.isArray(exclusions?.hosts) ? exclusions.hosts.length : 0,
            allExcluded: exclusions?.all === true,
            droppedSessionLimit: toCount(plan?.dropped?.stockSessionLimit) +
                toCount(plan?.dropped?.userSessionLimit),
        },
    };
}
