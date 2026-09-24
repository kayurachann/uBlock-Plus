/* uBlock Plus+ - strict-block rule shapes and session plan. GPL-3.0-or-later. */
//
// Candidate detection, stock folding and user derivation run on the real
// outputs of the stock compiler (src/js/static-dnr-filtering.js) and of the
// runtime compiler (ubo-parser.js, My filters and imported lists). The
// session plan is checked for shapes, priorities, budgets, IDs and owners,
// and its precedence against a small model of Chrome's DNR rule selection.

import * as namespaces from '../platform/mv3/extension/js/dnr-namespaces.js';
import {
    STOCK_STRICTBLOCK_PRIORITY,
    STRICTBLOCK_PAGE_PATH,
    STRICTBLOCK_SESSION_ID_LIMIT,
    USER_RULES_PRIORITY,
    deriveUserStrictBlockRules,
    foldStockStrictBlockRules,
    isStrictBlockCandidate,
    isStrictBlockSessionRule,
    ownerForRuleId,
    planStrictBlockSessionRules,
    stripPrivateProperties,
} from '../platform/mv3/extension/js/strictblock-rules.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { dnrRulesetFromRawLists } from '../src/js/static-dnr-filtering.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pageURL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/strictblock.html';
const hasPrivate = value => JSON.stringify(value).includes('"_');

/******************************************************************************/

// Constants come from the namespace registry.
assert.equal(STRICTBLOCK_PAGE_PATH, '/strictblock.html');
assert.equal(STOCK_STRICTBLOCK_PRIORITY, 29);
assert.equal(STRICTBLOCK_SESSION_ID_LIMIT, 1000000);
assert.equal(USER_RULES_PRIORITY, 1000000);
assert.equal(STOCK_STRICTBLOCK_PRIORITY, namespaces.STOCK_STRICTBLOCK_PRIORITY);
assert.equal(STRICTBLOCK_SESSION_ID_LIMIT, namespaces.STRICTBLOCK_SESSION_ID_LIMIT);
assert.equal(USER_RULES_PRIORITY, namespaces.USER_RULES_PRIORITY);
assert.equal(isStrictBlockSessionRule, namespaces.isStrictBlockSessionRule);

// Session ownership is by ID range, not by shape: legacy regexSubstitution
// rules (IDs 1..826) are replaced on upgrade, other owners are never touched.
for ( const id of [ 1, 826, 999999 ] ) {
    assert.equal(isStrictBlockSessionRule({ id }), true, `${id}`);
}
for ( const rule of [ { id: 0 }, { id: 1000000 }, { id: 7000000 },
    { id: 8000001 }, { id: 1.5 }, { id: '1' }, {}, undefined, null ] ) {
    assert.equal(isStrictBlockSessionRule(rule), false, JSON.stringify(rule));
}

/******************************************************************************/

// Candidate detection: every narrowing condition keeps a plain block.
{
    const doc = { action: { type: 'block' },
        condition: { requestDomains: [ 'a.test' ], resourceTypes: [ 'main_frame' ] } };
    assert.equal(isStrictBlockCandidate(doc), true);
    for ( const [ prop, value ] of [
        [ 'domainType', 'thirdParty' ], [ 'excludedResourceTypes', [ 'script' ] ],
        [ 'requestMethods', [ 'get' ] ], [ 'excludedRequestMethods', [ 'post' ] ],
        [ 'requestHeaders', [ { header: 'a' } ] ],
        [ 'responseHeaders', [ { header: 'a' } ] ],
        [ 'excludedResponseHeaders', [ { header: 'a' } ] ],
        [ 'initiatorDomains', [ 'x.test' ] ], [ 'excludedInitiatorDomains', [ 'x.test' ] ],
        [ 'domains', [ 'x.test' ] ], [ 'excludedDomains', [ 'x.test' ] ],
        [ 'topDomains', [ 'x.test' ] ], [ 'excludedTopDomains', [ 'x.test' ] ],
        [ 'tabIds', [ 1 ] ], [ 'excludedTabIds', [ 1 ] ],
    ] ) {
        const rule = structuredClone(doc);
        rule.condition[prop] = value;
        assert.equal(isStrictBlockCandidate(rule), false, prop);
        assert.equal(isStrictBlockCandidate(rule, { hostnameOnly: true }), false, prop);
    }
    for ( const type of [ 'allow', 'redirect', 'allowAllRequests', 'modifyHeaders' ] ) {
        assert.equal(isStrictBlockCandidate({ ...doc, action: { type } }), false, type);
    }
    assert.equal(isStrictBlockCandidate({ action: { type: 'block' } }), false);
    assert.equal(isStrictBlockCandidate(undefined), false);
    const noDoc = { action: { type: 'block' },
        condition: { requestDomains: [ 'a.test' ], resourceTypes: [ 'script' ] } };
    assert.equal(isStrictBlockCandidate(noDoc, { hostnameOnly: true }), false);
    // Stock semantics: a rule without resource types strict-blocks only when
    // its sole URL predicate is a hostname.
    const hostnameRule = { action: { type: 'block' }, condition: { requestDomains: [ 'a.test' ] } };
    assert.equal(isStrictBlockCandidate(hostnameRule), false);
    assert.equal(isStrictBlockCandidate(hostnameRule, { hostnameOnly: true }), true);
    for ( const [ condition, expected ] of [
        [ { urlFilter: '||a.test^' }, true ],
        [ { urlFilter: '||a.test/path^' }, false ],
        [ { urlFilter: '/ads/' }, false ],
        [ { regexFilter: '^https?://a\\.test/' }, false ],
        [ { requestDomains: [ 'a.test' ], urlFilter: '/ads/' }, false ],
        [ {}, false ],
    ] ) {
        assert.equal(isStrictBlockCandidate({ action: { type: 'block' }, condition },
            { hostnameOnly: true }), expected, JSON.stringify(condition));
    }
}

/******************************************************************************/

// Stock folding on real stock compiler output, split as make-rulesets does:
// candidates are cloned without resource types.
{
    const lines = [
        '||a.test^', '||b.test^', '||c.test^$doc', '||d.test/path^$doc',
        '/^https?:\\/\\/e\\.test\\/[a-z]+/$doc', '||f.test^$doc,domain=x.test',
        '||g.test^$doc,to=~sub.g.test', '||h.test^$to=~sub.h.test',
        '||j.test^$doc,method=get', '||k.test^$all', '||l.test^$doc,script',
        '||m.test^$doc,important', '/^https?:\\/\\/n\\.test\\//$doc,match-case',
    ];
    const result = await dnrRulesetFromRawLists(
        [ { name: 'strictblock-test', text: lines.join('\n') } ],
        { env: [ 'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol' ],
            extensionPaths: [], secret: 'strictblock-test' }
    );
    const compiled = result.network.ruleset.filter(rule => rule._error === undefined);
    const candidates = compiled
        .filter(rule => isStrictBlockCandidate(rule, { hostnameOnly: true }))
        .map(rule => {
            const clone = structuredClone(rule);
            clone.condition.resourceTypes = undefined;
            return clone;
        });
    const sources = candidates.flatMap(rule => rule._sourceFilters);
    for ( const filter of [ '||f.test^$doc,domain=x.test', '||j.test^$doc,method=get' ] ) {
        assert.equal(sources.includes(filter), false, filter);
    }
    const snapshot = structuredClone(candidates);
    const folded = foldStockStrictBlockRules(candidates);
    assert.deepEqual(candidates, snapshot, 'folding does not modify its input');
    const byKey = new Map(folded.map(rule => [ JSON.stringify([
        rule.condition.regexFilter ?? rule.condition.urlFilter ?? 'hn',
        rule.condition.excludedRequestDomains ?? [],
    ]), rule ]));
    assert.equal(folded.length, 6);
    for ( const rule of folded ) {
        assert.deepEqual(rule.action, { type: 'redirect',
            redirect: { extensionPath: '/strictblock.html' } });
        assert.equal(rule.priority, 29);
        assert.deepEqual(rule.condition.resourceTypes, [ 'main_frame' ]);
        assert.equal(JSON.stringify(rule).includes('regexSubstitution'), false);
        assert.equal(rule.id, undefined);
    }
    // Hostname filters and $doc filters without exclusions share one rule.
    const hostnames = byKey.get(JSON.stringify([ 'hn', [] ]));
    assert.deepEqual(hostnames.condition.requestDomains,
        [ 'a.test', 'b.test', 'c.test', 'k.test', 'l.test', 'm.test' ]);
    // Different exclusions are never merged, so no rule is narrowed.
    assert.deepEqual(byKey.get(JSON.stringify([ 'hn', [ 'sub.g.test' ] ])).condition,
        { requestDomains: [ 'g.test' ], excludedRequestDomains: [ 'sub.g.test' ],
            resourceTypes: [ 'main_frame' ] });
    assert.deepEqual(byKey.get(JSON.stringify([ 'hn', [ 'sub.h.test' ] ])).condition,
        { requestDomains: [ 'h.test' ], excludedRequestDomains: [ 'sub.h.test' ],
            resourceTypes: [ 'main_frame' ] });
    assert.deepEqual(byKey.get(JSON.stringify([ '||d.test/path^', [] ])).condition,
        { urlFilter: '||d.test/path^', resourceTypes: [ 'main_frame' ] });
    // Only regex-sourced filters use the shared regex pool.
    const regexSourced = candidates.filter(rule => rule.condition.regexFilter).length;
    assert.equal(regexSourced, 2);
    assert.equal(folded.filter(rule => rule.condition.regexFilter).length, regexSourced);
    const caseSensitive = folded.find(rule => rule.condition.isUrlFilterCaseSensitive);
    assert.match(caseSensitive.condition.regexFilter, /n\\?\.test/);
    // Provenance is carried for the badfilter and logger indexes, and is
    // stripped on write.
    assert.deepEqual(new Set(hostnames._sourceFilters), new Set([ '||a.test^', '||b.test^',
        '||c.test^$doc', '||k.test^$all', '||l.test^$doc,script', '||m.test^$doc,important' ]));
    assert.equal(hasPrivate(stripPrivateProperties(folded)), false);
    assert.equal(stripPrivateProperties(undefined), undefined);
    assert.deepEqual(stripPrivateProperties({ a: { _b: 1, c: [ { _d: 2, e: 3 } ] } }),
        { a: { c: [ { e: 3 } ] } });
}

// Folding details.
{
    const block = (condition, extra = {}) => ({ action: { type: 'block' }, condition, ...extra });
    const folded = foldStockStrictBlockRules([
        block({ urlFilter: '||a.test^' }, { _sourceFilters: [ 'A' ], _sourceKeys: [ 'k1' ] }),
        block({ requestDomains: [ 'b.test' ] }, { _sourceFilters: [ 'B', 'A' ], _sourceKeys: [ 'k1', 'k2' ] }),
        // Not a DNR request domain: stays a urlFilter.
        block({ urlFilter: '||c.test:8080^' }),
        // `||host^` combined with requestDomains keeps both predicates.
        block({ urlFilter: '||d.test^', requestDomains: [ 'x.test' ] }),
        // Same pattern: requestDomains are unioned...
        block({ urlFilter: '/ads/', requestDomains: [ 'p.test' ] }),
        block({ urlFilter: '/ads/', requestDomains: [ 'q.test' ] }),
        // ...and an unrestricted member makes the group unrestricted.
        block({ urlFilter: '/track/', requestDomains: [ 'p.test' ] }),
        block({ urlFilter: '/track/' }),
        block({ urlFilter: '/track/', requestDomains: [ 'q.test' ] }),
        // Case sensitivity is part of the group key.
        block({ regexFilter: '^https?://r\\.test/A' }),
        block({ regexFilter: '^https?://r\\.test/A', isUrlFilterCaseSensitive: true }),
        block({ regexFilter: '^https?://r\\.test/A', isUrlFilterCaseSensitive: false }),
        // Exclusions are compared as sets.
        block({ requestDomains: [ 's.test' ], excludedRequestDomains: [ 'y.s.test', 'x.s.test' ] }),
        block({ requestDomains: [ 't.test' ], excludedRequestDomains: [ 'x.s.test', 'y.s.test' ] }),
        // An empty list matches nothing: never folded into a broader rule.
        block({ requestDomains: [] }),
        block(undefined),
    ]);
    const find = predicate => folded.filter(predicate);
    const hn = find(rule => !rule.condition.urlFilter && !rule.condition.regexFilter &&
        !rule.condition.excludedRequestDomains);
    assert.equal(hn.length, 1);
    assert.deepEqual(hn[0].condition, { requestDomains: [ 'a.test', 'b.test' ],
        resourceTypes: [ 'main_frame' ] });
    assert.deepEqual(hn[0]._sourceFilters, [ 'A', 'B' ]);
    assert.deepEqual(hn[0]._sourceKeys, [ 'k1', 'k2' ]);
    assert.deepEqual(find(rule => rule.condition.urlFilter === '||c.test:8080^')[0].condition,
        { urlFilter: '||c.test:8080^', resourceTypes: [ 'main_frame' ] });
    assert.deepEqual(find(rule => rule.condition.urlFilter === '||d.test^')[0].condition,
        { urlFilter: '||d.test^', requestDomains: [ 'x.test' ], resourceTypes: [ 'main_frame' ] });
    assert.deepEqual(find(rule => rule.condition.urlFilter === '/ads/')[0].condition.requestDomains,
        [ 'p.test', 'q.test' ]);
    const track = find(rule => rule.condition.urlFilter === '/track/');
    assert.equal(track.length, 1);
    assert.equal(track[0].condition.requestDomains, undefined);
    const regex = find(rule => rule.condition.regexFilter);
    assert.equal(regex.length, 2);
    assert.deepEqual(regex.map(rule => rule.condition.isUrlFilterCaseSensitive === true).sort(),
        [ false, true ]);
    assert.equal(regex.some(rule => rule.condition.isUrlFilterCaseSensitive === false), false);
    const excluded = find(rule => rule.condition.excludedRequestDomains);
    assert.equal(excluded.length, 1);
    assert.deepEqual(excluded[0].condition, { requestDomains: [ 's.test', 't.test' ],
        excludedRequestDomains: [ 'x.s.test', 'y.s.test' ], resourceTypes: [ 'main_frame' ] });
    assert.equal(folded.length, 8);
    assert.deepEqual(foldStockStrictBlockRules(undefined), []);
    // A candidate without any URL predicate strict-blocks every document, as
    // the regex '^https?://.*' of the old shape did.
    assert.deepEqual(foldStockStrictBlockRules([ block({}) ])[0].condition,
        { resourceTypes: [ 'main_frame' ] });
}

/******************************************************************************/

// Runtime compiler shapes (tmp/design/step2-regex-pool/runtime-doc.mjs).
const runtimeLines = [
    '||evil.example^$document',
    '||evil2.example^$doc,important',
    '||evil3.example/path^$doc',
    '/^https?:\\/\\/evil4\\.example\\/[a-z]{3}\\//$doc',
    '@@||good.example^$document',
    '||hostonly.example^',
    '||evil5.example^$doc,domain=a.example',
    '||evil6.example^$all',
    '||evil7.example^$doc,script',
    '*$doc,to=evil8.example',
];
const runtimeRules = await (async ( ) => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-plus-strictblock-rules-'));
    try {
        await fs.mkdir(path.join(temporaryRoot, 'js'));
        await fs.mkdir(path.join(temporaryRoot, 'lib'));
        await Promise.all([
            [ 'platform/mv3/extension/js/ubo-parser.js', 'js/ubo-parser.js' ],
            [ 'platform/mv3/extension/js/compiled-popup-matcher.js', 'js/compiled-popup-matcher.js' ],
            [ 'src/js/static-filtering-parser.js', 'js/static-filtering-parser.js' ],
            [ 'src/js/arglist-parser.js', 'js/arglist-parser.js' ],
            [ 'src/js/jsonpath.js', 'js/jsonpath.js' ],
            [ 'src/js/redirect-resources.js', 'js/redirect-resources.js' ],
            [ 'src/lib/punycode.js', 'js/punycode.js' ],
        ].map(([ source, destination ]) => fs.copyFile(
            path.join(projectRoot, source), path.join(temporaryRoot, destination)
        )));
        await fs.cp(path.join(projectRoot, 'src/lib/csstree'),
            path.join(temporaryRoot, 'lib/csstree'), { recursive: true });
        await fs.writeFile(path.join(temporaryRoot, 'package.json'), '{"type":"module"}\n');
        const sfp = await import(pathToFileURL(path.join(temporaryRoot, 'js/static-filtering-parser.js')));
        const { NetworkFilterCompiler } = await import(pathToFileURL(
            path.join(temporaryRoot, 'js/ubo-parser.js')));
        const parser = new sfp.AstFilterParser({ trustedSource: false, nativeCssHas: true });
        const compiler = new NetworkFilterCompiler({ listid: 'strictblock-test' });
        runtimeLines.forEach((line, i) => {
            parser.parse(line);
            compiler.add(parser, i + 1);
        });
        const out = compiler.finish();
        assert.deepEqual(out.rejections, []);
        return out.dnrRules;
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
})();

const findRule = (rules, predicate) => {
    const found = rules.filter(predicate);
    assert.equal(found.length, 1);
    return found[0];
};
const hasDomain = hostname => rule => rule.condition.requestDomains?.includes(hostname);
{
    const expectations = [
        [ hasDomain('evil.example'), 'block', 10, true ],
        [ hasDomain('evil2.example'), 'block', 40, true ],
        [ rule => rule.condition.urlFilter === '||evil3.example/path^', 'block', 10, true ],
        [ rule => rule.condition.regexFilter !== undefined, 'block', 10, true ],
        [ hasDomain('good.example'), 'allow', 30, false ],
        [ hasDomain('hostonly.example'), 'block', 10, false ],
        [ hasDomain('evil5.example'), 'block', 10, false ],
        [ hasDomain('evil6.example'), 'block', 10, true ],
        [ hasDomain('evil7.example'), 'block', 10, true ],
    ];
    for ( const [ predicate, type, priority, candidate ] of expectations ) {
        const rule = findRule(runtimeRules, predicate);
        assert.equal(rule.action.type, type, JSON.stringify(rule));
        assert.equal(rule.priority, priority, JSON.stringify(rule));
        assert.equal(isStrictBlockCandidate(rule), candidate, JSON.stringify(rule));
    }
    // Hostname-only filters have no main_frame in the runtime compiler; they
    // are strict-blocked only by the stock semantics (step 4 unifies this).
    assert.equal(isStrictBlockCandidate(findRule(runtimeRules, hasDomain('hostonly.example')),
        { hostnameOnly: true }), true);
    assert.equal(findRule(runtimeRules, hasDomain('evil5.example')).condition.initiatorDomains
        .includes('a.example'), true);
}

// User derivation: a redirect template per document block, the block itself
// untouched.
{
    const input = structuredClone(runtimeRules);
    input[0]._sourceKeys = [ 'key' ];
    input[0].__important = true;
    const snapshot = structuredClone(input);
    const derived = deriveUserStrictBlockRules(input);
    assert.deepEqual(input, snapshot, 'the dynamic block rules stay the fallback');
    assert.equal(derived.length, input.filter(rule => isStrictBlockCandidate(rule)).length);
    assert.equal(derived.length, 6);
    assert.equal(hasPrivate(derived), false, 'Chrome rejects private properties');
    for ( const rule of derived ) {
        const source = input[rule.id - 1];
        assert.equal(isStrictBlockCandidate(source), true);
        assert.deepEqual(rule.action, { type: 'redirect',
            redirect: { extensionPath: STRICTBLOCK_PAGE_PATH } });
        assert.equal(rule.priority, source.priority);
        assert.deepEqual(rule.condition.resourceTypes, [ 'main_frame' ]);
        assert.deepEqual({ ...rule.condition, resourceTypes: undefined },
            { ...source.condition, resourceTypes: undefined });
    }
    // `$all` and `$doc,script` redirect documents only.
    const all = findRule(derived, hasDomain('evil6.example'));
    assert.deepEqual(all.condition.resourceTypes, [ 'main_frame' ]);
    assert.equal(findRule(derived, hasDomain('evil2.example')).priority, 40);
    assert.equal(derived.some(hasDomain('evil5.example')), false);
    assert.equal(derived.some(hasDomain('good.example')), false);
    assert.equal(derived.some(hasDomain('hostonly.example')), false);
    // A block without priority defaults to 1, as the installer does.
    assert.equal(deriveUserStrictBlockRules([ { action: { type: 'block' },
        condition: { requestDomains: [ 'a.test' ], resourceTypes: [ 'main_frame' ] } } ])[0].priority, 1);
    assert.deepEqual(deriveUserStrictBlockRules(undefined), []);
    assert.deepEqual(deriveUserStrictBlockRules({}), []);
}

/******************************************************************************/

// Session plan fixtures.
const userTemplates = deriveUserStrictBlockRules(runtimeRules);
const stockRules = foldStockStrictBlockRules([
    { action: { type: 'block' }, condition: { requestDomains: [ 'w.test', 'v.test' ] } },
    { action: { type: 'block' }, condition: { urlFilter: '||u.test/path^' } },
    { action: { type: 'block' }, condition: { regexFilter: '^https?://t\\.test/' } },
    { action: { type: 'block' }, condition: { requestDomains: [ 's.test' ],
        excludedRequestDomains: [ 'keep.s.test' ] } },
]).map((rule, i) => ({ id: i + 1, ...stripPrivateProperties(rule) }));
const legacyRules = [
    { id: 1, action: { type: 'redirect', redirect: { regexSubstitution: '/strictblock.html#\\0' } },
        condition: { regexFilter: '^https?://legacy\\.test/.*', resourceTypes: [ 'main_frame' ] },
        priority: 29 },
    { id: 2, action: { type: 'redirect', redirect: { regexSubstitution: '/strictblock.html#\\0' } },
        condition: { regexFilter: '^https?://.*', requestDomains: [ 'legacy2.test' ],
            resourceTypes: [ 'main_frame' ] }, priority: 29 },
];
const baseInput = ( ) => ({
    flavor: 'chromium',
    strictBlockMode: true,
    hasOmnipotence: true,
    exactUrlSource: true,
    extensionPageURL: pageURL,
    stock: [ { rulesetId: 'ublock-badware', rules: structuredClone(stockRules) } ],
    user: [
        // Realms are planned sandbox first, whatever the input order.
        { realm: 'imported', rules: structuredClone(userTemplates) },
        { realm: 'sandbox', rules: structuredClone(userTemplates.slice(0, 2)) },
    ],
    excludedHostnames: [],
    sessionRuleBudget: 5000,
    regexRuleBudget: 1000,
});
const checkIds = plan => {
    plan.rules.forEach((rule, i) => {
        assert.equal(rule.id, i + 1);
        assert.equal(isStrictBlockSessionRule(rule), true);
    });
    let next = 1;
    for ( const [ first, last, owner, action, sources ] of plan.owners ) {
        assert.equal(first, next);
        assert.ok(last >= first);
        assert.ok(typeof owner === 'string' && /^(stock(:.+)?|sandbox|imported)$/.test(owner));
        assert.ok(action === 'redirect' || action === 'allow');
        if ( sources !== undefined ) { assert.equal(sources.length, last - first + 1); }
        for ( let id = first; id <= last; id++ ) {
            assert.equal(plan.rules[id - 1].action.type, action);
        }
        next = last + 1;
    }
    assert.equal(next, plan.rules.length + 1);
    assert.equal(plan.redirectCount, plan.rules.filter(rule => rule.action.type === 'redirect').length);
    assert.equal(plan.counts.rules, plan.rules.length);
    assert.equal(plan.counts.redirects, plan.redirectCount);
    assert.equal(plan.counts.regex, plan.rules.filter(rule => rule.condition.regexFilter).length);
    assert.equal(plan.counts.allows, plan.rules.filter(rule => rule.action.type === 'allow').length);
    assert.equal(hasPrivate(plan.rules), false);
};

// Mode off, host access withheld, Safari: nothing is installed. A redirect
// without host access would shadow the block and let the page load.
for ( const override of [
    { strictBlockMode: false }, { hasOmnipotence: false }, { hasOmnipotence: 'yes' },
    { flavor: 'safari' },
] ) {
    const plan = planStrictBlockSessionRules({ ...baseInput(), ...override,
        excludedHostnames: [ 'w.test' ] });
    assert.deepEqual(plan.rules, [], JSON.stringify(override));
    assert.deepEqual(plan.owners, []);
    assert.equal(plan.redirectCount, 0);
}
assert.equal(planStrictBlockSessionRules().rules.length, 0);

// Full plan without exclusions.
{
    const input = baseInput();
    const snapshot = structuredClone(input);
    const plan = planStrictBlockSessionRules(input);
    assert.deepEqual(input, snapshot, 'the plan does not modify its input');
    checkIds(plan);
    assert.equal(plan.rules.length, 2 + 6 + 4);
    assert.equal(plan.redirectCount, 12);
    assert.deepEqual(plan.counts, { rules: 12, regex: 1 + 1, redirects: 12,
        stock: 4, sandbox: 2, imported: 6, allows: 0, exclusions: 0 });
    assert.deepEqual(plan.owners.map(owner => owner.slice(0, 4)), [
        [ 1, 2, 'sandbox', 'redirect' ],
        [ 3, 8, 'imported', 'redirect' ],
        [ 9, 12, 'stock:ublock-badware', 'redirect' ],
    ]);
    // User redirects sit one above their own block; My filters are offset.
    assert.deepEqual(plan.rules.slice(0, 2).map(rule => rule.priority), [ 1000011, 1000041 ]);
    assert.deepEqual(plan.rules.slice(2, 8).map(rule => rule.priority),
        userTemplates.map(rule => rule.priority + 1));
    assert.ok(plan.rules.slice(2, 8).some(rule => rule.priority === 41));
    assert.ok(plan.rules.slice(8).every(rule => rule.priority === 29));
    for ( const rule of plan.rules ) {
        assert.deepEqual(rule.action, { type: 'redirect', redirect: { extensionPath: '/strictblock.html' } });
        assert.deepEqual(rule.condition.resourceTypes, [ 'main_frame' ]);
    }
    // A packaged exclusion is kept; none is added.
    assert.deepEqual(plan.rules.find(hasDomain('s.test')).condition.excludedRequestDomains,
        [ 'keep.s.test' ]);
    assert.equal(plan.rules.filter(rule => rule.condition.excludedRequestDomains).length, 1);
    // Owners, with the source rule of every redirect.
    assert.deepEqual(ownerForRuleId(plan.owners, 1), { kind: 'sandbox', source: userTemplates[0].id });
    assert.deepEqual(ownerForRuleId(plan.owners, 3), { kind: 'imported', source: userTemplates[0].id });
    assert.deepEqual(ownerForRuleId(plan.owners, 8), { kind: 'imported', source: userTemplates[5].id });
    assert.deepEqual(ownerForRuleId(plan.owners, 9), { kind: 'stock', rulesetId: 'ublock-badware', source: 1 });
    assert.deepEqual(ownerForRuleId(plan.owners, 12), { kind: 'stock', rulesetId: 'ublock-badware', source: 4 });
    assert.equal(ownerForRuleId(plan.owners, 13), undefined);
    assert.equal(ownerForRuleId(plan.owners, 0), undefined);
    assert.equal(ownerForRuleId(plan.owners, 1.5), undefined);
    assert.equal(ownerForRuleId(undefined, 1), undefined);
    assert.equal(ownerForRuleId([ null, [ 1, 1, 'unknown', 'redirect' ] ], 1), undefined);
    assert.deepEqual(ownerForRuleId([ [ 1, 2, 'imported', 'redirect' ] ], 2), { kind: 'imported' });
    // The stored plan survives storage.session (structured clone and JSON).
    assert.deepEqual(JSON.parse(JSON.stringify(plan.owners)), plan.owners);
}

// Exclusions: injected into every extensionPath redirect, one allow per user
// base priority, and one stock allow at 29 for stock main_frame blocks that
// are not strict-block candidates.
{
    const plan = planStrictBlockSessionRules({ ...baseInput(),
        excludedHostnames: [ 'w.test', 'EVIL.example', 'w.test', '', 42, 'bad host', 'a/b' ] });
    checkIds(plan);
    const excluded = [ 'evil.example', 'w.test' ];
    assert.equal(plan.counts.exclusions, 2);
    const redirects = plan.rules.filter(rule => rule.action.type === 'redirect');
    assert.equal(redirects.length, 12);
    for ( const rule of redirects ) {
        const list = rule.condition.excludedRequestDomains;
        assert.deepEqual(list, [ ...list ].sort());
        for ( const hostname of excluded ) { assert.ok(list.includes(hostname), JSON.stringify(rule)); }
    }
    assert.deepEqual(plan.rules.find(hasDomain('s.test')).condition.excludedRequestDomains,
        [ 'evil.example', 'keep.s.test', 'w.test' ]);
    const allows = plan.rules.filter(rule => rule.action.type === 'allow');
    assert.deepEqual(allows.map(rule => rule.priority), [ 1000010, 1000040, 10, 40, 29 ]);
    for ( const rule of allows ) {
        assert.deepEqual(rule.condition, { requestDomains: excluded, resourceTypes: [ 'main_frame' ] });
    }
    assert.deepEqual(plan.owners.map(owner => owner.slice(0, 4)), [
        [ 1, 2, 'sandbox', 'redirect' ],
        [ 3, 8, 'imported', 'redirect' ],
        [ 9, 10, 'sandbox', 'allow' ],
        [ 11, 12, 'imported', 'allow' ],
        [ 13, 16, 'stock:ublock-badware', 'redirect' ],
        [ 17, 17, 'stock', 'allow' ],
    ]);
    assert.equal(plan.owners[2].length, 4, 'allow ranges have no sources');
    for ( const id of [ 9, 10, 11, 12, 17 ] ) {
        assert.equal(ownerForRuleId(plan.owners, id), undefined);
    }
}

// Without an exact URL source, on Firefox, or without user rules: stock only,
// and no user allow tiers.
for ( const override of [ { exactUrlSource: false }, { exactUrlSource: 'yes' },
    { flavor: 'firefox' }, { user: [] }, { user: undefined } ] ) {
    const plan = planStrictBlockSessionRules({ ...baseInput(), ...override,
        excludedHostnames: [ 'w.test' ] });
    checkIds(plan);
    assert.equal(plan.counts.sandbox + plan.counts.imported, 0, JSON.stringify(override));
    assert.equal(plan.counts.stock, 4);
    assert.deepEqual(plan.rules.filter(rule => rule.action.type === 'allow')
        .map(rule => rule.priority), [ 29 ]);
}
// No stock rule installed: no stock allow.
{
    const plan = planStrictBlockSessionRules({ ...baseInput(), stock: [],
        excludedHostnames: [ 'w.test' ] });
    assert.deepEqual(plan.rules.filter(rule => rule.action.type === 'allow')
        .map(rule => rule.priority), [ 1000010, 1000040, 10, 40 ]);
}

// Legacy regexSubstitution shape (Firefox builds): the fragment carries the
// URL, exclusions are enforced by the allow at 29 as before.
{
    const plan = planStrictBlockSessionRules({ ...baseInput(), flavor: 'firefox',
        stock: [ { rulesetId: 'ublock-filters', rules: structuredClone(legacyRules) } ],
        excludedHostnames: [ 'legacy.test' ] });
    checkIds(plan);
    assert.equal(plan.rules.length, 3);
    for ( const rule of plan.rules.slice(0, 2) ) {
        assert.deepEqual(rule.action, { type: 'redirect',
            redirect: { regexSubstitution: `${pageURL}#\\0` } });
        assert.equal(rule.priority, 29);
        assert.equal(rule.condition.excludedRequestDomains, undefined);
    }
    assert.deepEqual(plan.rules[1].condition.requestDomains, [ 'legacy2.test' ]);
    assert.deepEqual(plan.rules[2], { id: 3, action: { type: 'allow' },
        condition: { requestDomains: [ 'legacy.test' ], resourceTypes: [ 'main_frame' ] },
        priority: 29 });
    assert.deepEqual(plan.owners, [ [ 1, 2, 'stock:ublock-filters', 'redirect', [ 1, 2 ] ],
        [ 3, 3, 'stock', 'allow' ] ]);
    assert.equal(plan.counts.regex, 2);
    // Without the page URL the legacy shape cannot be built.
    const broken = planStrictBlockSessionRules({ ...baseInput(), flavor: 'firefox',
        extensionPageURL: undefined,
        stock: [ { rulesetId: 'ublock-filters', rules: structuredClone(legacyRules) } ] });
    assert.equal(broken.rules.length, 0);
    assert.equal(broken.dropped.stockMalformed, 2);
}

// Malformed stored entries are never installed.
{
    const plan = planStrictBlockSessionRules({ ...baseInput(),
        stock: [ { rulesetId: 'x', rules: [ { action: { type: 'block' }, condition: {} },
            { action: { type: 'redirect', redirect: { url: 'https://evil.test/' } }, condition: {} },
            null ] }, { rulesetId: 42, rules: stockRules }, { rulesetId: 'y', rules: null } ],
        user: [ { realm: 'imported', rules: [ runtimeRules[0], { action: { type: 'redirect' } } ] },
            { realm: 'other', rules: userTemplates } ] });
    assert.equal(plan.rules.length, 0);
    assert.equal(plan.dropped.stockMalformed, 3);
    assert.equal(plan.dropped.userMalformed, 2);
    // A stored template can only ever redirect documents to the page.
    const forged = structuredClone(userTemplates[0]);
    forged.action.redirect = { url: 'https://evil.test/' };
    forged.condition.resourceTypes = [ 'script', 'main_frame' ];
    forged._sourceKeys = [ 'x' ];
    const safe = planStrictBlockSessionRules({ ...baseInput(), stock: [],
        user: [ { realm: 'imported', rules: [ forged ] } ] });
    assert.deepEqual(safe.rules[0].action, { type: 'redirect',
        redirect: { extensionPath: '/strictblock.html' } });
    assert.deepEqual(safe.rules[0].condition.resourceTypes, [ 'main_frame' ]);
    assert.equal(hasPrivate(safe.rules), false);
}

// Budgets: stock is dropped from the end first, user last; an exclusion
// allow is reserved with the first redirect that needs it.
{
    const plan = planStrictBlockSessionRules({ ...baseInput(), sessionRuleBudget: 10 });
    checkIds(plan);
    assert.equal(plan.counts.sandbox + plan.counts.imported, 8);
    assert.equal(plan.counts.stock, 2);
    assert.deepEqual(plan.dropped, { stockSessionLimit: 2, stockRegexPool: 0,
        userSessionLimit: 0, userRegexPool: 0, stockMalformed: 0, userMalformed: 0 });
    assert.deepEqual(plan.owners.at(-1).slice(0, 5), [ 9, 10, 'stock:ublock-badware', 'redirect', [ 1, 2 ] ]);
}
{
    const plan = planStrictBlockSessionRules({ ...baseInput(), sessionRuleBudget: 5 });
    assert.equal(plan.counts.sandbox, 2);
    assert.equal(plan.counts.imported, 3);
    assert.equal(plan.dropped.userSessionLimit, 3);
    assert.equal(plan.dropped.stockSessionLimit, 4);
    assert.equal(planStrictBlockSessionRules({ ...baseInput(), sessionRuleBudget: 0 }).rules.length, 0);
    assert.equal(planStrictBlockSessionRules({ ...baseInput(), sessionRuleBudget: -3 }).rules.length, 0);
}
{
    // One regex slot: the user regex keeps it, the stock regex is dropped and
    // the stock rules after it still fit.
    const plan = planStrictBlockSessionRules({ ...baseInput(), regexRuleBudget: 1 });
    checkIds(plan);
    assert.equal(plan.counts.regex, 1);
    assert.deepEqual(plan.dropped, { stockSessionLimit: 0, stockRegexPool: 1,
        userSessionLimit: 0, userRegexPool: 0, stockMalformed: 0, userMalformed: 0 });
    assert.equal(plan.counts.stock, 3);
    assert.ok(plan.rules.find(hasDomain('s.test')));
    const none = planStrictBlockSessionRules({ ...baseInput(), regexRuleBudget: 0 });
    assert.equal(none.counts.regex, 0);
    assert.deepEqual([ none.dropped.userRegexPool, none.dropped.stockRegexPool ], [ 1, 1 ]);
}
{
    // With exclusions a lone user redirect needs two slots.
    const input = { ...baseInput(), stock: [],
        user: [ { realm: 'imported', rules: userTemplates.slice(0, 1) } ],
        excludedHostnames: [ 'w.test' ] };
    assert.equal(planStrictBlockSessionRules({ ...input, sessionRuleBudget: 1 }).rules.length, 0);
    assert.equal(planStrictBlockSessionRules({ ...input, sessionRuleBudget: 1 }).dropped.userSessionLimit, 1);
    assert.deepEqual(planStrictBlockSessionRules({ ...input, sessionRuleBudget: 2 }).rules
        .map(rule => rule.action.type), [ 'redirect', 'allow' ]);
    // Stock: the allow is reserved with the first stock redirect.
    const stockOnly = planStrictBlockSessionRules({ ...baseInput(), user: [],
        excludedHostnames: [ 'w.test' ], sessionRuleBudget: 3 });
    assert.deepEqual(stockOnly.rules.map(rule => rule.action.type), [ 'redirect', 'redirect', 'allow' ]);
    assert.equal(stockOnly.dropped.stockSessionLimit, 2);
}
{
    // Missing budgets mean "not limited here"; IDs stay in the owned range.
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1,
        action: { type: 'redirect', redirect: { extensionPath: '/strictblock.html' } },
        condition: { requestDomains: [ `h${i}.test` ], resourceTypes: [ 'main_frame' ] },
        priority: 29 }));
    const plan = planStrictBlockSessionRules({ ...baseInput(), user: [],
        stock: [ { rulesetId: 'a', rules: many.slice(0, 1500) },
            { rulesetId: 'b', rules: many.slice(1500) } ],
        sessionRuleBudget: undefined, regexRuleBudget: Number.NaN });
    checkIds(plan);
    assert.equal(plan.rules.length, 3000);
    assert.deepEqual(plan.owners.map(owner => owner.slice(0, 3)),
        [ [ 1, 1500, 'stock:a' ], [ 1501, 3000, 'stock:b' ] ]);
    assert.deepEqual(ownerForRuleId(plan.owners, 1501), { kind: 'stock', rulesetId: 'b', source: 1501 });
    assert.ok(plan.rules.at(-1).id < STRICTBLOCK_SESSION_ID_LIMIT);
}

/******************************************************************************/

// Precedence, with a model of Chrome's rule selection for main-frame requests:
// highest priority wins; at equal priority allow > allowAllRequests > block >
// upgradeScheme > redirect (measured in report-1790237869236.json).
{
    const within = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);
    const rank = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1 };
    const decide = (rules, hostname) => {
        const matched = rules.filter(({ condition: c }) => {
            assert.equal(c.urlFilter ?? c.regexFilter, undefined, 'model covers domains only');
            if ( c.resourceTypes && c.resourceTypes.includes('main_frame') === false ) { return false; }
            if ( c.requestDomains && c.requestDomains.some(d => within(hostname, d)) === false ) { return false; }
            return c.excludedRequestDomains?.some(d => within(hostname, d)) !== true;
        }).sort((a, b) => b.priority - a.priority || rank[b.action.type] - rank[a.action.type]);
        return matched[0]?.action.type ?? 'load';
    };
    const docBlock = (hostname, priority) => ({ action: { type: 'block' },
        condition: { requestDomains: [ hostname ], resourceTypes: [ 'main_frame' ] }, priority });
    const imported = [ docBlock('x.test', 10), docBlock('z.test', 10),
        { action: { type: 'allow' }, condition: { requestDomains: [ 'z.test' ],
            resourceTypes: [ 'main_frame' ] }, priority: 30 },
        docBlock('imp.test', 40) ];
    const sandbox = [ docBlock('y.test', 10), docBlock('z.test', 10) ];
    // Installed dynamic rules: My filters are offset by USER_RULES_PRIORITY.
    const dynamic = [ ...imported, ...sandbox.map(rule => ({ ...rule,
        priority: rule.priority + USER_RULES_PRIORITY })) ];
    // Static stock rules: a main_frame block which is not a strict-block
    // candidate (for example with requestMethods), plus a hostname filter.
    const stockStatic = [ docBlock('w.test', 10) ];
    const stockSession = foldStockStrictBlockRules([ { action: { type: 'block' },
        condition: { requestDomains: [ 'w.test', 'q.test' ] } } ]);
    const plan = excludedHostnames => planStrictBlockSessionRules({ ...baseInput(),
        stock: [ { rulesetId: 'ublock-badware', rules: stockSession } ],
        user: [ { realm: 'imported', rules: deriveUserStrictBlockRules(imported) },
            { realm: 'sandbox', rules: deriveUserStrictBlockRules(sandbox) } ],
        excludedHostnames });
    const all = excludedHostnames => [ ...dynamic, ...stockStatic, ...plan(excludedHostnames).rules ];

    const none = all([]);
    assert.equal(decide(none, 'x.test'), 'redirect', 'imported $doc shows the page');
    assert.equal(decide(none, 'sub.x.test'), 'redirect');
    assert.equal(decide(none, 'imp.test'), 'redirect', 'important $doc too');
    assert.equal(decide(none, 'y.test'), 'redirect', 'My filters $doc shows the page');
    assert.equal(decide(none, 'z.test'), 'redirect', 'My filters outrank imported exceptions');
    assert.equal(decide(none, 'w.test'), 'redirect');
    assert.equal(decide(none, 'q.test'), 'redirect');
    assert.equal(decide(none, 'other.test'), 'load');
    // An exception in the same list still wins over its redirect.
    assert.equal(decide([ ...imported, ...plan([]).rules.filter(rule =>
        rule.priority < USER_RULES_PRIORITY && rule.priority !== 29) ], 'z.test'), 'allow');

    // Proceed / Don't warn: the excluded document loads, whichever rule kind
    // blocked it; other sites are still strict-blocked.
    const excluded = all([ 'x.test', 'imp.test', 'y.test', 'w.test' ]);
    for ( const hostname of [ 'x.test', 'sub.x.test', 'imp.test', 'y.test', 'w.test' ] ) {
        assert.equal(decide(excluded, hostname), 'allow', hostname);
    }
    assert.equal(decide(excluded, 'q.test'), 'redirect');
    assert.equal(decide(excluded, 'z.test'), 'redirect');

    // Host access withheld or strict mode off: the dynamic blocks remain.
    const fallback = [ ...dynamic, ...stockStatic, ...planStrictBlockSessionRules({
        ...baseInput(), hasOmnipotence: false }).rules ];
    assert.equal(decide(fallback, 'x.test'), 'block');
    assert.equal(decide(fallback, 'y.test'), 'block');
    // A redirect at the block's own priority would lose to it.
    assert.equal(decide([ docBlock('x.test', 10), { ...deriveUserStrictBlockRules(
        [ docBlock('x.test', 10) ])[0], id: undefined } ], 'x.test'), 'block');
}

console.log('strictblock-rules: all tests passed');
