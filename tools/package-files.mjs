// uBlock Plus+ — GPL-3.0-or-later. See LICENSE.txt.
//
// Lists every file of a built extension in updater/package-files.json. The
// Windows updater (platform/mv3/updater) replaces an installed folder with a
// newer package and deletes the files that the new package lacks; it does so
// only for files that the installed package listed here, so that files a user
// put into the extension folder are never deleted.
//
//   node tools/package-files.mjs <extension-directory>

import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const PACKAGE_FILES_PATH = 'updater/package-files.json';

// Relative paths with forward slashes, sorted. Chrome keeps indexed rulesets
// in _metadata inside a loaded unpacked folder; the updater leaves it alone.
export async function listPackageFiles(directory) {
    const files = [];
    const walk = async (absolute, relative) => {
        for ( const entry of await fs.readdir(absolute, { withFileTypes: true }) ) {
            const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
            if ( entry.isDirectory() ) {
                if ( name === '_metadata' ) { continue; }
                await walk(path.join(absolute, entry.name), name);
            } else {
                files.push(name);
            }
        }
    };
    await walk(directory, '');
    return files.sort();
}

export async function writePackageFiles(directory) {
    const files = await listPackageFiles(directory);
    if ( files.includes(PACKAGE_FILES_PATH) === false ) {
        files.push(PACKAGE_FILES_PATH);
        files.sort();
    }
    const target = path.join(directory, ...PACKAGE_FILES_PATH.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(files, null, 1)}\n`);
    return files;
}

if ( process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ) {
    const directory = process.argv[2];
    if ( typeof directory !== 'string' ) {
        console.error('Usage: node tools/package-files.mjs <extension-directory>');
        process.exit(1);
    }
    const files = await writePackageFiles(path.resolve(directory));
    console.log(`Listed ${files.length} package files in ${PACKAGE_FILES_PATH}`);
}
