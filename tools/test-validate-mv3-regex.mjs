/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// validate-mv3.mjs on Chromium packages whose stock regex rules are part of
// the lists' static rulesets (roadmap step 2):
// - main/<id>.json holds `plain` + `regexStatic` rules, the regex rules
//   last; `total` is plain + regexStatic + regex;
// - all the static regex rules together stay within Chrome's limit of 1000,
//   and each is inside the portable RE2 subset (one Chrome rejects would
//   make the unpacked extension fail to load);
// - rulesets/regex-details.json matches them (count, digest), and release
//   builds name the Chrome which checked them;
// - strict-block rules are extensionPath redirects to /strictblock.html at
//   priority 29 for main_frame only, without regexSubstitution;
// - strict-block rejected filters add up from their reasons.
//
// The fixture package is built by make-rulesets.js from fixture lists, with
// cached Chrome verdicts (no Chrome is started), then tampered with.
//
//   node tools/test-validate-mv3-regex.mjs [--validator <validate-mv3.mjs>]
//
// --validator runs another copy of the validator, for example the one of an
// earlier commit, to check that this test catches its gaps.

import {
    prepareOutput,
    readJSON,
    runMakeRulesets,
    stageRulesetBuild,
} from './stock-ruleset-harness.mjs';
import assert from 'node:assert/strict';
import { dnrRulesetFromRawLists } from '../src/js/static-dnr-filtering.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { regexDetailsDigest } from '../platform/mv3/stock-regex.js';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const validatorArg = process.argv.indexOf('--validator');
const validator = validatorArg !== -1
    ? path.resolve(process.argv[validatorArg + 1])
    : path.join(projectRoot, 'tools', 'validate-mv3.mjs');

const regexFilter = (list, i) =>
    `/^https?:\\/\\/r${i}\\.${list}\\.fixture\\.test\\/[a-z]+/$script`;
const sbRegexOk = '/^https?:\\/\\/sb-re\\.fixture\\.test\\/[a-z]+/$doc';
const sbRegexMemory = '/^https?:\\/\\/sb-memory\\.fixture\\.test\\/[a-z]{1,9}/$doc';

const fixtureRulesets = [ {
    id: 'vr-a',
    name: 'Validator A',
    group: 'default',
    enabled: true,
    urls: [],
    filters: [
        '||ads.vr-a.fixture.test^',
        '||vr-a.fixture.test/ads^$script',
        '||sb-a.fixture.test^$doc',
        '||sb-path.fixture.test/x^$document',
        sbRegexOk,
        sbRegexMemory,
        regexFilter('vr-a', 0),
        regexFilter('vr-a', 1),
        regexFilter('vr-a', 2),
    ],
}, {
    id: 'vr-b',
    name: 'Validator B',
    group: 'default',
    enabled: false,
    urls: [],
    filters: [
        '||ads.vr-b.fixture.test^',
        regexFilter('vr-b', 0),
        regexFilter('vr-b', 1),
    ],
} ];

// Chrome's verdicts, as regex-verdicts.mjs caches them: every regex is
// supported, except one strict-block regex over the memory limit.
const verdictCache = async ( ) => {
    const verdicts = {};
    for ( const list of fixtureRulesets ) {
        const result = await dnrRulesetFromRawLists(
            [ { name: list.id, text: list.filters.join('\n') } ],
            { env: [ 'chromium', 'native_css_has', 'mv3', 'ublock', 'ubol' ] }
        );
        for ( const rule of result.network.ruleset ) {
            const regex = rule.condition?.regexFilter;
            if ( typeof regex !== 'string' ) { continue; }
            const memory = rule._sourceFilters?.includes(sbRegexMemory);
            verdicts[JSON.stringify([ regex, false, false ])] = memory
                ? 'memoryLimitExceeded'
                : 'ok';
        }
    }
    return { schemaVersion: 1, chromeVersion: 'Chrome/153.0.0.0', verdicts };
};

const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, 'ublock-plus-validate-regex-')
);

try {
    const buildDir = path.join(temporaryRoot, 'ruleset-build');
    await stageRulesetBuild(buildDir);
    await fs.writeFile(path.join(buildDir, 'rulesets.json'),
        JSON.stringify(fixtureRulesets));
    const outputDir = await prepareOutput(temporaryRoot);
    await fs.writeFile(
        path.join(temporaryRoot, 'build', 'mv3-data', 'regex-verdicts.json'),
        JSON.stringify(await verdictCache())
    );
    const built = await runMakeRulesets(buildDir, outputDir);
    assert.equal(built.code ?? 0, 0, built.stderr);
    // The validator loads js/redirect-resources.js and js/ubo-parser.js from
    // the extension, as packaged by the build.
    await fs.cp(path.join(buildDir, 'js'), path.join(outputDir, 'js'), { recursive: true });
    await fs.cp(path.join(buildDir, 'lib'), path.join(outputDir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(outputDir, 'package.json'), '{"type":"module"}\n');

    // The fixture build is what the validator must accept.
    const details = await readJSON(outputDir, 'rulesets/ruleset-details.json');
    const rulesOf = id => details.find(entry => entry.id === id).rules;
    assert.equal(rulesOf('vr-a').regexStatic, 3);
    assert.equal(rulesOf('vr-b').regexStatic, 2);
    assert.equal(rulesOf('vr-a').strictblockRejected, 1);
    const regexDetails = await readJSON(outputDir, 'rulesets/regex-details.json');
    assert.equal(regexDetails.verifiedWith, 'Chrome/153.0.0.0');
    assert.equal(regexDetails.staticRegexCount, 5);
    const strictblock = await readJSON(outputDir, 'rulesets/strictblock/vr-a.json');
    assert.ok(strictblock.some(rule => typeof rule.condition.regexFilter === 'string'));

    // The fixture is not a complete extension: only the errors about rule
    // counts, regex rules and strict blocking are this test's concern.
    const relevant = new RegExp('^ERROR: (?:' + [
        'Ruleset ', 'DNR r', 'Static regex', 'Static rulesets', 'Strict-block ',
        'rulesets/regex-details', 'Release builds must have their static',
        'Build log', '/strictblock\\.html must',
    ].join('|') + ')');
    const validate = async (...args) => {
        const result = await run(process.execPath, [ validator, outputDir, ...args ],
            { maxBuffer: 64 * 1024 * 1024 }
        ).catch(error => error);
        assert.doesNotMatch(result.stderr, /^\s+at .+:\d+:\d+\)?\r?$/m,
            'The validator ran to completion');
        return result.stderr.split(/\r?\n/)
            .filter(line => relevant.test(line))
            .join('\n');
    };
    assert.equal(await validate(), '', 'The fixture build is valid');
    assert.equal(await validate('--release'), '', 'The fixture build is a valid release');

    const file = relative => path.join(outputDir, relative);
    const tamper = async (relative, edit, expected, args = []) => {
        const original = await fs.readFile(file(relative), 'utf8');
        const edited = edit(original);
        assert.notEqual(edited, original, `${relative} was edited`);
        await fs.writeFile(file(relative), edited);
        try {
            const errors = await validate(...args);
            for ( const pattern of [ expected ].flat() ) {
                assert.match(errors, pattern);
            }
            return errors;
        } finally {
            await fs.writeFile(file(relative), original);
        }
    };
    const editJSON = edit => text => {
        const value = JSON.parse(text);
        edit(value);
        return JSON.stringify(value);
    };
    const editDetails = (id, edit) => editJSON(value => {
        edit(value.find(entry => entry.id === id).rules);
    });
    const isRegex = rule => typeof rule.condition.regexFilter === 'string';

    // Count identities
    await tamper('rulesets/ruleset-details.json',
        editDetails('vr-a', rules => { rules.regexStatic += 1; rules.total += 1; }),
        /Ruleset vr-a reports 4 regexStatic rules, the package has 3/);
    await tamper('rulesets/ruleset-details.json',
        editDetails('vr-a', rules => { rules.plain += 3; rules.regexStatic = 0; }),
        [ /Ruleset vr-a reports \d+ plain rules, the package has \d+/,
            /Ruleset vr-a reports 0 regexStatic rules, the package has 3/ ]);
    // The identity of packages with dynamic regex rules only
    await tamper('rulesets/ruleset-details.json',
        editDetails('vr-a', rules => { rules.total = rules.plain + rules.regex; }),
        /Ruleset vr-a total rule count does not add up/);
    await tamper('rulesets/ruleset-details.json',
        editDetails('vr-a', rules => { rules.regexStatic = undefined; }),
        /Ruleset vr-a has no valid static regex rule count/);

    // Static regex rules come last, and inside the portable RE2 subset.
    await tamper('rulesets/main/vr-a.json', editJSON(rules => {
        const regex = rules.findLast(isRegex);
        rules.splice(rules.indexOf(regex), 1);
        rules.unshift(regex);
    }), /DNR ruleset vr-a has regex rules before other rules/);
    await tamper('rulesets/main/vr-a.json', editJSON(rules => {
        rules.find(isRegex).condition.regexFilter = '^https?://(a+)\\1/';
    }), [ /Static regex rule vr-a\/\d+ is outside the portable RE2 subset \(backreference/,
        /regex-details.json digest does not match the packaged static regex rules/ ]);

    // rulesets/regex-details.json
    await tamper('rulesets/regex-details.json', editJSON(value => {
        value.staticRegexCount += 1;
    }), /regex-details.json counts 6 static regex rules, the package has 5/);
    await tamper('rulesets/regex-details.json', editJSON(value => {
        value.digest = '0'.repeat(64);
    }), /regex-details.json digest does not match the packaged static regex rules/);
    await tamper('rulesets/regex-details.json', editJSON(value => {
        value.schemaVersion = 2;
    }), /rulesets\/regex-details.json is missing or invalid/);
    await tamper('rulesets/regex-details.json', editJSON(value => {
        value.staticRegexLimit = 1001;
    }), /regex-details.json has an invalid static regex limit: 1001/);
    await tamper('rulesets/regex-details.json', editJSON(value => {
        value.verifiedWith = 'checked';
    }), /regex-details.json names no browser version: checked/);
    // Unverified regexes are fine for a development build, not for a release.
    const unverified = editJSON(value => { value.verifiedWith = ''; });
    assert.equal(await tamper('rulesets/regex-details.json', unverified, [ /^$/ ]), '');
    await tamper('rulesets/regex-details.json', unverified,
        /Release builds must have their static regex rules checked by Chrome/,
        [ '--release' ]);
    await tamper('log.txt', text => text.replace('\nStatic regex rules: 5/1000 (',
        '\nStatic regex rules: 4/1000 ('),
    /Build log and regex-details.json disagree on static regex rules/);

    // Chrome's limit for the static rulesets as a whole: 1000 regex rules,
    // disabled rulesets included. The counts and the digest agree here.
    {
        const mainPath = file('rulesets/main/vr-b.json');
        const detailsPath = file('rulesets/ruleset-details.json');
        const regexDetailsPath = file('rulesets/regex-details.json');
        const originals = await Promise.all([ mainPath, detailsPath, regexDetailsPath ]
            .map(filePath => fs.readFile(filePath, 'utf8')));
        try {
            const main = JSON.parse(originals[0]);
            let id = Math.max(...main.map(rule => rule.id));
            for ( let i = 0; i < 996; i++ ) {
                main.push({
                    id: ++id,
                    action: { type: 'block' },
                    condition: {
                        regexFilter: `^https?://x${i}\\.vr-b\\.fixture\\.test/`,
                        resourceTypes: [ 'script' ],
                    },
                });
            }
            await fs.writeFile(mainPath, JSON.stringify(main));
            await fs.writeFile(detailsPath, editDetails('vr-b', rules => {
                rules.regexStatic += 996;
                rules.total += 996;
            })(originals[1]));
            const entries = [];
            for ( const id of [ 'vr-a', 'vr-b' ] ) {
                for ( const rule of await readJSON(outputDir, `rulesets/main/${id}.json`) ) {
                    if ( isRegex(rule) === false ) { continue; }
                    entries.push([ id, rule.condition.regexFilter,
                        rule.condition.isUrlFilterCaseSensitive === true ]);
                }
            }
            assert.equal(entries.length, 1001);
            await fs.writeFile(regexDetailsPath, editJSON(value => {
                value.staticRegexCount = entries.length;
                value.digest = regexDetailsDigest(entries);
            })(originals[2]));
            const errors = await validate();
            assert.match(errors, /Static rulesets have 1001 regex rules, over Chrome's limit of 1000/);
            assert.doesNotMatch(errors, /reports|digest|counts 1001/);
        } finally {
            await fs.writeFile(mainPath, originals[0]);
            await fs.writeFile(detailsPath, originals[1]);
            await fs.writeFile(regexDetailsPath, originals[2]);
        }
    }

    // Strict-block rules: extensionPath redirects of top-level documents.
    const editFirstStrictBlock = edit => editJSON(rules => { edit(rules[0]); });
    const sbFile = 'rulesets/strictblock/vr-a.json';
    await tamper(sbFile, editFirstStrictBlock(rule => { rule.priority = 10; }),
        /Strict-block ruleset vr-a: 1 rule\(s\) do not have priority 29 \(first: rule 1\)/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.action.redirect = { regexSubstitution: 'chrome-extension://x/strictblock.html#\\0' };
    }), /Strict-block ruleset vr-a: 1 rule\(s\) use a regexSubstitution/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.action.redirect.extensionPath = '/document-blocked.html';
    }), /Strict-block ruleset vr-a: 1 rule\(s\) do not redirect to extensionPath \/strictblock.html/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.action = { type: 'block' };
    }), /Strict-block ruleset vr-a: 1 rule\(s\) are not redirects/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.condition.resourceTypes = [ 'main_frame', 'sub_frame' ];
    }), /Strict-block ruleset vr-a: 1 rule\(s\) are not limited to resourceTypes \[ main_frame \]/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.condition = { resourceTypes: [ 'main_frame' ] };
    }), /Strict-block ruleset vr-a: 1 rule\(s\) have no URL condition/);
    await tamper(sbFile, editFirstStrictBlock(rule => {
        rule.condition._sourceFilters = [ '||sb-a.fixture.test^$doc' ];
    }), /Strict-block ruleset vr-a: 1 rule\(s\) carry private build properties/);
    await tamper(sbFile, editJSON(rules => {
        rules.find(isRegex).condition.regexFilter = '^https?://(?=a)b/';
    }), /Strict-block ruleset vr-a: 1 rule\(s\) have a regexFilter outside the portable RE2 subset/);
    await tamper('manifest.json', editJSON(value => {
        value.web_accessible_resources = value.web_accessible_resources.filter(entry =>
            entry.resources.includes('/strictblock.html') === false);
    }), /\/strictblock.html must be web-accessible to <all_urls>/);

    // Strict-block rejected filters add up from their reasons.
    await tamper('rulesets/ruleset-details.json', editDetails('vr-a', rules => {
        rules.strictblockRejected = 2;
    }), /Ruleset vr-a strict-block rejected reasons add up to 1, not 2/);
    await tamper('rulesets/ruleset-details.json', editDetails('vr-a', rules => {
        rules.strictblockRejectedReasons = undefined;
    }), /Ruleset vr-a has 1 strict-block rejected filters without reasons/);
    await tamper('rulesets/ruleset-details.json', editDetails('vr-a', rules => {
        rules.strictblockRejectedReasons = { 'Memory': 1 };
    }), /Ruleset vr-a has malformed strict-block rejected reasons/);
} finally {
    // This is the exact directory returned by mkdtemp for this test only.
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('validate-mv3 static regex and strict-block tests passed');
