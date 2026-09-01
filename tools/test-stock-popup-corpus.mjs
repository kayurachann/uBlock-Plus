/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import {
    MAX_STOCK_POPUP_FILTERS,
    STOCK_POPUP_CORPUS_SCHEMA_VERSION,
    STOCK_POPUP_DEFERRED_ROUTE_CODE,
    STOCK_POPUP_RUNTIME_ROUTE_CODE,
    STOCK_POPUP_SOURCE_KIND_PRECISION,
    makeStockPopupCorpus,
} from '../platform/mv3/popup-corpus.js';
import {
    POPUP_DEFERRED_ROUTE_CODE,
    POPUP_RUNTIME_ROUTE_CODE,
    classifyPopupCondition,
} from '../platform/mv3/extension/js/compiled-popup-matcher.js';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

assert.equal(STOCK_POPUP_CORPUS_SCHEMA_VERSION, 1);
assert.equal(STOCK_POPUP_DEFERRED_ROUTE_CODE, POPUP_DEFERRED_ROUTE_CODE);
assert.equal(STOCK_POPUP_RUNTIME_ROUTE_CODE, POPUP_RUNTIME_ROUTE_CODE);
assert.equal(
    STOCK_POPUP_SOURCE_KIND_PRECISION,
    'stock-dnr-export-popup-only'
);

const popupCondition = {
    urlFilter: '||popup.example^',
    requestDomains: [ 'popup.example' ],
    resourceTypes: undefined,
};
const popupRules = [
    {
        id: 101,
        action: { type: 'block' },
        condition: popupCondition,
        priority: 10,
    },
    {
        id: 102,
        action: { type: 'allow' },
        condition: {
            initiatorDomains: [ 'safe.example' ],
            excludedInitiatorDomains: [ 'unsafe.safe.example' ],
            topDomains: [ 'safe.example' ],
        },
        priority: 30,
    },
    {
        id: 103,
        action: { type: 'block' },
        condition: { regexFilter: '^https://ads\\.example/' },
        priority: 40,
        __important: true,
    },
    {
        id: 104,
        action: { type: 'block' },
        condition: { domainType: 'thirdParty' },
        priority: 10,
    },
    {
        id: 105,
        action: { type: 'redirect' },
        condition: {},
    },
    {
        id: 106,
        action: { type: 'block' },
        condition: null,
    },
    {
        id: 107,
        action: { type: 'allow' },
        condition: {
            requestDomains: [ 'guarded.example' ],
            domainType: 'firstParty',
        },
        priority: 30,
    },
];

const corpus = makeStockPopupCorpus(
    'stock-test',
    popupRules,
    classifyPopupCondition
);
assert.equal(corpus.schemaVersion, 1);
assert.equal(corpus.routeCode, POPUP_RUNTIME_ROUTE_CODE);
assert.deepEqual(corpus.source, {
    type: 'stock-static-ruleset',
    rulesetId: 'stock-test',
    kind: 'popup',
    kindPrecision: STOCK_POPUP_SOURCE_KIND_PRECISION,
    omittedKinds: [ 'popunder' ],
    lineNumberSemantics: 'compiled-rule-id',
});
assert.deepEqual(corpus.stats, {
    input: 7,
    runnable: 3,
    guards: 1,
    deferred: 2,
    discarded: 2,
    important: 1,
    block: 2,
    allow: 1,
    deferredReasons: {
        'unsupported-domain-type': 2,
    },
});
assert.deepEqual(corpus.filters.map(filter => ({
    routeCode: filter.routeCode,
    kind: filter.kind,
    action: filter.action,
    important: filter.important,
    listid: filter.listid,
    lineNumber: filter.lineNumber,
})), [
    {
        routeCode: POPUP_RUNTIME_ROUTE_CODE,
        kind: 'popup',
        action: 'block',
        important: false,
        listid: 'stock-test',
        lineNumber: 101,
    },
    {
        routeCode: POPUP_RUNTIME_ROUTE_CODE,
        kind: 'popup',
        action: 'allow',
        important: false,
        listid: 'stock-test',
        lineNumber: 102,
    },
    {
        routeCode: POPUP_RUNTIME_ROUTE_CODE,
        kind: 'popup',
        action: 'block',
        important: true,
        listid: 'stock-test',
        lineNumber: 103,
    },
    {
        routeCode: POPUP_DEFERRED_ROUTE_CODE,
        kind: 'popup',
        action: 'allow',
        important: false,
        listid: 'stock-test',
        lineNumber: 107,
    },
]);
assert.equal(corpus.filters.slice(0, 3).every(filter =>
    classifyPopupCondition(filter.condition).supported
), true);
assert.equal(
    classifyPopupCondition(corpus.filters[3].condition).supported,
    false
);
assert.equal('resourceTypes' in corpus.filters[0].condition, false);
assert.equal('resourceTypes' in popupCondition, true);
assert.equal(JSON.stringify(corpus).includes('__important'), false);
assert.equal(JSON.stringify(corpus).includes('"priority"'), false);

const oversized = makeStockPopupCorpus(
    'oversized',
    new Array(MAX_STOCK_POPUP_FILTERS + 1).fill(popupRules[0]),
    classifyPopupCondition
);
assert.equal(oversized.filters.length, 0);
assert.equal(oversized.stats.suppressed, true);
assert.equal(
    oversized.stats.suppressionReason,
    'stock-popup-filter-limit'
);

const makeRulesetsSource = await fs.readFile(
    path.join(root, 'platform', 'mv3', 'make-rulesets.js'),
    'utf8'
);
for ( const requiredSource of [
    'makeStockPopupCorpus(',
    'rulesetDir}/popup/',
    'popupObserver: popupStats?.observer',
] ) {
    assert.equal(
        makeRulesetsSource.includes(requiredSource),
        true,
        `make-rulesets.js is missing ${requiredSource}`
    );
}

console.log('Stock popup corpus tests passed');

/******************************************************************************/
