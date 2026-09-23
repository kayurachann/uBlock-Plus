// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Release signing for the Windows updater (platform/mv3/updater).
//
//   node tools/release-signing.mjs generate --out <private-key.pem> [--id <key-id>]
//       Creates an RSA-3072 key pair. The private key is written outside the
//       repository; the public key is appended to
//       platform/mv3/updater/release-signing-keys.json.
//
//   node tools/release-signing.mjs retire --id <key-id>
//       Removes a key from the key set at the end of a key rotation.
//
//   generate and retire raise the key set's generation. Installers adopt a
//   key set of a later generation, and never go back to an older one.
//
//   node tools/release-signing.mjs sign <package.zip>...
//       Reads one or more PEM private keys, concatenated, from the
//       UBP_RELEASE_SIGNING_KEY environment variable and writes
//       <package.zip>.sig: one base64 RSA PKCS#1 v1.5 signature over the
//       SHA-256 digest of the file per key, one per line. Every signature is
//       verified against the published key set before it is written. Two keys
//       sign releases while keys rotate.
//
//   node tools/release-signing.mjs verify <package.zip>...
//       Checks that <package.zip>.sig verifies against the key set.
//
//   Every command accepts --keys <file> to use another key set file.
//
// Updaters accept a package when any line of its .sig verifies with any key
// they trust. They adopt a new key set only from a package that verified, and
// never one of an older generation.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const KEYS_PATH = path.join(projectRoot, 'platform/mv3/updater/release-signing-keys.json');
// Limits that the updater enforces on .sig files.
export const MAX_SIGNATURE_BYTES = 8192;
export const MAX_SIGNATURES = 8;

export async function readKeySet(file = KEYS_PATH) {
    const document = JSON.parse(await readFile(file, 'utf8'));
    if ( document?.schemaVersion !== 1 || Array.isArray(document.keys) === false ) {
        throw new Error('Unsupported release key file');
    }
    if ( document.generation !== undefined &&
        (Number.isSafeInteger(document.generation) === false || document.generation < 0) ) {
        throw new Error('Malformed release key set generation');
    }
    for ( const key of document.keys ) {
        if ( /^[A-Za-z0-9._-]{1,64}$/.test(key?.id) === false || key.kty !== 'RSA' ||
            typeof key.n !== 'string' || typeof key.e !== 'string' ) {
            throw new Error('Malformed release key');
        }
    }
    return document;
}

export function signBytes(bytes, privateKeyPem) {
    return sign('sha256', bytes, createPrivateKey(privateKeyPem)).toString('base64');
}

// The contents of a .sig file: one base64 signature per line. Blank lines
// are ignored; oversized files and files with too many lines verify nothing.
export function signatureLines(text) {
    if ( Buffer.byteLength(text) > MAX_SIGNATURE_BYTES ) { return []; }
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    return lines.length <= MAX_SIGNATURES ? lines : [];
}

// The ID of the first trusted key that verifies any signature line, or null.
export function verifyBytes(bytes, signatureText, keySet) {
    for ( const line of signatureLines(signatureText) ) {
        const signature = Buffer.from(line, 'base64');
        if ( signature.length === 0 ) { continue; }
        for ( const key of keySet.keys ) {
            const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
            if ( verify('sha256', bytes, publicKey, signature) ) { return key.id; }
        }
    }
    return null;
}

// Every PEM private key in text, in order.
export function privateKeysFromPem(text) {
    return text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g) || [];
}

export function generateKey(id) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const jwk = publicKey.export({ format: 'jwk' });
    return {
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        publicKey: { id, kty: 'RSA', n: jwk.n, e: jwk.e },
    };
}

// Whether target is directory or inside it. Windows paths compare without
// regard to case, so that a differently cased path is not mistaken for an
// outside one.
export function isInsideDirectory(directory, target, platform = process.platform) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const fold = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
    const relative = paths.relative(fold(directory), fold(target));
    const outside = relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
    return outside === false;
}

// Writes keys to file as the next generation of keySet.
async function writeNextKeySet(file, keySet, keys) {
    const generation = (keySet.generation ?? 0) + 1;
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, generation, keys }, null, 2)}\n`);
    return generation;
}

function optionValue(args, name) {
    const index = args.indexOf(name);
    if ( index === -1 ) { return; }
    const value = args[index + 1];
    if ( typeof value !== 'string' || value.startsWith('--') ) { throw new Error(`${name} needs a value`); }
    args.splice(index, 2);
    return value;
}

async function main(args) {
    const [ command, ...rest ] = args;
    const keysPath = path.resolve(optionValue(rest, '--keys') || KEYS_PATH);
    if ( command === 'generate' ) {
        const out = optionValue(rest, '--out');
        const id = optionValue(rest, '--id') || `release-${new Date().toISOString().slice(0, 10)}`;
        if ( typeof out !== 'string' ) {
            throw new Error('Usage: generate --out <private-key.pem> [--id <key-id>]');
        }
        const target = path.resolve(out);
        if ( isInsideDirectory(projectRoot, target) ) {
            throw new Error('Refusing to write the private key inside the repository');
        }
        if ( await stat(target).then(() => true, () => false) ) {
            throw new Error(`${target} already exists`);
        }
        const keySet = await readKeySet(keysPath);
        if ( keySet.keys.some(key => key.id === id) ) { throw new Error(`Key ID ${id} is already published`); }
        const rotating = keySet.keys.length !== 0;
        const { privateKeyPem, publicKey } = generateKey(id);
        await writeFile(target, privateKeyPem, { mode: 0o600, flag: 'wx' });
        const generation = await writeNextKeySet(keysPath, keySet, [ ...keySet.keys, publicKey ]);
        console.log(`Private key: ${target} (keep it secret; never commit it)`);
        console.log(`Public key "${id}" added to ${path.relative(projectRoot, keysPath)} (key set generation ${generation})`);
        if ( rotating === false ) {
            console.log('Store the private key as the GitHub Actions secret UBP_RELEASE_SIGNING_KEY, e.g.:');
            console.log(`  gh secret set UBP_RELEASE_SIGNING_KEY < "${target}"`);
            return;
        }
        // Installed updaters trust only the keys they already have, and a
        // user can skip any number of releases.
        console.log('Key rotation: installed updaters do not trust the new key yet.');
        console.log('  1. Keep the current private key. Set the secret to both keys, e.g.:');
        console.log(`       cat <current-key.pem> "${target}" | gh secret set UBP_RELEASE_SIGNING_KEY`);
        console.log('  2. Publish releases signed with both keys (sign writes one line per key) for a');
        console.log('     long overlap, so that updaters that skip releases still adopt the new key set.');
        console.log('  3. Only then retire the old key and set the secret to the new key alone:');
        console.log('       node tools/release-signing.mjs retire --id <current-key-id>');
        console.log('Updaters that miss the overlap adopt the new key set when their user reruns');
        console.log('updater\\install-updater.cmd from a newer package (a later key set generation).');
        return;
    }
    if ( command === 'retire' ) {
        const id = optionValue(rest, '--id');
        if ( typeof id !== 'string' ) { throw new Error('Usage: retire --id <key-id>'); }
        const keySet = await readKeySet(keysPath);
        const keys = keySet.keys.filter(key => key.id !== id);
        if ( keys.length === keySet.keys.length ) { throw new Error(`Key ID ${id} is not published`); }
        // Updaters keep the keys they trust when a package ships none, and
        // would then refuse every unsigned release.
        if ( keys.length === 0 ) { throw new Error('Refusing to retire the last release key'); }
        const generation = await writeNextKeySet(keysPath, keySet, keys);
        console.log(`Key "${id}" retired from ${path.relative(projectRoot, keysPath)} (key set generation ${generation})`);
        console.log('Remove its private key from the UBP_RELEASE_SIGNING_KEY secret, e.g.:');
        console.log('  gh secret set UBP_RELEASE_SIGNING_KEY < <remaining-key.pem>');
        return;
    }
    if ( command === 'sign' ) {
        const secret = process.env.UBP_RELEASE_SIGNING_KEY || '';
        if ( secret.trim() === '' ) { throw new Error('UBP_RELEASE_SIGNING_KEY is not set'); }
        const privateKeys = privateKeysFromPem(secret);
        if ( privateKeys.length === 0 ) { throw new Error('UBP_RELEASE_SIGNING_KEY holds no PEM private key'); }
        if ( privateKeys.length > MAX_SIGNATURES ) { throw new Error(`At most ${MAX_SIGNATURES} signing keys are supported`); }
        if ( rest.length === 0 ) { throw new Error('Usage: sign <package.zip>...'); }
        const keySet = await readKeySet(keysPath);
        if ( keySet.keys.length === 0 ) {
            throw new Error('No public release key is published; run "generate" first');
        }
        for ( const file of rest ) {
            const bytes = await readFile(file);
            const lines = [];
            const keyIds = [];
            for ( const [ index, privateKeyPem ] of privateKeys.entries() ) {
                const signature = signBytes(bytes, privateKeyPem);
                const keyId = verifyBytes(bytes, signature, keySet);
                if ( keyId === null ) {
                    throw new Error(`Signing key ${index + 1} does not match any published release key`);
                }
                if ( keyIds.includes(keyId) ) { continue; }
                lines.push(signature);
                keyIds.push(keyId);
            }
            await writeFile(`${file}.sig`, `${lines.join('\n')}\n`);
            console.log(`Signed ${path.basename(file)} with ${keyIds.join(', ')}`);
        }
        return;
    }
    if ( command === 'verify' ) {
        if ( rest.length === 0 ) { throw new Error('Usage: verify [--keys <file>] <package.zip>...'); }
        const keySet = await readKeySet(keysPath);
        for ( const file of rest ) {
            const signature = await readFile(`${file}.sig`, 'utf8').catch(() => '');
            const keyId = verifyBytes(await readFile(file), signature, keySet);
            if ( keyId === null ) {
                throw new Error(`${path.basename(file)} has no signature from a key in ${path.basename(keysPath)}`);
            }
            console.log(`${path.basename(file)} verifies with ${keyId}`);
        }
        return;
    }
    throw new Error('Usage: node tools/release-signing.mjs generate|retire|sign|verify ...');
}

if ( process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ) {
    main(process.argv.slice(2)).catch(reason => {
        console.error(`release-signing: ${reason.message}`);
        process.exit(1);
    });
}
