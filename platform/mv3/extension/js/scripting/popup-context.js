/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

(( ) => {
    const runtime = (self.browser || self.chrome)?.runtime;
    if ( runtime?.onMessage === undefined ) { return; }

    let lastGestureAt = 0;
    let lastTargetURL = '';
    let sequence = 0;

    const navigationTargetFromEvent = event => {
        const path = typeof event.composedPath === 'function'
            ? event.composedPath()
            : [ event.target ];
        for ( const node of path ) {
            if ( node?.localName === 'a' || node?.localName === 'area' ) {
                if ( typeof node.href === 'string' ) { return node.href; }
            }
            if ( node?.localName === 'form' ) {
                if ( typeof node.action === 'string' ) { return node.action; }
            }
            if ( typeof node?.form?.action === 'string' ) {
                return node.form.action;
            }
        }
        return '';
    };

    const record = event => {
        if ( event.isTrusted !== true ) { return; }
        if ( event.type === 'keydown' &&
            event.key !== 'Enter' && event.key !== ' ' ) {
            return;
        }
        const timestamp = Date.now();
        const targetURL = navigationTargetFromEvent(event);
        if ( timestamp - lastGestureAt < 750 &&
            targetURL === lastTargetURL ) {
            return;
        }
        lastGestureAt = timestamp;
        lastTargetURL = targetURL;
        sequence += 1;
    };

    self.addEventListener('pointerdown', record, {
        capture: true,
        passive: true,
    });
    self.addEventListener('keydown', record, {
        capture: true,
        passive: true,
    });
    self.addEventListener('click', record, {
        capture: true,
        passive: true,
    });

    runtime.onMessage.addListener((message, sender, sendResponse) => {
        void sender;
        if ( message?.what !== 'getPopupGestureContext' ) { return; }
        sendResponse({
            at: lastGestureAt,
            sequence,
            targetURL: lastTargetURL,
        });
    });
})();

/******************************************************************************/
