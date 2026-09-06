/* uBlock Plus+ — live diagnostics UI. GPL-3.0-or-later. */

import { exportLoggerEntries } from './logger-format.js';
import { loggerUIText } from './logger-ui-text.js';
import { webext } from './ext-compat.js';

const $ = selector => document.querySelector(selector);
const labels = loggerUIText(webext.i18n.getUILanguage?.() || navigator.language);
document.documentElement.lang = labels.language;
document.title = `uBlock Plus+ — ${labels.title}`;
for ( const [ selector, key ] of [
    [ 'h1', 'title' ], [ '#intro', 'intro' ], [ '#tabLabel', 'tab' ],
    [ '#start', 'start' ], [ '#stop', 'pause' ], [ '#clear', 'clear' ], [ '#export', 'export' ],
    [ '#searchLabel', 'search' ], [ '#kindLabel', 'kind' ], [ '#status', 'initial' ],
    [ 'summary', 'summary' ], [ '#empty', 'empty' ],
] ) { $(selector).textContent = labels[key]; }
$('#tab').setAttribute('aria-label', labels.tab);
$('#search').placeholder = labels.searchPlaceholder;
for ( const option of $('#kind').options ) { option.textContent = labels.kinds[option.value]; }
document.querySelectorAll('thead th').forEach((node, i) => { node.textContent = labels.columns[i]; });
document.querySelectorAll('header details p').forEach((node, i) => { node.textContent = labels.details[i]; });
const requestedTab = Number(new URL(location.href).searchParams.get('tab'));
const tabs = await webext.tabs.query({});
for ( const tab of tabs ) {
    if ( Number.isInteger(tab.id) === false || /^https?:/.test(tab.url || '') === false ) { continue; }
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = `${tab.title || new URL(tab.url).hostname} (${tab.id})`;
    option.selected = tab.id === requestedTab;
    $('#tab').append(option);
}

let snapshot = { entries: [], capturing: false };
let port;
let connected = false;
let permissionNote = '';
let lastSignature = '';
const renderWarnings = warnings => {
    const values = Array.isArray(warnings) ? warnings.filter(s => typeof s === 'string') : [];
    $('#scriptletWarnings').hidden = values.length === 0;
    $('#scriptletWarnings').textContent = values.join(' ');
};
webext.storage.local.get('scriptletExceptions.warnings').then(bin => {
    renderWarnings(bin['scriptletExceptions.warnings']);
}).catch(( ) => {});
webext.storage.onChanged.addListener((changes, area) => {
    if ( area !== 'local' || changes['scriptletExceptions.warnings'] === undefined ) { return; }
    renderWarnings(changes['scriptletExceptions.warnings'].newValue);
});
const connect = ( ) => {
    port = webext.runtime.connect({ name: 'ublock-plus-logger' });
    connected = true;
    port.onMessage.addListener(message => {
        snapshot = message;
        $('#start').disabled = snapshot.capturing;
        $('#stop').disabled = !snapshot.capturing;
        $('#tab').disabled = snapshot.capturing;
        $('#status').textContent = message.error || [
            snapshot.capturing ? labels.capturing : labels.paused,
            `${labels.network}: ${snapshot.networkEnabled ? labels.available : labels.unavailable}.`,
            `${labels.native}: ${snapshot.nativeMatchesEnabled ? labels.available : labels.unavailable}.`,
            `${snapshot.entries.length}/${snapshot.limit} ${labels.records}; ${snapshot.discarded} ${labels.discarded}.`,
            permissionNote,
        ].join(' ');
        render();
    });
    port.onDisconnect.addListener(( ) => {
        connected = false;
        snapshot = { entries: [], capturing: false };
        $('#start').disabled = false;
        $('#stop').disabled = true;
        $('#tab').disabled = false;
        $('#status').textContent = labels.disconnected;
        render();
    });
};
const send = what => {
    if ( connected === false ) { connect(); }
    port.postMessage({ what, tabId: Number($('#tab').value) });
};
const filtered = ( ) => {
    const search = $('#search').value.toLowerCase();
    const kind = $('#kind').value;
    return snapshot.entries.filter(entry =>
        (kind === '' || entry.kind === kind) &&
        (search === '' || JSON.stringify(entry).toLowerCase().includes(search))
    );
};
const render = ( ) => {
    const entries = filtered();
    const signature = JSON.stringify(entries);
    if ( signature === lastSignature ) { return; }
    lastSignature = signature;
    const fragment = new DocumentFragment();
    for ( const entry of entries.slice().reverse() ) {
        const row = document.createElement('tr');
        row.dataset.kind = entry.kind;
        const columns = [
            new Date(entry.time).toLocaleTimeString(),
            `${labels.kinds[entry.kind] || entry.kind}\n${labels.phases[entry.phase] || entry.phase}`,
            `${entry.source}\ntab ${entry.tabId}, ${labels.frame} ${entry.frameId}`,
            [ entry.type, entry.url, entry.detail, entry.requestId && `request ${entry.requestId}` ].filter(Boolean).join('\n'),
        ];
        for ( const value of columns ) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.append(cell);
        }
        fragment.append(row);
    }
    $('#matchedEntries').replaceChildren(fragment);
    $('#empty').hidden = entries.length !== 0;
};

$('#start').addEventListener('click', async ( ) => {
    if ( $('#tab').value === '' ) { return; }
    const accepted = await webext.permissions.request({ permissions: [ 'webRequest' ] }).catch(( ) => false);
    permissionNote = accepted ? '' : labels.permissionRefused;
    send('start');
});
$('#stop').addEventListener('click', ( ) => send('stop'));
$('#clear').addEventListener('click', ( ) => send('clear'));
$('#search').addEventListener('input', render);
$('#kind').addEventListener('change', render);
$('#export').addEventListener('click', ( ) => {
    const entries = exportLoggerEntries(filtered());
    const blob = new Blob([ JSON.stringify({
        format: 'ublock-plus-diagnostics-v1',
        note: 'Query strings, fragments, credentials and free text omitted. URL paths can remain sensitive.',
        entries,
    }, null, 2) ], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ublock-plus-logger-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(( ) => URL.revokeObjectURL(url), 1000);
});
connect();
const timer = setInterval(( ) => {
    if ( connected ) { send('read'); }
}, 1000);
window.addEventListener('pagehide', ( ) => {
    clearInterval(timer);
    port?.disconnect();
}, { once: true });
