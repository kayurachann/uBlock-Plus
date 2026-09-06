/* uBlock Plus+ — isolated-world, opt-in procedural diagnostics. GPL-3.0-or-later. */
// No page-world message bridge: a website cannot impersonate these reports.
(async ( ) => {
    if ( typeof self.ublockPlusLogger === 'function' ) { return; }
    const active = await chrome.runtime.sendMessage({ what: 'getLoggerCapture' }).catch(( ) => false);
    if ( active !== true ) { return; }
    if ( typeof self.ublockPlusLogger === 'function' ) { return; }
    let count = 0;
    let started = Date.now();
    const stop = ( ) => {
        self.ublockPlusLogger = undefined;
        chrome.runtime.onMessage.removeListener(onMessage);
    };
    const report = (phase, detail) => {
        const now = Date.now();
        if ( now - started >= 1000 ) { count = 0; started = now; }
        // Do not let a pathological page turn DOM changes into unbounded work.
        if ( ++count > 32 ) { return; }
        try {
            chrome.runtime.sendMessage({
                what: 'recordContentDiagnostic', kind: 'dom', phase, detail,
            }).then(accepted => {
                if ( accepted !== true ) { stop(); }
            }).catch(stop);
        } catch { stop(); }
    };
    const sampleCSS = css => {
        if ( typeof css !== 'string' || css.length > 65536 ) { return; }
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            const queue = Array.from(sheet.cssRules).slice(0, 32);
            const deadline = Date.now() + 8;
            let checked = 0;
            while ( queue.length && ++checked <= 32 && Date.now() < deadline ) {
                const rule = queue.shift();
                if ( typeof rule.selectorText === 'string' ) {
                    if ( document.querySelector(rule.selectorText) ) {
                        report('css-selector-present', `${rule.selectorText.slice(0, 1500)}; ` +
                            'at least one node at sampling time; not proof of visibility or media activation');
                    }
                } else if ( rule.cssRules ) {
                    queue.push(...Array.from(rule.cssRules).slice(0, 32));
                }
            }
        } catch { /* Unsupported selectors and stylesheets are left unchanged. */ }
    };
    const onMessage = message => {
        if ( message.what === 'stopLoggerContent' ) { stop(); }
        if ( message.what === 'sampleLoggerCSS' ) { sampleCSS(message.css); }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    self.ublockPlusLogger = (selector, matches, action) => report('procedural-applied',
        `${String(selector).slice(0, 1500)}; matched nodes=${matches}; action=${action || 'hide'}`
    );
})();
