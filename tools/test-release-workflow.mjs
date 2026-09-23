// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Runs the PowerShell steps of .github/workflows/release.yml that decide what
// gets published, the way GitHub runs a pwsh step, against a stub gh placed
// first on PATH: the check of the build artifact, the check that updaters of
// the previous release accept the packages, and the upload to a release that
// may already exist. The release runner is Windows, so is this test. The
// workflow uses pwsh; Windows PowerShell runs the same scripts.
//
// Started with UBP_GH_STUB set, this file is that stub gh.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { generateKey, signBytes } from './release-signing.mjs';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Stub gh: answers from a scenario file and logs every call.

function runStub(scenarioFile) {
    const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
    const args = process.argv.slice(2);
    appendFileSync(scenario.log, `${JSON.stringify(args)}\n`);
    const option = name => args[args.indexOf(name) + 1];
    const [ group, command ] = args;
    if ( group === 'release' && command === 'list' ) {
        process.stdout.write(scenario.tags.map(tag => `${tag}\n`).join(''));
        return 0;
    }
    if ( group === 'api' ) {
        const ref = /[?&]ref=([^&]+)/.exec(args[1])?.[1];
        const keys = scenario.keys[ref];
        if ( typeof keys !== 'string' ) {
            process.stderr.write('gh: Not Found (HTTP 404)\n');
            return 1;
        }
        process.stdout.write(keys);
        return 0;
    }
    if ( group === 'release' && command === 'view' ) {
        if ( scenario.release === null ) {
            process.stderr.write('release not found\n');
            return 1;
        }
        if ( args.includes('--json') ) {
            process.stdout.write(Object.keys(scenario.release.assets).map(name => `${name}\n`).join(''));
        }
        return 0;
    }
    if ( group === 'release' && command === 'download' ) {
        const name = option('--pattern');
        writeFileSync(path.join(option('--dir'), name), Buffer.from(scenario.release.assets[name], 'base64'));
        return 0;
    }
    if ( group === 'release' && (command === 'create' || command === 'upload') ) { return 0; }
    process.stderr.write(`Unexpected gh call: ${args.join(' ')}\n`);
    return 2;
}

if ( process.env.UBP_GH_STUB ) {
    process.exit(runStub(process.env.UBP_GH_STUB));
}

if ( process.platform !== 'win32' ) {
    console.log('Release workflow: skipped (Windows only).');
    process.exit(0);
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const powershell = process.env.UBP_TEST_POWERSHELL || [ 'pwsh', 'powershell.exe' ].find(candidate =>
    spawnSync(candidate, [ '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major' ],
        { encoding: 'utf8' }).status === 0);
assert.ok(powershell, 'PowerShell is required on Windows');

// ---------------------------------------------------------------------------
// The run: blocks of release.yml

const workflow = await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8');
const indentOf = line => line.length - line.trimStart().length;
function stepScript(name) {
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
    assert.notEqual(start, -1, `release.yml has a step named "${name}"`);
    let index = start + 1;
    while ( /^\s*run: \|$/.test(lines[index]) === false ) {
        assert.ok(index < lines.length && lines[index].trim().startsWith('- ') === false, `"${name}" has a run block`);
        index++;
    }
    const runIndent = indentOf(lines[index]);
    const body = [];
    for ( index++; index < lines.length; index++ ) {
        if ( lines[index].trim() !== '' && indentOf(lines[index]) <= runIndent ) { break; }
        body.push(lines[index]);
    }
    const blockIndent = Math.min(...body.filter(line => line.trim() !== '').map(indentOf));
    const script = body.map(line => line.slice(blockIndent)).join('\n').trimEnd();
    assert.equal(script.includes('${{'), false, `"${name}" reads its inputs from env`);
    return script;
}
const verifyStep = stepScript('Verify packages and checksums');
const previousStep = stepScript('Check that updaters of the previous release accept the packages');
const publishStep = stepScript('Publish GitHub release');

// ---------------------------------------------------------------------------
// Fixtures

// Stored entries only.
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for ( const [ name, content ] of entries ) {
        const nameBytes = Buffer.from(name, 'utf8');
        const data = Buffer.from(content);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt32LE(crc32(data), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        locals.push(header, nameBytes, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        offset += header.length + nameBytes.length + data.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([ ...locals, ...centrals, end ]);
}

const version = '1.2.0';
const names = [ `uBlock-Plus_${version}.chromium.zip`, `uBlock-Plus_${version}.experimental.chromium.zip` ];
const packageFor = (name, variant = '') => makeZip([
    [ 'manifest.json', JSON.stringify({ manifest_version: 3, version }) ],
    [ 'updater/ublock-plus-updater.ps1', `# ${name}${variant}\n` ],
    [ 'updater/package-files.json', '[]' ],
]);
const keyA = generateKey('test-a');
const keyB = generateKey('test-b');
const keyFile = keys => JSON.stringify({ schemaVersion: 1, keys: keys.map(key => key.publicKey) });

const fixture = await mkdtemp(path.join(os.tmpdir(), 'ubp-release-workflow-'));
const stubDirectory = path.join(fixture, 'bin');
await mkdir(stubDirectory);
await writeFile(path.join(stubDirectory, 'gh.cmd'),
    `@"${process.execPath}" "${fileURLToPath(import.meta.url)}" %*\r\n`);
let runs = 0;

// A fresh runner workspace holding what the build job uploads (dist/build)
// and what the publish job checks out (tools/release-signing.mjs).
async function workspace({ signWith = [] } = {}) {
    const root = path.join(fixture, `run-${++runs}`);
    const build = path.join(root, 'dist', 'build');
    await mkdir(build, { recursive: true });
    await mkdir(path.join(root, 'tools'));
    await mkdir(path.join(root, 'temp'));
    await copyFile(path.join(projectRoot, 'tools', 'release-signing.mjs'), path.join(root, 'tools', 'release-signing.mjs'));
    const files = {};
    for ( const name of names ) {
        const zip = packageFor(name);
        files[name] = zip;
        files[`${name}.sha256`] = Buffer.from(`${createHash('sha256').update(zip).digest('hex')}  ${name}\n`);
        if ( signWith.length !== 0 ) {
            files[`${name}.sig`] = Buffer.from(`${signWith.map(key => signBytes(zip, key.privateKeyPem)).join('\n')}\n`);
        }
    }
    for ( const [ name, bytes ] of Object.entries(files) ) {
        await writeFile(path.join(build, name), bytes);
    }
    return { root, build, files };
}

// As GitHub runs a pwsh step: pwsh -command ". '<file>'", the script between
// this prologue and epilogue. Returns the gh calls.
async function runStep(script, space, scenario) {
    const log = path.join(space.root, 'gh-calls.jsonl');
    await writeFile(log, '');
    const scenarioFile = path.join(space.root, 'gh-scenario.json');
    await writeFile(scenarioFile, JSON.stringify({ tags: [], keys: {}, release: null, ...scenario, log }));
    const file = path.join(space.root, 'step.ps1');
    // With a BOM: Windows PowerShell reads a script without one as ANSI.
    await writeFile(file, `\uFEFF$ErrorActionPreference = 'stop'\n${script}\n` +
        'if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [ stubDirectory, path.dirname(process.execPath), env[pathKey] ].join(path.delimiter);
    Object.assign(env, {
        VERSION: version, RELEASE_TAG: `v${version}`, GITHUB_REPOSITORY: 'test/repo', GH_TOKEN: 'test',
        PRERELEASE: 'true', RUNNER_TEMP: path.join(space.root, 'temp'), UBP_GH_STUB: scenarioFile,
    });
    const result = spawnSync(powershell, [ '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', `. '${file}'` ], { cwd: space.root, env, encoding: 'utf8' });
    const calls = (await readFile(log, 'utf8')).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    return { status: result.status, output: `${result.stdout}${result.stderr}`.replace(/\s+/g, ' '), calls };
}
const uploads = calls => calls.filter(args => args[0] === 'release' && (args[1] === 'upload' || args[1] === 'create'))
    .map(args => args.filter(arg => /\.(?:zip|sha256|sig)$/.test(arg)).map(arg => path.basename(arg)));
const base64 = bytes => Buffer.from(bytes).toString('base64');

try {
    // The artifact must hold exactly the two packages and their checksums.
    let space = await workspace();
    let result = await runStep(verifyStep, space);
    assert.equal(result.status, 0, result.output);
    await writeFile(path.join(space.build, 'extra.txt'), 'x');
    result = await runStep(verifyStep, space);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /must hold exactly/);
    space = await workspace();
    await writeFile(path.join(space.build, `${names[1]}.sha256`), `${'0'.repeat(64)}  ${names[1]}\n`);
    result = await runStep(verifyStep, space);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /malformed or does not match/);

    // Updaters that installed the previous release (the highest earlier
    // one, not a later one) trust only its keys.
    const tags = [ 'v1.3.0', 'v1.1.0', 'v1.0.0', 'nightly' ];
    space = await workspace({ signWith: [ keyB ] });
    result = await runStep(previousStep, space, { tags, keys: { 'v1.1.0': keyFile([ keyA ]), 'v1.0.0': keyFile([ keyB ]) } });
    assert.notEqual(result.status, 0, 'A package signed only with a new key is refused');
    assert.match(result.output, /Updaters that installed v1\.1\.0 would refuse these packages/);
    assert.ok(result.calls.some(args => args[0] === 'api' && args[1].endsWith('?ref=v1.1.0')));
    space = await workspace({ signWith: [ keyA, keyB ] });
    result = await runStep(previousStep, space, { tags, keys: { 'v1.1.0': keyFile([ keyA ]) } });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /verifies with test-a/);
    space = await workspace({ signWith: [ keyB ] });
    result = await runStep(previousStep, space, { tags });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /v1\.1\.0 ships no release signing keys/, 'A release before signing has no key file');
    result = await runStep(previousStep, space, { tags: [ 'v1.3.0' ] });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /There is no earlier release/);

    // A new release is created in one call, which gh keeps a draft until
    // every asset is uploaded.
    space = await workspace({ signWith: [ keyA ] });
    result = await runStep(publishStep, space);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(uploads(result.calls), [ [
        `${names[0]}.sha256`, `${names[0]}.sig`, `${names[1]}.sha256`, `${names[1]}.sig`, names[0], names[1],
    ] ]);
    // An existing release keeps its assets. Only missing ones are added,
    // checksums and signatures in a call before the packages, because gh
    // uploads the files of one call concurrently.
    const existing = { [names[0]]: base64(space.files[names[0]]), [`${names[0]}.sha256`]: base64(space.files[`${names[0]}.sha256`]) };
    result = await runStep(publishStep, space, { release: { assets: existing } });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(uploads(result.calls), [
        [ `${names[0]}.sig`, `${names[1]}.sha256`, `${names[1]}.sig` ],
        [ names[1] ],
    ]);
    // A different package already on the release stops everything: a
    // checksum or signature must never sit next to another package.
    const different = { ...existing, [names[0]]: base64(packageFor(names[0], ' (built elsewhere)')) };
    result = await runStep(publishStep, space, { release: { assets: different } });
    assert.notEqual(result.status, 0);
    assert.match(result.output, new RegExp(`already has a ${names[0].replace(/[.+]/g, '\\$&')} that differs from this build`));
    assert.deepEqual(uploads(result.calls), [], 'Nothing is uploaded');
} finally {
    await rm(fixture, { recursive: true, force: true });
}

console.log(`Release workflow: artifact check, previous release keys and release uploads passed (${path.basename(powershell)}).`);
