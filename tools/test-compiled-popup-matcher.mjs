/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

import {
    POPUP_DEFERRED_ROUTE_CODE,
    POPUP_RUNTIME_ROUTE_CODE,
    classifyPopupCondition,
    evaluateCompiledPopupFilters,
} from '../platform/mv3/extension/js/compiled-popup-matcher.js';
import assert from 'node:assert/strict';

assert.equal(POPUP_RUNTIME_ROUTE_CODE, 'popup-observer-runtime');
assert.equal(POPUP_DEFERRED_ROUTE_CODE, 'popup-compiler-required');

const popupFilter = (lineNumber, action, condition = {}, extra = {}) => ({
    schemaVersion: 1,
    routeCode: POPUP_RUNTIME_ROUTE_CODE,
    kind: 'popup',
    action,
    important: false,
    condition,
    lineNumber,
    ...extra,
});

const baseInput = {
    kind: 'popup',
    targetURL: 'https://ads.example/popup',
    initiatorURL: 'https://app.example/page',
    topURL: 'https://www.example/home',
    initiatorContextComplete: true,
    filteringMode: 2,
};

const evaluate = (realms, input = {}) => evaluateCompiledPopupFilters(
    realms,
    { ...baseInput, ...input }
);

const noMatch = {
    action: 'none',
    reason: 'compiled-popup-filter',
};
const contextPending = {
    action: 'defer',
    reason: 'compiled-popup-context-pending',
};

assert.deepEqual(classifyPopupCondition({}), { supported: true });
assert.deepEqual(classifyPopupCondition({
    requestDomains: [ 'example.com' ],
    excludedRequestDomains: [ 'safe.example.com' ],
    initiatorDomains: [ 'origin.example' ],
    excludedInitiatorDomains: [ 'excluded.origin.example' ],
    topDomains: [ 'top.example' ],
    excludedTopDomains: [ 'excluded.top.example' ],
    urlFilter: '||example.com^',
    isUrlFilterCaseSensitive: false,
}), { supported: true });

for ( const [ condition, reasonCode ] of [
    [ null, 'invalid-popup-condition' ],
    [ { domainType: 'firstParty' }, 'unsupported-domain-type' ],
    [ { requestMethods: [ 'get' ] }, 'unsupported-request-methods' ],
    [ {
        excludedRequestMethods: [ 'post' ],
    }, 'unsupported-excluded-request-methods' ],
    [ { responseHeaders: [] }, 'unsupported-response-headers' ],
    [ {
        excludedResponseHeaders: [],
    }, 'unsupported-excluded-response-headers' ],
    [ { resourceTypes: [ 'script' ] }, 'unsupported-resource-types' ],
    [ { tabIds: [ 1 ] }, 'unsupported-tab-ids' ],
    [ { unexpected: true }, 'unsupported-condition-key' ],
    [ { requestDomains: [] }, 'invalid-domain-list' ],
    [ { requestDomains: [ 'bad/domain' ] }, 'invalid-domain-list' ],
    [ { isUrlFilterCaseSensitive: 'yes' }, 'invalid-match-case' ],
    [ { urlFilter: 'a', regexFilter: 'a' }, 'conflicting-url-patterns' ],
    [ { urlFilter: '||example.com|middle' }, 'invalid-url-filter' ],
] ) {
    assert.deepEqual(classifyPopupCondition(condition), {
        supported: false,
        reasonCode,
    });
}

assert.deepEqual(classifyPopupCondition({ regexFilter: '(' }), {
    supported: false,
    reasonCode: 'invalid-regex-filter',
});
assert.deepEqual(classifyPopupCondition({
    regexFilter: 'a'.repeat(1025),
}), {
    supported: false,
    reasonCode: 'regex-filter-too-long',
});
for ( const regexFilter of [
    '(a+)+$',
    '(a|aa)+$',
    '((a|aa)b)+$',
    'a.*b',
    '^a|b.*c',
    'a+.*b+',
    'a?a?a?a?a?a?a?a?a?',
] ) {
    assert.deepEqual(classifyPopupCondition({ regexFilter }), {
        supported: false,
        reasonCode: 'unsafe-regex-filter',
    });
}
for ( const regexFilter of [
    '(?=ads)ads',
    '(ads)\\1',
    '(?<name>ads)',
    '\\qads',
] ) {
    assert.deepEqual(classifyPopupCondition({ regexFilter }), {
        supported: false,
        reasonCode: 'unsupported-regex-syntax',
    });
}
assert.deepEqual(classifyPopupCondition({
    regexFilter: '^https?://[^/]+/ad(?:s)?$',
}), { supported: true });
assert.deepEqual(classifyPopupCondition({
    regexFilter: '^a.*b$',
}), { supported: true });

// Hostname lists match the named host and its descendants. An exclusion at
// index zero must still win before an included parent domain.
const hierarchicalRealm = [ {
    id: 'imported',
    filters: [ popupFilter(7, 'block', {
        requestDomains: [ 'example.com' ],
        excludedRequestDomains: [
            'ads.example.com',
            'z.example.com',
        ],
    }) ],
} ];
assert.deepEqual(evaluate(hierarchicalRealm, {
    targetURL: 'https://child.ads.example.com/popup',
}), noMatch);
assert.equal(evaluate(hierarchicalRealm, {
    targetURL: 'https://cdn.example.com/popup',
}).action, 'block');
assert.deepEqual(evaluate(hierarchicalRealm, {
    targetURL: 'https://notexample.com/popup',
}), noMatch);

// A sandbox decision wins over imported rules. Within one realm, important
// block > allow > ordinary block, with allow selected independently of order.
const realmPrecedence = [
    {
        id: 'imported',
        filters: [ popupFilter(90, 'block', {}, { important: true }) ],
    },
    {
        id: 'sandbox',
        filters: [
            popupFilter(20, 'block'),
            popupFilter(30, 'allow', {}, { listid: 'private-list-url' }),
        ],
    },
];
assert.deepEqual(evaluate(realmPrecedence), {
    action: 'allow',
    reason: 'compiled-popup-filter',
    matchedRealm: 'sandbox',
    lineNumber: 30,
    kind: 'popup',
});
const withinRealm = [ {
    id: 'imported',
    filters: [
        popupFilter(1, 'allow'),
        popupFilter(2, 'block'),
        popupFilter(3, 'block', {}, { important: true }),
    ],
} ];
assert.equal(evaluate(withinRealm).action, 'block');
assert.equal(evaluate(withinRealm).lineNumber, 3);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [ popupFilter(2, 'block'), popupFilter(1, 'allow') ],
} ]).action, 'allow');

// Stock popup rules participate in Basic mode. At Optimal mode, stock and
// imported rules share one priority competition; their array order must not
// silently override important/allow semantics. Sandbox remains authoritative.
const stockAndImported = [
    {
        id: 'stock',
        filters: [ popupFilter(40, 'allow') ],
    },
    {
        id: 'imported',
        filters: [ popupFilter(50, 'block', {}, { important: true }) ],
    },
];
assert.equal(evaluate(stockAndImported, {
    filteringMode: 1,
}).matchedRealm, 'stock');
assert.deepEqual(evaluate(stockAndImported, {
    filteringMode: 2,
}), {
    action: 'block',
    reason: 'compiled-popup-filter',
    matchedRealm: 'imported',
    lineNumber: 50,
    kind: 'popup',
});
assert.equal(evaluate([
    stockAndImported[1],
    stockAndImported[0],
], {
    filteringMode: 2,
}).matchedRealm, 'imported');

// DNR-style URL filters retain left/right, hostname and separator anchors.
const urlFilterRealm = condition => [ {
    id: 'imported',
    filters: [ popupFilter(1, 'block', condition) ],
} ];
assert.equal(evaluate(urlFilterRealm({
    urlFilter: '|https://exact.example/path|',
}), {
    targetURL: 'https://exact.example/path',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: '|https://exact.example/path|',
}), {
    targetURL: 'https://exact.example/path?query=private',
}), noMatch);
assert.equal(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^',
}), {
    targetURL: 'https://cdn.ads.example/popup',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^',
}), {
    targetURL: 'https://notads.example/popup',
}), noMatch);
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^',
}), {
    targetURL: 'https://ads.example-cdn/popup',
}), noMatch);
assert.equal(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^popup',
}), {
    targetURL: 'https://ads.example/popup',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^popup',
}), {
    targetURL: 'https://ads.example-popup/',
}), noMatch);

assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: 'CaseSensitive',
    isUrlFilterCaseSensitive: true,
}), {
    targetURL: 'https://ads.example/casesensitive',
}), noMatch);
assert.equal(evaluate(urlFilterRealm({
    urlFilter: 'CaseSensitive',
    isUrlFilterCaseSensitive: true,
}), {
    targetURL: 'https://ads.example/CaseSensitive',
}).action, 'block');
assert.equal(evaluate(urlFilterRealm({
    urlFilter: 'CaseSensitive',
}), {
    targetURL: 'https://ads.example/casesensitive',
}).action, 'block');

// about:blank has no hostname, but an exact URL filter may intentionally
// match it. Hostname-only rules must not inherit the opener's hostname.
assert.equal(evaluate(urlFilterRealm({
    urlFilter: '|about:blank|',
}), {
    targetURL: 'about:blank',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    requestDomains: [ 'example.com' ],
}), {
    targetURL: 'about:blank',
}), noMatch);
assert.deepEqual(evaluate(urlFilterRealm({}), {
    targetURL: '',
}), noMatch);

// Oversized event URLs retain their bounded, parseable origin context. Broad
// and request-domain rules still work, while path/regex decisions defer until
// a complete URL is available. A caller may also provide an already-redacted
// canonical origin and explicitly mark it incomplete.
const oversizedTargetURL = `https://oversized.example/${'a'.repeat(9000)}`;
assert.equal(evaluate(urlFilterRealm({}), {
    targetURL: oversizedTargetURL,
}).action, 'block');
assert.equal(evaluate(urlFilterRealm({
    requestDomains: [ 'oversized.example' ],
}), {
    targetURL: oversizedTargetURL,
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: 'path-fragment',
}), {
    targetURL: oversizedTargetURL,
}), contextPending);
assert.equal(evaluate(urlFilterRealm({
    requestDomains: [ 'oversized.example' ],
}), {
    targetURL: 'https://oversized.example/',
    targetURLComplete: false,
}).action, 'block');
const incompleteTargetException = [ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block'),
        popupFilter(2, 'allow', { urlFilter: '/safe-path' }),
    ],
} ];
assert.deepEqual(evaluate(incompleteTargetException, {
    targetURL: 'https://oversized.example/',
    targetURLComplete: false,
}), contextPending);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block', {}, { important: true }),
        popupFilter(2, 'allow', { urlFilter: '/safe-path' }),
    ],
} ], {
    targetURL: 'https://oversized.example/',
    targetURLComplete: false,
}).action, 'block');

const popunder = popupFilter(8, 'block', {}, { kind: 'popunder' });
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: [ popunder ],
} ]), noMatch);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [ popunder ],
} ], {
    kind: 'popunder',
}).action, 'block');

// A $popup fallback used for popunder detection needs positive evidence that
// the rule addresses the target hostname. Broad, path-only and regex-only
// filters are not guessed into popunder rules.
for ( const condition of [
    {},
    { urlFilter: '/popup-path' },
    { regexFilter: '^https://[^/]+/popup-path$' },
] ) {
    assert.deepEqual(evaluate(urlFilterRealm(condition), {
        requireTargetHostnameMatch: true,
    }), noMatch);
}
assert.equal(evaluate(urlFilterRealm({
    requestDomains: [ 'ads.example' ],
}), {
    requireTargetHostnameMatch: true,
}).action, 'block');
assert.equal(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^',
}), {
    requireTargetHostnameMatch: true,
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    urlFilter: '||ads.example^',
}), {
    requireTargetHostnameMatch: true,
    targetURL: 'https://ads.example/',
    targetURLComplete: false,
}), contextPending);

// Sandbox filters run in Basic mode; imported filters require Optimal mode.
const modeRealms = [
    { id: 'sandbox', filters: [ popupFilter(1, 'block') ] },
    { id: 'imported', filters: [ popupFilter(2, 'block') ] },
];
assert.deepEqual(evaluate(modeRealms, { filteringMode: 0 }), noMatch);
assert.equal(evaluate(modeRealms, { filteringMode: 1 }).matchedRealm, 'sandbox');
assert.deepEqual(evaluate([ modeRealms[1] ], { filteringMode: 1 }), noMatch);
assert.equal(evaluate([ modeRealms[1] ], { filteringMode: 2 }).action, 'block');

// Both positive and negative initiator constraints require a complete opener
// context. Ignoring a negative constraint would otherwise create a block.
for ( const condition of [
    { initiatorDomains: [ 'app.example' ] },
    { excludedInitiatorDomains: [ 'safe.example' ] },
] ) {
    const realms = urlFilterRealm(condition);
    assert.deepEqual(evaluate(realms, {
        initiatorContextComplete: false,
        initiatorURL: 'https://app.example/page',
    }), contextPending);
}
assert.equal(evaluate(urlFilterRealm({
    initiatorDomains: [ 'example' ],
}), {
    initiatorURL: 'https://child.example/page',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    excludedInitiatorDomains: [ 'example' ],
}), {
    initiatorURL: 'https://child.example/page',
}), noMatch);
assert.equal(evaluate(urlFilterRealm({
    initiatorDomains: [ 'origin.example' ],
    topDomains: [ 'top.example' ],
}), {
    initiatorURL: 'blob:https://origin.example/opaque-id',
    topURL: 'blob:https://top.example/another-id',
}).action, 'block');

// An incomplete context may also conceal a constrained allow exception. A
// broad block must wait for complete context instead of becoming authoritative.
const contextSensitiveException = [ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block'),
        popupFilter(2, 'allow', {
            initiatorDomains: [ 'safe.example' ],
        }),
    ],
} ];
assert.deepEqual(evaluate(contextSensitiveException, {
    initiatorContextComplete: false,
    initiatorURL: '',
}), contextPending);
assert.deepEqual(evaluate(urlFilterRealm({
    requestDomains: [ 'unrelated.example' ],
}), {
    initiatorContextComplete: false,
}), noMatch);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [ popupFilter(3, 'allow') ],
} ], {
    initiatorContextComplete: false,
    initiatorURL: '',
}).action, 'allow');
assert.equal(evaluate(contextSensitiveException, {
    initiatorURL: 'https://login.safe.example/page',
}).action, 'allow');
assert.equal(evaluate(contextSensitiveException, {
    initiatorURL: 'https://unsafe.example/page',
}).action, 'block');

// Pending decisions are compared by the same priority lattice as concrete
// matches. An important block hidden by incomplete provenance must not turn
// into an allow merely because the allow can be evaluated immediately.
const pendingImportantBlock = [ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block', {}, { important: true }),
        popupFilter(2, 'allow'),
    ],
} ];
assert.deepEqual(evaluate(pendingImportantBlock, {
    initiatorContextComplete: false,
    initiatorURL: '',
}), contextPending);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block'),
        popupFilter(2, 'allow'),
    ],
} ], {
    initiatorContextComplete: false,
    initiatorURL: '',
}).action, 'allow');

assert.equal(evaluate(urlFilterRealm({
    topDomains: [ 'example' ],
}), {
    topURL: 'https://frame.child.example/page',
}).action, 'block');
assert.deepEqual(evaluate(urlFilterRealm({
    excludedTopDomains: [ 'example' ],
}), {
    topURL: 'https://frame.child.example/page',
}), noMatch);

assert.equal(evaluate(urlFilterRealm({
    regexFilter: '^https?://[^/]+/ad(?:s)?$',
}), {
    targetURL: 'https://cdn.example/ads',
}).action, 'block');

// The glob implementation has an aggregate step budget, so the classic
// `*aaaa...b` worst case fails open deterministically instead of doing
// quadratic work. The same bound covers excessive filter/realm collections.
const budgetExhausted = {
    action: 'defer',
    reason: 'compiled-popup-evaluation-budget-exhausted',
};
const adversarialUrlFilter = `*${'a'.repeat(2000)}b`;
assert.deepEqual(classifyPopupCondition({
    urlFilter: adversarialUrlFilter,
}), { supported: true });
const adversarialRealm = urlFilterRealm({
    urlFilter: adversarialUrlFilter,
});
for ( let i = 0; i < 4; i++ ) {
    assert.deepEqual(evaluate(adversarialRealm, {
        targetURL: `https://quadratic.example/${'a'.repeat(7000)}`,
    }), budgetExhausted);
}
const repeatedFilter = popupFilter(1, 'block');
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: Array(4097).fill(repeatedFilter),
} ]), budgetExhausted);
assert.deepEqual(evaluate(Array.from({ length: 17 }, (_, index) => ({
    id: `realm-${index}`,
    filters: [],
}))), budgetExhausted);

// Runtime filter validation and matcher compilation are cached by immutable
// filter identity. Re-evaluating an event must not re-read/reclassify the
// condition or reconstruct its RegExp.
let cachedConditionReads = 0;
const cachedCondition = {
    regexFilter: '^https://ads\\.example/popup$',
};
const cachedRuntimeFilter = popupFilter(70, 'block');
Object.defineProperty(cachedRuntimeFilter, 'condition', {
    configurable: true,
    enumerable: true,
    get() {
        cachedConditionReads += 1;
        return cachedCondition;
    },
});
const cachedRealm = [ {
    id: 'imported',
    filters: [ cachedRuntimeFilter ],
} ];
assert.equal(evaluate(cachedRealm).action, 'block');
const readsAfterCompilation = cachedConditionReads;
assert.ok(readsAfterCompilation > 0);
assert.equal(evaluate(cachedRealm).action, 'block');
assert.equal(cachedConditionReads, readsAfterCompilation);

// A compiler-required block is never approximated. A compiler-required allow
// becomes a conservative guard: supported predicates narrow where possible,
// but an unknown predicate can only defer an ordinary block/heuristic. An
// important block retains its higher priority.
const deferredAllowGuard = popupFilter(2, 'allow', {
    requestDomains: [ 'ads.example' ],
    domainType: 'firstParty',
}, {
    routeCode: POPUP_DEFERRED_ROUTE_CODE,
});
const deferredAllowDecision = {
    action: 'defer',
    reason: 'compiled-popup-allow-condition-deferred',
};
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block', { domainType: 'thirdParty' }),
        popupFilter(2, 'block', {}, {
            routeCode: POPUP_DEFERRED_ROUTE_CODE,
        }),
    ],
} ]), noMatch);
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: [ popupFilter(1, 'block'), deferredAllowGuard ],
} ]), deferredAllowDecision);
assert.equal(evaluate([ {
    id: 'imported',
    filters: [ popupFilter(1, 'block'), deferredAllowGuard ],
} ], {
    targetURL: 'https://unrelated.example/popup',
}).action, 'block');
assert.equal(evaluate([ {
    id: 'imported',
    filters: [
        popupFilter(1, 'block', {}, { important: true }),
        deferredAllowGuard,
    ],
} ]).action, 'block');
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: [ deferredAllowGuard ],
} ]), deferredAllowDecision);
const unsafeRegexGuard = popupFilter(3, 'allow', {
    requestDomains: [ 'ads.example' ],
    regexFilter: 'a.*b',
}, {
    routeCode: POPUP_DEFERRED_ROUTE_CODE,
});
assert.deepEqual(evaluate([ {
    id: 'imported',
    filters: [ popupFilter(1, 'block'), unsafeRegexGuard ],
} ]), deferredAllowDecision);

const redacted = evaluate(realmPrecedence);
assert.deepEqual(Object.keys(redacted).sort(), [
    'action',
    'kind',
    'lineNumber',
    'matchedRealm',
    'reason',
]);
assert.equal(JSON.stringify(redacted).includes('private-list-url'), false);
assert.equal(JSON.stringify(redacted).includes('ads.example'), false);

console.log('Compiled popup matcher tests passed');
