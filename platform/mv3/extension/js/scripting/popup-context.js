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
    let pendingClick = '';
    let pendingForm;
    let pendingFormData;
    let formDataScheduled = false;
    const gestureLifetime = 5_000;
    const maximumTargetLength = 8192;

    const boundedTarget = value => typeof value === 'string' &&
        value.length <= maximumTargetLength ? value : '';

    const submitDetails = (form, submitter) => {
        if ( form?.localName !== 'form' ) { return; }
        const overrideAction = submitter?.hasAttribute?.('formaction') === true;
        const overrideMethod = submitter?.hasAttribute?.('formmethod') === true;
        const action = boundedTarget(overrideAction
            ? submitter.formAction : form.action);
        const method = overrideMethod ? submitter.formMethod : form.method;
        if ( action === '' || (method !== 'get' && method !== 'post') ) {
            return;
        }
        return { action, method };
    };

    const navigationTargetFromEvent = event => {
        const path = typeof event.composedPath === 'function'
            ? event.composedPath()
            : [ event.target ];
        for ( const node of path ) {
            if ( node?.localName === 'a' || node?.localName === 'area' ) {
                if ( typeof node.href === 'string' ) {
                    return boundedTarget(node.href);
                }
            }
            if ( (node?.localName === 'button' || node?.localName === 'input') &&
                (node.type === 'submit' || node.type === 'image') ) {
                const details = submitDetails(node.form, node);
                // GET changes the action's query. Wait for the browser's
                // actual entry list rather than guessing from form controls.
                return details?.method === 'post' ? details.action : '';
            }
        }
        return '';
    };

    const record = event => {
        if ( event.isTrusted !== true ) { return; }
        if ( event.type === 'keydown' &&
            (event.repeat === true ||
                (event.key !== 'Enter' && event.key !== ' ')) ) {
            return;
        }
        if ( event.type === 'auxclick' && event.button > 1 ) {
            return;
        }
        const timestamp = Date.now();
        const targetURL = navigationTargetFromEvent(event);
        if ( event.type === 'click' || event.type === 'auxclick' ) {
            const phase = event.detail === 0 ? 'key' : 'pointer';
            const sameActivation = pendingClick !== '' &&
                (phase === pendingClick || event.detail === undefined) &&
                timestamp - lastGestureAt >= 0 &&
                timestamp - lastGestureAt <= gestureLifetime;
            pendingClick = '';
            if ( sameActivation ) {
                lastTargetURL = targetURL;
                return;
            }
        } else {
            // Distinct pointer/key presses are distinct user activations,
            // even when they happen rapidly on the same link. Only coalesce
            // the subsequent click phase of that physical activation.
            pendingClick = event.type === 'keydown' ? 'key' : 'pointer';
        }
        pendingForm = undefined;
        pendingFormData = undefined;
        lastGestureAt = timestamp;
        lastTargetURL = targetURL;
        sequence += 1;
    };

    const recordSubmit = event => {
        if ( event.isTrusted !== true || sequence === 0 ||
            Date.now() - lastGestureAt < 0 ||
            Date.now() - lastGestureAt > gestureLifetime ) {
            return;
        }
        const details = submitDetails(event.target, event.submitter);
        if ( details === undefined ) { return; }
        // requestSubmit() also produces a trusted SubmitEvent. It can refine
        // an existing physical activation, never manufacture another one.
        lastTargetURL = details.method === 'post' ? details.action : '';
        pendingForm = {
            form: event.target,
            submitter: event.submitter,
            sequence,
        };
    };

    const recordFormData = event => {
        if ( event.isTrusted !== true || pendingForm?.form !== event.target ||
            pendingForm.sequence !== sequence ||
            Date.now() - lastGestureAt > gestureLifetime ) {
            return;
        }
        const pending = pendingForm;
        pendingForm = undefined;
        // Chrome has selected the action/method by the time it constructs
        // the entry list. Later formdata listeners can edit entries, but an
        // action mutation there must not invent a different trusted URL.
        const details = submitDetails(pending.form, pending.submitter);
        const formData = details?.method === 'get' ? event.formData : undefined;
        const charset = pending.form.acceptCharset?.trim() ||
            pending.form.ownerDocument?.characterSet || '';
        // Reading the browser-created FormData avoids scanning the DOM,
        // creating extra formdata events, or changing page submission code.
        // A microtask here can run before the page's next event listener.
        // Refine after dispatch, or just before the worker requests context.
        // At most one pending callback/entry list is retained for one task.
        pendingFormData = ( ) => {
            pendingFormData = undefined;
            if ( pending.sequence !== sequence ) { return; }
            if ( details === undefined ) { return; }
            if ( details.method === 'post' ) {
                lastTargetURL = details.action;
                return;
            }
            if ( formData === undefined ) { return; }
            // URLSearchParams implements UTF-8 form encoding. A document
            // using another submission encoding has no exact URL proof.
            if ( /^utf-8$/i.test(charset) === false ) { return; }
            try {
                const target = new URL(details.action);
                if ( target.protocol !== 'http:' &&
                    target.protocol !== 'https:' ) {
                    return;
                }
                const params = new URLSearchParams();
                let count = 0;
                let length = 0;
                for ( const [ name, entry ] of formData ) {
                    const value = typeof entry === 'string' ? entry : entry.name;
                    if ( typeof name !== 'string' || typeof value !== 'string' ) {
                        return;
                    }
                    count += 1;
                    length += name.length + value.length;
                    if ( count > 256 || length > maximumTargetLength ) { return; }
                    const normalize = value => value.replace(/\r\n|\r|\n/g, '\r\n');
                    params.append(normalize(name), normalize(value));
                }
                // GET replaces an existing query; POST preserves it.
                target.search = `?${params}`;
                lastTargetURL = boundedTarget(target.href);
            } catch {
            }
        };
        if ( formDataScheduled ) { return; }
        formDataScheduled = true;
        setTimeout(( ) => {
            formDataScheduled = false;
            pendingFormData?.();
        }, 0);
    };

    for ( const type of [ 'pointerdown', 'keydown', 'click', 'auxclick' ] ) {
        self.addEventListener(type, record, {
            capture: true,
            passive: true,
        });
    }
    self.addEventListener('submit', recordSubmit, {
        capture: true,
        passive: true,
    });
    self.addEventListener('formdata', recordFormData, {
        capture: true,
        passive: true,
    });

    runtime.onMessage.addListener((message, sender, sendResponse) => {
        void sender;
        if ( message?.what !== 'getPopupGestureContext' ) { return; }
        pendingFormData?.();
        sendResponse({
            at: lastGestureAt,
            sequence,
            targetURL: lastTargetURL,
        });
    });
})();

/******************************************************************************/
