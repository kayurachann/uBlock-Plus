/* uBlock Plus+ — safe diagnostic export. GPL-3.0-or-later. */
export function redactLoggerURL(value) {
    try {
        const url = new URL(value);
        if ( /^https?:$/.test(url.protocol) === false ) { return ''; }
        return `${url.origin}${url.pathname}`;
    } catch {
        return '';
    }
}

export function exportLoggerEntries(entries) {
    return entries.map(entry => ({
        time: entry.time, kind: entry.kind, phase: entry.phase, source: entry.source,
        tabId: entry.tabId, frameId: entry.frameId, type: entry.type,
        url: redactLoggerURL(entry.url),
        detail: '[omitted from redacted export]',
    }));
}
