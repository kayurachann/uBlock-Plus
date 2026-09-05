/*******************************************************************************

    uBlock Plus+ - stock content-script filtering-mode scope regressions
    Copyright (C) 2026-present uBlock Plus+ contributors

*******************************************************************************/

import assert from 'node:assert/strict';

const stored = new Map();
globalThis.self = globalThis;
globalThis.chrome = {
    declarativeNetRequest: {},
    i18n: { getMessage() { return ''; } },
    runtime: {
        getManifest() { return { permissions: [] }; },
        getURL(value = '') { return `chrome-extension://test/${value}`; },
    },
    storage: {
        local: {
            async getKeys() { return [ ...stored.keys() ]; },
            async remove(keys) { for ( const key of keys ) { stored.delete(key); } },
            async set(values) {
                for ( const [ key, value ] of Object.entries(values) ) {
                    stored.set(key, value);
                }
            },
        },
    },
};
globalThis.fetch = async url => {
    assert.equal(url, '/rulesets/scripting/specific/stock.json');
    return { async json() { return { selectors: '.ad' }; } };
};

const {
    registerCosmetic,
    registerGeneric,
    registerScriptlet,
} = await import('../platform/mv3/extension/js/scripting-manager.js');
const { registerPreventPopup } = await import('../platform/mv3/extension/js/prevent-popup.js');

const genericDetails = new Map([ [ 'stock', {} ] ]);
const scriptletDetails = new Map([ [ 'stock', {
    MAIN: [ '*' ],
    ISOLATED: [ 'parent.example' ],
} ] ]);
const modeNames = [ 'none', 'basic', 'optimal', 'complete' ];

function makeContext(values) {
    return {
        filteringModeDetails: Object.fromEntries(modeNames.map(name =>
            [ name, new Set(values[name] || []) ]
        )),
        memoryProfile: { importCompileConcurrency: 1 },
        rulesetsDetails: [ { id: 'stock', css: { generic: 1, specific: 1 } } ],
        toAdd: [],
    };
}

function matchesHostname(pattern, hostname) {
    if ( pattern === '<all_urls>' ) { return true; }
    const match = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(pattern);
    assert.notEqual(match, null, `Unexpected registration pattern: ${pattern}`);
    return hostname === match[1] || hostname.endsWith(`.${match[1]}`);
}

function applies(directive, hostname) {
    return directive.matches.some(pattern => matchesHostname(pattern, hostname)) &&
        (directive.excludeMatches || []).some(pattern =>
            matchesHostname(pattern, hostname)
        ) === false;
}

function assertScoped(directives, blockedHosts, activeHosts) {
    assert.ok(directives.length !== 0);
    for ( const hostname of blockedHosts ) {
        assert.equal(directives.some(directive => applies(directive, hostname)), false,
            `Scripts must not apply to ${hostname}`);
    }
    for ( const hostname of activeHosts ) {
        assert.equal(directives.some(directive => applies(directive, hostname)), true,
            `Scripts should apply to ${hostname}`);
    }
    for ( const directive of directives ) {
        assert.equal((directive.excludeMatches || []).includes('<all_urls>'), false,
            'The global default is not an explicit site exclusion');
    }
}

const trustedChild = 'off.parent.example';
const basicChild = 'basic.parent.example';
const optimalChild = 'optimal.parent.example';
const sibling = 'active.parent.example';

// Explicit Complete parent scopes retain child exclusions under every global
// default. A default sentinel must not hide the explicit exclusions in its set.
for ( const defaultMode of [ 'none', 'basic', 'optimal' ] ) {
    const values = {
        none: [ trustedChild ],
        basic: [ basicChild ],
        optimal: [ optimalChild ],
        complete: [ 'parent.example' ],
    };
    values[defaultMode].push('all-urls');
    const generic = makeContext(values);
    registerGeneric(generic, genericDetails);
    assertScoped(generic.toAdd,
        [ trustedChild, `sub.${trustedChild}`, basicChild, optimalChild ],
        [ 'parent.example', sibling ]);

    const cosmetic = makeContext(values);
    await registerCosmetic(cosmetic);
    assertScoped(cosmetic.toAdd,
        [ trustedChild, `sub.${trustedChild}`, basicChild ],
        [ 'parent.example', sibling, optimalChild ]);

    const scriptlets = makeContext(values);
    registerScriptlet(scriptlets, scriptletDetails);
    for ( const directive of scriptlets.toAdd ) {
        assertScoped([ directive ], [ trustedChild, basicChild ], [ sibling ]);
    }
    assert.equal(scriptlets.toAdd.length, 2);
    const popup = makeContext(values);
    await registerPreventPopup(popup);
    assertScoped(popup.toAdd,
        [ trustedChild, `sub.${trustedChild}`, basicChild ],
        [ 'parent.example', sibling, optimalChild ]);
}

// Complete everywhere, including the force-included generic path beneath a
// filter-list generic exception, still respects site power and reduced modes.
const broadValues = {
    none: [ trustedChild ],
    basic: [ basicChild ],
    optimal: [ optimalChild ],
    complete: [ 'all-urls' ],
};
const forced = makeContext(broadValues);
registerGeneric(forced, new Map([ [ 'stock', {
    unhide: [ 'parent.example' ], hide: [ 'parent.example' ],
} ] ]));
assert.equal(forced.toAdd.length, 2);
assertScoped(forced.toAdd,
    [ trustedChild, `sub.${trustedChild}`, basicChild, optimalChild ],
    [ sibling, 'unrelated.example' ]);
const forcedDirective = forced.toAdd.find(directive => directive.id === 'css-generic-some');
assertScoped([ forcedDirective ], [ trustedChild, basicChild, optimalChild ], [ sibling ]);

const broadCosmetic = makeContext(broadValues);
await registerCosmetic(broadCosmetic);
assertScoped(broadCosmetic.toAdd, [ trustedChild, basicChild ], [ sibling, optimalChild ]);
const broadScriptlets = makeContext(broadValues);
registerScriptlet(broadScriptlets, scriptletDetails);
for ( const directive of broadScriptlets.toAdd ) {
    assertScoped([ directive ], [ trustedChild, basicChild ], [ sibling, optimalChild ]);
}

// Explicitly force-included generic scope remains limited by trusted children.
const explicitForced = makeContext({
    none: [ trustedChild ], basic: [ 'all-urls' ], complete: [ 'parent.example' ],
});
registerGeneric(explicitForced, new Map([ [ 'stock', {
    unhide: [ '*' ], hide: [ 'parent.example' ],
} ] ]));
assertScoped(explicitForced.toAdd, [ trustedChild ], [ sibling ]);

// No global advanced mode and no explicitly enabled advanced sites produces
// no stock cosmetic/scriptlet registrations.
const disabled = makeContext({ none: [ 'all-urls' ] });
registerGeneric(disabled, genericDetails);
await registerCosmetic(disabled);
registerScriptlet(disabled, scriptletDetails);
assert.deepEqual(disabled.toAdd, []);

console.log('Stock content-script filtering-mode scope tests passed.');
