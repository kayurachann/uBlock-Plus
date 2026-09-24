/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// The static regex rules of a built Chromium package, in a real Chrome:
//
//   node tools/test-static-regex-chrome.mjs [--extension dist/build/uBlockPlus.chromium]
//       [--chrome <chrome.exe>] [--output report.json] [--timeout 300000]
//
// Chrome refuses to load an unpacked extension when a regex of any of its
// static rulesets (enabled or not) is one its RE2 rejects as a syntax error,
// and silently skips a static regex over its memory limit. This test:
// - loads a copy of the package unpacked (Extensions.loadUnpacked), headless,
//   in a fresh temporary profile;
// - checks that the enabled rulesets are the manifest defaults;
// - asks isRegexSupported() about every packaged static regex: all must be
//   supported by this Chrome;
// - enables the 50 rulesets with the most static regex rules (Chrome's limit
//   of enabled rulesets) and checks that Chrome enabled them;
// - checks that the static regex rules leave the regex pool shared by dynamic
//   and session rules alone: the extension's own report, and Chrome
//   accepting that many more dynamic regex rules;
// - writes a JSON report, closes Chrome and removes the profile and the copy.
//
// Nothing reaches the network: every host name resolves to nothing.

import {
    cdp,
    closeChrome,
    copyExtension,
    createTempDir,
    findChrome,
    installHardTimeout,
    launchChrome,
    parseOptions,
    removeTempDir,
} from './chrome-cdp-harness.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';

const options = parseOptions(process.argv.slice(2), {
    extension: 'dist/build/uBlockPlus.chromium',
    chrome: '',
    output: '',
    timeout: 300000,
});
const clearHardTimeout = installHardTimeout(options.timeout, 'Static regex Chrome test');
const extensionSource = path.resolve(options.extension);
const chromePath = findChrome(options.chrome);
assert.ok(chromePath !== '', 'Chrome not found: use --chrome <path> or CHROME_PATH');

// Chrome: MAX_NUMBER_OF_ENABLED_STATIC_RULESETS
const MAX_ENABLED_RULESETS = 50;
// A dynamic rule ID range no part of the extension uses (dnr-namespaces.js).
const HEADROOM_RULE_BASE = 6500000;

const report = {
    extension: extensionSource,
    chrome: chromePath,
    startedAt: new Date().toISOString(),
    steps: [],
};
const step = (name, details = {}) => {
    report.steps.push({ name, ...details });
    console.log(`ok - ${name}${Object.keys(details).length !== 0 ? ` ${JSON.stringify(details)}` : ''}`);
};

/******************************************************************************/

// What the package declares.
const manifest = JSON.parse(await readFile(path.join(extensionSource, 'manifest.json'), 'utf8'));
const ruleResources = manifest.declarative_net_request?.rule_resources ?? [];
assert.ok(ruleResources.length !== 0, 'The package declares static rulesets');
const manifestDefaults = ruleResources.filter(resource => resource.enabled)
    .map(resource => resource.id).sort();
const staticRegex = [];
const regexPerRuleset = new Map();
for ( const resource of ruleResources ) {
    const rules = JSON.parse(await readFile(
        path.join(extensionSource, resource.path.replace(/^\/+/, '')), 'utf8'
    ));
    let count = 0;
    for ( const rule of rules ) {
        if ( typeof rule.condition?.regexFilter !== 'string' ) { continue; }
        count += 1;
        staticRegex.push({
            rulesetId: resource.id,
            ruleId: rule.id,
            options: {
                regex: rule.condition.regexFilter,
                isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
                requireCapturing: false,
            },
        });
    }
    regexPerRuleset.set(resource.id, count);
}
const regexDetails = JSON.parse(await readFile(
    path.join(extensionSource, 'rulesets', 'regex-details.json'), 'utf8'
));
report.package = {
    version: manifest.version,
    rulesets: ruleResources.length,
    defaults: manifestDefaults,
    staticRegex: staticRegex.length,
    regexDetails,
};
assert.equal(regexDetails.staticRegexCount, staticRegex.length,
    'regex-details.json counts the packaged static regex rules');

/******************************************************************************/

let browser;
let extensionDir;
let profileDir;
let failure;
try {
    extensionDir = await copyExtension(extensionSource, 'ublock-plus-static-regex-package-');
    profileDir = await createTempDir('ublock-plus-static-regex-profile-');
    browser = await launchChrome({
        chromePath,
        profileDir,
        // No traffic: every host name resolves to nothing.
        args: [ '--host-resolver-rules=MAP * ~NOTFOUND' ],
    });
    report.browser = browser.product;
    const { evaluate, openTab, waitFor } = cdp(browser);

    // A static regex Chrome's RE2 rejects makes this fail.
    const loadStart = Date.now();
    const { id } = await browser.send('Extensions.loadUnpacked', { path: extensionDir },
        undefined, 60000);
    report.extensionId = id;
    report.loadMs = Date.now() - loadStart;
    step('the package loads unpacked', { browser: browser.product, ms: report.loadMs });

    const page = await openTab(`chrome-extension://${id}/dashboard.html`);
    const inPage = (expression, timeoutMs) =>
        evaluate(page.sessionId, expression, { timeoutMs });
    await waitFor(( ) => inPage(`typeof chrome.declarativeNetRequest?.getEnabledRulesets === 'function'`),
        { what: 'the dashboard page' });
    // Every message waits for the service worker's initialization.
    await inPage(`import('./js/ext.js').then(ext => ext.sendMessage({ what: 'getCurrentConfig' }))`,
        60000);
    const enabledRulesets = async ( ) =>
        (await inPage('chrome.declarativeNetRequest.getEnabledRulesets()')).sort();
    const enabledAtStart = await enabledRulesets();
    report.enabledAtStart = enabledAtStart;
    assert.deepEqual(enabledAtStart, manifestDefaults,
        'The enabled rulesets are the manifest defaults');
    step('the manifest default rulesets are enabled', { rulesets: enabledAtStart.length });

    // Every packaged static regex is supported by this Chrome.
    const verdicts = await inPage(`Promise.all(${JSON.stringify(staticRegex.map(a => a.options))}
        .map(options => chrome.declarativeNetRequest.isRegexSupported(options).then(
            result => result.isSupported ? 'ok' : String(result.reason || 'unsupported'),
            reason => 'error: ' + reason
        )))`, 120000);
    const unsupported = staticRegex.map((entry, i) => ({ ...entry, verdict: verdicts[i] }))
        .filter(entry => entry.verdict !== 'ok');
    report.staticRegexChecked = {
        checked: verdicts.length,
        ok: verdicts.length - unsupported.length,
        unsupported: unsupported.map(entry => ({
            rulesetId: entry.rulesetId,
            ruleId: entry.ruleId,
            verdict: entry.verdict,
            regex: entry.options.regex.slice(0, 200),
        })),
    };
    assert.equal(unsupported.length, 0,
        `Static regex rules this Chrome does not support: ${JSON.stringify(report.staticRegexChecked.unsupported.slice(0, 10))}`);
    step('every static regex is supported', { checked: verdicts.length });

    // The 50 rulesets with the most static regex rules.
    const top = Array.from(regexPerRuleset)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, MAX_ENABLED_RULESETS)
        .map(([ rulesetId ]) => rulesetId);
    const topRegex = top.reduce((sum, rulesetId) => sum + regexPerRuleset.get(rulesetId), 0);
    const toDisable = enabledAtStart.filter(rulesetId => top.includes(rulesetId) === false);
    const enableResult = await inPage(`chrome.declarativeNetRequest.updateEnabledRulesets(${JSON.stringify({
        enableRulesetIds: top,
        disableRulesetIds: toDisable,
    })}).then(( ) => 'ok', reason => String(reason))`, 60000);
    const enabledAfter = await enabledRulesets();
    report.enableMost = {
        rulesets: top.length,
        staticRegex: topRegex,
        result: enableResult,
        enabled: enabledAfter.length,
        availableStaticRuleCount: await inPage('chrome.declarativeNetRequest.getAvailableStaticRuleCount()'),
    };
    assert.equal(enableResult, 'ok', 'Chrome enables the rulesets with the most regex rules');
    assert.deepEqual(enabledAfter, top.slice().sort());
    step(`the ${top.length} rulesets with the most static regex rules are enabled`, {
        staticRegex: topRegex,
    });

    // The extension's own check of the enabled static regex rules
    // (Dashboard > Diagnostics > Check now), and its shared pool report.
    const capacity = await inPage(`import('./js/ext.js').then(ext =>
        ext.sendMessage({ what: 'getRegexCapacity', verifyStatic: true }))`, 120000);
    report.regexCapacity = capacity;
    assert.equal(capacity?.schemaVersion, 1, 'getRegexCapacity answers');
    assert.equal(capacity.static.enabled, topRegex);
    assert.equal(capacity.static.packaged, staticRegex.length);
    assert.equal(capacity.static.verifiedWith, regexDetails.verifiedWith);
    assert.equal(capacity.static.skippedByBrowser, 0, 'Check now finds no skipped regex');

    // Static regex rules do not use the regex pool of dynamic and session
    // rules: Chrome still accepts all of it.
    const headroom = await inPage(`(async ( ) => {
        const dnr = chrome.declarativeNetRequest;
        const isRegex = rule => typeof rule.condition.regexFilter === 'string';
        const used = (await dnr.getDynamicRules()).filter(isRegex).length +
            (await dnr.getSessionRules()).filter(isRegex).length;
        const free = dnr.MAX_NUMBER_OF_REGEX_RULES - used;
        const addRules = Array.from({ length: free }, (_, i) => ({
            id: ${HEADROOM_RULE_BASE} + i,
            priority: 1,
            action: { type: 'block' },
            condition: {
                regexFilter: '^https?://headroom' + i + '\\\\.invalid/',
                resourceTypes: [ 'xmlhttprequest' ],
            },
        }));
        let result = 'ok';
        try {
            await dnr.updateDynamicRules({ addRules });
        } catch ( reason ) {
            result = String(reason);
        }
        await dnr.updateDynamicRules({ removeRuleIds: addRules.map(rule => rule.id) });
        return { limit: dnr.MAX_NUMBER_OF_REGEX_RULES, used, added: free, result };
    })()`, 60000);
    report.sharedRegexHeadroom = headroom;
    assert.equal(headroom.result, 'ok', 'Chrome accepts the free shared regex rules');
    assert.equal(capacity.shared.free, headroom.limit - headroom.used);
    step('the shared regex pool stays free for dynamic and session rules', {
        free: headroom.added,
        limit: headroom.limit,
    });
    report.result = 'passed';
} catch ( reason ) {
    failure = reason;
    report.result = 'failed';
    report.error = String(reason?.stack ?? reason);
} finally {
    report.chromeForceKilled = await closeChrome(browser);
    report.profileRemoved = profileDir !== undefined && await removeTempDir(profileDir);
    report.packageCopyRemoved = extensionDir !== undefined && await removeTempDir(extensionDir);
    report.finishedAt = new Date().toISOString();
    if ( options.output !== '' ) {
        const output = path.resolve(options.output);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    clearHardTimeout();
}
if ( failure !== undefined ) { throw failure; }
assert.ok(report.profileRemoved && report.packageCopyRemoved, 'Temporary folders are removed');
console.log(`Static regex Chrome test passed on ${report.browser}: ` +
    `${report.staticRegexChecked.checked} static regex rules, ` +
    `${report.enableMost.rulesets} rulesets enabled.`);
