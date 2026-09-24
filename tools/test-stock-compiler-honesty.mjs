/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// Stock (build-time) compiler honesty:
// - every filter which cannot become a DNR rule is counted, per reason, in the
//   build log and in ruleset-details.json, and validate-mv3.mjs checks that
//   the reported counts match the packaged rulesets; filters are counted, not
//   the rule entries they compile into, and the dashboard shows the number of
//   filters converted
// - `removeparam=~name` is reported as unsupported, not converted into a
//   removeParams entry which never matches
// - `##^responseheader()` is keyed on the response's own hostname, with the
//   exception semantics of classic uBO (httpheader-filtering.js)
// - every redirect resource the runtime compiler accepts is packaged and
//   web-accessible, or listed as unavailable; a missing one fails the build

import {
    dnrConvertedFilterCount,
    dnrErrorReason,
    dnrErrorSummary,
    dnrRulesetFromRawLists,
} from '../src/js/static-dnr-filtering.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import redirectResources from '../src/js/redirect-resources.js';
import { stageRulesetBuild } from './stock-ruleset-harness.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const env = [ 'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol' ];
const extensionPaths = [ [ 'noop.js', '/web_accessible_resources/noop.js' ] ];
// Fixture lists are trusted, as the stock lists which use these options are.
const secret = 'honesty-test';

const compile = async lines => {
    const result = await dnrRulesetFromRawLists(
        [ { name: 'honesty-test', text: [ `!#trusted on ${secret}`, ...lines ].join('\n') } ],
        { env, extensionPaths, secret }
    );
    const rules = result.network.ruleset;
    return {
        rules: rules.filter(rule => rule._error === undefined),
        errors: rules.filter(rule => rule._error !== undefined),
    };
};

const headerRules = rules => rules.filter(rule =>
    rule.action?.type === 'modifyHeaders' &&
    rule.action.responseHeaders?.some(header => header.operation === 'remove')
);

/******************************************************************************/

// Every error message which the stock compiler can produce maps to a stable
// reason code.
{
    const expected = new Map([
        [ '||a.fixture.test^$script,redirect-rule=noop.js', 'unsupported-redirect-rule' ],
        [ '||b.fixture.test^$domain=example.*', 'unsupported-domain' ],
        [ '/ab(?=c)d/$script', 'unsupported-regex' ],
        [ '||c.fixture.test^$ipaddress=192.0.2.1', 'unsupported-ipaddress' ],
        [ '||d.fixture.test^$removeparam=/^utm_/', 'unsupported-removeparam-regex' ],
        [ '||e.fixture.test^$removeparam=/^utm_/i', 'unsupported-removeparam-regex' ],
        // Legacy `|prefix` value: a regex for classic uBO
        [ '||e2.fixture.test^$removeparam=|utm_', 'unsupported-removeparam-regex' ],
        [ '||e3.fixture.test^$removeparam=~/^utm_/', 'unsupported-removeparam-regex' ],
        [ '||f.fixture.test^$removeparam=~keep', 'unsupported-removeparam-negated' ],
        [ '||g.fixture.test^$strict1p', 'unsupported-strict-first-party' ],
        [ '||h.fixture.test^$strict3p', 'unsupported-strict-third-party' ],
        [ '||i.fixture.test^$frame,redirect=click2load.html', 'unsupported-redirect-resource' ],
        [ '||j.fixture.test^$requestheader=x-foo:bar', 'unsupported-requestheader' ],
        [ '||k.fixture.test^$header=etag:/^W\\/"[0-9a-f]{64}"$/', 'unsupported-header-value' ],
        [ '||l.fixture.test^$uritransform=/a/b/', 'unsupported-urltransform-regex' ],
        [ 'l.*##^responseheader(refresh)', 'unsupported-responseheader-hostname' ],
        [ 'l.*#@#^responseheader(refresh)', 'unsupported-responseheader-hostname' ],
        [ 'fixture.test##:-abp-properties(width: 1px)', 'invalid-filter' ],
        [ '@@||m.fixture.test^$genericblock', 'invalid-network-filter' ],
    ]);
    const { errors } = await compile(Array.from(expected.keys()));
    assert.equal(errors.length, expected.size);
    for ( const rule of errors ) {
        assert.notEqual(dnrErrorReason(rule._error[0]), 'other', rule._error[0]);
    }
    const counts = new Map();
    for ( const reason of expected.values() ) {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const summary = dnrErrorSummary([ ...errors, { action: { type: 'block' } } ]);
    assert.equal(summary.count, expected.size);
    assert.deepEqual(summary.reasons, Object.fromEntries(Array.from(counts)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))));
    assert.equal(dnrErrorReason('Something new'), 'other');
    assert.equal(dnrErrorReason(undefined), 'other');
}

// Filters are counted, not the entries they compile into: one entry per
// type, entries merging several filters, entries with several errors.
{
    const { rules, errors } = await compile([
        // 3 entries, 1 filter
        '||types.fixture.test^$script,image,xhr,strict1p',
        // 1 entry, 2 filters
        '*$script,domain=merged1.*',
        '*$script,domain=merged2.*',
        // 2 errors, 1 entry: counted under its first error
        '||multi.fixture.test^$strict1p,domain=example.*',
        // 2 compiled lines, 1 entry once duplicates are removed: 2 filters
        '||dup.fixture.test^$script,strict3p,domain=x.test|y.test',
        '||dup.fixture.test^$script,strict3p,domain=y.test|x.test',
        '||ok.fixture.test^$script,image',
        '||ok.fixture.test^$script',
    ]);
    const types = errors.filter(rule =>
        rule._sourceFilters.includes('||types.fixture.test^$script,image,xhr,strict1p'));
    assert.equal(types.length, 3);
    const merged = errors.filter(rule =>
        rule._sourceFilters.includes('*$script,domain=merged1.*'));
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]._sourceFilters.slice().sort(),
        [ '*$script,domain=merged1.*', '*$script,domain=merged2.*' ]);
    const multi = errors.find(rule =>
        rule._sourceFilters.includes('||multi.fixture.test^$strict1p,domain=example.*'));
    assert.equal(multi._error.length, 2);
    assert.equal(dnrErrorReason(multi._error[0]), 'unsupported-strict-first-party');
    assert.equal(dnrErrorReason(multi._error[1]), 'unsupported-domain');
    const dup = errors.filter(rule =>
        rule.condition?.requestDomains?.includes('dup.fixture.test'));
    assert.equal(dup.length, 1);
    assert.equal(dup[0]._sourceFilters.length, 2);
    assert.deepEqual(dnrErrorSummary(errors), {
        count: 6,
        reasons: {
            'unsupported-strict-first-party': 2,
            'unsupported-domain': 2,
            'unsupported-strict-third-party': 2,
        },
    });
    // `||ok…^$script` is a duplicate of a compiled line of the other `ok`
    // filter: both are converted, and neither is counted twice.
    assert.equal(dnrConvertedFilterCount([ ...rules, ...errors ]), 2);
    // A filter with any rejected entry is not converted.
    assert.equal(dnrConvertedFilterCount([
        { action: { type: 'block' }, _sourceFilters: [ 'a', 'b' ] },
        { _error: [ 'x' ], _sourceFilters: [ 'b' ] },
        { _error: [ 'y' ] },
    ]), 1);
}

// A negated removeparam keeps only the named parameter: DNR cannot express
// it, while a plain name and the remove-all form still convert.
{
    const { rules, errors } = await compile([
        '||negated.fixture.test^$removeparam=~keep',
        '@@||negated.fixture.test^$removeparam=~keep',
        '||plain.fixture.test^$removeparam=utm_source',
        '||all.fixture.test^$removeparam',
    ]);
    assert.equal(errors.length, 2);
    for ( const rule of errors ) {
        assert.equal(dnrErrorReason(rule._error[0]), 'unsupported-removeparam-negated');
    }
    assert.equal(rules.some(rule =>
        JSON.stringify(rule).includes('~keep')
    ), false, 'No rule mentions the negated parameter');
    const plain = rules.find(rule =>
        rule.condition.requestDomains?.includes('plain.fixture.test'));
    assert.deepEqual(plain.action.redirect.transform.queryTransform.removeParams,
        [ 'utm_source' ]);
    const all = rules.find(rule =>
        rule.condition.requestDomains?.includes('all.fixture.test'));
    assert.deepEqual(all.action.redirect.transform, { query: '' });
}

// Response header filters are keyed on the response's hostname, for every
// type of request, and classic exception semantics hold within a list.
{
    const { rules, errors } = await compile([
        'a.fixture.test,~sub.a.fixture.test##^responseheader(refresh)',
        'b.fixture.test##^responseheader(refresh)',
        'c.fixture.test,d.fixture.test##^responseheader(set-cookie)',
        'c.fixture.test#@#^responseheader(set-cookie)',
        'e.fixture.test##^responseheader(report-to)',
        '#@#^responseheader(report-to)',
        'f.fixture.test#@#^responseheader()',
        '~only-negated.fixture.test##^responseheader(location)',
        'entity.*,g.fixture.test##^responseheader(location)',
    ]);
    assert.deepEqual(errors, []);
    const byHeader = new Map(headerRules(rules).map(rule =>
        [ rule.action.responseHeaders[0].header, rule ]
    ));
    assert.deepEqual(Array.from(byHeader.keys()).sort(),
        [ 'location', 'refresh', 'set-cookie' ],
        'A global exception drops every report-to filter');
    for ( const rule of byHeader.values() ) {
        assert.equal(rule.condition.initiatorDomains, undefined);
        assert.equal(rule.condition.excludedInitiatorDomains, undefined);
        for ( const type of [ 'main_frame', 'sub_frame', 'image', 'script', 'xmlhttprequest' ] ) {
            assert.ok(rule.condition.resourceTypes.includes(type), type);
        }
        assert.deepEqual(rule.action.responseHeaders.length, 1);
        assert.equal(rule.action.responseHeaders[0].operation, 'remove');
    }
    const refresh = byHeader.get('refresh').condition;
    assert.deepEqual(refresh.requestDomains, [ 'a.fixture.test', 'b.fixture.test' ]);
    assert.deepEqual(refresh.excludedRequestDomains,
        [ 'f.fixture.test', 'sub.a.fixture.test' ],
        'A negated hostname excepts it for every filter of that header');
    const cookie = byHeader.get('set-cookie').condition;
    assert.deepEqual(cookie.requestDomains, [ 'c.fixture.test', 'd.fixture.test' ]);
    assert.deepEqual(cookie.excludedRequestDomains, [ 'c.fixture.test', 'f.fixture.test' ]);
    const location = byHeader.get('location');
    assert.deepEqual(location.condition.requestDomains, [ 'g.fixture.test' ],
        'Entities are dropped when a plain hostname remains');
    assert.deepEqual(location.condition.excludedRequestDomains,
        [ 'f.fixture.test', 'only-negated.fixture.test' ]);
    assert.ok(location._warning.some(warning => warning.includes('entity.*')));

    // Generic filter; negated-only filter; entity-only filter
    const generic = await compile([ '*,~h.fixture.test##^responseheader(location)' ]);
    const genericRule = headerRules(generic.rules)[0];
    assert.equal(genericRule.condition.requestDomains, undefined);
    assert.deepEqual(genericRule.condition.excludedRequestDomains, [ 'h.fixture.test' ]);
    assert.ok(genericRule.condition.resourceTypes.includes('main_frame'));
    const negated = await compile([ '~i.fixture.test##^responseheader(location)' ]);
    assert.deepEqual(headerRules(negated.rules), [],
        'A filter with only negated hostnames is an exception, as in classic');
    assert.deepEqual(negated.errors, []);
    const entity = await compile([ 'entity.*##^responseheader(location)' ]);
    assert.deepEqual(headerRules(entity.rules), [],
        'An entity-only filter must not become a global rule');
    assert.equal(entity.errors.length, 1);
    assert.equal(dnrErrorReason(entity.errors[0]._error[0]),
        'unsupported-responseheader-hostname');
    const everything = await compile([
        'j.fixture.test##^responseheader(location)',
        '#@#^responseheader()',
    ]);
    assert.deepEqual(headerRules(everything.rules), []);
}

// Response header exceptions which DNR cannot fully express.
{
    const refreshRules = rules => headerRules(rules).filter(rule =>
        rule.action.responseHeaders[0].header === 'refresh');
    // `*` excepts the header everywhere, as no hostname does
    const star = await compile([
        'k.fixture.test##^responseheader(report-to)',
        '*#@#^responseheader(report-to)',
    ]);
    assert.deepEqual(headerRules(star.rules), []);
    assert.deepEqual(star.errors, []);
    // No exception to an exception: negated hostnames are ignored
    const negated = await compile([
        'k.fixture.test##^responseheader(refresh)',
        '~k.fixture.test#@#^responseheader(refresh)',
        '~sub.k.fixture.test#@#^responseheader(refresh)',
    ]);
    const negatedRules = refreshRules(negated.rules);
    assert.equal(negatedRules.length, 1);
    assert.deepEqual(negatedRules[0].condition.requestDomains, [ 'k.fixture.test' ]);
    assert.equal(negatedRules[0].condition.excludedRequestDomains, undefined);
    assert.deepEqual(negated.errors, []);
    // Entity and regex hostnames are dropped, with a warning when another
    // hostname remains...
    const partial = await compile([
        'k.fixture.test##^responseheader(refresh)',
        'x.*,y.fixture.test,/re\\.fixture/#@#^responseheader(refresh)',
    ]);
    const partialRule = refreshRules(partial.rules)[0];
    assert.deepEqual(partialRule.condition.excludedRequestDomains, [ 'y.fixture.test' ]);
    assert.deepEqual(partialRule._warning, [
        'Ignored unsupported responseheader() exception hostname: ' +
        'x.*,y.fixture.test,/re\\.fixture/#@#^responseheader(refresh)',
    ]);
    assert.deepEqual(partial.errors, []);
    // ...otherwise the exception is counted as unsupported, like a filter
    // (the header is then still removed where classic would keep it)
    const unsupported = await compile([
        'k.fixture.test##^responseheader(refresh)',
        'k.*#@#^responseheader(refresh)',
        '/k\\.fixture/#@#^responseheader(refresh)',
        'n.*#@#^responseheader(location)',
    ]);
    const unsupportedRule = refreshRules(unsupported.rules)[0];
    assert.equal(unsupportedRule.condition.excludedRequestDomains, undefined);
    assert.equal(unsupportedRule._warning, undefined);
    assert.deepEqual(dnrErrorSummary(unsupported.errors), {
        count: 3,
        reasons: { 'unsupported-responseheader-hostname': 3 },
    });
    // The warning of an all-header exception is reported once
    const allHeaders = await compile([
        'k.fixture.test##^responseheader(refresh)',
        'k.fixture.test##^responseheader(location)',
        'x.*,z.fixture.test#@#^responseheader()',
    ]);
    const allHeaderRules = headerRules(allHeaders.rules);
    assert.equal(allHeaderRules.length, 2);
    for ( const rule of allHeaderRules ) {
        assert.deepEqual(rule.condition.excludedRequestDomains, [ 'z.fixture.test' ]);
    }
    assert.equal(allHeaderRules.flatMap(rule => rule._warning ?? []).length, 1);
}

// The dashboard's "N rules, converted from M network filters": M is what a
// stock ruleset converted, not what it accepted (which includes the filters
// counted as rejected, once per type); imported lists count converted filters
// as accepted.
{
    const {
        FakeDocument, createExtension, stageModules,
    } = await import('./dashboard-test-harness.mjs');
    const staged = await stageModules({
        modules: [ 'filter-lists.js' ],
        stubs: {
            'dashboard.js': 'export const hashFromIterable = ( ) => \'\';\n' +
                'export const nodeFromTemplate = ( ) => null;\n',
        },
        document: new FakeDocument(),
        extension: createExtension(),
    });
    try {
        const { rulesetStatsFromDetails } = await staged.load('filter-lists.js');
        assert.deepEqual(rulesetStatsFromDetails({
            filters: { total: 12, accepted: 11, rejected: 1, converted: 4 },
            rules: { total: 6, plain: 5, regex: 1, rejected: 3 },
        }), { ruleCount: 6, filterCount: 4, unsupportedCount: 3 });
        assert.deepEqual(rulesetStatsFromDetails({
            filters: { total: 3, accepted: 2, rejected: 1 },
            rules: { total: 2, plain: 2, regex: 0 },
        }), { ruleCount: 2, filterCount: 2, unsupportedCount: 0 });
    } finally {
        await staged.cleanup();
    }
}

/******************************************************************************/

// Chromium builds: a regexFilter which Chrome's RE2 cannot run is counted
// like any other filter DNR cannot express, with its own reason code. The
// codes are those of platform/mv3/stock-regex.js.
{
    const regex = '^https?:\\/\\/x\\.fixture\\.test\\/';
    for ( const [ message, reason ] of [
        [ `regexFilter rejected by Chrome RE2 (syntaxError): ${regex}`, 'unsupported-regex-syntax' ],
        [ `regexFilter rejected by Chrome RE2 (memoryLimitExceeded): ${regex}`, 'unsupported-regex-memory' ],
        [ `regexFilter outside the portable RE2 subset (backreference-or-octal): ${regex}`, 'unsupported-regex-syntax' ],
        [ `regexFilter is not RE2-compatible: ${regex}`, 'unsupported-regex' ],
    ] ) {
        assert.equal(dnrErrorReason(message), reason, message);
    }
    // Filters, not entries: one filter per `_sourceFilters` item.
    assert.deepEqual(dnrErrorSummary([
        { _error: [ `regexFilter rejected by Chrome RE2 (memoryLimitExceeded): ${regex}` ],
            _sourceFilters: [ '/a/$script', '/a/$image' ] },
        { _error: [ `regexFilter rejected by Chrome RE2 (memoryLimitExceeded): ${regex}` ],
            _sourceFilters: [ '/a/$script' ] },
        { _error: [ `regexFilter outside the portable RE2 subset (lookaround): ${regex}` ],
            _sourceFilters: [ '/b/' ] },
    ]), {
        count: 3,
        reasons: { 'unsupported-regex-memory': 2, 'unsupported-regex-syntax': 1 },
    });
}

/******************************************************************************/

// make-rulesets.js: stage it the way tools/make-mv3.ps1 does, compile three
// fixture lists, and check the reports, the packaged redirect resources and
// validate-mv3.mjs.

const run = promisify(execFile);
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, 'ublock-plus-stock-honesty-')
);
const fromRoot = relative => path.join(projectRoot, relative);

// Regex filters Chrome cannot run: outside the portable RE2 subset, or
// rejected by Chrome's RE2. Without a Chrome, make-rulesets takes Chrome's
// verdicts from its cache (build/mv3-data/regex-verdicts.json), which this
// test writes. The last filter only blocks documents: its strict-block rule
// is all that is left of it, so when Chrome cannot run that rule the filter
// is rejected like the others, and the rule is also counted apart
// (`strictblockRejected`).
const regexFixtures = new Map([
    [ '/^https?:\\/\\/backref\\.fixture\\.test\\/(a+)\\1/$script', 'portable' ],
    [ '/^https?:\\/\\/memory\\.fixture\\.test\\/[a-z]{1,9}/$script', 'memoryLimitExceeded' ],
    [ '/^https?:\\/\\/syntax\\.fixture\\.test\\/[a-z]+/$script', 'syntaxError' ],
    [ '/^https?:\\/\\/sb-memory\\.fixture\\.test\\/[a-z]+/$doc', 'memoryLimitExceeded' ],
]);
const regexVerdictCache = await (async ( ) => {
    const { rules } = await compile(Array.from(regexFixtures.keys()));
    const verdicts = {};
    for ( const [ filter, verdict ] of regexFixtures ) {
        const rule = rules.find(rule => rule._sourceFilters.includes(filter));
        assert.equal(typeof rule?.condition.regexFilter, 'string', filter);
        if ( verdict === 'portable' ) { continue; }
        verdicts[JSON.stringify([ rule.condition.regexFilter, false, false ])] = verdict;
    }
    return { schemaVersion: 1, chromeVersion: 'Chrome/153.0.0.0', verdicts };
})();

const fixtureRulesets = [ {
    id: 'honesty-a',
    name: 'Honesty A',
    group: 'default',
    enabled: true,
    urls: [],
    filters: [
        '||ads.fixture.test^',
        '||noop.fixture.test^$script,redirect=noop.js',
        '||vast.fixture.test^$xhr,redirect=noopvast-4.0',
        '||rr.fixture.test^$script,redirect-rule=noop.js',
        '||rr2.fixture.test^$image,redirect-rule=1x1.gif',
        '||neg.fixture.test^$removeparam=~keep',
        '||plain.fixture.test^$removeparam=utm_source',
        '||c2l.fixture.test^$frame,redirect=click2load.html',
        '||dom.fixture.test^$domain=example.*',
        // 2 entries, 1 filter
        '||types.fixture.test^$script,image,strict3p',
        // 1 entry, 2 errors
        '||multi.fixture.test^$strict1p,domain=example.*',
        // Matches no navigation: the navigated hostname would have to be both
        '||rp.fixture.test^$removeparam=r,doc,domain=a.fixture.test',
        'fixture.test##^responseheader(location)',
        'fixture.test##:-abp-properties(width: 1px)',
    ],
}, {
    id: 'honesty-b',
    name: 'Honesty B',
    group: 'default',
    enabled: false,
    urls: [],
    filters: [
        '||clean.fixture.test^',
    ],
}, {
    id: 'honesty-c',
    name: 'Honesty C',
    group: 'default',
    enabled: true,
    urls: [],
    filters: [
        '||plain-c.fixture.test^',
        ...regexFixtures.keys(),
    ],
}, {
    // Chromium strict blocking uses the runtime's definition of a candidate
    // (strictblock-rules.js): a document block narrowed by `top=` stays a
    // plain main_frame block, since a redirect would ignore the narrowing.
    id: 'honesty-d',
    name: 'Honesty D',
    group: 'default',
    enabled: true,
    urls: [],
    filters: [
        '||sb-top.fixture.test^$doc,top=frame-top.fixture.test',
        '||sb-control.fixture.test^$doc',
    ],
} ];
const expectedRejected = {
    'honesty-a': {
        rejected: 8,
        rejectedReasons: {
            'unsupported-redirect-rule': 2,
            'invalid-filter': 1,
            'unsupported-domain': 1,
            'unsupported-redirect-resource': 1,
            'unsupported-removeparam-negated': 1,
            'unsupported-strict-first-party': 1,
            'unsupported-strict-third-party': 1,
        },
        // ads, noop, vast, plain and rp
        converted: 5,
    },
    'honesty-b': { rejected: 0, rejectedReasons: undefined, converted: 1 },
    'honesty-c': {
        // The document-only regex filter's sole rule is the strict-block
        // rule Chrome cannot run: the filter is enforced nowhere.
        rejected: 4,
        rejectedReasons: {
            'unsupported-regex-memory': 2,
            'unsupported-regex-syntax': 2,
        },
        // plain-c
        converted: 1,
        strictblockRejected: 1,
        strictblockRejectedReasons: { 'unsupported-regex-memory': 1 },
    },
    'honesty-d': { rejected: 0, rejectedReasons: undefined, converted: 2 },
};

try {
    const buildDir = path.join(temporaryRoot, 'ruleset-build');
    const outputDir = path.join(temporaryRoot, 'build', 'uBlockPlus.chromium');
    await stageRulesetBuild(buildDir);
    await fs.writeFile(path.join(buildDir, 'rulesets.json'),
        JSON.stringify(fixtureRulesets));
    await fs.mkdir(outputDir, { recursive: true });
    await fs.copyFile(fromRoot('platform/mv3/chromium/manifest.json'),
        path.join(outputDir, 'manifest.json'));
    await fs.mkdir(path.join(temporaryRoot, 'build', 'mv3-data'));
    await fs.writeFile(path.join(temporaryRoot, 'build', 'mv3-data', 'secret.txt'),
        '0123456789abcdef');
    await fs.writeFile(path.join(temporaryRoot, 'build', 'mv3-data', 'regex-verdicts.json'),
        JSON.stringify(regexVerdictCache));
    const built = await run(process.execPath, [
        '--no-warnings', 'make-rulesets.js',
        `output=${outputDir}`, 'platform=chromium',
    ], { cwd: buildDir, maxBuffer: 64 * 1024 * 1024 });
    const readJSON = relative => fs.readFile(path.join(outputDir, relative), 'utf8')
        .then(text => JSON.parse(text));

    // Per-ruleset rejected counts, with reasons, in ruleset-details.json and
    // in the build log.
    const details = await readJSON('rulesets/ruleset-details.json');
    const buildLog = await fs.readFile(path.join(outputDir, 'log.txt'), 'utf8');
    for ( const [ id, expected ] of Object.entries(expectedRejected) ) {
        const entry = details.find(a => a.id === id);
        assert.equal(entry.rules.rejected, expected.rejected, id);
        assert.deepEqual(entry.rules.rejectedReasons, expected.rejectedReasons, id);
        assert.equal(entry.filters.converted, expected.converted, id);
        const section = buildLog.slice(buildLog.indexOf(`Listset for '${id}':`));
        const reasonLines = Object.entries(expected.rejectedReasons ?? {})
            .map(([ reason, count ]) => `\t\t${reason}: ${count}\n`).join('');
        assert.ok(section.includes(`\tUnsupported: ${expected.rejected}\n${reasonLines}`),
            `Build log reports the rejected filters of ${id}`);
        assert.equal(entry.rules.strictblockRejected, expected.strictblockRejected, id);
        assert.deepEqual(entry.rules.strictblockRejectedReasons,
            expected.strictblockRejectedReasons, id);
        // No regex rule of these lists can be packaged.
        assert.equal(entry.rules.regexStatic, 0, id);
        assert.equal(entry.rules.regex, 0, id);
    }
    assert.match(built.stdout, /Unsupported filters in 4 rulesets: 12\n/);
    assert.match(built.stdout, /\tunsupported-redirect-rule: 2\n/);
    assert.match(built.stdout, /\tunsupported-regex-syntax: 2\n/);
    assert.match(built.stdout, /\tunsupported-regex-memory: 2\n/);
    assert.match(built.stdout, /\nRE2 rejected: memory 1, syntax 2\n/);
    assert.match(built.stdout, /\nStrict-block RE2 rejected: memory 1, syntax 0\n/);
    // Every regex was answered by the (cached) verdicts of one Chrome.
    assert.match(built.stdout, /\nStatic regex rules: 0\/1000 \(verified with Chrome\/153\.0\.0\.0\)\n/);
    const regexDetails = await readJSON('rulesets/regex-details.json');
    assert.equal(regexDetails.verifiedWith, 'Chrome/153.0.0.0');
    assert.equal(regexDetails.staticRegexCount, 0);
    // The rejected regex rules are reported, never packaged.
    for ( const file of [ 'main/honesty-c.json', 'strictblock/honesty-c.json' ] ) {
        const text = await fs.readFile(path.join(outputDir, 'rulesets', file), 'utf8');
        assert.equal(text.includes('regexFilter'), false, file);
    }
    await assert.rejects(fs.stat(path.join(outputDir, 'rulesets', 'regex', 'honesty-c.json')));
    const compiledC = await readJSON('rulesets/debug/honesty-c.all.json');
    const errorsC = compiledC.filter(rule => rule._error).map(rule => rule._error[0]);
    assert.equal(errorsC.length, 4);
    const documentOnly = compiledC.find(rule => rule._sourceFilters.some(filter =>
        filter.includes('sb-memory')));
    assert.match(documentOnly?._error?.[0] ?? '',
        /^regexFilter rejected by Chrome RE2 \(memoryLimitExceeded\): /,
        'a document-only filter whose strict-block regex Chrome cannot run is rejected');
    assert.ok(buildLog.slice(buildLog.indexOf('Listset for \'honesty-c\':'))
        .includes('\tStrict-block regex filters rejected: 1\n'));
    assert.ok(errorsC.some(message => message.startsWith(
        'regexFilter outside the portable RE2 subset (backreference-or-octal): ')));
    assert.ok(errorsC.some(message => message.startsWith(
        'regexFilter rejected by Chrome RE2 (memoryLimitExceeded): ')));
    assert.ok(errorsC.some(message => message.startsWith(
        'regexFilter rejected by Chrome RE2 (syntaxError): ')));
    // One line per error, also for an entry with several errors
    assert.ok(buildLog.includes('\t\tstrict1p not supported\n' +
        '\t\tCan\'t salvage rule with unsupported domain= option: example.*\n'));
    assert.equal(buildLog.includes(',\t\t'), false);

    // top= narrows a document block: no redirect, the plain block stays.
    const strictD = await readJSON('rulesets/strictblock/honesty-d.json');
    assert.equal(JSON.stringify(strictD).includes('sb-top.fixture.test'), false,
        'a top= document block is not a strict-block redirect');
    assert.ok(strictD.some(rule =>
        rule.condition.requestDomains?.includes('sb-control.fixture.test')),
    'an unnarrowed document block is');
    const mainD = await readJSON('rulesets/main/honesty-d.json');
    const topBlock = mainD.find(rule =>
        rule.condition.requestDomains?.includes('sb-top.fixture.test'));
    assert.equal(topBlock?.action.type, 'block');
    assert.deepEqual(topBlock.condition.resourceTypes, [ 'main_frame' ]);
    assert.deepEqual(topBlock.condition.topDomains, [ 'frame-top.fixture.test' ]);
    assert.equal(mainD.some(rule =>
        rule.condition.requestDomains?.includes('sb-control.fixture.test')), false,
    'the redirect replaces the plain main_frame block of an unnarrowed document block');

    // Unsupported entries are reported, never emitted.
    const mainRules = await readJSON('rulesets/main/honesty-a.json');
    assert.equal(JSON.stringify(mainRules).includes('~keep'), false);
    assert.equal(mainRules.some(rule =>
        rule.condition.requestDomains?.includes('rr.fixture.test')), false);
    assert.ok(mainRules.some(rule =>
        rule.action.redirect?.transform?.queryTransform?.removeParams?.[0] === 'utm_source'));
    // expandRemoveparamsRule() reports a main_frame-only rule which matches no
    // navigation, which must then be discarded
    assert.equal(mainRules.some(rule =>
        rule.action.redirect?.transform?.queryTransform?.removeParams?.[0] === 'r'), false);
    const locationRule = mainRules.find(rule =>
        rule.action.responseHeaders?.[0]?.header === 'location');
    assert.deepEqual(locationRule.condition.requestDomains, [ 'fixture.test' ]);
    assert.equal(locationRule.condition.initiatorDomains, undefined);

    // Every redirect resource the runtime compiler accepts is packaged and
    // web-accessible, except those listed as unavailable.
    const manifest = await readJSON('manifest.json');
    const webAccessible = manifest.web_accessible_resources
        .filter(entry => entry.matches.includes('<all_urls>'))
        .flatMap(entry => entry.resources);
    const generated = await readJSON('rulesets/redirect-resources.json');
    assert.equal(generated.schemaVersion, 1);
    assert.deepEqual(generated.unavailable, {
        'click2load.html': 'requires-click-to-load-page',
    });
    let packagedCount = 0;
    for ( const [ name, metadata ] of redirectResources ) {
        const tokens = [ name, ...[ metadata.alias ?? [] ].flat() ];
        if ( name === 'click2load.html' ) {
            assert.equal(webAccessible.includes(`web_accessible_resources/${name}`), false);
            await assert.rejects(fs.stat(path.join(outputDir, 'web_accessible_resources', name)));
            continue;
        }
        const resourcePath = `web_accessible_resources/${name}`;
        assert.ok(webAccessible.includes(resourcePath), `${name} is web-accessible`);
        const packaged = await fs.readFile(path.join(outputDir, resourcePath));
        const upstream = await fs.readFile(fromRoot(`src/${resourcePath}`));
        assert.deepEqual(packaged, upstream, `${name} is the upstream resource`);
        for ( const token of tokens ) {
            assert.equal(generated.resources[token], `/${resourcePath}`, token);
        }
        packagedCount += 1;
    }
    assert.equal(packagedCount, redirectResources.size - 1);
    for ( const name of [ 'noop-vast4.xml', 'noeval.js', 'google-ima-dai.js', 'noop-0.5s.mp3' ] ) {
        assert.ok(webAccessible.includes(`web_accessible_resources/${name}`), name);
    }
    const warEntry = manifest.web_accessible_resources.find(entry =>
        entry.resources.includes('web_accessible_resources/noop.js'));
    assert.equal(warEntry.use_dynamic_url, true);

    // validate-mv3.mjs accepts the counts and resources of this build (the
    // fixture is not a complete extension, so other errors are expected) and
    // reports every inconsistency.
    // The validator loads js/redirect-resources.js and js/ubo-parser.js from
    // the extension, as packaged by the build.
    await fs.cp(path.join(buildDir, 'js'), path.join(outputDir, 'js'), { recursive: true });
    await fs.cp(path.join(buildDir, 'lib'), path.join(outputDir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(outputDir, 'package.json'), '{"type":"module"}\n');
    const validate = async ( ) => {
        const result = await run(process.execPath, [
            fromRoot('tools/validate-mv3.mjs'), outputDir,
        ], { maxBuffer: 64 * 1024 * 1024 }).catch(error => error);
        assert.doesNotMatch(result.stderr, /^\s+at .+:\d+:\d+\)?\r?$/m,
            'The validator ran to completion');
        return result.stderr;
    };
    const countErrors = /Ruleset|ruleset details|Build log|[Rr]edirect/;
    const baseline = await validate();
    assert.doesNotMatch(baseline, countErrors, baseline);
    const detailsPath = path.join(outputDir, 'rulesets', 'ruleset-details.json');
    const logPath = path.join(outputDir, 'log.txt');
    const tamper = async (file, edit, expected) => {
        const original = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, edit(original));
        try {
            assert.match(await validate(), expected);
        } finally {
            await fs.writeFile(file, original);
        }
    };
    const editDetails = edit => text => {
        const value = JSON.parse(text);
        const entry = value.find(a => a.id === 'honesty-a');
        edit(entry.rules, entry.filters);
        return JSON.stringify(value);
    };
    await tamper(detailsPath, editDetails(rules => { rules.rejected = 0; }),
        /Ruleset honesty-a rejected reasons add up to 8, not 0/);
    await tamper(detailsPath, editDetails(rules => {
        rules.rejected = 0;
        rules.rejectedReasons = undefined;
    }), /Ruleset honesty-a reports 0 rejected filters, the compiler rejected 8/);
    // Entries, not filters: the compiler output has 9 rejected entries
    await tamper(detailsPath, editDetails(rules => {
        rules.rejected = 9;
        rules.rejectedReasons['unsupported-strict-third-party'] += 1;
    }), /Ruleset honesty-a reports 9 rejected filters, the compiler rejected 8/);
    await tamper(detailsPath, editDetails(rules => {
        rules.rejectedReasons = { 'Bad Reason': 8 };
    }), /Ruleset honesty-a has malformed rejected reasons/);
    await tamper(detailsPath, editDetails(rules => { rules.plain += 1; }),
        /Ruleset honesty-a reports \d+ plain rules, the package has \d+/);
    await tamper(detailsPath, editDetails(rules => { rules.total += 1; }),
        /Ruleset honesty-a total rule count does not add up/);
    await tamper(detailsPath, editDetails((rules, filters) => { filters.converted = 6; }),
        /Ruleset honesty-a reports 6 converted filters, the compiler converted 5/);
    await tamper(detailsPath, editDetails((rules, filters) => { filters.converted = undefined; }),
        /Ruleset honesty-a has an invalid converted filter count/);
    await tamper(logPath, text => text.replace('\tUnsupported: 8\n', '\tUnsupported: 0\n'),
        /Build log and ruleset details disagree on rejected filters in honesty-a/);
    const manifestPath = path.join(outputDir, 'manifest.json');
    await tamper(manifestPath, text => text.replace(
        '"web_accessible_resources/noop-vast4.xml",', ''),
    /Redirect resource noop-vast4.xml is not web-accessible/);
    const generatedPath = path.join(outputDir, 'rulesets', 'redirect-resources.json');
    const editGenerated = edit => text => {
        const value = JSON.parse(text);
        edit(value);
        return JSON.stringify(value);
    };
    await tamper(generatedPath, text => text.replace('"click2load.html"', '"click2load-x"'),
        /Redirect resource click2load.html must be either packaged or listed as unavailable/);
    await tamper(generatedPath, editGenerated(value => {
        value.resources['not-a-resource'] = '/web_accessible_resources/noop.js';
    }), /Unknown redirect resource listed: not-a-resource/);
    await tamper(generatedPath, editGenerated(value => {
        value.unavailable['click2load.html'] = '';
    }), /Unavailable redirect resource click2load.html has no reason/);

    // A redirect resource which cannot be found fails the build.
    await fs.rm(path.join(buildDir, 'web_accessible_resources', 'noop.js'));
    const missingOutputDir = path.join(temporaryRoot, 'build', 'missing-resource');
    await fs.mkdir(missingOutputDir);
    await fs.copyFile(fromRoot('platform/mv3/chromium/manifest.json'),
        path.join(missingOutputDir, 'manifest.json'));
    const failed = await run(process.execPath, [
        '--no-warnings', 'make-rulesets.js',
        `output=${missingOutputDir}`, 'platform=chromium',
    ], { cwd: buildDir, maxBuffer: 64 * 1024 * 1024 }).catch(error => error);
    assert.notEqual(failed.code ?? 0, 0, 'The build fails');
    assert.match(failed.stderr, /Redirect resource not found: noop\.js/);
    await assert.rejects(fs.stat(path.join(missingOutputDir, 'rulesets', 'ruleset-details.json')));
} finally {
    // This is the exact directory returned by mkdtemp for this test only.
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Stock compiler honesty tests passed');
