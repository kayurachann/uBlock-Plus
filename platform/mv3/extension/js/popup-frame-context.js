/*******************************************************************************

    uBlock Plus+
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*******************************************************************************/

const MAX_CONTEXT_URL_LENGTH = 8192;
const MAX_PARENT_DEPTH = 32;
const inheritedFramePaths = new Set([ 'blank', 'srcdoc' ]);
const ambiguousOriginProtocols = new Set([ 'data:', 'javascript:' ]);

/******************************************************************************/

function validFrameId(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function boundedURLDetails(value) {
    if ( typeof value !== 'string' || value === '' ) {
        return { url: '', complete: false };
    }
    if ( value.length <= MAX_CONTEXT_URL_LENGTH ) {
        return { url: value, complete: true };
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return { url: '', complete: false };
    }
    if ( parsed.protocol === 'blob:' ) {
        try {
            const inner = new URL(parsed.pathname);
            return { url: `blob:${inner.origin}/`, complete: false };
        } catch {
            return { url: '', complete: false };
        }
    }
    if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ||
        parsed.origin !== 'null' ) {
        return { url: `${parsed.origin}/`, complete: false };
    }
    if ( parsed.protocol === 'data:' ) {
        return { url: 'data:,', complete: false };
    }
    return {
        url: `${parsed.protocol}${parsed.pathname.slice(0, 256)}`,
        complete: false,
    };
}

function isInheritedFrameURL(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'about:' &&
            inheritedFramePaths.has(url.pathname.toLowerCase());
    } catch {
        return false;
    }
}

function hasReliableFrameOrigin(value) {
    try {
        return ambiguousOriginProtocols.has(new URL(value).protocol) === false;
    } catch {
        return false;
    }
}

async function readFrame(getFrame, tabId, frameId) {
    try {
        const frame = await getFrame({ tabId, frameId });
        return frame instanceof Object ? frame : undefined;
    } catch {
    }
}

/**
 * Capture the root-document and exact source-frame provenance as soon as
 * onCreatedNavigationTarget fires. about:blank/about:srcdoc inherit their
 * parent context, so walk the frame ancestry instead of treating those URLs
 * as independent origins. The bounded walk fails open on missing/cyclic data.
 */
export async function capturePopupFrameContext(
    getFrame,
    tabId,
    sourceFrameId
) {
    const empty = {
        topURL: '',
        topContextComplete: false,
        initiatorURL: '',
        initiatorContextComplete: false,
    };
    if ( typeof getFrame !== 'function' || validFrameId(tabId) === false ||
        validFrameId(sourceFrameId) === false ) {
        return empty;
    }

    // Start both browser queries in the same turn. In particular, do not wait
    // for storage hydration or gesture collection before taking this snapshot:
    // a popunder can navigate its opener immediately after opening the tab.
    const topPromise = readFrame(getFrame, tabId, 0);
    const sourcePromise = sourceFrameId === 0
        ? topPromise
        : readFrame(getFrame, tabId, sourceFrameId);
    const [ topFrame, initialSourceFrame ] = await Promise.all([
        topPromise,
        sourcePromise,
    ]);
    const top = boundedURLDetails(topFrame?.url);
    const topURL = top.url;
    const result = {
        topURL,
        topContextComplete: top.complete,
        initiatorURL: '',
        initiatorContextComplete: false,
    };

    let frame = initialSourceFrame;
    let frameId = sourceFrameId;
    const visited = new Set();
    for ( let depth = 0; depth < MAX_PARENT_DEPTH; depth++ ) {
        if ( frame instanceof Object === false || visited.has(frameId) ) {
            return result;
        }
        visited.add(frameId);
        const frameURLDetails = boundedURLDetails(frame.url);
        const frameURL = frameURLDetails.url;
        if ( frameURL === '' ) { return result; }
        if ( isInheritedFrameURL(frameURL) === false || frameId === 0 ) {
            // data:/javascript: provenance cannot be reconstructed safely
            // from a URL string alone. Keep it pending so a parent-scoped
            // allow/exclusion can never turn into a broad false block.
            if ( hasReliableFrameOrigin(frameURL) === false ) {
                return result;
            }
            result.initiatorURL = frameURL;
            // Runtime popup conditions constrain initiators by hostname only,
            // so a canonical origin retains complete matching provenance even
            // when an oversized path was discarded.
            result.initiatorContextComplete = true;
            return result;
        }
        const parentFrameId = frame.parentFrameId;
        if ( validFrameId(parentFrameId) === false ||
            visited.has(parentFrameId) ) {
            return result;
        }
        frameId = parentFrameId;
        frame = frameId === 0
            ? topFrame
            : await readFrame(getFrame, tabId, frameId);
    }
    return result;
}

/******************************************************************************/
