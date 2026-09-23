// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Exercises the Windows updater (platform/mv3/updater) end to end against a
// loopback release server: installation, the native messaging protocol,
// staging, checksum, signature and identity guards, atomic apply, recovery
// from an interrupted apply, rollback and removal. The test never touches the
// registry (-NoRegistry) or the network.
//
// Users run Windows PowerShell 5.1 (install-updater.cmd, the native host
// launcher), so it is preferred; UBP_TEST_POWERSHELL=pwsh selects another.

import { crc32, deflateRawSync } from 'node:zlib';
import { generateKey, signBytes } from './release-signing.mjs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

if ( process.platform !== 'win32' ) {
    console.log('Updater host: skipped (Windows only).');
    process.exit(0);
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const updaterSource = path.join(projectRoot, 'platform/mv3/updater');
const powershell = process.env.UBP_TEST_POWERSHELL || [ 'powershell.exe', 'pwsh' ].find(candidate =>
    spawnSync(candidate, [ '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major' ],
        { encoding: 'utf8' }).status === 0);
assert.ok(powershell, 'PowerShell is required on Windows');

// ---------------------------------------------------------------------------
// Minimal ZIP writer so fixtures can contain hostile names. Entries are
// stored, or deflated with an optional (false) declared size.

function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for ( const [ name, content, options = {} ] of entries ) {
        const nameBytes = Buffer.from(name, 'utf8');
        const raw = Buffer.from(content);
        const data = options.deflate ? deflateRawSync(raw) : raw;
        const method = options.deflate ? 8 : 0;
        const size = options.declaredSize ?? raw.length;
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
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

// A valid end record in front of a garbage central directory.
function corruptCentralDirectory(zip) {
    const corrupt = Buffer.from(zip);
    corrupt.fill(0x41, corrupt.readUInt32LE(corrupt.length - 6), corrupt.length - 22);
    return corrupt;
}

const manifestFor = (version, extra = {}) => JSON.stringify({
    manifest_version: 3, name: '__MSG_extName__', short_name: 'uBlock Plus+', version, ...extra,
});
const FILE_LIST = 'updater/package-files.json';
// Packages list their own files, as tools/package-files.mjs does.
const listed = entries => {
    const kept = entries.filter(([ name ]) => name !== FILE_LIST);
    const names = [ ...kept.map(([ name ]) => name), FILE_LIST ].sort();
    return [ ...kept, [ FILE_LIST, JSON.stringify(names) ] ];
};
const baseEntries = (version, extra = {}) => [
    [ 'manifest.json', manifestFor(version, extra) ],
    [ 'js/background.js', `// ${version}\n` ],
    [ `only-in-${version}.txt`, version ],
    [ 'updater/ublock-plus-updater.ps1', '' ],
];
const packageEntries = (version, extra = {}, more = []) => listed([ ...baseEntries(version, extra), ...more ]);

// ---------------------------------------------------------------------------
// Loopback release server

const assets = new Map();
const requests = [];
function publish(version, zip, { checksum, checksumText, assetName, signWith, signatureText } = {}) {
    const name = assetName || `uBlock-Plus_${version}.chromium.zip`;
    const digest = checksum || createHash('sha256').update(zip).digest('hex');
    const url = `/releases/download/v${version}/${name}`;
    assets.set(url, zip);
    assets.set(`${url}.sha256`, Buffer.from(checksumText ?? `${digest}  ${name}\n`));
    if ( signWith ) {
        const keys = Array.isArray(signWith) ? signWith : [ signWith ];
        assets.set(`${url}.sig`, Buffer.from(`${keys.map(key => signBytes(zip, key)).join('\n')}\n`));
    }
    if ( signatureText !== undefined ) {
        assets.set(`${url}.sig`, typeof signatureText === 'number' ? signatureText : Buffer.from(signatureText));
    }
}
let releaseList = [];
const server = createServer((request, response) => {
    requests.push(request.url);
    if ( request.url.startsWith('/repos/test/repo/releases') ) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(releaseList));
        return;
    }
    const body = assets.get(request.url);
    if ( body === undefined || typeof body === 'number' ) {
        response.statusCode = body ?? 404;
        response.end('unavailable');
        return;
    }
    response.setHeader('Content-Length', body.length);
    response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Fixture folders

// TEMP may be an 8.3 path (C:\Users\RUNNER~1\... on GitHub runners). Chrome's
// folder picker gives long paths, from which Chrome derives the extension ID.
const fixtureAsGiven = await mkdtemp(path.join(os.tmpdir(), 'ubp-updater-test-'));
const fixture = await realpath(fixtureAsGiven);
// Windows PowerShell started from PowerShell 7 (as in a PowerShell 7 terminal
// or a GitHub Actions step) inherits a module path from which it cannot load
// Microsoft.PowerShell.Security, and so has no Get-Acl. Every PowerShell
// process of this test runs with such a module first on its path.
if ( spawnSync(powershell, [ '-NoProfile', '-Command', '$PSVersionTable.PSEdition' ],
    { encoding: 'utf8' }).stdout.trim() === 'Desktop' ) {
    const modules = path.join(fixture, 'PSModules');
    await mkdir(path.join(modules, 'Microsoft.PowerShell.Security'), { recursive: true });
    await writeFile(path.join(modules, 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1'),
        "@{ ModuleVersion = '7.0.0.0'; GUID = 'a94c8c7e-9810-47c0-b8af-65089c13a35a'; " +
        "PowerShellVersion = '7.0'; CompatiblePSEditions = @('Core'); " +
        "NestedModules = 'Microsoft.PowerShell.Security.dll'; CmdletsToExport = @('Get-Acl', 'Set-Acl') }\r\n");
    process.env.PSModulePath = [ modules, process.env.PSModulePath ].filter(Boolean).join(';');
    const probe = spawnSync(powershell, [ '-NoProfile', '-Command', 'Get-Acl -LiteralPath $env:TEMP | Out-Null' ],
        { encoding: 'utf8' });
    assert.match(probe.stderr, /CouldNotAutoloadMatchingModule/, 'The module path hides Get-Acl as PowerShell 7 does');
}
const installRoot = path.join(fixture, 'Updater');
const extensionDir = path.join(fixture, 'Extensions', 'uBlock-Plus');
async function writePackage(directory, entries) {
    await rm(directory, { recursive: true, force: true });
    for ( const [ name, content ] of entries ) {
        const target = path.join(directory, ...name.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}
const readVersion = async directory =>
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).version;
const exists = target => stat(target).then(() => true, () => false);
const readJson = async target => JSON.parse(await readFile(target, 'utf8'));

function unpackedId(directory) {
    let normalized = path.resolve(directory);
    if ( /^[a-z]:/.test(normalized) ) { normalized = normalized[0].toUpperCase() + normalized.slice(1); }
    return createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest('hex')
        .slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + Number.parseInt(c, 16)));
}
// The updater names per-folder data after this key (Get-PathKey).
const pathKey = directory => createHash('sha256')
    .update(Buffer.from(directory.replace(/\\+$/, '').toLowerCase(), 'utf8')).digest('hex').slice(0, 16);

// Directory junctions need no administrator rights.
function junction(link, target) {
    const result = spawnSync('cmd.exe', [ '/d', '/c', 'mklink', '/J', link, target ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
}
function removeJunction(link) {
    const result = spawnSync('cmd.exe', [ '/d', '/c', 'rmdir', link ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
}

// Grants or removes rights of a group that every account belongs to
// (Authenticated Users, unless another SID is given).
function icacls(...args) {
    const result = spawnSync('icacls.exe', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
}
const share = (target, rights, sid = 'S-1-5-11') => icacls(target, '/grant', `*${sid}:${rights}`);
const unshare = (target, sid = 'S-1-5-11') => icacls(target, '/remove:g', `*${sid}`);

// Keeps a file open for reading only until release() is called.
function holdFile(file) {
    return new Promise((resolve, reject) => {
        const child = spawn(powershell, [ '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            `$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'Read'); 'locked'; ` +
            '[Console]::In.ReadLine() | Out-Null; $f.Dispose()' ], { stdio: [ 'pipe', 'pipe', 'inherit' ] });
        child.on('error', reject);
        child.stdout.once('data', () => resolve({
            release: () => new Promise(done => {
                child.on('close', done);
                child.stdin.end('\n');
            }),
        }));
    });
}

// Asynchronous: the loopback release server shares this event loop.
function runPowerShell(script, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(powershell, [ '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', script, ...args ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

const installArgs = [ '-InstallRoot', installRoot, '-NoRegistry', '-Repository', 'test/repo',
    '-ReleaseBaseUrl', `${base}/releases/download`, '-ApiBaseUrl', base ];
const argsFor = root => installArgs.map(arg => arg === installRoot ? root : arg);
const installer = path.join(updaterSource, 'install-updater.ps1');

// Chrome's framing: 32-bit native-endian length, then UTF-8 JSON.
function nativeRequest(message, origin, root = installRoot) {
    return new Promise((resolve, reject) => {
        const launcher = path.join(root, 'ublock-plus-updater.cmd');
        const child = spawn('cmd.exe', [ '/d', '/s', '/c', `""${launcher}" ${origin} --parent-window=0"` ],
            { windowsVerbatimArguments: true, stdio: [ 'pipe', 'pipe', 'pipe' ] });
        const chunks = [];
        let stderr = '';
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', () => {
            const buffer = Buffer.concat(chunks);
            const messages = [];
            let offset = 0;
            while ( offset + 4 <= buffer.length ) {
                const length = buffer.readUInt32LE(offset);
                messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
                offset += 4 + length;
            }
            if ( offset !== buffer.length ) {
                reject(new Error(`Stray bytes on the native messaging channel: ${buffer.subarray(offset)}`));
                return;
            }
            resolve({ messages, final: messages.at(-1), stderr });
        });
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        child.stdin.end(Buffer.concat([ header, body ]));
    });
}

try {
    await writePackage(extensionDir, packageEntries('1.0.0'));

    // Installation
    // The folder as TEMP spells it: the installer registers the ID of its
    // long path, as Chrome derives it.
    const installed = await runPowerShell(installer, [ ...installArgs, '-ExtensionDirectory',
        path.join(fixtureAsGiven, 'Extensions', 'uBlock-Plus') ]);
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    assert.match(installed.stdout, /select Allow the updater \(if shown\), then Check now/,
        'The installer names the permission step before Check now');
    const config = await readJson(path.join(installRoot, 'config.json'));
    const id = unpackedId(extensionDir);
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.repository, 'test/repo');
    assert.equal(config.installations.length, 1);
    assert.equal(config.installations[0].edition, 'standard');
    assert.ok(config.installations[0].extensionIds.includes(id), 'Path-derived ID is registered');
    const hostManifest = await readJson(path.join(installRoot, 'io.github.kayurachann.ublock_plus.updater.json'));
    assert.equal(hostManifest.type, 'stdio');
    assert.ok(Array.isArray(hostManifest.allowed_origins), 'Chrome requires allowed_origins to be an array');
    assert.ok(Array.isArray(config.installations[0].extensionIds));
    assert.equal(hostManifest.path, path.join(installRoot, 'ublock-plus-updater.cmd'));
    assert.ok(hostManifest.allowed_origins.includes(`chrome-extension://${id}/`));
    const origin = `chrome-extension://${id}/`;
    const statePath = path.join(installRoot, `state-${pathKey(config.installations[0].extensionDir)}.json`);
    const lockPath = path.join(installRoot, 'updater.lock');

    // Protocol basics
    let reply = await nativeRequest({ v: 1, id: 'h1', cmd: 'hello' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.id, 'h1');
    // hello takes the updater lock only to undo an interrupted apply, so
    // that it never makes an update starting at the same moment fail.
    assert.equal(await exists(lockPath), false, 'hello leaves the updater lock alone');
    assert.equal(reply.final.installedVersion, '1.0.0');
    assert.equal(reply.final.protocol, 1);
    assert.equal(reply.final.edition, 'standard');
    assert.equal(reply.final.recovered, undefined);
    reply = await nativeRequest({ v: 1, id: 'h2', cmd: 'hello' }, `chrome-extension://${'a'.repeat(32)}/`);
    assert.equal(reply.final.error.code, 'forbidden-origin');
    reply = await nativeRequest({ v: 2, cmd: 'hello' }, origin);
    assert.equal(reply.final.error.code, 'unsupported-protocol');
    reply = await nativeRequest({ v: 1, cmd: 'exec', script: 'calc' }, origin);
    assert.equal(reply.final.error.code, 'unsupported-command');
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.1.0; calc' }, origin);
    assert.equal(reply.final.error.code, 'invalid-version');
    for ( const cmd of [ 'stage', 'apply' ] ) {
        reply = await nativeRequest({ v: 1, cmd }, origin);
        assert.equal(reply.final.error.code, 'invalid-version', `${cmd} without a version`);
    }
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.0.0' }, origin);
    assert.equal(reply.final.error.code, 'not-newer');
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
    assert.equal(reply.final.error.code, 'not-staged');

    // Hostile or broken packages never reach the extension folder.
    const plain = makeZip(packageEntries('1.0.9'));
    const hostile = [
        [ '1.0.1', makeZip(packageEntries('1.0.1')), { checksum: 'b'.repeat(64) }, 'checksum-mismatch' ],
        [ '1.0.2', makeZip([ ...packageEntries('1.0.2'), [ '../escaped.txt', 'x' ] ]), {}, 'package-invalid' ],
        [ '1.0.3', makeZip([ ...packageEntries('1.0.3'), [ 'C:/escaped.txt', 'x' ] ]), {}, 'package-invalid' ],
        [ '1.0.4', makeZip(packageEntries('9.9.9')), {}, 'identity-mismatch' ],
        [ '1.0.5', makeZip(packageEntries('1.0.5', { short_name: 'Other' })), {}, 'identity-mismatch' ],
        [ '1.0.6', makeZip(packageEntries('1.0.6', { key: 'QUJD' })), {}, 'identity-mismatch' ],
        [ '1.0.7', makeZip([ [ 'manifest.json', manifestFor('1.0.7') ], [ 'experimental-webrequest.json', '{}' ] ]), {}, 'identity-mismatch' ],
        // The checksum file must name the asset it belongs to.
        [ '1.0.9', plain, { checksumText: `${createHash('sha256').update(plain).digest('hex')}\n` }, 'checksum-invalid' ],
        // An entry that inflates beyond its declared size (a ZIP bomb).
        [ '1.0.10', makeZip([ ...packageEntries('1.0.10'),
            [ 'bomb.bin', Buffer.alloc(4 << 20), { deflate: true, declaredSize: 100 } ] ]), {}, 'package-invalid' ],
        [ '1.0.11', corruptCentralDirectory(makeZip(packageEntries('1.0.11'))), {}, 'package-invalid' ],
    ];
    for ( const [ version, zip, options, code ] of hostile ) {
        publish(version, zip, options);
        reply = await nativeRequest({ v: 1, cmd: 'stage', version }, origin);
        assert.equal(reply.final.ok, false, `${version} must be rejected`);
        assert.equal(reply.final.error.code, code, `${version}: ${JSON.stringify(reply.final.error)}`);
        assert.equal(await readVersion(extensionDir), '1.0.0');
    }
    assert.equal(await exists(path.join(fixture, 'Extensions', 'escaped.txt')), false);
    assert.equal(await exists(path.join(installRoot, 'staging', pathKey(config.installations[0].extensionDir))), false,
        'A package that fails extraction leaves nothing behind');
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.0.8' }, origin);
    assert.equal(reply.final.error.code, 'download-failed', 'Missing release assets are reported');

    // A concurrent update is refused while the lock is held.
    const lock = await open(path.join(installRoot, 'updater.lock'), 'w');
    publish('1.1.0', makeZip(packageEntries('1.1.0')));
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.1.0' }, origin);
    await lock.close();
    assert.equal(reply.final.error.code, 'update-busy');

    // Stage, apply and rollback.
    reply = await nativeRequest({ v: 1, id: 's1', cmd: 'stage', version: '1.1.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.version, '1.1.0');
    assert.ok(reply.messages.slice(0, -1).every(message => message.event === 'progress' && message.id === 's1'));
    assert.ok(reply.messages.some(message => message.phase === 'verify'));
    assert.equal(await readVersion(extensionDir), '1.0.0', 'Staging does not modify the installed extension');
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.stagedVersion, '1.1.0');
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.1.0' }, origin);
    assert.equal(reply.final.reused, true, 'A verified staged package is reused');

    // robocopy /MIR purges and writes through junctions even with /XJ, so a
    // link inside the folder stops the update before anything changes.
    const outside = path.join(fixture, 'Outside');
    await writePackage(outside, [ [ 'keep.txt', 'keep' ] ]);
    const link = path.join(extensionDir, 'js', 'linked');
    junction(link, outside);
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
    assert.equal(reply.final.error?.code, 'unsafe-extension-dir', JSON.stringify(reply.final));
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'The junction target survives');
    assert.equal(await readVersion(extensionDir), '1.0.0');
    removeJunction(link);

    // Links are checked at fixed moments, so other users of this PC must not
    // be able to change the folder or any folder in it, nor rename a folder
    // on its path: they could put a junction in place after the check.
    for ( const [ target, rights ] of [
        [ extensionDir, '(OI)(CI)M' ], [ path.join(extensionDir, 'js'), '(OI)(CI)M' ], [ path.dirname(extensionDir), '(D)' ],
    ] ) {
        share(target, rights);
        try {
            reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
        } finally {
            unshare(target);
        }
        assert.equal(reply.final.error?.code, 'unsafe-extension-dir', `${target}: ${JSON.stringify(reply.final)}`);
        assert.match(reply.final.error.message, /Other users of this PC can (?:change|rename or replace)/);
        assert.equal(await readVersion(extensionDir), '1.0.0');
    }

    // Files that no package listed are never deleted: the update stops and
    // names them. Folder files that Windows adds are left alone.
    await writeFile(path.join(extensionDir, 'user-note.txt'), 'mine');
    await writeFile(path.join(extensionDir, 'js', 'Thumbs.db'), 'thumbnails');
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
    assert.equal(reply.final.error?.code, 'unexpected-files', JSON.stringify(reply.final));
    assert.match(reply.final.error.message, /user-note\.txt/);
    assert.doesNotMatch(reply.final.error.message, /Thumbs\.db|only-in-1\.0\.0/);
    assert.equal(await readVersion(extensionDir), '1.0.0');
    assert.equal(await readFile(path.join(extensionDir, 'user-note.txt'), 'utf8'), 'mine');
    await rm(path.join(extensionDir, 'user-note.txt'));
    // robocopy removes a folder that the new package lacks with everything
    // in it, _metadata folders and Windows folder files included.
    await mkdir(path.join(extensionDir, 'oldlib', '_metadata'), { recursive: true });
    await writeFile(path.join(extensionDir, 'oldlib', '_metadata', 'notes.txt'), 'mine');
    await writeFile(path.join(extensionDir, 'oldlib', 'Thumbs.db'), 'thumbnails');
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
    assert.equal(reply.final.error?.code, 'unexpected-files', JSON.stringify(reply.final));
    assert.match(reply.final.error.message, /oldlib\/Thumbs\.db/);
    assert.match(reply.final.error.message, /oldlib\/_metadata\/notes\.txt/);
    assert.doesNotMatch(reply.final.error.message, /js\/Thumbs\.db/);
    assert.equal(await readFile(path.join(extensionDir, 'oldlib', '_metadata', 'notes.txt'), 'utf8'), 'mine');
    await rm(path.join(extensionDir, 'oldlib'), { recursive: true });

    // Chrome keeps indexed DNR rulesets in _metadata inside unpacked folders.
    await mkdir(path.join(extensionDir, '_metadata', 'generated_indexed_rulesets'), { recursive: true });
    await writeFile(path.join(extensionDir, '_metadata', 'generated_indexed_rulesets', '_ruleset1'), 'indexed');
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.1.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(await exists(path.join(extensionDir, '_metadata', 'generated_indexed_rulesets', '_ruleset1')), true,
        'Chrome-owned _metadata is neither copied nor purged');
    assert.equal(await exists(path.join(extensionDir, 'js', 'Thumbs.db')), true, 'Windows folder files are kept');
    assert.deepEqual([ reply.final.applied.from, reply.final.applied.to ], [ '1.0.0', '1.1.0' ]);
    assert.equal(await readVersion(extensionDir), '1.1.0');
    assert.equal(await exists(path.join(extensionDir, 'only-in-1.0.0.txt')), false, 'Stale listed files are removed');
    assert.equal(await exists(path.join(extensionDir, 'only-in-1.1.0.txt')), true);
    assert.equal((await readJson(statePath)).applying, undefined, 'The apply marker is cleared once verified');
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.installedVersion, '1.1.0');
    assert.equal(reply.final.backupVersion, '1.0.0');
    assert.equal(reply.final.stagedVersion, null);
    assert.equal(reply.final.lastApplied.to, '1.1.0');

    // Rollback refuses links, folders that others can change and unlisted
    // files the same way.
    junction(link, outside);
    reply = await nativeRequest({ v: 1, cmd: 'rollback' }, origin);
    assert.equal(reply.final.error?.code, 'unsafe-extension-dir', JSON.stringify(reply.final));
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'The junction target survives');
    assert.equal(await readVersion(extensionDir), '1.1.0');
    removeJunction(link);
    share(extensionDir, '(OI)(CI)M');
    try {
        reply = await nativeRequest({ v: 1, cmd: 'rollback' }, origin);
    } finally {
        unshare(extensionDir);
    }
    assert.equal(reply.final.error?.code, 'unsafe-extension-dir', JSON.stringify(reply.final));
    assert.equal(await readVersion(extensionDir), '1.1.0');
    await writeFile(path.join(extensionDir, 'my-list.txt'), 'mine');
    reply = await nativeRequest({ v: 1, cmd: 'rollback' }, origin);
    assert.equal(reply.final.error?.code, 'unexpected-files', JSON.stringify(reply.final));
    assert.match(reply.final.error.message, /my-list\.txt/);
    await rm(path.join(extensionDir, 'my-list.txt'));
    reply = await nativeRequest({ v: 1, cmd: 'rollback' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.applied.to, '1.0.0');
    assert.equal(await readVersion(extensionDir), '1.0.0');
    assert.equal(await exists(path.join(extensionDir, 'only-in-1.1.0.txt')), false);

    // An apply that stopped midway (the marker is still set, the folder mixes
    // both versions) is undone by the next run that can take the lock. The
    // staged package stays until an apply succeeds.
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.1.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    const interrupt = async () => writeFile(statePath, JSON.stringify({ ...(await readJson(statePath)),
        applying: { from: '1.0.0', to: '1.1.0', at: new Date().toISOString() } }));
    await interrupt();
    await writeFile(path.join(extensionDir, 'js', 'background.js'), '// 1.1.0\n');
    await writeFile(path.join(extensionDir, 'only-in-1.1.0.txt'), '1.1.0');
    // The repair deletes files of the two packages only: a file added since
    // stops it, and -Status reports that instead of failing.
    await writeFile(path.join(extensionDir, 'user-note.txt'), 'mine');
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.error?.code, 'unexpected-files', JSON.stringify(reply.final));
    assert.match(reply.final.error.message, /user-note\.txt/);
    assert.doesNotMatch(reply.final.error.message, /only-in-1\.1\.0/);
    assert.equal(await readFile(path.join(extensionDir, 'user-note.txt'), 'utf8'), 'mine');
    assert.equal((await readJson(statePath)).applying?.to, '1.1.0', 'The repair is retried later');
    const installedHost = path.join(installRoot, 'ublock-plus-updater.ps1');
    let cli = await runPowerShell(installedHost, [ '-Status' ]);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    const pending = JSON.parse(cli.stdout).interrupted;
    assert.deepEqual([ pending.from, pending.to, pending.error.code ], [ '1.0.0', '1.1.0', 'unexpected-files' ]);
    reply = await nativeRequest({ v: 1, cmd: 'rollback' }, origin);
    assert.equal(reply.final.error?.code, 'unexpected-files', `A rollback keeps it too: ${JSON.stringify(reply.final)}`);
    await rm(path.join(extensionDir, 'user-note.txt'));
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.deepEqual(reply.final.recovered, { restored: '1.0.0', interrupted: '1.1.0' });
    assert.equal(reply.final.installedVersion, '1.0.0');
    assert.equal(await readFile(path.join(extensionDir, 'js', 'background.js'), 'utf8'), '// 1.0.0\n');
    assert.equal(await exists(path.join(extensionDir, 'only-in-1.1.0.txt')), false);
    const afterRecovery = await readJson(statePath);
    assert.equal(afterRecovery.applying, undefined);
    assert.deepEqual([ afterRecovery.lastApplied.to, afterRecovery.lastApplied.rollback ], [ '1.0.0', true ],
        'The last completed operation is kept');
    // Without a backup nothing can be undone: -Status still answers, and
    // -Rollback keeps the folder as it is and forgets the interrupted apply.
    await rm(path.join(installRoot, 'backup'), { recursive: true });
    await interrupt();
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.error?.code, 'rollback-failed', JSON.stringify(reply.final));
    cli = await runPowerShell(installedHost, [ '-Status' ]);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(JSON.parse(cli.stdout).interrupted.error.code, 'rollback-failed');
    cli = await runPowerShell(installedHost, [ '-Rollback' ]);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.match(cli.stdout, /Cleared the interrupted update to 1\.1\.0/);
    assert.equal((await readJson(statePath)).applying, undefined);
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.installedVersion, '1.0.0');

    // Command line: newest compatible release, ignoring drafts, other
    // editions and releases without checksums.
    const realUpdater = await readFile(path.join(updaterSource, 'ublock-plus-updater.ps1'), 'utf8');
    const realLauncher = await readFile(path.join(updaterSource, 'ublock-plus-updater.cmd'), 'utf8');
    assert.ok(realUpdater.includes("$script:UpdaterVersion = '1.0.0'"), 'Fixture expects updater 1.0.0');
    const updaterVersioned = version =>
        realUpdater.replace("$script:UpdaterVersion = '1.0.0'", `$script:UpdaterVersion = '${version}'`);
    const withUpdater = (version, script, more = []) => listed([
        ...baseEntries(version).filter(([ name ]) => name.startsWith('updater/') === false),
        [ 'updater/ublock-plus-updater.ps1', script ],
        [ 'updater/ublock-plus-updater.cmd', realLauncher ],
        ...more,
    ]);
    publish('1.2.0', makeZip(packageEntries('1.2.0')));
    publish('1.3.0', makeZip(packageEntries('1.3.0')));
    const release = (version, extra = {}, names = null) => ({
        tag_name: `v${version}`, draft: false, prerelease: true, ...extra,
        assets: (names || [ `uBlock-Plus_${version}.chromium.zip`, `uBlock-Plus_${version}.chromium.zip.sha256` ])
            .map(name => ({ name })),
    });
    releaseList = [
        release('9.0.0', { draft: true }),
        release('8.0.0', {}, [ 'uBlock-Plus_8.0.0.experimental.chromium.zip', 'uBlock-Plus_8.0.0.experimental.chromium.zip.sha256' ]),
        release('7.0.0', {}, [ 'uBlock-Plus_7.0.0.chromium.zip' ]),
        release('nightly'),
        release('1.3.0'),
        release('1.2.0', { prerelease: false }),
    ];
    // Without its own file list, the installed folder's extra files cannot be
    // told apart from user files.
    const fileList = path.join(extensionDir, ...FILE_LIST.split('/'));
    const savedList = await readFile(fileList);
    await rm(fileList);
    cli = await runPowerShell(installedHost, [ '-Update', '-IncludePrerelease', 'no' ]);
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /\(unexpected-files\).*only-in-1\.0\.0\.txt/);
    assert.equal(await readVersion(extensionDir), '1.0.0');
    await writeFile(fileList, savedList);
    cli = await runPowerShell(installedHost, [ '-Update', '-IncludePrerelease', 'no' ]);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(await readVersion(extensionDir), '1.2.0', 'Stable-only selects the newest stable release');
    cli = await runPowerShell(installedHost, [ '-Update' ]);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(await readVersion(extensionDir), '1.3.0', 'Pre-releases are included by default');
    // Same size and fixed ZIP timestamps: content must still be replaced.
    assert.equal(await readFile(path.join(extensionDir, 'js/background.js'), 'utf8'), '// 1.3.0\n');
    cli = await runPowerShell(installedHost, [ '-Update' ]);
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /up to date/);
    cli = await runPowerShell(installedHost, [ '-Status' ]);
    assert.equal(JSON.parse(cli.stdout).installedVersion, '1.3.0');

    // Without release signing, a package never replaces the updater.
    publish('1.4.0', makeZip(withUpdater('1.4.0', updaterVersioned('1.0.1'))));
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.4.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.4.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.equal(reply.final.updaterVersion, '1.0.0', 'An unsigned package does not replace the updater');
    assert.equal(reply.final.installedVersion, '1.4.0');
    assert.equal(await readFile(installedHost, 'utf8'), realUpdater);

    // The updater refuses to manage a folder that is not uBlock Plus+.
    await writeFile(path.join(extensionDir, 'manifest.json'), manifestFor('1.4.0', { short_name: 'Something else' }));
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '9.9.9' }, origin);
    assert.equal(reply.final.error.code, 'identity-mismatch');
    cli = await runPowerShell(installedHost, [ '-Rollback' ]);
    assert.notEqual(cli.status, 0, 'Rollback must not overwrite a foreign folder');
    assert.match(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'), /Something else/);
    await writeFile(path.join(extensionDir, 'manifest.json'), manifestFor('1.4.0'));

    // A file that stays locked (antivirus, an editor) makes both the copy and
    // the restore fail: the error says so, and the apply marker stays until a
    // later run restores the backup.
    publish('1.5.0', makeZip(packageEntries('1.5.0')));
    reply = await nativeRequest({ v: 1, cmd: 'stage', version: '1.5.0' }, origin);
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    const held = await holdFile(path.join(extensionDir, 'js', 'background.js'));
    try {
        reply = await nativeRequest({ v: 1, cmd: 'apply', version: '1.5.0' }, origin);
    } finally {
        await held.release();
    }
    assert.equal(reply.final.error?.code, 'apply-failed', JSON.stringify(reply.final));
    assert.match(reply.final.error.message, /NOT fully restored/);
    assert.equal(await readVersion(extensionDir), '1.4.0', 'manifest.json is replaced last');
    assert.deepEqual([ (await readJson(statePath)).applying?.from, (await readJson(statePath)).applying?.to ],
        [ '1.4.0', '1.5.0' ]);
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, origin);
    assert.deepEqual(reply.final.recovered, { restored: '1.4.0', interrupted: '1.5.0' }, JSON.stringify(reply.final));
    assert.equal(await readFile(path.join(extensionDir, 'js', 'background.js'), 'utf8'), '// 1.4.0\n');
    assert.equal(await exists(path.join(extensionDir, 'only-in-1.5.0.txt')), false);

    // Release signatures: an updater installed with pinned keys requires a
    // valid signature, and keys only rotate through a signed package.
    const keyA = generateKey('test-a');
    const keyB = generateKey('test-b');
    const keyFile = (keys, generation) => JSON.stringify({ schemaVersion: 1, generation, keys: keys.map(key => key.publicKey) });
    const signedSource = path.join(fixture, 'signed-source');
    await writePackage(signedSource, [
        [ 'ublock-plus-updater.ps1', realUpdater ],
        [ 'ublock-plus-updater.cmd', realLauncher ],
        [ 'install-updater.ps1', await readFile(installer, 'utf8') ],
        [ 'release-signing-keys.json', keyFile([ keyA ]) ],
    ]);
    const signedRoot = path.join(fixture, 'SignedUpdater');
    const signedDir = path.join(fixture, 'Signed', 'uBlock-Plus');
    await writePackage(signedDir, packageEntries('3.0.0'));
    const signedInstaller = path.join(signedSource, 'install-updater.ps1');
    const signedInstall = await runPowerShell(signedInstaller, [ ...argsFor(signedRoot), '-ExtensionDirectory', signedDir ]);
    assert.equal(signedInstall.status, 0, signedInstall.stderr + signedInstall.stdout);
    assert.match(signedInstall.stdout, /Signed releases\s+: required/);
    const signedOrigin = `chrome-extension://${unpackedId(signedDir)}/`;
    const signedRequest = message => nativeRequest(message, signedOrigin, signedRoot);
    const signedHost = path.join(signedRoot, 'ublock-plus-updater.ps1');
    const trustedKeys = () => readJson(path.join(signedRoot, 'release-signing-keys.json'));
    const trustedIds = async () => (await trustedKeys()).keys.map(key => key.id);
    reply = await signedRequest({ v: 1, cmd: 'hello' });
    assert.equal(reply.final.signatureRequired, true);
    publish('3.0.1', makeZip(packageEntries('3.0.1')));
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.1' });
    assert.equal(reply.final.error?.code, 'signature-missing', 'Unsigned releases are refused once keys are pinned');
    publish('3.0.2', makeZip(packageEntries('3.0.2')), { signWith: keyB.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.2' });
    assert.equal(reply.final.error?.code, 'signature-invalid', 'Signatures from unknown keys are refused');
    publish('3.0.3', makeZip(packageEntries('3.0.3')), { checksum: 'c'.repeat(64), signWith: keyA.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.3' });
    assert.equal(reply.final.error?.code, 'checksum-mismatch');
    // Only a missing .sig means "unsigned"; a server error stays a download
    // error, and an empty or oversized .sig is an invalid signature.
    publish('3.0.10', makeZip(packageEntries('3.0.10')), { signatureText: 503 });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.10' });
    assert.equal(reply.final.error?.code, 'download-failed', JSON.stringify(reply.final));
    publish('3.0.11', makeZip(packageEntries('3.0.11')), { signatureText: '\n' });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.11' });
    assert.equal(reply.final.error?.code, 'signature-invalid', JSON.stringify(reply.final));
    const nineLines = makeZip(packageEntries('3.0.12'));
    publish('3.0.12', nineLines, { signatureText: `${'AAAA\n'.repeat(8)}${signBytes(nineLines, keyA.privateKeyPem)}\n` });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.12' });
    assert.equal(reply.final.error?.code, 'signature-invalid', 'More than eight signature lines are refused');
    publish('3.0.13', makeZip(packageEntries('3.0.13')), { signatureText: 'A'.repeat(9000) });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.13' });
    assert.equal(reply.final.error?.code, 'signature-invalid', 'A .sig over 8 KiB is refused');
    // One signature per line: any line from a trusted key verifies.
    const dualSigned = makeZip(packageEntries('3.0.14'));
    publish('3.0.14', dualSigned, { signatureText: `not base64!\n\n${signBytes(dualSigned, keyB.privateKeyPem)}\n${signBytes(dualSigned, keyA.privateKeyPem)}\n` });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.14' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.signedBy, 'test-a');
    assert.equal(await readVersion(signedDir), '3.0.0');
    // A signed package rotates the trusted key from A to B. Its damaged
    // updater (declaring a higher version) must not replace a working one.
    const rotating = makeZip(withUpdater('3.0.4', `${updaterVersioned('99.0.0')}\nfunction {`,
        [ [ 'updater/release-signing-keys.json', keyFile([ keyB ], 1) ] ]));
    publish('3.0.4', rotating, { signWith: keyA.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.4' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.equal(reply.final.signedBy, 'test-a');
    assert.ok(reply.messages.some(message => message.phase === 'signature'));
    reply = await signedRequest({ v: 1, cmd: 'apply', version: '3.0.4' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.deepEqual(await trustedIds(), [ 'test-b' ]);
    assert.equal(await readFile(signedHost, 'utf8'), realUpdater, 'A damaged updater is not installed');
    publish('3.0.5', makeZip(packageEntries('3.0.5')), { signWith: keyA.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.5' });
    assert.equal(reply.final.error?.code, 'signature-invalid', 'The retired key no longer verifies');
    // A well-formed newer updater in a signed package replaces this one, with
    // exactly the bytes of the verified package.
    const newerUpdater = updaterVersioned('1.0.1');
    publish('3.0.6', makeZip(withUpdater('3.0.6', newerUpdater,
        [ [ 'updater/release-signing-keys.json', keyFile([ keyB ], 1) ] ])), { signWith: keyB.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.6' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await signedRequest({ v: 1, cmd: 'apply', version: '3.0.6' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await signedRequest({ v: 1, cmd: 'hello' });
    assert.equal(reply.final.updaterVersion, '1.0.1', 'The refreshed updater answers');
    assert.equal(reply.final.installedVersion, '3.0.6');
    assert.equal(await readFile(signedHost, 'utf8'), newerUpdater);
    // An unsigned package cannot replace the pinned keys.
    const unsignedKeys = makeZip(packageEntries('3.0.7', {}, [ [ 'updater/release-signing-keys.json', keyFile([ keyA ]) ] ]));
    publish('3.0.7', unsignedKeys);
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.7' });
    assert.equal(reply.final.error?.code, 'signature-missing');
    // A signed package never brings back an older key set generation.
    publish('3.0.8', makeZip(packageEntries('3.0.8', {}, [ [ 'updater/release-signing-keys.json', keyFile([ keyA ]) ] ])),
        { signWith: keyB.privateKeyPem });
    reply = await signedRequest({ v: 1, cmd: 'stage', version: '3.0.8' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await signedRequest({ v: 1, cmd: 'apply', version: '3.0.8' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    assert.deepEqual(await trustedIds(), [ 'test-b' ]);
    // Rerunning an older installer keeps the newer updater and the rotated
    // keys; only -Force and -ResetKeys replace them.
    const rerunWith = async (keys, ...args) => {
        await writeFile(path.join(signedSource, 'release-signing-keys.json'), keys);
        const result = await runPowerShell(signedInstaller, [ ...argsFor(signedRoot), '-ExtensionDirectory', signedDir, ...args ]);
        assert.equal(result.status, 0, result.stderr + result.stdout);
        return result;
    };
    let rerun = await rerunWith(keyFile([ keyA ]));
    assert.match(rerun.stdout, /Kept the installed updater 1\.0\.1/);
    assert.match(rerun.stdout, /Kept the trusted release signing keys/);
    assert.equal(await readFile(signedHost, 'utf8'), newerUpdater);
    assert.deepEqual(await trustedIds(), [ 'test-b' ]);
    await rerunWith(keyFile([ keyB, keyA ], 1));
    assert.deepEqual(await trustedIds(), [ 'test-b', 'test-a' ], 'A superset of the same generation is adopted');
    rerun = await rerunWith(keyFile([ keyB, keyA ]));
    assert.match(rerun.stdout, /Kept the trusted release signing keys/);
    assert.equal((await trustedKeys()).generation, 1, 'An older generation is kept out, even as a superset');
    // An updater that missed a whole key rotation catches up when its user
    // reruns the installer of a newer package.
    await rerunWith(keyFile([ keyA ], 2));
    assert.deepEqual([ await trustedIds(), (await trustedKeys()).generation ], [ [ 'test-a' ], 2 ],
        'A later generation is adopted without the keys it retired');
    await rerunWith(keyFile([ keyA ]), '-ResetKeys', '-Force');
    assert.deepEqual([ await trustedIds(), (await trustedKeys()).generation ], [ [ 'test-a' ], undefined ]);
    assert.equal(await readFile(signedHost, 'utf8'), realUpdater);

    // Without published keys, an unsigned package changes neither the keys
    // nor the updater; rerunning the installer from a newer package does.
    const tofuRoot = path.join(fixture, 'TofuUpdater');
    const tofuDir = path.join(fixture, 'Tofu', 'uBlock-Plus');
    await writePackage(tofuDir, packageEntries('4.0.0'));
    const tofuInstall = await runPowerShell(installer, [ ...argsFor(tofuRoot), '-ExtensionDirectory', tofuDir ]);
    assert.equal(tofuInstall.status, 0, tofuInstall.stderr);
    assert.match(tofuInstall.stdout, /Signed releases\s+: not configured/);
    const tofuRequest = message => nativeRequest(message, `chrome-extension://${unpackedId(tofuDir)}/`, tofuRoot);
    publish('4.0.1', makeZip(withUpdater('4.0.1', newerUpdater,
        [ [ 'updater/release-signing-keys.json', keyFile([ keyA ]) ] ])));
    reply = await tofuRequest({ v: 1, cmd: 'stage', version: '4.0.1' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await tofuRequest({ v: 1, cmd: 'apply', version: '4.0.1' });
    assert.equal(reply.final.ok, true, JSON.stringify(reply.final));
    reply = await tofuRequest({ v: 1, cmd: 'hello' });
    assert.equal(reply.final.signatureRequired, false, 'Keys are not adopted from an unsigned package');
    assert.equal(reply.final.updaterVersion, '1.0.0', 'The updater is not replaced by an unsigned package');
    const tofuRerun = await runPowerShell(signedInstaller, [ ...argsFor(tofuRoot), '-ExtensionDirectory', tofuDir ]);
    assert.equal(tofuRerun.status, 0, tofuRerun.stderr + tofuRerun.stdout);
    assert.match(tofuRerun.stdout, /Signed releases\s+: required/);
    publish('4.0.2', makeZip(packageEntries('4.0.2')));
    reply = await tofuRequest({ v: 1, cmd: 'stage', version: '4.0.2' });
    assert.equal(reply.final.error?.code, 'signature-missing');

    // Options passed to the installer replace stored ones; others are kept.
    const stableRoot = path.join(fixture, 'StableUpdater');
    const stableDir = path.join(fixture, 'Stable', 'uBlock-Plus');
    const stableConfig = () => readJson(path.join(stableRoot, 'config.json'));
    await writePackage(stableDir, packageEntries('5.0.0'));
    const savedReleases = releaseList;
    releaseList = [ release('5.1.0') ];
    let stable = await runPowerShell(installer, [ ...argsFor(stableRoot), '-ExtensionDirectory', stableDir, '-StableOnly' ]);
    assert.equal(stable.status, 0, stable.stderr + stable.stdout);
    assert.match(stable.stdout + stable.stderr, /No stable release is published yet/);
    assert.equal((await stableConfig()).includePrerelease, false);
    const bare = [ '-InstallRoot', stableRoot, '-NoRegistry', '-ExtensionDirectory', stableDir ];
    stable = await runPowerShell(installer, bare);
    assert.equal(stable.status, 0, stable.stderr + stable.stdout);
    assert.equal((await stableConfig()).includePrerelease, false, 'A rerun without options keeps the channel');
    assert.equal((await stableConfig()).repository, 'test/repo', 'A rerun without options keeps the repository');
    stable = await runPowerShell(installer, [ ...bare, '-IncludePrerelease' ]);
    assert.equal(stable.status, 0, stable.stderr + stable.stdout);
    assert.equal((await stableConfig()).includePrerelease, true);
    stable = await runPowerShell(installer, [ ...bare, '-Repository', 'test/other' ]);
    assert.equal(stable.status, 0, stable.stderr + stable.stdout);
    assert.equal((await stableConfig()).repository, 'test/other', 'An explicit -Repository replaces the stored one');
    assert.equal((await stableConfig()).releaseBaseUrl, 'https://github.com/test/other/releases/download');
    assert.equal((await stableConfig()).apiBaseUrl, base);
    stable = await runPowerShell(installer, [ ...bare, '-StableOnly', '-IncludePrerelease' ]);
    assert.notEqual(stable.status, 0);
    releaseList = savedReleases;

    // Experimental builds share one extension ID. A second folder with the
    // same ID is refused unless -Replace moves the registration.
    const dupRoot = path.join(fixture, 'DupUpdater');
    const dupA = path.join(fixture, 'DupA', 'uBlock-Plus');
    const dupB = path.join(fixture, 'DupB', 'uBlock-Plus');
    const sharedId = 'a'.repeat(32);
    await writePackage(dupA, packageEntries('6.0.0'));
    await writePackage(dupB, packageEntries('6.0.0'));
    let dup = await runPowerShell(installer, [ ...argsFor(dupRoot), '-ExtensionDirectory', dupA, '-ExtensionId', sharedId ]);
    assert.equal(dup.status, 0, dup.stderr + dup.stdout);
    dup = await runPowerShell(installer, [ ...argsFor(dupRoot), '-ExtensionDirectory', dupB, '-ExtensionId', sharedId ]);
    assert.notEqual(dup.status, 0);
    // PowerShell may wrap long error lines.
    assert.match((dup.stderr + dup.stdout).replace(/\s+/g, ' '), /already registered for extension ID/);
    assert.match(dup.stderr + dup.stdout, /-Replace/);
    const dupConfigPath = path.join(dupRoot, 'config.json');
    assert.deepEqual((await readJson(dupConfigPath)).installations.map(entry => entry.extensionDir.toLowerCase()),
        [ dupA.toLowerCase() ]);
    dup = await runPowerShell(installer, [ ...argsFor(dupRoot), '-ExtensionDirectory', dupB, '-ExtensionId', sharedId, '-Replace' ]);
    assert.equal(dup.status, 0, dup.stderr + dup.stdout);
    const dupConfig = await readJson(dupConfigPath);
    assert.deepEqual(dupConfig.installations.map(entry => entry.extensionDir.toLowerCase()), [ dupB.toLowerCase() ]);
    // A configuration that still lists the ID twice is never guessed.
    const [ entryB ] = dupConfig.installations;
    dupConfig.installations = [ { ...entryB, extensionDir: path.join(fixture, 'DupA', 'uBlock-Plus') }, entryB ];
    await writeFile(dupConfigPath, JSON.stringify(dupConfig));
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, `chrome-extension://${sharedId}/`, dupRoot);
    assert.equal(reply.final.error?.code, 'ambiguous-installation', JSON.stringify(reply.final));

    // The installer refuses a folder that other users of this PC can change
    // before it registers anything, and removes a folder it created for the
    // first download.
    const commonRoot = path.join(fixture, 'CommonUpdater');
    const commonParent = path.join(fixture, 'Common');
    const commonDir = path.join(commonParent, 'uBlock-Plus');
    await writePackage(commonDir, packageEntries('7.0.0'));
    share(commonDir, '(OI)(CI)M', 'S-1-5-32-545');
    let common = await runPowerShell(installer, [ ...argsFor(commonRoot), '-ExtensionDirectory', commonDir ]);
    assert.notEqual(common.status, 0);
    assert.match((common.stderr + common.stdout).replace(/\s+/g, ' '), /Other users of this PC can change/);
    assert.equal(await exists(path.join(commonRoot, 'config.json')), false, 'Nothing is registered');
    unshare(commonDir, 'S-1-5-32-545');
    share(commonParent, '(OI)(CI)M', 'S-1-5-32-545');
    const commonMissing = path.join(commonParent, 'Missing');
    common = await runPowerShell(installer, [ ...argsFor(commonRoot), '-ExtensionDirectory', commonMissing ]);
    assert.notEqual(common.status, 0);
    assert.match((common.stderr + common.stdout).replace(/\s+/g, ' '), /Other users of this PC can rename or replace/);
    assert.equal(await exists(commonMissing), false, 'The folder created for the first download is removed');
    assert.equal(await exists(path.join(commonRoot, 'config.json')), false);
    unshare(commonParent, 'S-1-5-32-545');
    // Like C:\, a parent may give its new folders rights that it does not
    // hold itself: the updater checks a folder it creates again.
    share(commonParent, '(OI)(CI)(IO)M', 'S-1-5-32-545');
    const mainConfigPath = path.join(installRoot, 'config.json');
    const mainConfig = await readFile(mainConfigPath, 'utf8');
    await writeFile(mainConfigPath, JSON.stringify({ ...JSON.parse(mainConfig), installations: [
        ...JSON.parse(mainConfig).installations,
        { extensionDir: commonMissing, edition: 'standard', extensionIds: [ 'b'.repeat(32) ] },
    ] }));
    cli = await runPowerShell(installedHost, [ '-Install', '-ExtensionDirectory', commonMissing, '-Version', '1.3.0' ]);
    await writeFile(mainConfigPath, mainConfig);
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr.replace(/\s+/g, ' '), /\(unsafe-extension-dir\): Other users of this PC can change/);
    assert.equal(await exists(path.join(commonMissing, 'manifest.json')), false);

    // Bootstrap into an empty folder, then uninstall both registrations.
    const secondDir = path.join(fixture, 'Second', 'uBlock-Plus');
    const bootstrap = await runPowerShell(installer, [ ...installArgs, '-ExtensionDirectory', secondDir ]);
    assert.equal(bootstrap.status, 0, bootstrap.stderr + bootstrap.stdout);
    assert.match(bootstrap.stdout, /select Allow the updater, then Check now/);
    assert.equal(await readVersion(secondDir), '1.3.0');
    const both = await readJson(path.join(installRoot, 'config.json'));
    assert.equal(both.installations.length, 2);
    reply = await nativeRequest({ v: 1, cmd: 'hello' }, `chrome-extension://${unpackedId(secondDir)}/`);
    assert.equal(reply.final.extensionDir.toLowerCase(), secondDir.toLowerCase());
    const secondKey = pathKey(both.installations.find(entry =>
        entry.extensionDir.toLowerCase() === secondDir.toLowerCase()).extensionDir);
    const secondData = [ `state-${secondKey}.json`, `backup/${secondKey}`, `staging/${secondKey}` ]
        .map(name => path.join(installRoot, ...name.split('/')));
    await mkdir(secondData[1], { recursive: true });
    await mkdir(secondData[2], { recursive: true });
    assert.equal(await exists(secondData[0]), true, 'The bootstrap recorded its state');
    // Uninstall waits for a running update.
    const busy = await open(path.join(installRoot, 'updater.lock'), 'w');
    let removed = await runPowerShell(installer, [ ...installArgs, '-ExtensionDirectory', secondDir, '-Uninstall' ]);
    await busy.close();
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr + removed.stdout, /An update is running/);
    assert.equal((await readJson(path.join(installRoot, 'config.json'))).installations.length, 2);
    assert.equal(await exists(secondData[1]), true, 'Nothing is removed while an update runs');
    removed = await runPowerShell(installer, [ ...installArgs, '-ExtensionDirectory', secondDir, '-Uninstall' ]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal((await readJson(path.join(installRoot, 'config.json'))).installations.length, 1);
    for ( const target of secondData ) {
        assert.equal(await exists(target), false, `Uninstall removes ${path.basename(target)} of that folder`);
    }
    assert.equal(await exists(statePath), true, 'The remaining installation keeps its state');
    const remaining = await readJson(path.join(installRoot, 'io.github.kayurachann.ublock_plus.updater.json'));
    assert.ok(Array.isArray(remaining.allowed_origins) && remaining.allowed_origins.length === 1,
        'allowed_origins stays an array after an uninstall leaves one installation');
    assert.equal(await readVersion(secondDir), '1.3.0', 'Uninstall never deletes the extension');
    removed = await runPowerShell(installer, [ ...installArgs, '-ExtensionDirectory', extensionDir, '-Uninstall' ]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await exists(installRoot), false, 'Removing the last installation removes the updater');
    assert.ok(requests.every(url => url.startsWith('/releases/download/') || url.startsWith('/repos/test/repo/releases')));
} finally {
    server.close();
    await rm(fixture, { recursive: true, force: true });
}

console.log('Updater host: install, protocol, staging, integrity/signature/identity guards, links, folder permissions, unlisted files, apply, recovery, rollback, key set generations, CLI, installer options and removal passed.');
