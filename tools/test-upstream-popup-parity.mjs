/* uBlock Plus+ — upstream issue-driven compiler comparison. GPL-3.0-or-later. */
import {
    classifyPopupCondition, evaluateCompiledPopupFilters,
} from '../platform/mv3/extension/js/compiled-popup-matcher.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { makeStockPopupCorpus } from '../platform/mv3/popup-corpus.js';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-upstream-parity-'));
try {
    const origin = 'https://opener.test/page';
    const cases = [
        // uBOL#745: preserve to= on URL patterns, including excluded targets.
        {
            raw: '/popup$popup,to=ads.test|~safe.ads.test',
            urls: [ 'https://ads.test/popup', 'https://sub.ads.test/popup',
                'https://safe.ads.test/popup', 'https://other.test/popup',
                'https://ads.test/ordinary' ],
            expected: [ 'block', 'block', 'none', 'none', 'none' ],
        },
        // uAssets#33581: exclusion survives combined target-only rules.
        {
            raw: '*$popup,to=ads.test|tracker.test|~safe.ads.test',
            urls: [ 'https://ads.test/', 'https://tracker.test/',
                'https://safe.ads.test/', 'https://other.test/' ],
            expected: [ 'block', 'block', 'none', 'none' ],
        },
        {
            raw: '||ads.test^$popup\n@@||ads.test/safe$popup',
            urls: [ 'https://ads.test/popup', 'https://ads.test/safe' ],
            expected: [ 'block', 'allow' ],
        },
        {
            raw: '||ads.test^$popup,important\n@@||ads.test^$popup',
            urls: [ 'https://ads.test/popup' ], expected: [ 'block' ],
        },
        {
            raw: '/popup$popup,from=opener.test|~excluded.opener.test',
            urls: [ 'https://ads.test/popup', 'https://ads.test/ordinary',
                'https://ads.test/popup', 'https://ads.test/popup' ],
            origins: [ origin, origin, 'https://other.test/', 'https://excluded.opener.test/' ],
            expected: [ 'block', 'none', 'none', 'none' ],
        },
    ];
    let comparisons = 0;
    for ( const [ fixtureIndex, fixture ] of cases.entries() ) {
        // The upstream engine uses module singletons. Give every independent
        // list a fresh engine and trie/string caches, like a fresh installation.
        const fixtureRoot = path.join(temporary, `${fixtureIndex}`);
        await fs.mkdir(fixtureRoot);
        await Promise.all([
            fs.cp(path.join(root, 'src/js'), path.join(fixtureRoot, 'js'), { recursive: true }),
            fs.cp(path.join(root, 'src/lib'), path.join(fixtureRoot, 'lib'), { recursive: true }),
            fs.copyFile(path.join(root, 'platform/nodejs/index.js'), path.join(fixtureRoot, 'index.js')),
            fs.writeFile(path.join(fixtureRoot, 'package.json'), '{"type":"module"}\n'),
        ]);
        const moduleURL = name => pathToFileURL(path.join(fixtureRoot, name));
        const { StaticNetFilteringEngine, pslInit } = await import(moduleURL('index.js'));
        pslInit('com\norg\nnet\ntest\n');
        const engine = await StaticNetFilteringEngine.create({ noPSL: true });
        const { dnrRulesetFromRawLists } = await import(moduleURL('js/static-dnr-filtering.js'));
        const { default: upstreamEngine } = await import(moduleURL('js/static-net-filtering.js'));
        const { FilteringContext } = await import(moduleURL('js/filtering-context.js'));
        const lists = [ { name: 'regression', text: fixture.raw, raw: fixture.raw } ];
        const output = await dnrRulesetFromRawLists(lists);
        assert.equal(output.network.ruleset.some(rule => rule._error), false);
        const popupRules = output.network.ruleset.filter(rule =>
            rule.condition?.resourceTypes?.includes('popup')
        ).map(rule => {
            const copy = structuredClone(rule);
            delete copy.condition.resourceTypes;
            return copy;
        });
        assert.ok(popupRules.length > 0, fixture.raw);
        const corpus = makeStockPopupCorpus('regression', popupRules, classifyPopupCondition);
        assert.equal(corpus.stats.deferred, 0);
        await engine.useLists([ { name: 'regression', raw: fixture.raw } ]);
        for ( const [ index, url ] of fixture.urls.entries() ) {
            const requestOrigin = fixture.origins?.[index] ?? origin;
            const request = new FilteringContext().setURL(url).setType('popup')
                .setDocOriginFromURL(requestOrigin).setTabOriginFromURL(requestOrigin);
            const upstream = [ 'none', 'block', 'allow' ][upstreamEngine.matchRequest(request)];
            const actual = evaluateCompiledPopupFilters([ {
                id: 'stock', filters: corpus.filters,
            } ], {
                kind: 'popup', targetURL: url, initiatorURL: requestOrigin,
                topURL: requestOrigin, initiatorContextComplete: true, filteringMode: 2,
            }).action;
            assert.equal(upstream, fixture.expected[index], `${fixture.raw}: upstream ${url}`);
            assert.equal(actual, upstream, `${fixture.raw}: MV3 ${url}`);
            comparisons += 1;
        }
        await StaticNetFilteringEngine.release();
    }
    console.log(`Upstream popup compiler parity passed (${comparisons} request comparisons)`);
} finally {
    await fs.rm(temporary, { recursive: true, force: true });
}
