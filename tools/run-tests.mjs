// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Runs every source test program: tools/test-*.mjs plus
// platform/mv3/test-filter-store.mjs. Tests are discovered, so a new test file
// cannot be forgotten in package.json. Browser tests (*-chrome.mjs) need a
// real Chrome and explicit arguments and are run separately.
//
//   node tools/run-tests.mjs            run everything
//   node tools/run-tests.mjs popup      run tests whose path contains "popup"
//   node tools/run-tests.mjs --list     list the discovered tests

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function discoverTests(root = projectRoot) {
    const tools = readdirSync(path.join(root, 'tools'))
        .filter(name => /^test-.+\.mjs$/.test(name) && name.endsWith('-chrome.mjs') === false)
        .map(name => `tools/${name}`);
    return [ ...tools, 'platform/mv3/test-filter-store.mjs' ].sort();
}

const args = process.argv.slice(2);
const filters = args.filter(arg => arg.startsWith('--') === false);
const tests = discoverTests().filter(file =>
    filters.length === 0 || filters.some(filter => file.includes(filter)));

if ( args.includes('--list') ) {
    console.log(tests.join('\n'));
    process.exit(0);
}
if ( tests.length === 0 ) {
    console.error('No test matched.');
    process.exit(1);
}

const failures = [];
const started = Date.now();
for ( const file of tests ) {
    const t0 = Date.now();
    const result = spawnSync(process.execPath, [ file ], { cwd: projectRoot, stdio: 'inherit' });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if ( result.status !== 0 ) {
        failures.push(file);
        console.error(`✖ ${file} failed (exit ${result.status ?? result.signal}, ${seconds}s)`);
    }
}
const total = ((Date.now() - started) / 1000).toFixed(1);
if ( failures.length !== 0 ) {
    console.error(`\n${failures.length} of ${tests.length} test programs failed in ${total}s:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log(`\nAll ${tests.length} test programs passed in ${total}s.`);
