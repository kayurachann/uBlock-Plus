/*******************************************************************************
    uBlock Plus+ - one registry of native DNR rule-ID ranges and priorities
    Copyright (C) 2026-present uBlock Plus+ contributors; GPL-3.0-or-later

    Pure module: no browser API and no import from ext.js, so it can be loaded
    by the build (Node), the offscreen document and the service worker.
******************************************************************************/

// Chrome keeps dynamic and session rules in two separate ID spaces, so an ID
// is only unique within its own namespace. Every owner that writes dynamic
// or session rules declares its range here; tools/test-dnr-namespaces.mjs
// asserts that the ranges of one namespace, and all priority bands, are
// pairwise disjoint. Ranges are inclusive [min, max].

export const MAX_RULE_ID = 2 ** 31 - 1;

/******************************************************************************/

// Dynamic rule IDs

// Stock regex rules which could not be packaged statically (the dynamic
// fallback). They are replaced wholesale on every stock refresh.
export const STOCK_REGEX_FALLBACK_MAX_RULE_ID = 4999999;
// First dynamic ID which is not a stock regex fallback rule. 5,000,000 to
// 5,999,999 is reserved and unused.
export const SPECIAL_RULES_REALM = 5000000;
// Per-site switches (roadmap step 3).
export const SITE_SWITCH_RULE_BASE = 6000000;
export const SITE_SWITCH_RULE_LIMIT = 1000;
// Engine DNR profile suppression rules (roadmap step 6).
export const ENGINE_PROFILE_RULE_BASE = 6100000;
export const ENGINE_PROFILE_RULE_LIMIT = 100000;
// Trusted-site directive: allowAllRequests at this dynamic ID, and the
// matching tabId -1 allow at this ID + 1 in the session namespace.
export const TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000;
// User rules: developer DNR text, My filters, imported lists, stock
// residuals and, later, fragments and stock deltas.
export const USER_RULES_BASE_RULE_ID = 9000000;

// Session rule IDs

// Strict-block plan: stock and user redirects plus their exclusion allows.
export const STRICTBLOCK_SESSION_ID_LIMIT = 1000000;
// Large-media tab allowances (roadmap step 3).
export const LARGE_MEDIA_SESSION_RULE_BASE = 6001000;
export const LARGE_MEDIA_SESSION_RULE_LIMIT = 64;
// Firewall cells. Today's firewall-core.js uses the first 4,096 IDs.
export const FIREWALL_SESSION_RULE_BASE = 7000000;
export const FIREWALL_SESSION_RULE_LIMIT = 50000;
// URL rules (roadmap step 7).
export const URL_RULE_SESSION_BASE = 7050000;
export const URL_RULE_SESSION_LIMIT = 50000;

/******************************************************************************/

// Priorities
//
// Stock rulesets and imported lists share the stock bands; see the priority
// comment in src/js/static-net-filtering.js. My filters and developer DNR
// rules are offset by USER_RULES_PRIORITY. At equal priority Chrome prefers
// allow > allowAllRequests > block > upgradeScheme > redirect.

export const STOCK_BLOCK_PRIORITY = 10;
export const STOCK_ALLOW_PRIORITY = 30;
export const STOCK_STRICTBLOCK_PRIORITY = 29;
export const ENGINE_SUPPRESSION_PRIORITY = 20;
export const USER_RULES_PRIORITY = 1000000;
// A developer DNR rule written with a priority of 500,000 or more reaches the
// firewall band; the compilers never emit such priorities.
export const USER_RULES_MAX_PRIORITY = 1499999;
export const FIREWALL_PRIORITY = 1500000;
export const URL_RULE_PRIORITY_MIN = 1600000;
export const URL_RULE_PRIORITY_MAX = 1749999;
// URL rule priorities grow with the depth of their context; step 7 clamps
// the depth so that the deepest rule stays inside its band.
export const URL_RULE_MAX_DEPTH = 64;
export const SITE_SWITCH_PRIORITY = 1900000;
export const LARGE_MEDIA_ALLOWANCE_PRIORITY = 1900001;
export const TRUSTED_DIRECTIVE_PRIORITY = 2000000;

/******************************************************************************/

const range = (owner, min, max, note) => Object.freeze({ owner, min, max, note });

export const DYNAMIC_RULE_ID_RANGES = Object.freeze([
    range('stockRegexFallback', 1, STOCK_REGEX_FALLBACK_MAX_RULE_ID,
        'stock regex rules that are not packaged statically'),
    range('siteSwitches', SITE_SWITCH_RULE_BASE,
        SITE_SWITCH_RULE_BASE + SITE_SWITCH_RULE_LIMIT - 1, 'step 3'),
    range('engineProfile', ENGINE_PROFILE_RULE_BASE,
        ENGINE_PROFILE_RULE_BASE + ENGINE_PROFILE_RULE_LIMIT - 1, 'step 6'),
    range('trustedDirective', TRUSTED_DIRECTIVE_BASE_RULE_ID,
        TRUSTED_DIRECTIVE_BASE_RULE_ID, 'allowAllRequests for trusted sites'),
    range('user', USER_RULES_BASE_RULE_ID, MAX_RULE_ID,
        'developer, My filters, imported, stock residuals, fragments, deltas'),
]);

export const SESSION_RULE_ID_RANGES = Object.freeze([
    range('strictBlock', 1, STRICTBLOCK_SESSION_ID_LIMIT - 1,
        'strict-block plan (strictblock-rules.js)'),
    range('largeMedia', LARGE_MEDIA_SESSION_RULE_BASE,
        LARGE_MEDIA_SESSION_RULE_BASE + LARGE_MEDIA_SESSION_RULE_LIMIT - 1,
        'step 3'),
    range('firewall', FIREWALL_SESSION_RULE_BASE,
        FIREWALL_SESSION_RULE_BASE + FIREWALL_SESSION_RULE_LIMIT - 1,
        'firewall cells'),
    range('urlRules', URL_RULE_SESSION_BASE,
        URL_RULE_SESSION_BASE + URL_RULE_SESSION_LIMIT - 1, 'step 7'),
    range('trustedDirective', TRUSTED_DIRECTIVE_BASE_RULE_ID + 1,
        TRUSTED_DIRECTIVE_BASE_RULE_ID + 1, 'tabId -1 allow for trusted sites'),
]);

export const PRIORITY_BANDS = Object.freeze([
    range('stockModify', 1, 4, 'removeparam, csp, permissions, urlskip'),
    range('stockBlock', STOCK_BLOCK_PRIORITY, STOCK_BLOCK_PRIORITY, 'block'),
    range('stockRedirect', 11, 19, 'redirect; imported strict-block 11'),
    range('engineSuppression', ENGINE_SUPPRESSION_PRIORITY,
        ENGINE_SUPPRESSION_PRIORITY, 'step 6'),
    range('stockExceptedRedirect', 21, STOCK_STRICTBLOCK_PRIORITY,
        'excepted redirect; stock strict-block at 29'),
    range('stockAllow', STOCK_ALLOW_PRIORITY, STOCK_ALLOW_PRIORITY, 'allow'),
    range('stockImportant', 40, 49,
        'important block and redirect; imported strict-block 41'),
    range('user', USER_RULES_PRIORITY + 1, USER_RULES_MAX_PRIORITY,
        'developer and My filters, with their strict-block tiers'),
    range('firewall', FIREWALL_PRIORITY, FIREWALL_PRIORITY, 'firewall cells'),
    range('urlRules', URL_RULE_PRIORITY_MIN, URL_RULE_PRIORITY_MAX, 'step 7'),
    range('siteSwitches', SITE_SWITCH_PRIORITY, SITE_SWITCH_PRIORITY, 'step 3'),
    range('largeMediaAllowance', LARGE_MEDIA_ALLOWANCE_PRIORITY,
        LARGE_MEDIA_ALLOWANCE_PRIORITY, 'step 3'),
    range('trustedDirective', TRUSTED_DIRECTIVE_PRIORITY,
        TRUSTED_DIRECTIVE_PRIORITY, 'trusted sites'),
]);

/******************************************************************************/

const ruleIdOf = ruleOrId => typeof ruleOrId === 'number'
    ? ruleOrId
    : ruleOrId?.id;

const ownerIn = (ranges, ruleOrId) => {
    const id = ruleIdOf(ruleOrId);
    if ( Number.isInteger(id) === false ) { return ''; }
    for ( const { owner, min, max } of ranges ) {
        if ( id >= min && id <= max ) { return owner; }
    }
    return '';
};

// The owner key of a dynamic or session rule (or rule ID); '' when no owner
// declared the ID.
export const dynamicRuleOwner = ruleOrId =>
    ownerIn(DYNAMIC_RULE_ID_RANGES, ruleOrId);

export const sessionRuleOwner = ruleOrId =>
    ownerIn(SESSION_RULE_ID_RANGES, ruleOrId);

export const priorityBand = priority =>
    ownerIn(PRIORITY_BANDS, priority);

// Session rules owned by the strict-block plan. This replaces the older
// priority/shape heuristic; legacy regexSubstitution session rules (IDs
// 1..826) are in range, so an upgrade replaces them.
export const isStrictBlockSessionRule = rule =>
    Number.isInteger(rule?.id) && rule.id >= 1 &&
    rule.id < STRICTBLOCK_SESSION_ID_LIMIT;

export const isStockRegexFallbackRule = rule =>
    dynamicRuleOwner(rule) === 'stockRegexFallback';

export const isUserDynamicRule = rule => dynamicRuleOwner(rule) === 'user';

/******************************************************************************/

// The single queue through which every dynamic and session DNR write goes,
// so that owners sharing Chrome's quotas never interleave their
// read-modify-write sequences. A rejected task is returned to its caller and
// reported, and never blocks the tasks queued after it.

let pendingDNRMutation = Promise.resolve();
let reportDNRMutationError = ( ) => {};

export function setDNRMutationErrorReporter(fn) {
    reportDNRMutationError = typeof fn === 'function' ? fn : ( ) => {};
}

export function enqueueDNRMutation(task) {
    const result = pendingDNRMutation.then(task);
    pendingDNRMutation = result.catch(reason => {
        try { reportDNRMutationError(reason); } catch { }
    });
    return result;
}
