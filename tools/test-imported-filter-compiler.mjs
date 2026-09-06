/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectStockBadfilterRules } from '../platform/mv3/extension/js/stock-badfilter.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ublock-plus-filter-compiler-')
);

try {
    const jsRoot = path.join(temporaryRoot, 'js');
    const libRoot = path.join(temporaryRoot, 'lib');
    await Promise.all([
        fs.mkdir(jsRoot, { recursive: true }),
        fs.mkdir(libRoot, { recursive: true }),
    ]);
    await Promise.all([
        [
            'platform/mv3/extension/js/ubo-parser.js',
            'js/ubo-parser.js',
        ],
        [
            'platform/mv3/extension/js/compiled-popup-matcher.js',
            'js/compiled-popup-matcher.js',
        ],
        [ 'src/js/static-filtering-parser.js', 'js/static-filtering-parser.js' ],
        [ 'src/js/arglist-parser.js', 'js/arglist-parser.js' ],
        [ 'src/js/jsonpath.js', 'js/jsonpath.js' ],
        [ 'src/js/redirect-resources.js', 'js/redirect-resources.js' ],
        [ 'src/lib/punycode.js', 'js/punycode.js' ],
    ].map(([ from, to ]) => fs.copyFile(
        path.join(projectRoot, from),
        path.join(temporaryRoot, to)
    )));
    await fs.cp(
        path.join(projectRoot, 'src/lib/csstree'),
        path.join(libRoot, 'csstree'),
        { recursive: true }
    );
    await fs.writeFile(
        path.join(temporaryRoot, 'package.json'),
        '{"type":"module"}\n'
    );

    const parserModule = await import(pathToFileURL(
        path.join(jsRoot, 'ubo-parser.js')
    ));
    const sfp = await import(pathToFileURL(
        path.join(jsRoot, 'static-filtering-parser.js')
    ));
    const {
        NetworkFilterCompiler,
        attachStockBadfilterResiduals,
        minimizeRules,
        minimizeRuleset,
        networkFilterIdentities,
        resolveNetworkBadfilters,
        validateRule,
        validateRules,
    } = parserModule;

    const hostnameProperties = [
        'requestDomains',
        'excludedRequestDomains',
        'initiatorDomains',
        'excludedInitiatorDomains',
    ];
    const reasonForProperty = new Map(hostnameProperties.map(prop => [
        prop,
        `entity-only-${prop.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`,
    ]));

    // Native DNR domain matching covers every descendant, including a
    // grandchild whose immediate parent is absent from the hostname list.
    for ( const prop of hostnameProperties ) {
        for ( const hostnames of [
            [ 'js.users.example.test', 'example.test', 'other.test' ],
            [ 'other.test', 'example.test', 'js.users.example.test' ],
        ] ) {
            const rules = [ { action: { type: 'block' }, condition: { [prop]: hostnames } } ];
            minimizeRules(rules);
            assert.deepEqual(rules[0].condition[prop], [ 'example.test', 'other.test' ]);
            assert.deepEqual(minimizeRules(structuredClone(rules)), rules,
                'Hostname normalization must be idempotent for source residual validation');
        }
    }

    // Mixed entity/hostname lists must sanitize exactly the requested field.
    for ( const prop of hostnameProperties ) {
        const condition = {
            [prop]: [ 'tracker.*', 'example.test' ],
            domainType: 'thirdParty',
        };
        const rule = { action: { type: 'block' }, condition };
        assert.deepEqual(validateRules([ rule ]), [ rule ]);
        assert.deepEqual(condition[prop], [ 'example.test' ]);
        assert.equal(condition.domainType, 'thirdParty');
        if ( prop !== 'requestDomains' ) {
            assert.equal(condition.requestDomains, undefined);
        }
    }

    // All four lists may coexist; sanitizing one must never overwrite another.
    {
        const condition = Object.fromEntries(hostnameProperties.map(
            (prop, index) => [ prop, [ `${index}.*`, `${index}.example` ] ]
        ));
        const rule = { action: { type: 'block' }, condition };
        assert.deepEqual(validateRule(rule), { status: 'accepted' });
        hostnameProperties.forEach((prop, index) => {
            assert.deepEqual(condition[prop], [ `${index}.example` ]);
        });
    }

    // Entity-only lists reject deterministically, delete only their own field,
    // and retain unrelated diagnostic state.
    for ( const prop of hostnameProperties ) {
        const condition = {
            [prop]: [ 'tracker.*' ],
            urlFilter: 'ads',
        };
        const rule = { action: { type: 'block' }, condition };
        const rejections = [];
        assert.deepEqual(validateRules([ rule ], rejections), []);
        assert.deepEqual(rejections, [ {
            status: 'rejected',
            reasonCode: reasonForProperty.get(prop),
        } ]);
        assert.equal(condition[prop], undefined);
        assert.equal(condition.urlFilter, 'ads');
    }

    // A shared source list is not mutated in place or aliased into two rules.
    {
        const shared = [ 'tracker.*', 'example.test' ];
        const first = {
            action: { type: 'block' },
            condition: { initiatorDomains: shared },
        };
        const second = {
            action: { type: 'block' },
            condition: { excludedInitiatorDomains: shared },
        };
        validateRules([ first, second ]);
        assert.deepEqual(shared, [ 'tracker.*', 'example.test' ]);
        assert.notEqual(
            first.condition.initiatorDomains,
            second.condition.excludedInitiatorDomains
        );
    }

    assert.equal(validateRule({
        action: { type: 'block' },
        condition: {
            resourceTypes: [ 'script' ],
            excludedResourceTypes: [ 'image' ],
        },
    }).reasonCode, 'dnr-resource-types-conflict');
    assert.equal(validateRule({
        action: { type: 'block' },
        condition: {
            requestMethods: [ 'get' ],
            excludedRequestMethods: [ 'post' ],
        },
    }).reasonCode, 'dnr-request-methods-conflict');
    assert.equal(validateRule({
        action: {
            type: 'redirect',
            redirect: { regexSubstitution: 'x' },
        },
        condition: { urlFilter: 'x' },
    }).reasonCode, 'dnr-regex-substitution-without-regex-filter');

    const compile = lines => {
        const parser = new sfp.AstFilterParser({ trustedSource: true });
        const compiler = new NetworkFilterCompiler({
            listid: 'https://filters.example/list.txt',
        });
        const results = [];
        lines.forEach((line, index) => {
            parser.parse(line);
            assert.equal(parser.isNetworkFilter(), true, line);
            results.push(compiler.add(parser, index + 1));
        });
        return { ...compiler.finish(), results };
    };

    // Exact cancellation runs before merging, independent of line/list order.
    for ( const reverse of [ false, true ] ) {
        const lines = [
            '||one.example^$script', '||two.example^$script',
            '||one.example^$script,badfilter',
        ];
        const result = compile(reverse ? lines.reverse() : lines);
        assert.deepEqual(result.dnrRules.map(a => a.condition.requestDomains),
            [ [ 'two.example' ] ]);
        assert.equal(result.filterStats.rejected, 0);
        assert.equal(result.badfilterCancelledCount, 1);
        assert.equal(result.dnrRules.some(a => a.action.type === 'allow'), false);
    }
    // Aliases, option/domain ordering and first-party negation canonicalize.
    const canonical = compile([
        '||cdn.example^$stylesheet,domain=b.example|a.example,1p',
        '||cdn.example^$badfilter,~third-party,from=a.example|b.example,css',
    ]);
    assert.equal(canonical.dnrRules.length, 0, JSON.stringify([canonical.networkUnits, canonical.badfilterKeys]));
    const distinguish = compile([
        '||cdn.example^$image', '||cdn.example^$script,important',
        '||cdn.example^$script,badfilter',
    ]);
    assert.equal(distinguish.dnrRules.length, 2,
        'Different resource types and important rules must remain active');
    const exception = compile([
        '||cdn.example^$script', '@@||cdn.example^$script',
        '@@||cdn.example^$script,badfilter',
    ]);
    assert.equal(exception.dnrRules.length, 1);
    assert.equal(exception.dnrRules[0].action.type, 'block');
    const popup = compile([
        '||pop.example^$popup,popunder,script',
        '||pop.example^$script,popunder,popup,badfilter',
    ]);
    assert.equal(popup.dnrRules.length, 0);
    assert.equal(popup.popupFilters.length, 0);
    const partial = compile([
        '*$script,domain=a.example|b.example',
        '*$script,domain=a.example,badfilter',
    ]);
    assert.deepEqual(partial.dnrRules[0].condition.initiatorDomains, [ 'b.example' ]);
    const noPartial = compile([
        '||ads.example^$script,domain=a.example|b.example',
        '||ads.example^$script,domain=a.example,badfilter',
    ]);
    assert.deepEqual(noPartial.dnrRules[0].condition.initiatorDomains,
        [ 'a.example', 'b.example' ], 'Arbitrary domain lists are indivisible');
    const negatives = compile([
        '*$script,domain=a.example|~b.example',
        '*$script,domain=a.example,badfilter',
    ]);
    assert.equal(negatives.dnrRules.length, 1);
    assert.deepEqual(negatives.dnrRules[0].condition.excludedInitiatorDomains,
        [ 'b.example' ]);
    const imported = compile([ '||first.example^$image', '||second.example^$image' ]);
    const personal = compile([ '||first.example^$image,badfilter' ]);
    resolveNetworkBadfilters([ imported, personal ]);
    assert.deepEqual(imported.dnrRules.map(a => a.condition.requestDomains),
        [ [ 'second.example' ] ], 'A personal badfilter only removes its imported source');
    resolveNetworkBadfilters([ imported ]);
    assert.equal(imported.dnrRules.length, 2,
        'Removing a personal badfilter restores intact cached source units');
    const importedDisable = compile([ '||mine.example^$script,badfilter' ]);
    const myRules = compile([ '||mine.example^$script' ]);
    resolveNetworkBadfilters([ importedDisable, myRules ]);
    assert.equal(myRules.dnrRules.length, 0, 'Cross-source cancellation works both ways');
    const mergedFilters = compile([
        '||cdn.example^$script,domain=a.example',
        '||cdn.example^$script,domain=b.example',
    ]);
    resolveNetworkBadfilters([ mergedFilters,
        compile([ '||cdn.example^$script,domain=a.example,badfilter' ]) ]);
    assert.deepEqual(mergedFilters.dnrRules[0].condition.initiatorDomains, [ 'b.example' ]);
    // Similar DNR projections must not erase distinct source predicates.
    const lossy = compile([
        '||ads.example^$script,domain=a.example|tracker.*',
        '||ads.example^$script,domain=a.example,badfilter',
    ]);
    assert.equal(lossy.dnrRules.length, 1);
    const regex = compile([
        '/badfilter,ad[0-9]+/$script',
        '/badfilter,ad[0-9]+/$script,badfilter',
    ]);
    assert.equal(regex.dnrRules.length, 0,
        'The badfilter token is read from the AST, never stripped from regex text');

    // Exercise the full upstream stock compiler, which merges hostnames before
    // the MV3 minimizer. Both stages must retain every original identity.
    const stockCompiler = await import(pathToFileURL(
        path.join(projectRoot, 'src/js/static-dnr-filtering.js')
    ));
    const stockLines = [ '||source-one.test^$script', '||source-two.test^$script' ];
    const stock = await stockCompiler.dnrRulesetFromRawLists([
        { name: 'provenance', text: stockLines.join('\n') },
    ], { networkSourceIdentity: networkFilterIdentities });
    const stockRules = minimizeRuleset(stock.network.ruleset);
    assert.equal(stockRules.length, 1);
    assert.deepEqual(stockRules[0]._sourceKeys.slice().sort(),
        compile(stockLines).networkUnits.map(unit => unit.key).sort());
    assert.equal(stockRules[0]._sourceIncomplete, undefined);
    const stockCancellation = await stockCompiler.dnrRulesetFromRawLists([
        { name: 'provenance', text: [ ...stockLines,
            '||source-one.test^$script,badfilter' ].join('\n') },
    ], { networkSourceIdentity: networkFilterIdentities });
    assert.deepEqual(stockCancellation.network.ruleset[0].condition.requestDomains,
        [ 'source-two.test' ]);
    assert.deepEqual(stockCancellation.networkBadfilterKeys,
        compile([ '||source-one.test^$script,badfilter' ]).badfilterKeys);
    const stockDomains = await stockCompiler.dnrRulesetFromRawLists([
        { name: 'domains', text: '*$script,domain=a.example|b.example' },
    ], { networkSourceIdentity: networkFilterIdentities });
    assert.deepEqual(stockDomains.network.ruleset[0]._sourceKeys.slice().sort(),
        compile([ '*$script,domain=a.example|b.example' ]).networkUnits
            .map(unit => unit.key).sort());
    const nativeRule = structuredClone(stockRules[0]);
    delete nativeRule._sourceKeys;
    delete nativeRule._sourceIncomplete;
    nativeRule.condition.requestDomains = [ 'native.test' ];
    const mixedProvenance = minimizeRuleset([
        ...structuredClone(stockRules), nativeRule,
    ]);
    assert.equal(mixedProvenance[0]._sourceIncomplete, true,
        'Unmapped native DNR contributions make the entire merged rule ineligible');
    const residualLines = [ '||residual-a.test^$script', '||residual-b.test^$script',
        '||residual-a.test^$image' ];
    const digest = text => createHash('sha256').update(text).digest('hex');
    const residualStock = await stockCompiler.dnrRulesetFromRawLists([
        { name: 'residual', text: residualLines.join('\n') },
    ], { networkSourceIdentity: parser => networkFilterIdentities(parser)
        .map(identity => ({ ...identity, key: digest(identity.key) })) });
    attachStockBadfilterResiduals(residualStock.network.ruleset);
    const residualNative = minimizeRuleset(residualStock.network.ruleset);
    const residualPlan = selectStockBadfilterRules([ {
        id: 'stock', digest: digest('stock'), deferredKeys: [],
        rules: residualNative.map((rule, i) => ({ id: i + 1, complete: !rule._sourceIncomplete,
            keys: rule._sourceKeys, residual: rule._sourceResidualGroups })),
    } ], new Set([ digest(compile([ residualLines[0] ]).networkUnits[0].key) ]));
    assert.equal(residualPlan.status.deferredSourceCount, 0);
    assert.equal(residualPlan.selected.stock.ids.length, 1);
    assert.equal(residualPlan.residualRules.length, 1);
    assert.deepEqual(residualPlan.residualRules[0].condition.requestDomains, [ 'residual-b.test' ]);
    assert.deepEqual(residualPlan.residualRules[0].condition.resourceTypes, [ 'script' ]);

    const unsupported = [
        [ '@@||two.example^$cname', 'unsupported-cname' ],
        [ '||three.example^$replace=/old/new/', 'unsupported-replace' ],
        [
            '||four.example^$responseheader=set-cookie:/value/',
            'unsupported-response-header-regex',
        ],
        [ '*$removeparam=/^utm_/', 'unsupported-removeparam-regex' ],
        [ '*$removeparam=~utm_source', 'unsupported-removeparam-negated' ],
        [ '||five.example^$redirect=unknown-resource',
            'unsupported-redirect-resource' ],
        [ '||six.example^$domain=bad*domain', 'invalid-from-domain-list' ],
    ];
    const rejected = compile(unsupported.map(a => a[0]));
    assert.deepEqual(rejected.filterStats, {
        total: unsupported.length,
        accepted: 0,
        rejected: unsupported.length,
        routed: 0,
        deferred: 0,
    });
    assert.deepEqual(rejected.rejections, unsupported.map((entry, index) => ({
        status: 'rejected',
        reasonCode: entry[1],
        lineNumber: index + 1,
    })));
    assert.equal(
        rejected.filterStats.total,
        rejected.filterStats.accepted + rejected.filterStats.rejected
    );

    const routed = compile([
        '||ads.example^$popup,domain=site.example|~excluded.example',
        '@@||allowed.example^$popunder',
        '||combined.example^$popup,script',
        '||all-types.example^$popup,all',
        '||party.example^$1p,popup',
        '||combined-party.example^$1p,popup,script',
        '||cdn.example^$script',
    ]);
    assert.deepEqual(routed.filterStats, {
        total: 7,
        accepted: 6,
        rejected: 1,
        routed: 6,
        deferred: 2,
    });
    assert.deepEqual(routed.results, [
        ...[ 1, 2, 3, 4 ].map(lineNumber => ({
            status: 'accepted',
            classification: 'popup-runtime',
            lineNumber,
        })),
        ...[ 5, 6 ].map(lineNumber => ({
            status: 'deferred',
            reasonCode: 'unsupported-domain-type',
            classification: 'popup-compiler-required',
            disposition: 'deferred',
            lineNumber,
        })),
        {
            status: 'accepted',
            classification: 'dnr',
            lineNumber: 7,
        },
    ]);
    assert.deepEqual(routed.rejections, [ 5, 6 ].map(lineNumber => ({
        status: 'deferred',
        reasonCode: 'unsupported-domain-type',
        classification: 'popup-compiler-required',
        disposition: 'deferred',
        lineNumber,
    })));
    assert.equal(routed.popupFilters.length, 6);
    assert.deepEqual(routed.popupFilters.map(a => ({
        routeCode: a.routeCode,
        kind: a.kind,
        action: a.action,
        lineNumber: a.lineNumber,
    })), [
        {
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            lineNumber: 1,
        },
        {
            routeCode: 'popup-observer-runtime',
            kind: 'popunder',
            action: 'allow',
            lineNumber: 2,
        },
        {
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            lineNumber: 3,
        },
        {
            routeCode: 'popup-observer-runtime',
            kind: 'popup',
            action: 'block',
            lineNumber: 4,
        },
        {
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            lineNumber: 5,
        },
        {
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            lineNumber: 6,
        },
    ]);
    assert.deepEqual(routed.popupFilters[0].condition.initiatorDomains,
        [ 'site.example' ]);
    assert.deepEqual(routed.popupFilters[0].condition.excludedInitiatorDomains,
        [ 'excluded.example' ]);
    assert.equal(routed.popupFilters[0].condition.domainType, undefined);
    assert.equal(routed.popupFilters[4].condition.domainType, 'firstParty');
    assert.equal(routed.dnrRules.length, 3);
    const scriptRule = routed.dnrRules.find(rule =>
        rule.condition.resourceTypes?.length === 1 &&
        rule.condition.resourceTypes[0] === 'script' &&
        rule.condition.domainType === undefined
    );
    assert.deepEqual(scriptRule.condition.requestDomains, [
        'cdn.example',
        'combined.example',
    ]);
    const firstPartyScriptRule = routed.dnrRules.find(rule =>
        rule.condition.resourceTypes?.length === 1 &&
        rule.condition.resourceTypes[0] === 'script' &&
        rule.condition.domainType === 'firstParty'
    );
    assert.deepEqual(firstPartyScriptRule.condition.requestDomains, [
        'combined-party.example',
    ]);
    const allTypesRule = routed.dnrRules.find(rule =>
        rule.condition.requestDomains?.includes('all-types.example')
    );
    assert.equal(allTypesRule.condition.resourceTypes.length > 1, true);
    assert.equal(JSON.stringify(routed.dnrRules).includes('""'), false);

    console.log('Imported-filter compiler tests passed');
} finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
