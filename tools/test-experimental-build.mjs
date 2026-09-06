// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.

import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
    experimentalExtensionId,
    experimentalIdentityErrors,
    experimentalManifestErrors,
    experimentalName,
} from './experimental-build-config.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(projectRoot,
    'platform/mv3/chromium-experimental/metadata.json'), 'utf8'));
const standard = JSON.parse(await readFile(path.join(projectRoot,
    'platform/mv3/chromium/manifest.json'), 'utf8'));
const manifest = {
    ...standard,
    name: experimentalName,
    key: metadata.publicKey,
    permissions: [ ...standard.permissions, 'webRequest', 'webRequestBlocking' ],
    optional_permissions: standard.optional_permissions.filter(value => value !== 'webRequest'),
};
assert.deepEqual(experimentalIdentityErrors(metadata), []);
assert.deepEqual(experimentalManifestErrors(manifest, metadata, true), []);
assert.deepEqual(experimentalManifestErrors(standard, undefined, false), []);
assert.match(experimentalManifestErrors(manifest, metadata, false).join(), /--experimental-webrequest/);
assert.match(experimentalManifestErrors(standard, metadata, false).join(), /--experimental-webrequest/);
assert.notEqual(experimentalManifestErrors(standard, undefined, true).length, 0);
for ( const invalid of [
    { ...metadata, schemaVersion: 2 },
    { ...metadata, edition: 'power' },
    { ...metadata, extensionId: 'a'.repeat(32) },
    { ...metadata, publicKey: 'malformed-public-key' },
    { ...metadata, publicKey: `${metadata.publicKey}\n` },
] ) {
    assert.notEqual(experimentalIdentityErrors(invalid).length, 0);
}
assert.notEqual(experimentalManifestErrors({ ...manifest, key: 'incorrect' }, metadata, true).length, 0);
assert.notEqual(experimentalManifestErrors({ ...manifest, name: standard.name }, metadata, true).length, 0);
assert.notEqual(experimentalManifestErrors({
    ...manifest,
    optional_permissions: [ 'webRequest' ],
}, metadata, true).length, 0);
assert.notEqual(experimentalManifestErrors({
    ...manifest,
    permissions: manifest.permissions.filter(value => value !== 'webRequestBlocking'),
}, metadata, true).length, 0);

const fixture = await mkdtemp(path.join(os.tmpdir(), 'ubp-experimental-build-'));
const markerPath = path.join(fixture, 'experimental-webrequest.json');
const manifestPath = path.join(fixture, 'manifest.json');
const writeJSON = (target, value) => writeFile(target, JSON.stringify(value));
try {
    await writeJSON(manifestPath, manifest);
    await writeJSON(markerPath, metadata);
    const validator = path.join(projectRoot, 'tools/validate-mv3.mjs');
    const rejected = spawnSync(process.execPath, [ validator, fixture ], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /require --experimental-webrequest validation/);
    const incomplete = spawnSync(process.execPath,
        [ validator, fixture, '--experimental-webrequest' ], { encoding: 'utf8' });
    assert.equal(incomplete.status, 1);
    assert.doesNotMatch(incomplete.stderr, /require --experimental-webrequest validation/);
    assert.match(incomplete.stderr, /Required experimental component does not exist: js\/webrequest-firewall.js/);
    assert.match(incomplete.stderr, /Required experimental component does not exist: start-experimental-chrome.ps1/);
    assert.match(incomplete.stderr, /Required experimental component does not exist: start-experimental-chrome.cmd/);

    if ( process.platform === 'win32' ) {
        await mkdir(path.join(fixture, 'js'));
        await writeFile(path.join(fixture, 'js/webrequest-firewall.js'), '// Fixture; not executed.');
        const chromeFixture = path.join(fixture, 'chrome.exe');
        await writeFile(chromeFixture, 'PrintCommand fixture; never launched.');
        const launcher = path.join(projectRoot, 'tools/start-experimental-chrome.ps1');
        const command = [ '-NoProfile', '-NonInteractive', '-File', launcher,
            '-ExtensionDirectory', fixture, '-ChromePath', chromeFixture, '-PrintCommand' ];
        const expectedProfile = path.join(await realpath(process.env.LOCALAPPDATA),
            'uBlockPlus', 'ExperimentalChrome', experimentalExtensionId);
        const existed = await access(expectedProfile).then(() => true, () => false);
        const launch = spawnSync('pwsh', command, { encoding: 'utf8' });
        assert.equal(launch.status, 0, launch.stderr);
        const specification = JSON.parse(launch.stdout);
        // CI can expose TEMP via an 8.3 alias (RUNNER~1) which .NET expands.
        // Verify that the command targets the same file, not its path spelling.
        assert.equal(await realpath(specification.executable), await realpath(chromeFixture));
        assert.equal(specification.extensionId, experimentalExtensionId);
        assert.equal(specification.profileDirectory, expectedProfile);
        assert.deepEqual(specification.arguments, [
            `--user-data-dir=${specification.profileDirectory}`,
            `--allowlisted-extension-id=${experimentalExtensionId}`,
            '--no-first-run', '--no-default-browser-check', 'chrome://extensions/',
        ]);
        assert.equal(path.basename(specification.profileDirectory), experimentalExtensionId);
        assert.equal(path.basename(path.dirname(specification.profileDirectory)), 'ExperimentalChrome');
        assert.equal(path.basename(path.dirname(path.dirname(specification.profileDirectory))), 'uBlockPlus');
        assert.equal(await access(specification.profileDirectory).then(() => true, () => false), existed,
            'PrintCommand must not create the isolated profile');
        const repeat = spawnSync('pwsh', command, { encoding: 'utf8' });
        assert.equal(repeat.status, 0, repeat.stderr);
        assert.equal(await access(specification.profileDirectory).then(() => true, () => false), existed,
            'PrintCommand must not create the isolated profile');
        const forbiddenOverride = spawnSync('pwsh', [ ...command, '-ProfileDirectory', fixture ], { encoding: 'utf8' });
        assert.notEqual(forbiddenOverride.status, 0, 'Personal profile overrides must be rejected');
        for ( const invalid of [
            { ...metadata, extensionId: 'a'.repeat(32) },
            { ...metadata, publicKey: 'malformed-public-key' },
            { ...metadata, publicKey: `${metadata.publicKey}\n` },
        ] ) {
            await writeJSON(markerPath, invalid);
            const result = spawnSync('pwsh', command, { encoding: 'utf8' });
            assert.notEqual(result.status, 0, 'Launcher must reject malformed experimental identity');
        }
        await writeJSON(markerPath, metadata);
        await writeJSON(manifestPath, { ...manifest, key: 'incorrect' });
        assert.notEqual(spawnSync('pwsh', command, { encoding: 'utf8' }).status, 0,
            'Launcher must reject manifest/public-key mismatch');
        await writeJSON(manifestPath, manifest);
        await rm(path.join(fixture, 'js/webrequest-firewall.js'));
        assert.notEqual(spawnSync('pwsh', command, { encoding: 'utf8' }).status, 0,
            'Launcher must reject a missing firewall runtime');
    }
} finally {
    // This is the exact directory returned by mkdtemp for this test only.
    await rm(fixture, { recursive: true, force: true });
}
console.log('Experimental MV3 build identity, validator guards, and launcher tests passed');
