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
import { getTroubleshootingInfo } from './troubleshooting.js';
import { i18n$ } from './i18n.js';
import { sendMessage } from './ext.js';

/******************************************************************************/

// Reports are filed in a public tracker. As docs/PRIVACY.md states, they
// carry only origins: paths and queries can identify the user or embed
// tokens, e.g. in private imported-list subscription URLs.

const ISSUE_TRACKER = 'https://github.com/kayurachann/uBlock-Plus/issues';

function originOnlyURL(url) {
    return `${url.protocol}//${url.host}/`;
}

function redactURLs(text) {
    return text.replace(
        /\b([a-z][a-z\d+.-]*:\/\/)(?:[^\s/?#@]*@)?([^\s/?#]*)([/?#]\S*)?/gi,
        (match, scheme, host, rest) => `${scheme}${host}${rest ? '/…' : ''}`
    );
}

/******************************************************************************/

const reportedPage = (( ) => {
    const url = new URL(window.location.href);
    try {
        const pageURL = url.searchParams.get('url');
        if ( pageURL === null ) { return null; }
        const parsedURL = new URL(pageURL);
        const select = qs$('select[name="url"]');
        dom.text(select.options[0], originOnlyURL(parsedURL));
        return {
            hostname: parsedURL.hostname.replace(/^(m|mobile|www)\./, ''),
            siteMode: parseInt(url.searchParams.get('mode'), 10),
            tabId: parseInt(url.searchParams.get('tabid'), 10) || 0,
        };
    } catch {
    }
    return null;
})();

/******************************************************************************/

function reportSpecificFilterType() {
    return qs$('select[name="type"]').value;
}

/******************************************************************************/

async function reportSpecificFilterIssue() {
    if ( self.confirm(i18n$('reportGitHubConfirm')) !== true ) { return; }
    const githubURL = new URL(`${ISSUE_TRACKER}/new`);
    const issueType = reportSpecificFilterType();
    let title = `${reportedPage.hostname}: ${issueType}`;
    if ( qs$('#isNSFW').checked ) {
        title = `[nsfw] ${title}`;
    }
    githubURL.searchParams.set('title', title);
    const configBody = [
        `Page: \`${qs$('select[name="url"]').value}\``,
        `Category: ${issueType}`,
        '',
        '<details>\n\n```yaml',
        qs$('[data-i18n="supportS5H"] + pre').textContent,
        '```\n</details>',
        '',
    ].join('\n');
    githubURL.searchParams.set('body', configBody);
    githubURL.searchParams.set('labels', 'filter-issue');
    sendMessage({ what: 'gotoURL', url: githubURL.href });
}

/******************************************************************************/

// Links in localized text open in a new tab rather than replace this form.
// i18n.js has already rendered them: bind now, so that they work while the
// troubleshooting information is still loading. Real anchors can also be
// focused and activated with the keyboard.
const linkSelector = 'a[href^="https://"], [data-url]';

dom.on(linkSelector, 'click', ev => {
    const elem = ev.target.closest(linkSelector);
    const url = elem?.href || dom.attr(elem, 'data-url');
    if ( typeof url !== 'string' || url === '' ) { return; }
    sendMessage({ what: 'gotoURL', url });
    ev.preventDefault();
});

getTroubleshootingInfo(reportedPage).then(config => {
    // Show exactly what a report will contain.
    qs$('[data-i18n="supportS5H"] + pre').textContent = redactURLs(config);

    if ( reportedPage !== null ) {
        dom.on('[data-i18n="supportReportSpecificButton"]', 'click', ev => {
            reportSpecificFilterIssue();
            ev.preventDefault();
        });

        dom.on('[data-i18n="supportFindSpecificButton"]', 'click', ev => {
            const url = new URL(ISSUE_TRACKER);
            url.searchParams.set('q', `is:issue sort:updated-desc "${reportedPage.hostname}" in:title`);
            sendMessage({ what: 'gotoURL', url: url.href });
            ev.preventDefault();
        });
    }
});
