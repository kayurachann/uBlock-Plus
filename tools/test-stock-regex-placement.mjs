/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// Chromium packages carry the stock regex rules in the lists' static
// rulesets (platform/mv3/stock-regex.js, regex-verdicts.mjs,
// make-rulesets.js):
// - a regex outside the portable RE2 subset or rejected by Chrome's RE2 is
//   marked unsupported, with a reason code, and counted per filter;
// - the valid regex rules of a list are appended to its static ruleset while
//   all static rulesets stay within Chrome's limit of 1000, in list order; a
//   list which does not fit keeps them on the dynamic path;
// - the other rules keep the IDs of a build without regex rules;
// - rulesets/regex-details.json has a deterministic digest, and says which
//   Chrome checked the regexes, or '' when none did;
// - a release build (regexVerdicts=required) fails without Chrome;
// - strict-block rules are extensionPath redirects keeping the filters' own
//   URL predicate.
// No Chrome is started by this test.

import {
    STATIC_REGEX_BUDGET,
    annotateRegexRules,
    createStaticRegexPlacement,
    makeRegexDetails,
    regexDetailsDigest,
    regexVerdictError,
    staticRegexEntries,
    toJSONRuleset,
} from '../platform/mv3/stock-regex.js';
import {
    dnrErrorReason,
    dnrErrorSummary,
} from '../src/js/static-dnr-filtering.js';
import {
    prepareOutput,
    readJSON,
    runMakeRulesets,
    stageRulesetBuild,
} from './stock-ruleset-harness.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRegexVerdictResolver } from '../platform/mv3/regex-verdicts.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const regexRule = (regex, extra = {}) => ({
    action: { type: 'block' },
    condition: { regexFilter: regex, resourceTypes: [ 'script' ], ...extra },
});

// A stand-in for the Chrome resolver: verdicts by regex.
const fakeResolver = verdicts => {
    const calls = [];
    return {
        calls,
        async resolve(list) {
            calls.push(list);
            return list.map(options => verdicts[options.regex] ?? 'ok');
        },
    };
};

/******************************************************************************/

// Verdict annotation
{
    const rules = [
        regexRule('^https?:\\/\\/ok\\.test\\/'),
        regexRule('^https?:\\/\\/mem\\.test\\/[a-z]{900}', { isUrlFilterCaseSensitive: true }),
        regexRule('^https?:\\/\\/syn\\.test\\/x'),
        regexRule('^https?:\\/\\/(a)\\1'),
        regexRule('^https?:\\/\\/new\\.test\\/'),
        { action: { type: 'block' }, condition: { urlFilter: '||plain.test^' } },
        { ...regexRule('^https?:\\/\\/old\\.test\\/'), _error: [ 'earlier error' ] },
    ];
    const resolver = fakeResolver({
        '^https?:\\/\\/mem\\.test\\/[a-z]{900}': 'memoryLimitExceeded',
        '^https?:\\/\\/syn\\.test\\/x': 'syntaxError',
        '^https?:\\/\\/new\\.test\\/': 'unverified',
    });
    const stats = await annotateRegexRules(rules, resolver);
    assert.deepEqual(stats, {
        checked: 5, ok: 1, unverified: 1, rejected: 3,
        portable: 1, syntax: 1, memory: 1, other: 0,
    });
    // The portable gate runs first: Chrome is not asked about the others.
    assert.equal(resolver.calls.length, 1);
    assert.deepEqual(resolver.calls[0].map(options => options.regex), [
        '^https?:\\/\\/ok\\.test\\/',
        '^https?:\\/\\/mem\\.test\\/[a-z]{900}',
        '^https?:\\/\\/syn\\.test\\/x',
        '^https?:\\/\\/new\\.test\\/',
    ]);
    assert.deepEqual(resolver.calls[0][1], {
        regex: '^https?:\\/\\/mem\\.test\\/[a-z]{900}',
        isCaseSensitive: true,
        requireCapturing: false,
    });
    assert.equal(rules[0]._error, undefined);
    assert.equal(rules[4]._error, undefined, 'unverified regexes are kept');
    assert.deepEqual(rules[1]._error, [
        'regexFilter rejected by Chrome RE2 (memoryLimitExceeded): ^https?:\\/\\/mem\\.test\\/[a-z]{900}',
    ]);
    assert.deepEqual(rules[2]._error, [
        'regexFilter rejected by Chrome RE2 (syntaxError): ^https?:\\/\\/syn\\.test\\/x',
    ]);
    assert.deepEqual(rules[3]._error, [
        'regexFilter outside the portable RE2 subset (backreference-or-octal): ^https?:\\/\\/(a)\\1',
    ]);
    assert.deepEqual(rules[6]._error, [ 'earlier error' ]);
    assert.equal(dnrErrorReason(rules[1]._error[0]), 'unsupported-regex-memory');
    assert.equal(dnrErrorReason(rules[2]._error[0]), 'unsupported-regex-syntax');
    assert.equal(dnrErrorReason(rules[3]._error[0]), 'unsupported-regex-syntax');
    assert.equal(regexVerdictError('x', '', 'ok'), '');
    assert.equal(regexVerdictError('x', '', 'unverified'), '');
    // A capturing regex is checked as such
    const capturing = { action: { type: 'redirect', redirect: { regexSubstitution: '\\1' } },
        condition: { regexFilter: '^(https?)://' } };
    const capturingResolver = fakeResolver({});
    await annotateRegexRules([ capturing ], capturingResolver);
    assert.equal(capturingResolver.calls[0][0].requireCapturing, true);
    // Nothing to check: Chrome is not asked
    const idle = fakeResolver({});
    await annotateRegexRules([ rules[5] ], idle);
    assert.equal(idle.calls.length, 0);

    // Filters are counted, not entries: a filter compiled into two entries
    // (two types) counts once.
    const twoTypes = [
        { ...regexRule('^https?:\\/\\/mem\\.test\\/[a-z]{900}'), _sourceFilters: [ '/m/$script,image' ] },
        { ...regexRule('^https?:\\/\\/mem\\.test\\/[a-z]{900}'), _sourceFilters: [ '/m/$script,image' ] },
        { ...regexRule('^https?:\\/\\/syn\\.test\\/x'), _sourceFilters: [ '/s/', '/s/$1p' ] },
    ];
    await annotateRegexRules(twoTypes, resolver);
    assert.deepEqual(dnrErrorSummary(twoTypes), {
        count: 3,
        reasons: { 'unsupported-regex-syntax': 2, 'unsupported-regex-memory': 1 },
    });
}

/******************************************************************************/

// Budget placement: first fit in build order.
{
    assert.equal(STATIC_REGEX_BUDGET, 1000);
    const placement = createStaticRegexPlacement();
    assert.equal(placement.place('a', 998), true);
    assert.equal(placement.place('b', 3), false, 'crossing the limit: dynamic');
    assert.equal(placement.place('c', 2), true, 'a later list may still fit');
    assert.equal(placement.place('d', 0), true);
    assert.equal(placement.place('e', 1), false);
    assert.equal(placement.used, 1000);
    assert.deepEqual(placement.overflow, [
        { rulesetId: 'b', count: 3 }, { rulesetId: 'e', count: 1 },
    ]);
    const small = createStaticRegexPlacement(5);
    assert.equal(small.place('a', 6), false);
    assert.equal(small.place('b', 5), true);
}

/******************************************************************************/

// toJSONRuleset(): tail rules are numbered after the ruleset's own rules,
// which keep the IDs they have without a tail.
{
    const head = ( ) => [
        { action: { type: 'block' }, condition: { urlFilter: '||one.test^' } },
        { action: { type: 'block' }, condition: { requestDomains: [ 'a.test', 'b.test', 'a.test' ] } },
        { action: { type: 'allow' }, condition: { initiatorDomains: [ 'x.test' ], urlFilter: '/ad' } },
        { action: { type: 'block' }, condition: { requestDomains: [ 'c.test', 'd.test', 'e.test' ] }, _sourceKeys: [ 'k' ] },
    ];
    const tail = [
        regexRule('^https?:\\/\\/t1\\.test\\/'),
        regexRule('^https?:\\/\\/t2\\.test\\/', { requestDomains: [ 'p.test', 'q.test' ] }),
    ];
    const plain = JSON.parse(toJSONRuleset(head()));
    const combined = JSON.parse(toJSONRuleset(head(), { tail }));
    assert.equal(combined.length, plain.length + tail.length);
    assert.deepEqual(combined.slice(0, plain.length), plain);
    assert.deepEqual(combined.slice(plain.length).map(rule => rule.id), [ 5, 6 ]);
    // Tail rules are sorted like any ruleset, and private properties dropped
    assert.equal(combined[4].condition.regexFilter, '^https?:\\/\\/t2\\.test\\/');
    assert.equal(JSON.stringify(combined).includes('_sourceKeys'), false);
    assert.deepEqual(plain.map(rule => rule.id), [ 1, 2, 3, 4 ]);
    assert.deepEqual(plain[0].condition.requestDomains, [ 'c.test', 'd.test', 'e.test' ]);
    assert.deepEqual(plain[1].condition.requestDomains, [ 'a.test', 'b.test' ]);
}

/******************************************************************************/

// rulesets/regex-details.json: the digest does not depend on the order of
// lists or rules, and changes with any regex, list or case sensitivity.
{
    const entries = [
        ...staticRegexEntries('list-a', [
            regexRule('^a1'), regexRule('^a2', { isUrlFilterCaseSensitive: true }),
        ]),
        ...staticRegexEntries('list-b', [ regexRule('^b1') ]),
    ];
    assert.deepEqual(entries[1], [ 'list-a', '^a2', true ]);
    const digest = regexDetailsDigest(entries);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(regexDetailsDigest(entries.slice().reverse()), digest);
    assert.equal(regexDetailsDigest(structuredClone(entries)), digest);
    for ( const changed of [
        [ [ 'list-a', '^a1', true ], ...entries.slice(1) ],
        [ [ 'list-b', '^a1', false ], ...entries.slice(1) ],
        [ [ 'list-a', '^a0', false ], ...entries.slice(1) ],
        entries.slice(1),
    ] ) {
        assert.notEqual(regexDetailsDigest(changed), digest);
    }
    assert.deepEqual(makeRegexDetails({ verifiedWith: 'Chrome/153.0.8010.53', entries }), {
        schemaVersion: 1,
        verifiedWith: 'Chrome/153.0.8010.53',
        staticRegexLimit: 1000,
        staticRegexCount: 3,
        digest,
    });
    assert.equal(makeRegexDetails({ entries: [] }).verifiedWith, '');
    assert.equal(makeRegexDetails({ entries: [] }).digest,
        createHash('sha256').update('[]').digest('hex'));
}

/******************************************************************************/

const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, 'ublock-plus-regex-placement-')
);

try {
    // The resolver without a Chrome: required fails, optional falls back to
    // the verdict cache, then to 'unverified' (and then no Chrome version).
    {
        const cacheFile = path.join(temporaryRoot, 'cache', 'regex-verdicts.json');
        const missingChrome = path.join(temporaryRoot, 'no-such-chrome.exe');
        for ( const chromePath of [ '', missingChrome ] ) {
            const required = createRegexVerdictResolver({ chromePath, cacheFile, required: true });
            await assert.rejects(required.start(), /regexVerdicts=required/);
            await assert.rejects(required.resolve([ { regex: 'a' } ]), /regexVerdicts=required/);
            await required.close();
        }
        const logged = [];
        const optional = createRegexVerdictResolver({
            chromePath: missingChrome, cacheFile, log: text => logged.push(text),
        });
        assert.deepEqual(await optional.resolve([ { regex: 'a' }, { regex: 'b' } ]),
            [ 'unverified', 'unverified' ]);
        assert.equal(optional.chromeVersion(), '');
        assert.ok(logged.some(text => text.startsWith('!!! Regex verdicts: Chrome is unavailable')));
        await optional.close();
        await assert.rejects(fs.stat(cacheFile), 'nothing to cache without Chrome');

        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify({
            schemaVersion: 1,
            chromeVersion: 'Chrome/150.0.0.0',
            verdicts: {
                [JSON.stringify([ 'a', false, false ])]: 'memoryLimitExceeded',
                [JSON.stringify([ 'b', true, false ])]: 'ok',
            },
        }));
        const cached = createRegexVerdictResolver({ cacheFile });
        assert.deepEqual(await cached.resolve([
            { regex: 'a' }, { regex: 'b', isCaseSensitive: true },
        ]), [ 'memoryLimitExceeded', 'ok' ]);
        assert.equal(cached.chromeVersion(), 'Chrome/150.0.0.0');
        assert.deepEqual(await cached.resolve([ { regex: 'b' } ]), [ 'unverified' ],
            'the case sensitivity is part of the key');
        assert.equal(cached.chromeVersion(), '');
        await cached.close();
        await assert.rejects(cached.resolve([ { regex: 'a' } ]), /closed/);
        const nothing = createRegexVerdictResolver({});
        assert.equal(nothing.chromeVersion(), '');
        await nothing.close();
    }

    // make-rulesets.js on fixture lists.
    const buildDir = path.join(temporaryRoot, 'ruleset-build');
    await stageRulesetBuild(buildDir);

    const regexFilter = (name, i) =>
        `/^https?:\\/\\/r${i}\\.${name}\\.fixture\\.test\\/[a-z]+/$script`;
    const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
    const plainFilters = name => [
        `||${name}.fixture.test^`,
        `||${name}.fixture.test/ads^$script`,
        `*$script,domain=${name}1.fixture.test|${name}2.fixture.test|${name}3.fixture.test`,
        `@@||${name}.fixture.test/ok^$script`,
        `||${name}-img.fixture.test^$image,domain=x.fixture.test`,
    ];
    const lists = [
        // 998 + 3 > 1000: place-b stays dynamic, place-c still fits
        { id: 'place-a', count: 998, enabled: true },
        { id: 'place-b', count: 3, enabled: true },
        { id: 'place-c', count: 2, enabled: false, extra: [
            '||sb-host.fixture.test^',
            '||sb-doc.fixture.test/path^$doc',
            '/^https?:\\/\\/sb-re\\.fixture\\.test\\/[a-z]+/$doc',
            '||sb-ex.fixture.test^$doc,to=~sub.sb-ex.fixture.test',
            '||sb-script.fixture.test^$doc,script',
        ] },
    ];
    const fixture = withRegex => lists.map(list => ({
        id: list.id,
        name: list.id,
        group: 'default',
        enabled: list.enabled,
        urls: [],
        filters: [
            ...plainFilters(list.id),
            ...(list.extra ?? []),
            ...(withRegex ? range(list.count, i => regexFilter(list.id, i)) : []),
        ],
    }));

    const build = async (name, withRegex, extraArgs = []) => {
        const root = path.join(temporaryRoot, name);
        const outputDir = await prepareOutput(root);
        await fs.writeFile(path.join(buildDir, 'rulesets.json'),
            JSON.stringify(fixture(withRegex)));
        const result = await runMakeRulesets(buildDir, outputDir, extraArgs);
        return { outputDir, result };
    };

    const withRegex = await build('with-regex', true);
    assert.equal(withRegex.result.code ?? 0, 0, withRegex.result.stderr);
    const withoutRegex = await build('without-regex', false);
    assert.equal(withoutRegex.result.code ?? 0, 0, withoutRegex.result.stderr);
    const out = withRegex.outputDir;

    const details = await readJSON(out, 'rulesets/ruleset-details.json');
    const plainDetails = await readJSON(withoutRegex.outputDir, 'rulesets/ruleset-details.json');
    const byId = id => details.find(entry => entry.id === id).rules;
    const expected = {
        'place-a': { regexStatic: 998, regex: 0 },
        'place-b': { regexStatic: 0, regex: 3 },
        'place-c': { regexStatic: 2, regex: 0 },
    };
    const staticEntries = [];
    for ( const [ id, counts ] of Object.entries(expected) ) {
        const rules = byId(id);
        const plainRules = plainDetails.find(entry => entry.id === id).rules;
        assert.equal(rules.regexStatic, counts.regexStatic, id);
        assert.equal(rules.regex, counts.regex, id);
        assert.equal(rules.plain, plainRules.plain, id);
        assert.equal(rules.total, rules.plain + rules.regexStatic + rules.regex, id);
        assert.equal(plainRules.regexStatic, 0, id);

        // main/<id>.json: the other rules, identical to a build without
        // regex rules, then the static regex rules.
        const mainText = await fs.readFile(path.join(out, 'rulesets', 'main', `${id}.json`), 'utf8');
        const main = JSON.parse(mainText);
        const plainMain = await readJSON(withoutRegex.outputDir, `rulesets/main/${id}.json`);
        assert.equal(main.length, rules.plain + rules.regexStatic, id);
        assert.deepEqual(main.slice(0, rules.plain), plainMain, id);
        const tail = main.slice(rules.plain);
        assert.ok(tail.every(rule => typeof rule.condition.regexFilter === 'string'), id);
        assert.ok(main.slice(0, rules.plain).every(rule =>
            rule.condition.regexFilter === undefined), id);
        assert.deepEqual(tail.map(rule => rule.id),
            range(tail.length, i => rules.plain + 1 + i), id);
        staticEntries.push(...staticRegexEntries(id, tail));

        // rulesets/regex/<id>.json only for a list which did not fit
        const dynamic = await readJSON(out, `rulesets/regex/${id}.json`).catch(( ) => []);
        assert.equal(dynamic.length, counts.regex, id);

        // badfilter/<id>.json: head rules only, digest of the whole file
        const badfilter = await readJSON(out, `rulesets/badfilter/${id}.json`);
        assert.equal(badfilter.digest, createHash('sha256').update(mainText).digest('hex'), id);
        assert.ok(badfilter.rules.every(rule => rule.id <= rules.plain), id);
        assert.ok(badfilter.deferredKeys.length >= counts.regexStatic + counts.regex, id);
    }

    // regex-details.json: no Chrome and no cache, so not verified
    const regexDetails = await readJSON(out, 'rulesets/regex-details.json');
    assert.deepEqual(regexDetails, makeRegexDetails({ verifiedWith: '', entries: staticEntries }));
    assert.equal(regexDetails.staticRegexCount, 1000);
    const buildLog = await fs.readFile(path.join(out, 'log.txt'), 'utf8');
    assert.ok(buildLog.includes('\nStatic regex rules: 1000/1000 (not verified with Chrome)\n'));
    assert.ok(buildLog.includes('\n\tKept as dynamic rules: place-b (3)\n'));
    assert.ok(buildLog.includes('!!! place-b: 3 regex rules do not fit in the static regex limit'));
    assert.ok(buildLog.includes('!!! Static regex rules were not checked by Chrome'));
    const sectionA = buildLog.slice(buildLog.indexOf('Listset for \'place-a\':'));
    assert.ok(sectionA.includes('\tStatic regex rules: 998\n\tDynamic fallback regex rules: 0\n'));
    const sectionB = buildLog.slice(buildLog.indexOf('Listset for \'place-b\':'));
    assert.ok(sectionB.includes('\tStatic regex rules: 0\n\tDynamic fallback regex rules: 3\n'));

    // Strict-block rules: extensionPath redirects keeping the filters' own
    // URL predicate, so only regex filters use a regex rule.
    const strictblock = await readJSON(out, 'rulesets/strictblock/place-c.json');
    for ( const rule of strictblock ) {
        assert.deepEqual(rule.action, { redirect: { extensionPath: '/strictblock.html' }, type: 'redirect' });
        assert.equal(rule.priority, 29);
        assert.deepEqual(rule.condition.resourceTypes, [ 'main_frame' ]);
    }
    assert.equal(JSON.stringify(strictblock).includes('regexSubstitution'), false);
    const sbRegex = strictblock.filter(rule => rule.condition.regexFilter !== undefined);
    assert.deepEqual(sbRegex.map(rule => rule.condition.regexFilter),
        [ '^https?:\\/\\/sb-re\\.fixture\\.test\\/[a-z]+' ]);
    assert.ok(strictblock.some(rule =>
        rule.condition.urlFilter === '||sb-doc.fixture.test/path^'));
    const hostnames = strictblock.find(rule =>
        rule.condition.requestDomains?.includes('sb-host.fixture.test'));
    assert.equal(hostnames.condition.excludedRequestDomains, undefined);
    assert.ok(hostnames.condition.requestDomains.includes('sb-script.fixture.test'));
    // Different exclusions are never merged into one narrower rule
    const excluded = strictblock.find(rule =>
        rule.condition.requestDomains?.includes('sb-ex.fixture.test'));
    assert.deepEqual(excluded.condition.excludedRequestDomains, [ 'sub.sb-ex.fixture.test' ]);
    assert.equal(excluded.condition.requestDomains.includes('sb-host.fixture.test'), false);
    assert.equal(byId('place-c').strictblock, strictblock.length);
    // `$doc,script`: the script part stays a plain rule
    const mainC = await readJSON(out, 'rulesets/main/place-c.json');
    assert.ok(mainC.some(rule =>
        rule.condition.requestDomains?.includes('sb-script.fixture.test') &&
        rule.condition.resourceTypes?.includes('script') &&
        rule.condition.resourceTypes.includes('main_frame') === false));

    // A release build without a working Chrome fails before compiling.
    for ( const args of [
        [ 'regexVerdicts=required' ],
        [ 'regexVerdicts=required', `chrome=${path.join(temporaryRoot, 'no-such-chrome.exe')}` ],
    ] ) {
        const failed = await build('required', true, args);
        assert.notEqual(failed.result.code ?? 0, 0, 'the build fails');
        assert.match(failed.result.stderr, /Regex verdicts: Chrome is unavailable .*regexVerdicts=required/);
        await assert.rejects(fs.stat(path.join(failed.outputDir, 'rulesets', 'ruleset-details.json')));
        await fs.rm(path.join(temporaryRoot, 'required'), { recursive: true, force: true });
    }
    const invalid = await build('invalid-mode', true, [ 'regexVerdicts=sometimes' ]);
    assert.notEqual(invalid.result.code ?? 0, 0);
    assert.match(invalid.result.stderr, /Invalid regexVerdicts: sometimes/);
} finally {
    // This is the exact directory returned by mkdtemp for this test only.
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Stock regex placement tests passed');
