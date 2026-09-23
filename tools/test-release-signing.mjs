// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.

import {
    generateKey,
    isInsideDirectory,
    privateKeysFromPem,
    readKeySet,
    signBytes,
    verifyBytes,
} from './release-signing.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// The published key set must always parse, even while it is empty.
const published = await readKeySet();
assert.equal(published.schemaVersion, 1);
for ( const key of published.keys ) {
    assert.ok(Buffer.from(key.n, 'base64url').length >= 256, `Release key ${key.id} is at least 2048-bit`);
}

const a = generateKey('key-a');
const b = generateKey('key-b');
assert.equal(a.publicKey.kty, 'RSA');
assert.ok(Buffer.from(a.publicKey.n, 'base64url').length >= 384, 'New keys are RSA-3072');
assert.equal(a.privateKeyPem.includes('PRIVATE KEY'), true);
assert.equal(JSON.stringify(a.publicKey).includes('PRIVATE'), false, 'Only the public part is published');

const data = Buffer.from('uBlock Plus+ package bytes');
const signature = signBytes(data, a.privateKeyPem);
const keySet = { schemaVersion: 1, keys: [ b.publicKey, a.publicKey ] };
assert.equal(verifyBytes(data, signature, keySet), 'key-a');
assert.equal(verifyBytes(Buffer.from('tampered'), signature, keySet), null);
assert.equal(verifyBytes(data, signature, { schemaVersion: 1, keys: [ b.publicKey ] }), null);
assert.equal(verifyBytes(data, 'not-base64!', keySet), null);

// One signature per line: while keys rotate, a release carries the old and
// the new key's signature and verifies for updaters that trust either.
const signatureB = signBytes(data, b.privateKeyPem);
const dual = `${signatureB}\r\n\n${signature}\n`;
assert.equal(verifyBytes(data, dual, { schemaVersion: 1, keys: [ a.publicKey ] }), 'key-a');
assert.equal(verifyBytes(data, dual, { schemaVersion: 1, keys: [ b.publicKey ] }), 'key-b');
assert.equal(verifyBytes(data, `garbage\n${signature}`, keySet), 'key-a', 'A line that does not decode is skipped');
assert.equal(verifyBytes(data, '', keySet), null);
assert.equal(verifyBytes(data, `${'x\n'.repeat(8)}${signature}\n`, keySet), null, 'More than eight lines are refused');
assert.equal(verifyBytes(data, `${signature}\n${' '.repeat(8192)}`, keySet), null, 'Files over 8 KiB are refused');
assert.deepEqual(privateKeysFromPem(`${a.privateKeyPem}\n${b.privateKeyPem}`), [ a.privateKeyPem.trim(), b.privateKeyPem.trim() ]);
assert.deepEqual(privateKeysFromPem('no key'), []);

// The private key must never land inside the repository, whatever the case
// of the path on Windows; sibling folders are outside.
assert.equal(isInsideDirectory('C:\\Users\\me\\ublock', 'c:\\users\\ME\\UBLOCK\\k.pem', 'win32'), true);
assert.equal(isInsideDirectory('C:\\Users\\me\\ublock', 'C:\\Users\\me\\ublock', 'win32'), true);
assert.equal(isInsideDirectory('C:\\Users\\me\\ublock', 'C:\\Users\\me\\ublock\\..foo\\k.pem', 'win32'), true);
assert.equal(isInsideDirectory('C:\\Users\\me\\ublock', 'C:\\Users\\me\\ublock-keys\\k.pem', 'win32'), false);
assert.equal(isInsideDirectory('C:\\Users\\me\\ublock', 'D:\\keys\\k.pem', 'win32'), false);
assert.equal(isInsideDirectory('/home/me/ublock', '/home/me/UBLOCK/k.pem', 'linux'), false);
assert.equal(isInsideDirectory('/home/me/ublock', '/home/me/ublock/k.pem', 'linux'), true);

const fixture = await mkdtemp(path.join(os.tmpdir(), 'ubp-signing-'));
try {
    const bad = path.join(fixture, 'bad.json');
    await writeFile(bad, JSON.stringify({ schemaVersion: 1, keys: [ { id: 'x y', kty: 'RSA', n: 'a', e: 'AQAB' } ] }));
    await assert.rejects(readKeySet(bad), /Malformed/);
    await writeFile(bad, JSON.stringify({ schemaVersion: 2, keys: [] }));
    await assert.rejects(readKeySet(bad), /Unsupported/);
    for ( const generation of [ -1, 1.5, '2' ] ) {
        await writeFile(bad, JSON.stringify({ schemaVersion: 1, generation, keys: [] }));
        await assert.rejects(readKeySet(bad), /generation/, `generation ${JSON.stringify(generation)}`);
    }
    // The CLI refuses to sign without a key and never writes private keys
    // inside the repository.
    const script = path.join(import.meta.dirname, 'release-signing.mjs');
    const env = { ...process.env, UBP_RELEASE_SIGNING_KEY: '' };
    let result = spawnSync(process.execPath, [ script, 'sign', path.join(fixture, 'x.zip') ], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UBP_RELEASE_SIGNING_KEY is not set/);
    result = spawnSync(process.execPath, [ script, 'generate', '--out', path.join(import.meta.dirname, 'leak.pem') ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the repository/);
    if ( process.platform === 'win32' ) {
        result = spawnSync(process.execPath, [ script, 'generate', '--out',
            path.join(import.meta.dirname.toUpperCase(), 'leak.pem') ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /inside the repository/, 'The guard ignores the case of Windows paths');
    }

    // Signing with two keys writes one line per key; each must be published.
    const keysFile = path.join(fixture, 'keys.json');
    await writeFile(keysFile, JSON.stringify({ schemaVersion: 1, keys: [ a.publicKey, b.publicKey ] }));
    const zip = path.join(fixture, 'package.zip');
    await writeFile(zip, data);
    const run = (args, secret = '') => spawnSync(process.execPath, [ script, ...args ],
        { encoding: 'utf8', env: { ...process.env, UBP_RELEASE_SIGNING_KEY: secret } });
    result = run([ 'sign', '--keys', keysFile, zip ], `${a.privateKeyPem}${b.privateKeyPem}`);
    assert.equal(result.status, 0, result.stderr);
    const lines = (await readFile(`${zip}.sig`, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(verifyBytes(data, lines[0], { schemaVersion: 1, keys: [ a.publicKey ] }), 'key-a');
    assert.equal(verifyBytes(data, lines[1], { schemaVersion: 1, keys: [ b.publicKey ] }), 'key-b');
    result = run([ 'verify', '--keys', keysFile, zip ]);
    assert.equal(result.status, 0, result.stderr);
    const c = generateKey('key-c');
    result = run([ 'sign', '--keys', keysFile, zip ], `${a.privateKeyPem}${c.privateKeyPem}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Signing key 2 does not match any published release key/);
    await writeFile(`${zip}.sig`, `${signBytes(data, c.privateKeyPem)}\n`);
    result = run([ 'verify', '--keys', keysFile, zip ]);
    assert.notEqual(result.status, 0, 'verify fails without a signature from the key set');

    // Adding a key to a published set prints the rotation procedure instead
    // of telling the maintainer to replace the signing secret.
    const rotationKeys = path.join(fixture, 'rotation.json');
    await writeFile(rotationKeys, JSON.stringify({ schemaVersion: 1, keys: [ a.publicKey ] }));
    result = run([ 'generate', '--keys', rotationKeys, '--id', 'key-new', '--out', path.join(fixture, 'new.pem') ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Key rotation/);
    assert.match(result.stdout, /Keep the current private key/);
    assert.doesNotMatch(result.stdout, /Store the private key as the GitHub Actions secret/);
    assert.match(result.stdout, /retire --id/);
    let rotation = await readKeySet(rotationKeys);
    assert.deepEqual(rotation.keys.map(key => key.id), [ 'key-a', 'key-new' ]);
    // Every change raises the generation, so that installers can tell a
    // newer key set from an older one.
    assert.equal(rotation.generation, 1);
    result = run([ 'retire', '--keys', rotationKeys, '--id', 'key-a' ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /generation 2/);
    rotation = await readKeySet(rotationKeys);
    assert.deepEqual([ rotation.generation, rotation.keys.map(key => key.id) ], [ 2, [ 'key-new' ] ]);
    result = run([ 'retire', '--keys', rotationKeys, '--id', 'key-a' ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not published/);
    result = run([ 'retire', '--keys', rotationKeys, '--id', 'key-new' ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /last release key/);
    assert.equal((await readKeySet(rotationKeys)).generation, 2, 'A refused retire changes nothing');
} finally {
    await rm(fixture, { recursive: true, force: true });
}

console.log('Release signing: key generation, signing, verification, rotation, key set generations and CLI guards passed.');
