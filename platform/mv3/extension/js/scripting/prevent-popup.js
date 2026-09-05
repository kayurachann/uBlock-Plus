/*******************************************************************************

    uBlock Plus+ - popup observer compatibility entry point
    Copyright (C) 2026-present uBlock Plus+ contributors
    SPDX-License-Identifier: GPL-3.0-or-later

*******************************************************************************/

// Old persisted content-script registrations can still invoke this entry point
// during an update. A target-only matcher cannot determine whether the opener
// is trusted, a navigation was intentional, or an exception lacks context.
// Keep it inert: only the service-worker observer may close popup targets.
self.preventPopupDetails = undefined;
self.preventPopupTarget = undefined;

void 0;
