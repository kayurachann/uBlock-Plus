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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
        lines.forEach((line, index) => {
            parser.parse(line);
            assert.equal(parser.isNetworkFilter(), true, line);
            compiler.add(parser, index + 1);
        });
        return compiler.finish();
    };

    const unsupported = [
        [ '||one.example^$badfilter', 'unsupported-badfilter' ],
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
        '||cdn.example^$script',
    ]);
    assert.deepEqual(routed.filterStats, {
        total: 5,
        accepted: 3,
        rejected: 2,
        routed: 4,
        deferred: 4,
    });
    assert.deepEqual(routed.rejections, [ 1, 2, 3, 4 ].map(lineNumber => ({
        status: 'deferred',
        reasonCode: 'popup-runtime-consumer-required',
        classification: 'popup-compiler-required',
        disposition: 'deferred',
        lineNumber,
    })));
    assert.equal(routed.popupFilters.length, 4);
    assert.deepEqual(routed.popupFilters.map(a => ({
        routeCode: a.routeCode,
        kind: a.kind,
        action: a.action,
        lineNumber: a.lineNumber,
    })), [
        {
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            lineNumber: 1,
        },
        {
            routeCode: 'popup-compiler-required',
            kind: 'popunder',
            action: 'allow',
            lineNumber: 2,
        },
        {
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            lineNumber: 3,
        },
        {
            routeCode: 'popup-compiler-required',
            kind: 'popup',
            action: 'block',
            lineNumber: 4,
        },
    ]);
    assert.deepEqual(routed.popupFilters[0].condition.initiatorDomains,
        [ 'site.example' ]);
    assert.deepEqual(routed.popupFilters[0].condition.excludedInitiatorDomains,
        [ 'excluded.example' ]);
    assert.equal(routed.dnrRules.length, 2);
    const scriptRule = routed.dnrRules.find(rule =>
        rule.condition.resourceTypes?.length === 1 &&
        rule.condition.resourceTypes[0] === 'script'
    );
    assert.deepEqual(scriptRule.condition.requestDomains, [
        'cdn.example',
        'combined.example',
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
