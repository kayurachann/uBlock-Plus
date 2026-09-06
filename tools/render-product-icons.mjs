/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

// Optional artwork-maintenance command. Normal builds use the committed PNGs.
// Pass an installed sharp module path, or make sharp available to this script.
import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const sharp = require(process.argv[2] || 'sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'src/img/ublock.svg'), 'utf8');
const mv3Images = path.join(root, 'platform/mv3/extension/img');
await writeFile(path.join(mv3Images, 'ublock.svg'), source);

const render = async (directory, size, suffix, shield = '#800000') => {
    // Change only the shield color; the yellow plus is the product identity.
    const svg = Buffer.from(source.replaceAll('#800000', shield));
    const png = await sharp(svg, { density: Math.max(72, size / 128 * 72 * 4) })
        .resize(size, size)
        .png()
        .toBuffer();
    await writeFile(path.join(directory, `icon_${size}${suffix}.png`), png);
};

for ( const size of [ 16, 32, 64, 128, 512 ] ) {
    await render(mv3Images, size, '');
    if ( size !== 512 ) { await render(mv3Images, size, '_off', '#999999'); }
}
for ( const size of [ 16, 32, 64, 128 ] ) {
    const directory = path.join(root, 'src/img');
    await render(directory, size, '');
    if ( size === 128 ) { continue; }
    await render(directory, size, '-off', '#808080');
    await render(directory, size, '-loading', '#ffcc00');
}
console.log('Rendered product icons from src/img/ublock.svg (19 PNGs and the MV3 SVG).');
