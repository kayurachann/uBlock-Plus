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

import { dom, qs$ } from './dom.js';
import {
    localRead, localRemove, localWrite,
    runtime,
    webextFlavor,
} from './ext.js';
import { faIconsInit } from './fa-icons.js';
import { i18n } from './i18n.js';

/******************************************************************************/

dom.body.dataset.platform = webextFlavor;

{
    const manifest = runtime.getManifest();
    dom.text('#aboutNameVer', `${manifest.name} ${manifest.version}`);
}

dom.attr('a', 'target', '_blank');

// Managed `disabledFeatures` entries and the panes they lock. The stylesheet
// hides the same tabs; this also refuses hash or remembered-pane navigation.
const forbiddenPanesByFeature = new Map([
    [ 'dashboard', [ 'settings', 'rulesets', 'filters', 'siteRules', 'diagnostics', 'develop' ] ],
    [ 'develop', [ 'develop' ] ],
    [ 'picker', [ 'filters' ] ],
]);

export function isForbiddenPane(pane) {
    const forbid = (dom.body.dataset.forbid || '').split(' ');
    return forbid.some(feature =>
        forbiddenPanesByFeature.get(feature)?.includes(pane) === true
    );
}

function selectPane(pane) {
    const knownPane = Array.from(document.querySelectorAll('.tabButton[data-pane]'))
        .some(button => button.dataset.pane === pane);
    if ( knownPane === false || isForbiddenPane(pane) ) { return false; }
    dom.body.dataset.pane = pane;
    if ( pane === 'settings' ) {
        localRemove('dashboard.activePane');
    } else {
        localWrite('dashboard.activePane', pane);
    }
    return true;
}

// The page stays hidden (body.loading) until Settings rendered, and a hidden
// heading can be neither scrolled to nor focused: wait until it shows.
let pendingReveal;
function revealSection(heading) {
    pendingReveal?.disconnect();
    pendingReveal = undefined;
    const reveal = ( ) => {
        heading.setAttribute('tabindex', '-1');
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
    };
    if ( dom.cl.has(dom.body, 'loading') === false ) { return reveal(); }
    const observer = new MutationObserver(( ) => {
        if ( dom.cl.has(dom.body, 'loading') ) { return; }
        observer.disconnect();
        if ( pendingReveal === observer ) { pendingReveal = undefined; }
        reveal();
    });
    observer.observe(dom.body, { attributes: true, attributeFilter: [ 'class' ] });
    pendingReveal = observer;
}

// A hash can also name a section of the pane, as in #settings/autoUpdate:
// its heading is scrolled into view and focused.
function selectHashPane() {
    const [ pane, anchor ] = self.location.hash.slice(1).split('/');
    if ( selectPane(pane) === false ) { return false; }
    pendingReveal?.disconnect();
    pendingReveal = undefined;
    if ( typeof anchor !== 'string' || /^[A-Za-z][\w-]{0,63}$/.test(anchor) === false ) {
        return true;
    }
    const heading = qs$(`section[data-pane="${pane}"] #${anchor} h3`);
    if ( heading === null ) { return true; }
    revealSection(heading);
    return true;
}

dom.on('#dashboard-nav', 'click', '.tabButton', ev => {
    const pane = ev.target.closest('.tabButton')?.dataset.pane;
    if ( selectPane(pane) ) { self.location.hash = pane; }
});

self.addEventListener('hashchange', selectHashPane);

localRead('dashboard.activePane').then(pane => {
    if ( selectHashPane() ) { return; }
    if ( typeof pane !== 'string' ) { return; }
    selectPane(pane);
});

// Update troubleshooting on-demand
const tsinfoObserver = new IntersectionObserver(entries => {
    if ( entries.every(a => a.isIntersecting === false) ) { return; }
    import('./troubleshooting.js').then(module => {
        return module.getTroubleshootingInfo();
    }).then(config => {
        qs$('[data-i18n="supportS5H"] + pre').textContent = config;
    });
});
tsinfoObserver.observe(qs$('[data-i18n="supportS5H"] + pre'));

/******************************************************************************/

export function nodeFromTemplate(templateId, nodeSelector) {
    const template = qs$(`template#${templateId}`);
    const fragment = template.content.cloneNode(true);
    const node = nodeSelector !== undefined
        ? qs$(fragment, nodeSelector)
        : fragment.firstElementChild;
    faIconsInit(node);
    i18n.render(node);
    return node;
}

/******************************************************************************/

export function hashFromIterable(iter) {
    if ( Boolean(iter) === false ) { return ''; }
    return Array.from(iter).sort().join('\n');
}

/******************************************************************************/

// Shared result line for dashboard operations which have no inline status.

let operationTimer;

export function setOperationStatus(text, level = 'info') {
    const node = qs$('#operationStatus');
    if ( node === null ) { return; }
    self.clearTimeout(operationTimer);
    node.dataset.level = level;
    dom.text(node, text);
    if ( text !== '' ) {
        operationTimer = self.setTimeout(( ) => {
            dom.text(node, '');
            delete node.dataset.level;
        }, level === 'error' ? 9000 : 5000);
    }
}

/******************************************************************************/
