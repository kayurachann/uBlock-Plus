/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2024-present Raymond Hill

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
import { fetchJSON } from './fetch.js';
import { i18n$ } from './i18n.js';
import { sendMessage } from './ext.js';
import { urlSkip } from './urlskip.js';

/******************************************************************************/

const rulesetDetailsPromise = sendMessage({
    what: 'getEnabledRulesetsDetails',
}).then(details => Array.isArray(details) ? details : [], ( ) => []);

// history.state key: how the address was learned and which list blocked it,
// kept with the history entry so Back/Forward, reload and duplicated tabs
// show the same page without asking the service worker again.
const STATE_KEY = 'ublockPlusStrictBlock';

// The service worker waits up to 1.5 s for a late browser event.
const DETAILS_TIMEOUT_MS = 5000;

/******************************************************************************/

// Only web pages are ever displayed as the target or navigated to.
function toWebURL(raw) {
    if ( typeof raw !== 'string' || raw === '' ) { return; }
    try {
        const url = new URL(raw);
        if ( url.protocol === 'http:' || url.protocol === 'https:' ) {
            return url;
        }
    } catch {
    }
}

function sanitizeSource(source) {
    return typeof source === 'string' && /^[a-z-]{1,32}$/.test(source)
        ? source
        : '';
}

function sanitizeOwner(owner) {
    if ( owner instanceof Object === false ) { return; }
    if ( owner.kind === 'imported' || owner.kind === 'sandbox' ) {
        return { kind: owner.kind };
    }
    if ( owner.kind === 'stock' && typeof owner.rulesetId === 'string' ) {
        return { kind: 'stock', rulesetId: owner.rulesetId };
    }
}

// The blocked address, in this order:
// - the fragment: legacy regexSubstitution redirects (Firefox builds), and
//   every revisit of a history entry this page already annotated;
// - otherwise the service worker, which saw the redirect happen. The answer
//   is then carried in this history entry's own fragment and state.
async function blockedDetails() {
    const fromHash = toWebURL(self.location.hash.slice(1));
    if ( fromHash !== undefined ) {
        const state = self.history.state?.[STATE_KEY];
        return {
            url: fromHash,
            source: sanitizeSource(state?.source) || 'fragment',
            owner: sanitizeOwner(state?.owner),
        };
    }
    let response;
    try {
        response = await Promise.race([
            sendMessage({
                what: 'getStrictBlockDetails',
                timeOrigin: self.performance.timeOrigin,
            }),
            new Promise(resolve => {
                self.setTimeout(resolve, DETAILS_TIMEOUT_MS);
            }),
        ]);
    } catch {
    }
    const url = toWebURL(response?.url);
    if ( url === undefined ) {
        return { url: undefined, source: 'none' };
    }
    const details = {
        url,
        source: sanitizeSource(response.source) || 'none',
        owner: sanitizeOwner(response.owner),
    };
    try {
        const state = self.history.state instanceof Object
            ? self.history.state
            : {};
        self.history.replaceState({
            ...state,
            [STATE_KEY]: { source: details.source, owner: details.owner },
        }, '', `#${url.href}`);
    } catch {
    }
    return details;
}

/******************************************************************************/

function urlToFragment(raw) {
    try {
        const fragment = new DocumentFragment();
        const url = new URL(raw);
        const href = url.href;
        const hn = url.hostname;
        const i = href.indexOf(hn);
        const b = document.createElement('b');
        b.append(hn);
        fragment.append(href.slice(0,i), b, href.slice(i+hn.length));
        return fragment;
    } catch {
    }
    return raw;
}

/******************************************************************************/

function fragmentFromTemplate(template, placeholder, text, details) {
    const fragment = new DocumentFragment();
    const pos = template.indexOf(placeholder);
    if ( pos === -1 ) {
        fragment.append(template);
        return fragment;
    }
    const elem = document.createElement(details.tag);
    const { attributes } = details;
    if ( attributes ) {
        for ( let i = 0; i < attributes.length; i+= 2 ) {
            elem.setAttribute(attributes[i+0], attributes[i+1]);
        }
    }
    elem.append(text);
    fragment.append(
        template.slice(0, pos),
        elem,
        template.slice(pos + placeholder.length)
    );
    return fragment;
}

/******************************************************************************/

// Popup closing stays with the context-aware observer. This interstitial has
// no authoritative opener/intent context and must not bypass that decision.

/******************************************************************************/

function showURLNote(key) {
    const text = i18n$(key);
    if ( text === '' ) { return; }
    dom.text('#urlNote', text);
    dom.attr('#urlNote', 'hidden', null);
}

function disableDontWarn() {
    dom.prop('#disableWarning', 'checked', false);
    dom.prop('#disableWarning', 'disabled', true);
    dom.attr('#disableWarning', 'aria-disabled', 'true');
    dom.attr('.input.checkbox', 'disabled', '');
}

// Without a known address there is nothing to proceed to and no site to
// stop warning about.
function renderUnknownURL() {
    dom.attr('#theURL', 'hidden', '');
    showURLNote('strictblockPlusUrlUnavailable');
    dom.prop('#proceed', 'disabled', true);
    disableDontWarn();
}

// Where the navigation started may be a redirector in front of the blocked
// site: Proceed may come back here, and a permanent "don't warn" must not
// rest on a guessed host.
function renderApproximateURL() {
    showURLNote('strictblockPlusUrlApproximate');
    disableDontWarn();
}

function renderURL(toURL) {
    dom.clear('#theURL > p > span:first-of-type');
    qs$('#theURL > p > span:first-of-type').append(urlToFragment(toURL.href));
}

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/691
//   Parse URL to extract as much useful information as possible. This is
//   useful to assist the user in deciding whether to navigate to the web page.

function renderParsedURL(toURL) {
    const reURL = /^https?:\/\//;

    const liFromParam = function(name, value) {
        if ( value === '' ) {
            value = name;
            name = '';
        }
        const li = dom.create('li');
        let span = dom.create('span');
        dom.text(span, name);
        li.appendChild(span);
        if ( name !== '' && value !== '' ) {
            li.appendChild(document.createTextNode(' = '));
        }
        span = dom.create('span');
        if ( reURL.test(value) ) {
            const a = dom.create('a');
            dom.attr(a, 'href', value);
            dom.text(a, value);
            span.appendChild(a);
        } else {
            dom.text(span, value);
        }
        li.appendChild(span);
        return li;
    };

    // https://github.com/uBlockOrigin/uBlock-issues/issues/1649
    //   Limit recursion.
    const renderParams = function(parentNode, rawURL, depth = 0) {
        let url;
        try {
            url = new URL(rawURL);
        } catch {
            return false;
        }

        const search = url.search.slice(1);
        if ( search === '' ) { return false; }

        url.search = '';
        const li = liFromParam(i18n$('strictblockNoParamsPrompt'), url.href);
        parentNode.appendChild(li);

        const params = new self.URLSearchParams(search);
        for ( const [ name, value ] of params ) {
            const li = liFromParam(name, value);
            if ( depth < 2 && reURL.test(value) ) {
                const ul = dom.create('ul');
                renderParams(ul, value, depth + 1);
                li.appendChild(ul);
            }
            parentNode.appendChild(li);
        }

        return true;
    };

    if ( renderParams(qs$('#parsed'), toURL.href) === false ) { return; }

    dom.cl.remove('#toggleParse', 'hidden');

    dom.on('#toggleParse', 'click', ( ) => {
        dom.cl.toggle('#theURL', 'collapsed');
    });
}

/******************************************************************************/

// Which list caused the blocking. The service worker names it from the rule
// which matched; the rule files are searched only when it could not, and only
// if they still carry the URL in a regexSubstitution (Firefox builds). The
// extensionPath redirects of other builds have no regex to test.

async function legacyListName(rulesetDetails, toURL) {
    const candidates = rulesetDetails.filter(details =>
        Boolean(details?.rules?.strictblock)
    );
    if ( candidates.length === 0 ) { return ''; }
    const toHref = toURL.href;
    const matchesDomain = requestDomains => {
        if ( requestDomains === undefined ) { return true; }
        if ( Array.isArray(requestDomains) === false ) { return false; }
        let hn = toURL.hostname;
        for (;;) {
            if ( requestDomains.includes(hn) ) { return true; }
            const pos = hn.indexOf('.');
            if ( pos === -1 ) { return false; }
            hn = hn.slice(pos+1);
        }
    };
    const matchesList = rules => {
        if ( Array.isArray(rules) === false ) { return false; }
        for ( const rule of rules ) {
            if ( typeof rule?.action?.redirect?.regexSubstitution !== 'string' ) {
                continue;
            }
            const { regexFilter, requestDomains } = rule.condition || {};
            if ( typeof regexFilter !== 'string' ) { continue; }
            if ( matchesDomain(requestDomains) === false ) { continue; }
            try {
                const flags = rule.condition.isUrlFilterCaseSensitive === true
                    ? ''
                    : 'i';
                if ( new RegExp(regexFilter, flags).test(toHref) ) {
                    return true;
                }
            } catch {
            }
        }
        return false;
    };
    const results = await Promise.all(candidates.map(details =>
        fetchJSON(`/rulesets/strictblock/${details.id}`).then(matchesList)
    ));
    const i = results.indexOf(true);
    return i !== -1 ? candidates[i].name || '' : '';
}

async function renderReason(details) {
    const rulesetDetails = await rulesetDetailsPromise;
    const { owner } = details;
    let name = '';
    if ( owner?.kind === 'stock' ) {
        const ruleset = rulesetDetails.find(r => r?.id === owner.rulesetId);
        name = typeof ruleset?.name === 'string' ? ruleset.name : '';
    } else if ( owner?.kind === 'imported' ) {
        name = i18n$('3pGroupImported');
    } else if ( owner?.kind === 'sandbox' ) {
        name = i18n$('myFiltersPageName');
    } else if ( details.url !== undefined ) {
        name = await legacyListName(rulesetDetails, details.url);
    }
    if ( name === '' ) { return; }
    const fragment = fragmentFromTemplate(
        i18n$('strictblockReasonSentence1'),
        '{{listname}}', name,
        { tag: 'q' }
    );
    qs$('#reason').append(fragment);
    dom.attr('#reason', 'hidden', null);
}

/******************************************************************************/

// Offer to skip redirection whenever possible

async function renderURLSkip(toURL, toFinalURL) {
    const rulesetDetails = await rulesetDetailsPromise;
    const toFetch = [];
    for ( const details of rulesetDetails ) {
        if ( Boolean(details?.rules?.urlskip) === false ) { continue; }
        toFetch.push(fetchJSON(`/rulesets/urlskip/${details.id}`));
    }
    if ( toFetch.length === 0 ) { return; }
    const urlskipLists = await Promise.all(toFetch);
    const toHn = toURL.hostname;
    const matchesHn = hn => {
        if ( toHn.endsWith(hn) === false ) { return false; }
        if ( hn.length === toHn.length ) { return true; }
        return toHn.charAt(toHn.length - hn.length - 1) === '.';
    };
    for ( const urlskips of urlskipLists ) {
        if ( Array.isArray(urlskips) === false ) { continue; }
        for ( const urlskip of urlskips ) {
            let re;
            try {
                re = new RegExp(urlskip.re, urlskip.c ? undefined : 'i');
            } catch {
                continue;
            }
            if ( re.test(toURL.href) === false ) { continue; }
            if ( urlskip.hostnames ) {
                if ( urlskip.hostnames.some(hn => matchesHn(hn)) === false ) {
                    continue;
                }
            }
            const finalURL = toWebURL(urlSkip(toURL.href, false, urlskip.steps));
            if ( finalURL === undefined ) { continue; }
            toFinalURL.href = finalURL.href;
            const fragment = fragmentFromTemplate(
                i18n$('strictblockRedirectSentence1'),
                '{{url}}', urlToFragment(finalURL.href),
                { tag: 'a', attributes: [ 'href', finalURL.href, 'class', 'code' ] }
            );
            qs$('#urlskip').append(fragment);
            dom.attr('#urlskip', 'hidden', null);
            return;
        }
    }
}

/******************************************************************************/

async function proceed(toURL, toFinalURL) {
    if ( toURL === undefined ) { return; }
    const checkbox = qs$('#disableWarning');
    const permanent = checkbox.checked === true && checkbox.disabled !== true;
    // Do not exclude current hostname from strict-block ruleset if a urlskip
    // directive to another site is in effect.
    // TODO: what if the urlskip directive leads to a different subdomain on
    //       same site?
    if ( toFinalURL.hostname !== toURL.hostname && permanent !== true ) {
        const finalURL = toWebURL(toFinalURL.href);
        if ( finalURL === undefined ) { return; }
        return window.location.replace(finalURL.href);
    }
    await sendMessage({
        what: 'excludeFromStrictBlock',
        hostname: toURL.hostname,
        permanent,
    });
    window.location.replace(toURL.href);
}

/******************************************************************************/

// https://www.reddit.com/r/uBlockOrigin/comments/breeux/

if ( window.history.length > 1 ) {
    dom.on('#back', 'click', ( ) => { window.history.back(); });
    qs$('#bye').style.display = 'none';
} else {
    dom.on('#bye', 'click', ( ) => { window.close(); });
    qs$('#back').style.display = 'none';
}

dom.on('#disableWarning', 'change', ev => {
    const checked = ev.target.checked;
    dom.cl.toggle('[data-i18n="strictblockBack"]', 'disabled', checked);
    dom.cl.toggle('[data-i18n="strictblockClose"]', 'disabled', checked);
});

(async ( ) => {
    let details = { url: undefined, source: 'none' };
    try {
        details = await blockedDetails();
    } catch {
    }
    const toURL = details.url;
    const toFinalURL = new URL(toURL !== undefined ? toURL.href : 'about:blank');

    if ( toURL === undefined ) {
        renderUnknownURL();
    } else {
        renderURL(toURL);
        if ( details.source === 'navigation-start' ) {
            renderApproximateURL();
        }
        renderParsedURL(toURL);
        renderURLSkip(toURL, toFinalURL).catch(( ) => {});
        dom.on('#proceed', 'click', ( ) => { proceed(toURL, toFinalURL); });
    }
    renderReason(details).catch(( ) => {});

    dom.cl.remove(dom.body, 'loading');
})();

/******************************************************************************/
