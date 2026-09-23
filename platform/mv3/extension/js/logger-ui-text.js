/* uBlock Plus+ — logger copy from the extension message catalog. GPL-3.0-or-later. */

const kindKeys = {
    '': 'loggerKindAll', network: 'loggerKindNetwork', dnr: 'loggerKindDnr',
    cosmetic: 'loggerKindCosmetic', dom: 'loggerKindDom',
    scriptlet: 'loggerKindScriptlet', system: 'loggerKindSystem',
};
const phaseKeys = {
    requested: 'loggerPhaseRequested', completed: 'loggerPhaseCompleted',
    error: 'loggerPhaseError', redirected: 'loggerPhaseRedirected',
    blocked: 'loggerPhaseBlocked', matched: 'loggerPhaseMatched', 'stylesheet-inserted': 'loggerPhaseStylesheetInserted',
    'css-selector-present': 'loggerPhaseSelectorPresent',
    'procedural-applied': 'loggerPhaseProceduralApplied',
    registered: 'loggerPhaseRegistered', 'exception-applied': 'loggerPhaseExceptionApplied',
};

// `message` has the signature of i18n.getMessage; Chrome itself falls back
// to the default locale. Unknown kinds and phases keep their technical names.
export function loggerUIText(message) {
    const text = (key, ...substitutions) => message(key,
        substitutions.length ? substitutions.map(String) : undefined);
    const map = keys => Object.fromEntries(
        Object.entries(keys).map(([ id, key ]) => [ id, text(key) ])
    );
    return {
        title: text('loggerTitle'), intro: text('loggerIntro'),
        tab: text('loggerTab'), start: text('loggerStart'), pause: text('loggerPause'),
        clear: text('loggerClear'), export: text('loggerExport'),
        search: text('loggerSearch'), searchPlaceholder: text('loggerSearchPlaceholder'),
        kind: text('loggerKind'),
        kinds: map(kindKeys),
        columns: [ 'diagnosticTime', 'loggerColumnKind', 'loggerColumnSource', 'loggerColumnDetail' ]
            .map(key => text(key)),
        initial: text('loggerInitial'),
        summary: text('loggerSummary'),
        details: [
            'loggerDetailNetwork', 'loggerDetailDnr', 'loggerDetailCosmetic',
            'loggerDetailScriptlet', 'loggerDetailCapture', 'loggerDetailExport',
        ].map(key => text(key)),
        empty: text('loggerEmpty'),
        capturing: text('loggerCapturing'), paused: text('loggerPaused'),
        network: enabled => text(enabled ? 'loggerNetworkAttached' : 'loggerNetworkUnavailable'),
        native: enabled => text(enabled ? 'loggerNativeAttached' : 'loggerNativeUnavailable'),
        records: (count, limit, discarded) => text('loggerRecordCount', count, limit, discarded),
        context: (tabId, frameId) => text('loggerTabFrame', tabId, frameId),
        request: requestId => text('loggerRequestId', requestId),
        permissionRefused: text('loggerPermissionRefused'),
        disconnected: text('loggerDisconnected'),
        phases: map(phaseKeys),
    };
}
