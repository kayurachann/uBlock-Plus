/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

// The runtime compiler (imported lists and "My filters") must never turn a
// filter option it cannot express into a broader rule. Each option either
// compiles like the stock build (src/js/static-dnr-filtering.js, as driven by
// platform/mv3/make-rulesets.js) or is rejected with a reason code that the
// compile report counts.

import { dnrErrorReason, dnrRulesetFromRawLists } from '../src/js/static-dnr-filtering.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { isCompiledListData } from '../platform/mv3/extension/js/compiled-cache.js';
import os from 'node:os';
import path from 'node:path';
import redirectResources from '../src/js/redirect-resources.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ublock-plus-runtime-filter-options-')
);

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
    const {
        NetworkFilterCompiler,
        expandRemoveparamsRule,
        parseNetworkFilter,
    } = await import(pathToFileURL(path.join(temporaryRoot, 'js/ubo-parser.js')));

    // Imported lists are untrusted; "My filters" are trusted.
    const compile = (lines, trustedSource = false) => {
        const parser = new sfp.AstFilterParser({ trustedSource, nativeCssHas: true });
        const compiler = new NetworkFilterCompiler({ listid: 'runtime-options-test' });
        const results = lines.map((line, index) => {
            parser.parse(line);
            assert.equal(parser.isNetworkFilter(), true, line);
            return compiler.add(parser, index + 1);
        });
        return { ...compiler.finish(), results };
    };
    // One filter, before cross-filter minimization, for exact comparisons.
    const runtimeRules = (line, trustedSource = false) => {
        const parser = new sfp.AstFilterParser({ trustedSource, nativeCssHas: true });
        parser.parse(line);
        const rules = [];
        const result = parseNetworkFilter(parser, { popupFilters: [] }, rules);
        return { result, rules, parserError: parser.hasError() };
    };

    // make-rulesets.js hands the stock converter every redirect-resources.js
    // name and alias whose file it packages, except click2load.html: that
    // page needs uBO's own scripts and the blocked frame URL as a parameter.
    const stockUnmapped = new Set([ 'click2load.html' ]);
    for ( const name of redirectResources.keys() ) {
        if ( stockUnmapped.has(name) ) { continue; }
        assert.ok(existsSync(path.join(projectRoot, 'src/web_accessible_resources', name)),
            `${name} has a packaged file, so the stock build maps it`);
    }
    const extensionPaths = [];
    for ( const [ name, details ] of redirectResources ) {
        if ( stockUnmapped.has(name) ) { continue; }
        const extensionPath = `/web_accessible_resources/${name}`;
        extensionPaths.push([ name, extensionPath ]);
        const aliases = details.alias === undefined ? []
            : Array.isArray(details.alias) ? details.alias : [ details.alias ];
        for ( const alias of aliases ) { extensionPaths.push([ alias, extensionPath ]); }
    }
    const stockRules = async line => {
        const result = await dnrRulesetFromRawLists([ { name: 'stock', text: line } ], {
            env: [ 'chromium', 'mv3', 'ubol', 'native_css_has' ],
            extensionPaths,
            secret: 'runtime-options-test',
        });
        return result.network.ruleset;
    };
    // Order-insensitive view of DNR rules; stock-only `_` metadata is dropped.
    const normalize = rules => rules.map(rule => JSON.stringify({
        action: rule.action,
        condition: rule.condition,
        priority: rule.priority ?? 1,
    }, (key, value) => {
        if ( key.startsWith('_') ) { return; }
        if ( Array.isArray(value) ) {
            return value.every(a => typeof a === 'string') ? value.slice().sort() : value;
        }
        if ( value instanceof Object ) {
            return Object.fromEntries(Object.keys(value).sort().map(k => [ k, value[k] ]));
        }
        return value;
    })).sort();
    const assertRejected = (lines, reasonCode, trustedSource = false) => {
        const compiled = compile(lines, trustedSource);
        assert.deepEqual(compiled.dnrRules, [], lines.join('\n'));
        assert.deepEqual(compiled.filterStats, {
            total: lines.length, accepted: 0, rejected: lines.length, routed: 0, deferred: 0,
        }, lines.join('\n'));
        assert.deepEqual(compiled.rejections, lines.map((line, index) => ({
            status: 'rejected', reasonCode, lineNumber: index + 1,
        })), lines.join('\n'));
    };
    // Enough of the DNR matching algorithm for the conditions emitted here.
    const isWithin = (hn, list) => list.some(d => hn === d || hn.endsWith(`.${d}`));
    const reFromUrlFilter = urlFilter => {
        let prefix = '';
        let suffix = '';
        if ( urlFilter.startsWith('||') ) {
            prefix = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?';
            urlFilter = urlFilter.slice(2);
        } else if ( urlFilter.startsWith('|') ) {
            prefix = '^';
            urlFilter = urlFilter.slice(1);
        }
        if ( urlFilter.endsWith('|') ) {
            suffix = '$';
            urlFilter = urlFilter.slice(0, -1);
        }
        const body = Array.from(urlFilter, c => {
            if ( c === '*' ) { return '.*'; }
            if ( c === '^' ) { return '(?:[^a-z0-9_.%-]|$)'; }
            return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        }).join('');
        return new RegExp(`${prefix}${body}${suffix}`, 'i');
    };
    const dnrMatches = (rule, { url, type, initiator }) => {
        const { condition } = rule;
        const { hostname } = new URL(url);
        if ( condition.resourceTypes?.includes(type) === false ) { return false; }
        if ( condition.excludedResourceTypes?.includes(type) ) { return false; }
        if ( condition.requestDomains && isWithin(hostname, condition.requestDomains) === false ) {
            return false;
        }
        if ( condition.excludedRequestDomains && isWithin(hostname, condition.excludedRequestDomains) ) {
            return false;
        }
        if ( condition.initiatorDomains &&
            (initiator === undefined || isWithin(initiator, condition.initiatorDomains) === false) ) {
            return false;
        }
        if ( condition.excludedInitiatorDomains && initiator !== undefined &&
            isWithin(initiator, condition.excludedInitiatorDomains) ) {
            return false;
        }
        if ( condition.urlFilter !== undefined &&
            reFromUrlFilter(condition.urlFilter).test(url) === false ) {
            return false;
        }
        if ( condition.regexFilter !== undefined &&
            new RegExp(condition.regexFilter).test(url) === false ) {
            return false;
        }
        return condition.domainType === undefined;
    };
    // DNR applies only the highest-priority matching rule; on a tie, allow
    // beats block, which beats redirect.
    const actionRanks = { allow: 3, block: 2, redirect: 1 };
    const winningRule = (rules, request) => rules
        .filter(rule => rule.action.type !== 'modifyHeaders' && dnrMatches(rule, request))
        .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) ||
            actionRanks[b.action.type] - actionRanks[a.action.type])[0];
    let checks = 0;

    // 1. $requestheader: DNR has no request-header condition. Dropping the
    //    option used to leave an unconditional block (or allow).
    assertRejected([
        '||example.test^$requestheader=x-foo:bar',
        '@@||example.test^$requestheader=x-foo:bar',
        '*$script,requestheader=x-foo:bar,domain=site.test',
    ], 'unsupported-requestheader');
    for ( const line of [ '||example.test^$requestheader=x-foo:bar' ] ) {
        const stock = await stockRules(line);
        assert.ok(stock.length !== 0 && stock.every(rule =>
            dnrErrorReason(rule._error?.[0]) === 'unsupported-requestheader'),
        'The stock build rejects $requestheader too, with the same reason code');
    }
    checks += 2;

    // 2. $empty and $mp4 are redirect=empty and redirect=noopmp4-1s (media).
    //    They used to become a plain block of every request type.
    const redirectFamily = [
        '||empty.test^$empty',
        '||empty.test^$empty,important',
        '||empty.test^$empty,script,3p,domain=site.test|~off.site.test',
        '||empty.test/ads/$empty,xhr',
        '||media.test^$mp4',
        '||media.test^$mp4,important',
        '||media.test^$mp4,domain=site.test',
        '/media\\.test\\/ad[0-9]+\\.mp4/$mp4',
    ];
    for ( const line of redirectFamily ) {
        const { result, rules } = runtimeRules(line);
        assert.equal(result.status, 'accepted', line);
        assert.equal(rules.length, 1, line);
        assert.deepEqual(normalize(rules), normalize(await stockRules(line)), line);
        const isMp4 = line.includes('$mp4');
        assert.deepEqual(rules[0].action, {
            type: 'redirect',
            redirect: {
                extensionPath: isMp4
                    ? '/web_accessible_resources/noop-1s.mp4'
                    : '/web_accessible_resources/empty',
            },
        }, line);
        assert.equal(rules[0].priority, line.includes('important') ? 41 : 11, line);
        if ( isMp4 ) {
            assert.deepEqual(rules[0].condition.resourceTypes, [ 'media' ], line);
        }
        assert.ok(existsSync(path.join(projectRoot, 'src', rules[0].action.redirect.extensionPath)));
        checks += 1;
    }
    assert.deepEqual(runtimeRules('||x.test^$empty').rules,
        runtimeRules('||x.test^$redirect=empty').rules);
    assert.deepEqual(runtimeRules('||x.test^$mp4').rules,
        runtimeRules('||x.test^$media,redirect=noopmp4-1s').rules);
    {
        const compiled = compile([ '||empty.test^$empty', '||media.test^$mp4' ]);
        assert.equal(compiled.filterStats.accepted, 2);
        assert.equal(compiled.dnrRules.every(rule => rule.action.type === 'redirect'), true);
    }
    checks += 3;

    // A redirect exception cancels the redirection but keeps any block. DNR
    // cannot express that, so it is rejected; $empty and $mp4 exceptions
    // used to become a priority-30 allow of every request type.
    const redirectExceptions = [
        '@@||empty.test^$empty',
        '@@||media.test^$mp4',
        '@@||x.test^$redirect=noop.js',
        '@@||x.test^$redirect',
        '@@||x.test^$rewrite=abp-resource:blank-js',
    ];
    assertRejected(redirectExceptions, 'unsupported-redirect-exception');
    {
        const compiled = compile([ '||ads.test^', '@@||ads.test^$empty', '@@||ads.test^$mp4' ]);
        assert.deepEqual(compiled.dnrRules.map(rule => rule.action.type), [ 'block' ],
            'A redirect exception must not unblock the request');
    }
    checks += 2;

    // 3. A bare $removeparam strips the whole query in classic uBO. An empty
    //    removeParams list is accepted by Chromium but strips nothing; DNR
    //    documents an empty URLTransform.query as clearing the query.
    for ( const line of [
        '||track.test^$removeparam',
        '||track.test^$queryprune',
        '||track.test^$removeparam=|',
        '||track.test^$removeparam,important',
    ] ) {
        const { result, rules } = runtimeRules(line);
        assert.equal(result.status, 'accepted', line);
        assert.deepEqual(rules[0].action, {
            type: 'redirect', redirect: { transform: { query: '' } },
        }, line);
        const stock = await stockRules(line);
        assert.deepEqual(stock[0].action, rules[0].action, `${line} matches the stock action`);
        // `important` deliberately differs from the stock build: see 6c.
        if ( line.includes('important') === false ) {
            assert.equal(rules[0].priority ?? 1, stock[0].priority ?? 1, line);
        }
        assert.equal(rules[0].condition.urlFilter, undefined, line);
        checks += 1;
    }
    {
        const compiled = compile([
            '||track.test^$removeparam',
            '*$removeparam,domain=site.test',
            '||keep.test^$removeparam=utm_source',
        ]);
        assert.equal(compiled.filterStats.rejected, 0);
        const json = JSON.stringify(compiled.dnrRules);
        assert.equal(json.includes('"removeParams":[]'), false,
            'No rule may carry an empty removeParams list');
        const clearing = compiled.dnrRules.filter(rule =>
            rule.action.redirect?.transform?.query === '');
        // Like removeParams rules, a navigation is keyed on its own hostname.
        assert.deepEqual(clearing.find(rule =>
            rule.condition.resourceTypes?.length === 1 &&
            rule.condition.resourceTypes[0] === 'main_frame' &&
            rule.condition.initiatorDomains === undefined
        )?.condition.requestDomains, [ 'site.test' ]);
        assert.ok(clearing.some(rule =>
            rule.condition.initiatorDomains?.includes('site.test') &&
            rule.condition.resourceTypes.includes('main_frame') === false));
        assert.ok(compiled.dnrRules.some(rule =>
            rule.action.redirect?.transform?.queryTransform?.removeParams?.[0] === 'utm_source'));
        const exception = runtimeRules('@@||track.test^$removeparam').rules;
        assert.deepEqual(exception[0].action, { type: 'allow' });
        checks += 1;
    }

    // 3b. A navigation is matched on its own hostname, which must satisfy
    //     both the request side (hostname pattern, `to=`) and `domain=`.
    //     Concatenated into one requestDomains list (an OR in DNR), the
    //     domain= sites lost their query on every page load.
    const navigation = url => ({
        url, type: 'main_frame', initiator: new URL(url).hostname,
    });
    for ( const [ lines, urls ] of [
        [ [ '||fastlane.rubiconproject.com^$removeparam,domain=aternos.org' ],
            [ 'https://aternos.org/server/?x=1' ] ],
        [ [ '||htlb.casalemedia.com^$removeparam=r,domain=aternos.org' ],
            [ 'https://aternos.org/?r=1' ] ],
        [ [ '*$removeparam,to=a.test,domain=site.test' ], [ 'https://site.test/?q=1' ] ],
        [ [ '*$removeparam=x,to=a.test,domain=site.test|other.test' ],
            [ 'https://site.test/?x=1', 'https://other.test/?x=1' ] ],
        [ [ '*$removeparam=x,to=sub.site.test,domain=site.test|other.test' ],
            [ 'https://site.test/?x=1', 'https://other.test/?x=1' ] ],
        [ [ '||track.test^$doc,removeparam,domain=site.test' ], [ 'https://site.test/?q=1' ] ],
        [ [ '||sub.site.test^$removeparam,domain=site.test' ], [ 'https://site.test/?q=1' ] ],
        [ [
            '||fastlane.rubiconproject.com^$removeparam,domain=aternos.org',
            '*$removeparam,to=a.test,domain=site.test',
        ], [ 'https://aternos.org/server/?x=1', 'https://site.test/?q=1' ] ],
    ] ) {
        const compiled = compile(lines);
        assert.equal(compiled.filterStats.accepted, lines.length, lines.join('\n'));
        for ( const url of urls ) {
            assert.equal(compiled.dnrRules.some(rule => dnrMatches(rule, navigation(url))), false,
                `${lines.join('\n')} must not rewrite ${url}`);
        }
        checks += 1;
    }
    for ( const [ line, url ] of [
        [ '*$removeparam=x,to=sub.site.test,domain=site.test|other.test', 'https://sub.site.test/?x=1' ],
        [ '*$removeparam=x,to=sub.site.test,domain=site.test|other.test', 'https://a.sub.site.test/?x=1' ],
        [ '||sub.site.test^$removeparam,domain=site.test', 'https://sub.site.test/?q=1' ],
        [ '||fastlane.rubiconproject.com^$removeparam,domain=fastlane.rubiconproject.com',
            'https://fastlane.rubiconproject.com/?q=1' ],
        [ '*$removeparam,domain=site.test', 'https://site.test/?q=1' ],
        [ '*$removeparam=x,domain=site.test|other.test', 'https://other.test/?x=1' ],
    ] ) {
        const { dnrRules } = compile([ line ]);
        assert.ok(dnrRules.some(rule => dnrMatches(rule, navigation(url)) &&
            rule.action.type === 'redirect'), `${line} still rewrites ${url}`);
        checks += 1;
    }
    {
        // A filter whose navigations can never satisfy both is accepted and
        // emits nothing: classic uBO never applies it either.
        const { result, rules } = runtimeRules('||track.test^$doc,removeparam,domain=site.test');
        assert.equal(result.status, 'accepted');
        assert.deepEqual(rules, []);
        // The stock build shares the expansion: it must not widen either.
        const stock = {
            action: { type: 'redirect',
                redirect: { transform: { queryTransform: { removeParams: [ 'r' ] } } } },
            condition: {
                requestDomains: [ 'htlb.casalemedia.com' ], initiatorDomains: [ 'aternos.org' ],
                resourceTypes: [ 'image', 'main_frame', 'sub_frame', 'xmlhttprequest' ],
                urlFilter: '^r=',
            },
        };
        const out = [ stock ];
        assert.equal(expandRemoveparamsRule(stock, out), true);
        assert.deepEqual(out, [ stock ]);
        assert.deepEqual(stock.condition.resourceTypes, [ 'image', 'sub_frame', 'xmlhttprequest' ]);
        const mainFrameOnly = structuredClone(stock);
        mainFrameOnly.condition.resourceTypes = [ 'main_frame' ];
        const before = structuredClone(mainFrameOnly);
        assert.equal(expandRemoveparamsRule(mainFrameOnly, [ mainFrameOnly ]), false);
        assert.deepEqual(mainFrameOnly, before, 'An unmatchable rule is left as it was');
        checks += 2;
    }

    // 4. Negated and regex values select keys by pattern; DNR removeParams
    //    takes exact keys only.
    assertRejected([
        '*$removeparam=~utm_source',
        '*$removeparam=~/^utm_/',
    ], 'unsupported-removeparam-negated');
    assertRejected([
        '*$removeparam=/^utm_/',
        '||track.test^$removeparam=/^(utm_source|fbclid)=/i',
        '*$removeparam=|utm_',
    ], 'unsupported-removeparam-regex');
    checks += 2;

    // 5. Redirect resources: every name and alias maps exactly as in the
    //    stock build, and whatever the stock build cannot map is rejected.
    const tokens = [];
    for ( const [ name, details ] of redirectResources ) {
        tokens.push(name);
        const aliases = details.alias === undefined ? []
            : Array.isArray(details.alias) ? details.alias : [ details.alias ];
        tokens.push(...aliases);
    }
    tokens.push('NOOP.JS', 'noop', 'missing-resource.js', 'noop.js:3', 'empty:9');
    for ( const token of tokens ) {
        const line = `||redirect.test^$redirect=${token}`;
        const { result, rules } = runtimeRules(line);
        const stock = await stockRules(line);
        if ( stock.some(rule => rule._error) ) {
            assert.equal(result.status, 'rejected', token);
            assert.equal(result.reasonCode, 'unsupported-redirect-resource', token);
            assert.deepEqual(rules, [], token);
        } else {
            assert.equal(result.status, 'accepted', token);
            assert.deepEqual(normalize(rules), normalize(stock), token);
            assert.ok(existsSync(path.join(projectRoot, 'src',
                rules[0].action.redirect.extensionPath)), token);
        }
        checks += 1;
    }
    assertRejected([ '||frame.test^$frame,redirect=click2load.html' ],
        'unsupported-redirect-resource');

    // 6a. An exception $uritransform only cancels a transform. It used to
    //     compile into the transform itself, and exceptions bypass the
    //     parser's trusted-source check, so an imported list could redirect.
    assertRejected([
        '@@/^https:\\/\\/a\\.test\\/(.*)/$uritransform=//https:\\/\\/evil.test\\/$1/',
        '@@||a.test^$uritransform',
    ], 'unsupported-urltransform-exception');
    {
        const { result, rules } = runtimeRules(
            '/^https:\\/\\/a\\.test\\/(.*)/$uritransform=//https:\\/\\/b.test\\/$1/', true);
        assert.equal(result.status, 'accepted', 'Trusted transforms still compile');
        assert.deepEqual(rules[0].action,
            { type: 'redirect', redirect: { regexSubstitution: 'https://b.test/\\1' } });
    }
    checks += 2;

    // 6b. `|` separates policies in $permissions; left in place it made the
    //     appended Permissions-Policy header unparseable, i.e. a no-op.
    {
        const line = '||perm.test^$permissions=camera=()|microphone=()';
        const { rules } = runtimeRules(line);
        assert.equal(rules[0].action.responseHeaders[0].value, 'camera=(), microphone=()');
        const stock = await stockRules(line);
        assert.equal(stock[0].action.responseHeaders[0].value, 'camera=(), microphone=()');
        checks += 1;
    }

    // 6c. `important` on a modifier filter was silently dropped: the rule kept
    //     priority 1, tied with the exceptions of its kind. Header rules are
    //     matched apart from blocks and, like the stock build, get 31.
    for ( const line of [
        "||csp.test^$csp=script-src 'none',important",
        '||perm.test^$permissions=camera=(),important',
    ] ) {
        const { rules } = runtimeRules(line);
        const stock = await stockRules(line);
        assert.equal(rules[0].priority, 31, line);
        assert.ok(stock.every(rule => rule.priority === 31), line);
        checks += 1;
    }
    assert.equal(runtimeRules('||track.test^$removeparam=utm_source').rules[0].priority, undefined);
    // A transform stays below every block (10): DNR applies only the top
    // matching rule, and one with nothing to change does nothing, so at the
    // stock build's 31 it cancelled the block. Classic uBO blocks first.
    for ( const [ line, trustedSource ] of [
        [ '||track.test^$removeparam=utm_source,important', false ],
        [ '||track.test^$removeparam,important', false ],
        [ '/^https:\\/\\/a\\.test\\/(.*)/$uritransform=//https:\\/\\/b.test\\/$1/,important', true ],
    ] ) {
        const { result, rules } = runtimeRules(line, trustedSource);
        assert.equal(result.status, 'accepted', line);
        assert.equal(rules[0].priority, 2, line);
        checks += 1;
    }
    {
        const { dnrRules } = compile([
            '||ads.test^$script',
            '||ads.test/ad.js$script,important,removeparam=utm',
            '||ads.test^$script,removeparam,important',
            '||tracker.test^$removeparam=utm,important',
            '@@||tracker.test^$removeparam=utm',
        ]);
        for ( const url of [
            'https://ads.test/ad.js', 'https://ads.test/ad.js?utm=1', 'https://ads.test/ad.js?q=1',
        ] ) {
            const request = { url, type: 'script', initiator: 'site.test' };
            assert.equal(winningRule(dnrRules, request)?.action.type, 'block', url);
        }
        // Still above the `@@$removeparam` exceptions, as in classic uBO.
        const request = { url: 'https://tracker.test/?utm=1', type: 'xmlhttprequest', initiator: 'site.test' };
        assert.deepEqual(winningRule(dnrRules, request)?.action.redirect,
            { transform: { queryTransform: { removeParams: [ 'utm' ] } } });
        checks += 2;
    }

    // 6d. `to=` narrows a hostname pattern (both must match). It used to
    //     replace the pattern, blocking every request to the `to=` domains.
    {
        const { rules } = runtimeRules('||cdn.test^$to=other.test');
        assert.deepEqual(rules[0].condition, {
            urlFilter: '||cdn.test^', requestDomains: [ 'other.test' ],
        });
        const nested = compile([
            '||sub.cdn.test^$script,to=cdn.test',
            '||sub.cdn.test^$to=cdn.test,removeparam=utm_source',
            '||cdn.test^$to=~img.cdn.test',
        ]);
        assert.equal(nested.filterStats.rejected, 0);
        const script = nested.dnrRules.find(rule => rule.action.type === 'block' &&
            rule.condition.resourceTypes?.includes('script'));
        assert.equal(script.condition.urlFilter, '||sub.cdn.test^');
        assert.deepEqual(script.condition.requestDomains, [ 'cdn.test' ]);
        const strip = nested.dnrRules.find(rule => rule.action.type === 'redirect');
        assert.equal(strip.condition.urlFilter, '||sub.cdn.test^*^utm_source=');
        const excluded = nested.dnrRules.find(rule =>
            rule.condition.excludedRequestDomains !== undefined);
        assert.deepEqual(excluded.condition.requestDomains, [ 'cdn.test' ]);
        assert.equal(excluded.condition.urlFilter, undefined);
        checks += 2;
    }

    // 6e. Guard: no option name the parser knows may compile to exactly the
    //     rule of the same filter without that option, unless the option is
    //     meaningless for matching. Covers every NODE_TYPE_NET_OPTION_NAME_*.
    const neutralOptions = new Set([ '_', 'reason' ]);
    const sampleValues = new Map([
        [ 'csp', "script-src 'none'" ], [ 'denyallow', 'x.test' ],
        [ 'from', 'site.test' ], [ 'domain', 'site.test' ],
        [ 'ipaddress', '1.2.3.4' ], [ 'method', 'post' ],
        [ 'permissions', 'camera=()' ], [ 'reason', 'blocked' ],
        [ 'redirect', 'noop.js' ], [ 'rewrite', 'noop.js' ],
        [ 'redirect-rule', 'noop.js' ], [ 'replace', '/a/b/' ],
        [ 'requestheader', 'x-a:b' ], [ 'responseheader', 'x-a:b' ],
        [ 'header', 'x-a:b' ], [ 'to', 'other.test' ], [ 'top', 'site.test' ],
        [ 'urlskip', '?url' ], [ 'uritransform', '//x/' ],
    ]);
    const optionNodeTypes = new Set(Object.entries(sfp)
        .filter(([ name ]) => name.startsWith('NODE_TYPE_NET_OPTION_NAME_'))
        .map(([ , value ]) => value));
    optionNodeTypes.delete(sfp.NODE_TYPE_NET_OPTION_NAME_NOT);
    optionNodeTypes.delete(sfp.NODE_TYPE_NET_OPTION_NAME_UNKNOWN);
    const scannedNodeTypes = new Set();
    for ( const [ name, nodeType ] of sfp.nodeTypeFromOptionName ) {
        if ( name === '' ) { continue; }
        scannedNodeTypes.add(nodeType);
        const suffix = name === 'denyallow' ? ',domain=site.test' : '';
        const option = sampleValues.has(name) ? `${name}=${sampleValues.get(name)}` : name;
        for ( const prefix of [ '', '@@' ] ) {
            for ( const trustedSource of [ false, true ] ) {
                const line = `${prefix}||opt.test^$${option}${suffix}`;
                const actual = runtimeRules(line, trustedSource);
                if ( actual.parserError || actual.result.status !== 'accepted' ) {
                    if ( actual.parserError === false ) {
                        assert.match(actual.result.reasonCode, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, line);
                    }
                    continue;
                }
                if ( neutralOptions.has(name) ) { continue; }
                const plain = runtimeRules(`${prefix}||opt.test^${suffix ? `$${suffix.slice(1)}` : ''}`,
                    trustedSource);
                assert.notDeepEqual(actual.rules, plain.rules,
                    `$${name} silently compiles to the rule without it: ${line}`);
            }
        }
        checks += 1;
    }
    assert.deepEqual(Array.from(optionNodeTypes).filter(type => scannedNodeTypes.has(type) === false),
        [], 'Every option node type has a name the guard exercises');

    // 7. The new reason codes travel through the existing compile report:
    //    the cached list data which carries filterStats and rejections must
    //    still pass the validator applied before activation.
    {
        const compiled = compile([
            '||example.test^$requestheader=x-foo:bar',
            '@@||empty.test^$empty',
            '@@/^https:\\/\\/a\\.test\\/(.*)/$uritransform=//https:\\/\\/evil.test\\/$1/',
            '||empty.test^$empty',
            '||track.test^$removeparam',
        ]);
        assert.deepEqual(compiled.rejections.map(a => [ a.lineNumber, a.reasonCode ]), [
            [ 1, 'unsupported-requestheader' ],
            [ 2, 'unsupported-redirect-exception' ],
            [ 3, 'unsupported-urltransform-exception' ],
        ]);
        assert.equal(compiled.filterStats.rejected, 3);
        assert.equal(compiled.filterStats.accepted, 2);
        assert.equal(isCompiledListData({
            ...compiled,
            specificCosmeticDetails: new Map(),
            scriptletDetails: new Map(),
            ruleStats: { total: compiled.dnrRules.length, plain: compiled.dnrRules.length, regex: 0 },
        }), true);
        checks += 1;
    }

    console.log(`Runtime filter option tests passed (${checks} checks)`);
} finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
