/*******************************************************************************

    uBlock Plus+ - toolbar icon mode after service-worker restart
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Evaluate the real module with its imports replaced by small adapters. Each
// instance starts like a freshly woken service worker: `reverseMode` is false
// and no content-script registration has run.
const source = (await fs.readFile(new URL(
    '../platform/mv3/extension/js/action.js', import.meta.url
), 'utf8')).replace(/\r\n/g, '\n');
assert.match(source, /^import \{ getFilteringModeDetails \} from '\.\/mode-manager\.js';$/m);
const moduleBody = source
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');

const OFF_ICON = '/img/icon_16_off.png';
const ON_ICON = '/img/icon_16.png';

function freshWorker(readModes) {
    const icons = [];
    const context = vm.createContext({
        Set,
        browser: { action: {
            setIcon: details => { icons.push(details); },
        } },
        getFilteringModeDetails: readModes,
        matchesFromHostnames: hostnames => Array.from(hostnames),
    });
    vm.runInContext(moduleBody, context);
    return { context, icons };
}

const modes = (none, optimal = []) => ({
    none: new Set(none),
    basic: new Set(),
    optimal: new Set(optimal),
    complete: new Set(),
});

// Default "No filtering" with a few filtered sites: toolbar-icon.js is only
// registered on filtered sites, which must show the ON icon even after the
// worker restarted with its in-memory default.
{
    const { context, icons } = freshWorker(async ( ) =>
        modes([ 'all-urls' ], [ 'enabled.example' ])
    );
    await context.toggleToolbarIcon(5);
    assert.deepEqual(icons.map(details => [ details.tabId, details.path['16'] ]), [
        [ undefined, OFF_ICON ],
        [ 5, ON_ICON ],
    ], 'The global icon and the filtered tab are both restored');
    await context.toggleToolbarIcon(6);
    assert.deepEqual(icons.slice(2).map(details =>
        [ details.tabId, details.path['16'] ]
    ), [ [ 6, ON_ICON ] ], 'The global icon is set once');
}

// Ordinary default filtering: the script runs on sites set to No filtering.
{
    const { context, icons } = freshWorker(async ( ) =>
        modes([ 'trusted.example' ], [ 'all-urls' ])
    );
    await context.toggleToolbarIcon(7);
    assert.deepEqual(icons.map(details => [ details.tabId, details.path['16'] ]), [
        [ 7, OFF_ICON ],
    ]);
}

// Registration and later toggles agree; a mode change is picked up.
{
    let current = modes([ 'all-urls' ]);
    const { context, icons } = freshWorker(async ( ) => current);
    await context.registerToolbarIconToggler({
        filteringModeDetails: current, toAdd: [],
    });
    await context.toggleToolbarIcon(8);
    current = modes([], [ 'all-urls' ]);
    await context.toggleToolbarIcon(9);
    assert.deepEqual(icons.map(details => [ details.tabId, details.path['16'] ]), [
        [ undefined, OFF_ICON ],
        [ 8, ON_ICON ],
        [ undefined, ON_ICON ],
        [ 9, OFF_ICON ],
    ]);
}

// An unreadable mode store keeps the last known mode instead of throwing.
{
    const { context, icons } = freshWorker(async ( ) => {
        throw new Error('mode store unavailable');
    });
    await context.toggleToolbarIcon(10);
    assert.deepEqual(icons.map(details => [ details.tabId, details.path['16'] ]), [
        [ 10, OFF_ICON ],
    ]);
}

console.log('Toolbar icon mode tests passed');
