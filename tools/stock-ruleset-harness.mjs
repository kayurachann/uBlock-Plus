/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors
    License: GPLv3 or later.

*******************************************************************************/

// Test helper: runs platform/mv3/make-rulesets.js on fixture lists, staged
// the way tools/make-mv3.ps1 does, in a folder given by the test. No network
// (fixture lists carry their filters inline) and no Chrome unless the test
// passes a `chrome=` argument.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fromRoot = relative => path.join(projectRoot, relative);
const run = promisify(execFile);

export async function stageRulesetBuild(buildDir) {
    const copy = (from, to) => fs.cp(fromRoot(from), path.join(buildDir, to),
        { recursive: true });
    await fs.mkdir(path.join(buildDir, 'js'), { recursive: true });
    for ( const file of [
        'arglist-parser.js', 'base64-custom.js', 'biditrie.js',
        'dynamic-net-filtering.js', 'filtering-context.js', 'hnswitches.js',
        'hntrie.js', 'jsonpath.js', 'redirect-resources.js',
        'regex-analyzer.js', 's14e-serializer.js', 'static-dnr-filtering.js',
        'static-filtering-parser.js', 'static-net-filtering.js',
        'static-filtering-io.js', 'tasks.js', 'text-utils.js', 'urlskip.js',
        'uri-utils.js', 'url-net-filtering.js',
    ] ) {
        await copy(`src/js/${file}`, `js/${file}`);
    }
    await copy('src/lib/csstree', 'lib/csstree');
    await copy('src/lib/punycode.js', 'lib/punycode.js');
    await copy('src/lib/regexanalyzer', 'lib/regexanalyzer');
    await copy('src/lib/publicsuffixlist', 'lib/publicsuffixlist');
    for ( const file of await fs.readdir(fromRoot('platform/mv3')) ) {
        if ( /\.(?:json|m?js)$/.test(file) === false ) { continue; }
        await copy(`platform/mv3/${file}`, file);
    }
    for ( const file of [
        'ubo-parser.js', 'compiled-popup-matcher.js', 'utils.js',
        'imported-fetch-policy.js', 'strictblock-rules.js', 'dnr-namespaces.js',
    ] ) {
        await copy(`platform/mv3/extension/js/${file}`, `js/${file}`);
    }
    await copy('src/lib/punycode.js', 'js/punycode.js');
    await copy('src/lib/regexanalyzer', 'js/regexanalyzer');
    await copy('src/js/resources', 'js/resources');
    await copy('platform/mv3/scriptlets', 'scriptlets');
    await copy('platform/mv3/extension/js/offscreen', 'js/offscreen');
    await copy('src/js/regex-analyzer.js', 'js/offscreen/regex-analyzer.js');
    await copy('src/web_accessible_resources', 'web_accessible_resources');
    await copy('platform/mv3/chromium', 'chromium');
}

// `root` gets build/<name>/ (the output, with the Chromium manifest) and
// build/mv3-data/ (the list cache, with a fixed secret). Returns the output
// folder.
export async function prepareOutput(root, name = 'uBlockPlus.chromium') {
    const outputDir = path.join(root, 'build', name);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.copyFile(fromRoot('platform/mv3/chromium/manifest.json'),
        path.join(outputDir, 'manifest.json'));
    const dataDir = path.join(root, 'build', 'mv3-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'secret.txt'), '0123456789abcdef');
    return outputDir;
}

// Resolves to { stdout, stderr } on success, or to the error (with `code`,
// `stdout` and `stderr`) when make-rulesets.js fails.
export function runMakeRulesets(buildDir, outputDir, extraArgs = []) {
    return run(process.execPath, [
        '--no-warnings', 'make-rulesets.js',
        `output=${outputDir}`, 'platform=chromium', ...extraArgs,
    ], { cwd: buildDir, maxBuffer: 64 * 1024 * 1024 }).catch(error => error);
}

export const readJSON = (dir, relative) =>
    fs.readFile(path.join(dir, relative), 'utf8').then(text => JSON.parse(text));
