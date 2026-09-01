/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const productName = process.argv[2] || 'uBlock Plus+';
const previousProductNames = [ 'uBO Lite', 'uBlock Plus+' ];
const localesDir = process.argv[3] ||
    path.join('platform', 'mv3', 'extension', '_locales');
const extNamePattern = /("extName"\s*:\s*\{\s*"message"\s*:\s*)"(?:[^"\\]|\\.)*"/;

const entries = await fs.readdir(localesDir, { withFileTypes: true });
let modifiedCount = 0;

for ( const entry of entries ) {
    if ( entry.isDirectory() === false ) { continue; }
    const filePath = path.join(localesDir, entry.name, 'messages.json');
    let text = await fs.readFile(filePath, 'utf8');
    const match = extNamePattern.exec(text);
    if ( match === null ) {
        throw new Error(`Missing extName.message in ${filePath}`);
    }
    const replacement = `${match[1]}${JSON.stringify(productName)}`;
    let updated = text.replace(extNamePattern, replacement);
    for ( const previousProductName of previousProductNames ) {
        updated = updated.replaceAll(previousProductName, productName);
    }
    if ( updated === text ) { continue; }
    await fs.writeFile(filePath, updated);
    modifiedCount += 1;
}

console.log(`Updated ${modifiedCount} locale files to product name: ${productName}`);
