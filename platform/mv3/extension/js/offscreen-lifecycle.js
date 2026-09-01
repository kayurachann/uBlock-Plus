/*******************************************************************************

    uBlock Plus+ - a community-powered MV3 content blocker
    Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Home: https://github.com/kayurachann/uBlock-Plus
*/

export async function setupManagedOffscreenDocument(options) {
    const {
        closeDocument,
        createDocument,
        isCancelled,
    } = options;
    let creationStarted = false;
    try {
        try {
            await closeDocument();
        } catch {
        }
        if ( isCancelled() ) { return false; }
        creationStarted = true;
        await createDocument();
        return isCancelled() === false;
    } finally {
        // createDocument() can settle after the caller's timeout cleanup. A
        // second close here prevents that late completion from resurrecting
        // an offscreen compiler after the service worker has given up.
        if ( creationStarted && isCancelled() ) {
            try {
                await closeDocument();
            } catch {
            }
        }
    }
}

export async function cleanupFailedCompiledGeneration(options) {
    // Keep the staging marker until every generation key is gone. If removal
    // fails, startup recovery can still discover and retry the cleanup.
    await options.removeGeneration();
    await options.removeMarker();
}

/******************************************************************************/

export async function finalizeFailedOffscreenCompilation(options) {
    // The setup operation may still be inside createDocument() when the
    // watchdog fires. Drain it before the final close, otherwise a late-created
    // document can write generation keys after they were already removed.
    try {
        await options.setupPromise;
    } catch {
    }
    try {
        await options.closeDocument();
    } catch {
    }
    await options.cleanupGeneration();
}

/******************************************************************************/
