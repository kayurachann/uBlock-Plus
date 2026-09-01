/*******************************************************************************

    uBlock MV3 Community
    Copyright (C) 2026-present uBlock MV3 Community contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/kayurachann/uBlock-MV3-Community
*/

import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/******************************************************************************/

const extensionDir = path.resolve(process.argv[2] || 'dist/build/uBOLite.chromium');
const errors = [];
let jsonFileCount = 0;
let jsonByteCount = 0;

const reportError = message => {
    errors.push(message);
};

const relativeExtensionPath = value => {
    if ( typeof value !== 'string' || value === '' ) { return; }
    const relative = value.replace(/^[/\\]+/, '');
    const resolved = path.resolve(extensionDir, relative);
    if (
        resolved !== extensionDir &&
        resolved.startsWith(`${extensionDir}${path.sep}`) === false
    ) {
        reportError(`Path escapes the extension directory: ${value}`);
        return;
    }
    return { relative, resolved };
};

const validateFileReference = async (value, label) => {
    const details = relativeExtensionPath(value);
    if ( details === undefined ) {
        reportError(`${label} is not a valid extension path: ${value}`);
        return;
    }
    if ( /[*?]/.test(details.relative) ) { return; }
    const stat = await fs.stat(details.resolved).catch(( ) => { });
    if ( stat?.isFile() !== true ) {
        reportError(`${label} does not exist: ${value}`);
    }
};

const validateJsonFiles = async directory => {
    for ( const entry of await fs.readdir(directory, { withFileTypes: true }) ) {
        const filePath = path.join(directory, entry.name);
        if ( entry.isDirectory() ) {
            await validateJsonFiles(filePath);
            continue;
        }
        if ( entry.isFile() === false || entry.name.endsWith('.json') === false ) {
            continue;
        }
        const content = await fs.readFile(filePath, { encoding: 'utf8' });
        jsonFileCount += 1;
        jsonByteCount += Buffer.byteLength(content);
        try {
            JSON.parse(content);
        } catch ( reason ) {
            reportError(
                `Invalid JSON in ${path.relative(extensionDir, filePath)}: ` +
                reason.message
            );
        }
    }
};

/******************************************************************************/

const rootStat = await fs.stat(extensionDir).catch(( ) => { });
if ( rootStat?.isDirectory() !== true ) {
    throw new Error(`MV3 extension directory does not exist: ${extensionDir}`);
}

const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = await fs.readFile(manifestPath, { encoding: 'utf8' })
    .then(text => JSON.parse(text));

if ( manifest.manifest_version !== 3 ) {
    reportError('manifest.json must declare manifest_version 3');
}
if ( /^\d+(?:\.\d+){0,3}$/.test(manifest.version) === false ) {
    reportError(`Invalid Chromium extension version: ${manifest.version}`);
}
if ( manifest.background?.service_worker === undefined ) {
    reportError('manifest.json does not declare a background service worker');
} else {
    await validateFileReference(
        manifest.background.service_worker,
        'Background service worker'
    );
}
if ( manifest.permissions?.includes('declarativeNetRequest') !== true ) {
    reportError('manifest.json does not request declarativeNetRequest');
}

const ruleResources = manifest.declarative_net_request?.rule_resources;
if ( Array.isArray(ruleResources) === false || ruleResources.length === 0 ) {
    reportError('manifest.json does not declare any static DNR rulesets');
} else {
    const ids = new Set();
    for ( const resource of ruleResources ) {
        if ( typeof resource.id !== 'string' || resource.id === '' ) {
            reportError('A DNR ruleset has no ID');
        } else if ( ids.has(resource.id) ) {
            reportError(`Duplicate DNR ruleset ID: ${resource.id}`);
        } else {
            ids.add(resource.id);
        }
        await validateFileReference(
            resource.path,
            `DNR ruleset ${resource.id || '<missing ID>'}`
        );
    }
}

await validateFileReference(manifest.action?.default_popup, 'Action popup');
await validateFileReference(manifest.options_page, 'Options page');
for ( const [ size, iconPath ] of Object.entries(manifest.icons || {}) ) {
    await validateFileReference(iconPath, `Icon ${size}`);
}
for ( const entry of manifest.web_accessible_resources || [] ) {
    for ( const resource of entry.resources || [] ) {
        await validateFileReference(resource, 'Web-accessible resource');
    }
}
if ( typeof manifest.default_locale === 'string' ) {
    await validateFileReference(
        `_locales/${manifest.default_locale}/messages.json`,
        'Default locale'
    );
}
await validateFileReference('LICENSE.txt', 'License');
await validateJsonFiles(extensionDir);

if ( errors.length !== 0 ) {
    for ( const error of errors ) {
        console.error(`ERROR: ${error}`);
    }
    process.exitCode = 1;
} else {
    const mib = (jsonByteCount / (1024 * 1024)).toFixed(1);
    console.log(
        `Validated MV3 Chromium extension: ${ruleResources.length} rulesets, ` +
        `${jsonFileCount} JSON files (${mib} MiB).`
    );
}
