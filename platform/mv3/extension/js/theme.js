/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2014-present Raymond Hill
    Modifications Copyright (C) 2026-present uBlock Plus+ contributors

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

    Home: https://github.com/gorhill/uBlock
*/

import {
    applyPowerUISettings,
    getPowerUISettings,
    listenForPowerUISettings,
} from './power-ui.js';
import { dom } from './dom.js';

/******************************************************************************/

const colorScheme = self.matchMedia('(prefers-color-scheme: dark)');
let powerUISettings;

function applyTheme(settings) {
    powerUISettings = applyPowerUISettings(settings, dom.html);
    const theme = powerUISettings.theme === 'auto'
        ? colorScheme.matches ? 'dark' : 'light'
        : powerUISettings.theme;
    dom.cl.toggle(dom.html, 'dark', theme === 'dark');
    dom.cl.toggle(dom.html, 'light', theme !== 'dark');
}

applyTheme(await getPowerUISettings());
listenForPowerUISettings(applyTheme);
colorScheme.addEventListener?.('change', ( ) => {
    if ( powerUISettings.theme === 'auto' ) {
        applyTheme(powerUISettings);
    }
});

{
    const mql = self.matchMedia('(hover: hover)');
    const isTouchScreen = mql.matches !== true;
    dom.cl.toggle(dom.html, 'mobile', isTouchScreen);
    dom.cl.toggle(dom.html, 'desktop', isTouchScreen === false);
}
