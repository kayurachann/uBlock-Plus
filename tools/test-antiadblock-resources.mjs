/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { dnrRulesetFromRawLists } from '../src/js/static-dnr-filtering.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import redirectResources from '../src/js/redirect-resources.js';
import vm from 'node:vm';

// These names are explicitly paired by AdGuard's redirect compatibility table:
// https://github.com/AdguardTeam/Scriptlets/blob/ceff76181358797f9ffa0c9af6640a17f7950a20/wiki/compatibility-table.md#redirects
// We reuse the full uBO resource, including its MIME-bearing file extension.
const aliases = [
    [ 'amazon-apstag', 'amazon_apstag.js', 'script' ],
    [ 'google-analytics', 'google-analytics_analytics.js', 'script' ],
    [ 'google-ima3-dai', 'google-ima-dai.js', 'script' ],
    [ 'noopcss', 'noop.css', 'stylesheet' ],
    [ 'prebid-ads', 'prebid-ads.js', 'script' ],
    [ 'prevent-fab-3.2.0', 'nofab.js', 'script' ],
];
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, 'ublock-plus-antiadblock-resources-')
);
let checks = 0;

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
    const sfp = await import(pathToFileURL(
        path.join(temporaryRoot, 'js/static-filtering-parser.js')
    ));
    const { NetworkFilterCompiler } = await import(pathToFileURL(
        path.join(temporaryRoot, 'js/ubo-parser.js')
    ));
    const compile = (lines, trustedSource = false) => {
        const parser = new sfp.AstFilterParser({ trustedSource });
        const compiler = new NetworkFilterCompiler({ listid: 'antiadblock-test' });
        const results = lines.map((line, index) => {
            parser.parse(line);
            return compiler.add(parser, index + 1);
        });
        return { ...compiler.finish(), results };
    };
    const filter = (token, type, suffix = '') =>
        `||ads.fixture.test/bait$${type},3p,domain=reader.fixture.test|~off.reader.fixture.test,redirect=${token}${suffix}`;
    const sourceCodes = new Map();

    for ( const [ alias, canonical, type ] of aliases ) {
        const metadata = redirectResources.get(canonical);
        assert.ok(metadata);
        const names = typeof metadata.alias === 'string'
            ? [ metadata.alias ] : metadata.alias;
        assert.ok(names.includes(alias), alias);
        const filename = path.join(projectRoot, 'src/web_accessible_resources', canonical);
        const bytes = await fs.readFile(filename);
        sourceCodes.set(canonical, bytes.toString());
        for ( const trustedSource of [ false, true ] ) {
            for ( const suffix of [ '', ':3', ',important' ] ) {
                const actual = compile([ filter(alias, type, suffix) ], trustedSource);
                const expected = compile([ filter(canonical, type, suffix) ], trustedSource);
                assert.equal(actual.dnrRules.length, 1, alias);
                assert.equal(actual.filterStats.rejected, 0, alias);
                assert.deepEqual(actual.dnrRules, expected.dnrRules, alias);
                const { action, condition, priority } = actual.dnrRules[0];
                assert.deepEqual(action, {
                    type: 'redirect',
                    redirect: { extensionPath: `/web_accessible_resources/${canonical}` },
                });
                assert.deepEqual(condition.resourceTypes, [ type ]);
                assert.equal(condition.domainType, 'thirdParty');
                assert.deepEqual(condition.initiatorDomains, [ 'reader.fixture.test' ]);
                assert.deepEqual(condition.excludedInitiatorDomains, [ 'off.reader.fixture.test' ]);
                assert.equal(priority, suffix === ',important' ? 41 : suffix === ':3' ? 14 : 11);
                const loadedBytes = await fs.readFile(path.join(projectRoot, 'src', action.redirect.extensionPath));
                assert.deepEqual(loadedBytes, bytes, 'Aliases load the canonical resource without a generated payload');
                checks += 1;
            }
        }
        const cancelled = compile([ filter(alias, type), filter(alias, type, ',badfilter') ]);
        assert.equal(cancelled.dnrRules.length, 0, 'Exact badfilter cancellation is preserved');
        const withAllow = compile([
            filter(alias, type),
            '@@||ads.fixture.test/bait$domain=reader.fixture.test',
        ]);
        const allow = withAllow.dnrRules.find(rule => rule.action.type === 'allow');
        const redirect = withAllow.dnrRules.find(rule => rule.action.type === 'redirect');
        assert.ok(allow.priority > redirect.priority, 'An ordinary exception keeps precedence');
        checks += 2;
    }

    // Unsupported conditional redirects must not turn into unconditional ones.
    for ( const [ alias, , type ] of aliases ) {
        const result = compile([ filter(alias, type).replace('redirect=', 'redirect-rule=') ]);
        assert.equal(result.dnrRules.length, 0);
        assert.equal(result.results[0].reasonCode, 'unsupported-redirect-rule');
        checks += 1;
    }
    // Trusted scriptlets, arbitrary code and paths do not become redirect assets.
    for ( const token of [
        'missing-antiblock', 'trusted-set-constant', 'trusted-replace-node-text.js',
        '../js/background.js', '/web_accessible_resources/nofab.js',
        'https://example.test/remote.js', 'data:text/javascript;alert(1)',
        'prevent-fab-3.2.0.js', 'NOOPCSS',
    ] ) {
        for ( const trustedSource of [ false, true ] ) {
            const result = compile([ filter(token, 'script') ], trustedSource);
            assert.equal(result.dnrRules.length, 0, token);
            assert.equal(result.results[0].status, 'rejected', token);
            checks += 1;
        }
    }

    // Exercise the established APIs without permitting any network operation.
    const runResource = canonical => {
        const context = vm.createContext({
            console: { log: error => { throw error; }, trace: error => { throw error; } },
            fetch: () => { throw new Error('Redirect resource attempted a network request'); },
            XMLHttpRequest: class { constructor() { throw new Error('Unexpected XHR'); } },
            setTimeout: callback => { callback(); return 1; },
        });
        vm.runInContext('this.window = this;', context);
        vm.runInContext(sourceCodes.get(canonical), context, { filename: canonical });
        return expression => vm.runInContext(expression, context);
    };
    const fab = runResource('nofab.js');
    assert.equal(fab(`(() => {
        let safe = 0, detected = 0;
        const detector = new window.FuckAdBlock();
        detector.onNotDetected(() => safe++).onDetected(() => detected++);
        window.blockAdBlock.on(false, () => safe++);
        return safe === 2 && detected === 0 && typeof window.SniffAdBlock === 'function';
    })()`), true);
    const prebid = runResource('prebid-ads.js');
    assert.equal(prebid('window.canRunAds === true && window.isAdBlockActive === false'), true);
    const amazon = runResource('amazon_apstag.js');
    assert.equal(amazon(`(() => {
        let bids;
        window.apstag.fetchBids({}, value => { bids = value; });
        return Array.isArray(bids) && bids.length === 0 && typeof window.apstag.init === 'function';
    })()`), true);
    const analytics = runResource('google-analytics_analytics.js');
    assert.equal(analytics(`(() => {
        let callbacks = 0;
        window.ga('send', { hitCallback: () => callbacks++ });
        return callbacks === 1 && window.ga.loaded === true && typeof window.ga.create().send === 'function';
    })()`), true);
    const dai = runResource('google-ima-dai.js');
    assert.equal(dai(`typeof window.google.ima.dai.api.StreamManager === 'function' &&
        typeof window.google.ima.dai.api.VODStreamRequest === 'function'`), true);
    assert.equal(sourceCodes.get('noop.css').replace(/\/\*[\s\S]*?\*\//g, '').trim(), '');
    checks += 6;
    console.log(`Anti-adblock resource compatibility: ${checks} checks passed (6 aliases).`);

    // Chrome rejects six upstream allow regexes because of its compiled-memory
    // limit. Exercise the actual inline compatibility data, not a test-only
    // override. Only named nonempty token widths are intentionally relaxed.
    const catalog = JSON.parse(await fs.readFile(
        path.join(projectRoot, 'platform/mv3/rulesets.json'), 'utf8'
    ));
    const inline = catalog.find(entry => entry.id === 'ublock-filters').filters
        .filter(line => line.startsWith('@@/') && line.includes('pussyspace'));
    const cancellations = inline.filter(line => line.endsWith(',badfilter'));
    const originals = cancellations.map(line => line.slice(0, -10));
    const replacements = inline.filter(line => !line.endsWith(',badfilter'));
    assert.equal(originals.length, 6);
    assert.equal(replacements.length, 7);
    const originalRules = originals.map(line => {
        const result = compile([ line ]);
        assert.equal(result.dnrRules.length, 1);
        return result.dnrRules[0];
    });
    const replacementRules = compile(replacements).dnrRules;
    assert.equal(replacementRules.length, 7);
    const scope = rule => {
        const { regexFilter, ...condition } = rule.condition;
        assert.equal(typeof regexFilter, 'string');
        return { action: rule.action, priority: rule.priority, condition };
    };
    const expectedScope = {
        action: { type: 'allow' }, priority: 30,
        condition: { domainType: 'firstParty',
            initiatorDomains: [ 'pussyspace.com', 'pussyspace.net' ],
            resourceTypes: [ 'image' ] },
    };
    for ( const rule of [ ...originalRules, ...replacementRules ] ) {
        assert.deepEqual(scope(rule), expectedScope,
            'The compatibility data cannot widen party/domain/type or change case behavior');
    }
    const widthRelaxations = [
        [ '[0-9A-Za-z]{5,7}', '[0-9A-Za-z]+' ],
        [ '[-_0-9A-Za-z]{16}', '[-_0-9A-Za-z]+' ],
        [ '[0-9a-f]{32}', '[0-9a-f]+' ],
        [ '[0-9a-f]{42}', '[0-9a-f]+' ],
        [ '[_3a-z]{2,16}', '[_3a-z]+' ],
        [ '[%0-9A-Za-z]{16,32}', '[%0-9A-Za-z]+' ],
    ];
    const expectedPatterns = originalRules.flatMap(rule => {
        let pattern = rule.condition.regexFilter;
        for ( const [ from, to ] of widthRelaxations ) {
            pattern = pattern.replaceAll(from, to);
        }
        const directory = '(?:original|thumbs_\\d{2})';
        return pattern.includes(directory)
            ? [ 'original', 'thumbs_\\d{2}' ].map(value => pattern.replace(directory, value))
            : [ pattern ];
    });
    assert.deepEqual(replacementRules.map(rule => rule.condition.regexFilter).sort(),
        expectedPatterns.sort(), 'Only the documented token widths and directory split may differ');
    const originalMatchers = originalRules.map(rule => new RegExp(rule.condition.regexFilter, 'i'));
    const replacementMatchers = replacementRules.map(rule => new RegExp(rule.condition.regexFilter, 'i'));
    const preservedRules = rules => rules.map(rule => ({
        ...scope(rule), regex: rule.condition.regexFilter,
    })).sort((a, b) => a.regex.localeCompare(b.regex));
    for ( const lines of [
        [ ...originals, ...inline ], [ ...inline, ...originals ].reverse(),
    ] ) {
        const compiled = compile(lines);
        assert.equal(compiled.filterStats.rejected, 0);
        assert.deepEqual(preservedRules(compiled.dnrRules), preservedRules(replacementRules),
            'Exact originals cancel while all replacement exceptions survive');
    }
    const compileStock = async lines => (await dnrRulesetFromRawLists([
        { name: 'antiadblock-stock-test', text: lines.join('\n') },
    ], { env: [ 'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol' ] })).network.ruleset;
    assert.equal((await compileStock(originals)).length, 6);
    assert.deepEqual(preservedRules(await compileStock([ ...originals, ...inline ])),
        preservedRules(await compileStock(replacements)),
        'The actual packaged full-uBO compiler also cancels exactly the six originals');
    for ( let index = 0; index < originals.length; index++ ) {
        assert.equal(compile([ originals[index], cancellations[index] ]).dnrRules.length, 0);
        for ( const changed of [
            originals[index].replace('$image,1p,', '$image,3p,'),
            originals[index].replace('$image,1p,', '$stylesheet,1p,'),
            originals[index].slice(2),
        ] ) {
            assert.equal(compile([ changed, cancellations[index] ]).dnrRules.length, 1,
                'An exception badfilter cannot cancel a different scope/type/action');
        }
    }

    const paths = [];
    const alnum = length => 'Ab09cDEF23'.repeat(5).slice(0, length);
    const hex = length => 'aB09cDef23'.repeat(5).slice(0, length);
    const hash = 'AbCdEfGhIjKlMnOp';
    for ( const route of [ 'yi', 'yip', 'xvs' ] ) {
        const root = `${route}/videos/`;
        for ( const directory of [ 'original', 'thumbs_09' ] ) {
            for ( const digits of [ '', '1', '12' ] ) {
                paths.push([ false, `${root}202609/08/123456789/${directory}/${digits}.jpg` ]);
                for ( const length of [ 5, 6, 7 ] ) {
                    for ( const tail of [ '', 'aaaa' ] ) {
                        paths.push([ false, `${root}202609/08/123456789/${directory}/` +
                            `${digits}(m=e${alnum(length)}${tail})(mh=${hash})${digits}.jpg` ]);
                    }
                }
            }
        }
        for ( const tail of [ '', '-9' ] ) {
            for ( const digits of [ '1', '12' ] ) {
                paths.push([ false, `${root}thumbs169l/ab/cd/ef/${hex(32)}${tail}/${hex(32)}.${digits}.jpg` ]);
            }
        }
        for ( const digits of [ '1', '12' ] ) {
            paths.push([ false, `${root}thumbs_5/${digits}.jpg` ]);
            for ( const length of [ 5, 6, 7 ] ) {
                paths.push([ false, `${root}thumbs_5/${digits}(m=e${alnum(length)}aaaa)(mh=${hash}).jpg` ]);
            }
        }
    }
    for ( const route of [ 'jz', 'ajz' ] ) {
        for ( const depth of [ 3, 4, 5 ] ) {
            for ( const hyphen of [ '', '-' ] ) {
                for ( const tail of [ '23', '123', '.mp4-1', '.flv-2', '123-123-123-h264.mp4-12' ] ) {
                    paths.push([ false, `${route}/${'a/'.repeat(depth)}${hex(42)}${hyphen}${tail}.jpg` ]);
                }
            }
        }
    }
    for ( const length of [ 2, 3, 16 ] ) {
        paths.push([ true, `upload/cat.image/${'a_3'.repeat(6).slice(0, length)}.jpg` ]);
    }
    for ( const length of [ 16, 17, 32 ] ) {
        paths.push([ true, 'upload/poster_img_url/par/c3Rhci9' +
            `${'Ab09%ef'.repeat(5).slice(0, length)}&size_width/par/160/l.jpg` ]);
    }
    let positiveURLs = 0;
    let negativeURLs = 0;
    for ( const [ staticHost, pathname ] of paths ) {
        for ( const host of staticHost ? [ 'st' ] : [ 'a', 'z' ] ) {
            for ( const domain of [ 'com', 'net' ] ) {
                const lower = `https://${host}.pussyspace.${domain}/${pathname}`;
                for ( const url of [ lower, lower.toUpperCase() ] ) {
                    assert.ok(originalMatchers.some(re => re.test(url)), `Invalid positive fixture: ${url}`);
                    assert.ok(replacementMatchers.some(re => re.test(url)), `Lost original exception: ${url}`);
                    positiveURLs += 1;
                    for ( const invalid of [
                        url.replace(/^https:/i, 'http:'),
                        url.replace(/pussyspace\.(com|net)/i, 'unrelated.invalid'),
                        url.replace(/(https:\/\/[^/]+)\//i, '$1/wrong-prefix/'),
                        url.replace(/\.jpg$/i, '.png'),
                        `${url}?query=1`,
                    ] ) {
                        assert.equal(replacementMatchers.some(re => re.test(invalid)), false,
                            'The compatibility exception must retain its URL boundaries');
                        negativeURLs += 1;
                    }
                }
            }
        }
    }
    const relaxedWidths = [
        'a.pussyspace.com/yi/videos/202609/08/123456789/original/(m=eA)(mh=B).jpg',
        'a.pussyspace.com/yi/videos/thumbs169l/ab/cd/ef/a/b.1.jpg',
        'a.pussyspace.com/yi/videos/thumbs_5/1(m=eAaaaa)(mh=B).jpg',
        'a.pussyspace.com/jz/a/b/c/a-23.jpg',
        'st.pussyspace.com/upload/cat.image/a.jpg',
        'st.pussyspace.com/upload/poster_img_url/par/c3Rhci9A&size_width/par/160/l.jpg',
    ];
    for ( const path of relaxedWidths ) {
        const url = `https://${path}`;
        assert.equal(originalMatchers.some(re => re.test(url)), false);
        assert.equal(replacementMatchers.some(re => re.test(url)), true,
            'Shorter nonempty tokens are intentional fail-open underblocking, not exact equivalence');
    }
    for ( const path of [
        'a.pussyspace.com/yi/videos/202609/08/123456789/original/(m=e)(mh=B).jpg',
        'a.pussyspace.com/yi/videos/thumbs169l/ab/cd/ef//b.1.jpg',
        'a.pussyspace.com/yi/videos/thumbs_5/1(m=eaaaa)(mh=B).jpg',
        'a.pussyspace.com/jz/a/b/c/-23.jpg',
        'st.pussyspace.com/upload/cat.image/.jpg',
        'st.pussyspace.com/upload/poster_img_url/par/c3Rhci9&size_width/par/160/l.jpg',
    ] ) {
        assert.equal(replacementMatchers.some(re => re.test(`https://${path}`)), false,
            'Relaxed token classes must remain nonempty');
    }
    console.log(`Scoped regex compatibility: ${positiveURLs} original positives preserved, ` +
        `${negativeURLs} URL boundary negatives rejected, 6 deliberate width relaxations verified.`);
} finally {
    // The only recursive cleanup target is this test's newly created directory.
    const resolved = await fs.realpath(temporaryRoot);
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.ok(path.basename(resolved).startsWith('ublock-plus-antiadblock-resources-'));
    await fs.rm(resolved, { recursive: true, force: true });
}
