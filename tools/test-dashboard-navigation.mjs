/* uBlock Plus+ — existing dashboard navigation regression. GPL-3.0-or-later. */
import assert from 'node:assert/strict';

const calls = [];
globalThis.self = globalThis;
let existing = [ { id: 7, windowId: 2, url: 'chrome-extension://test/dashboard.html#settings' } ];
globalThis.chrome = {
    runtime: { getURL: value => `chrome-extension://test${value}` },
    tabs: {
        async query(query) { calls.push([ 'query', query ]); return existing; },
        async update(id, details) { calls.push([ 'update', id, details ]); },
        async create(details) { calls.push([ 'create', details ]); },
    },
    windows: {
        async update(id, details) { calls.push([ 'focus', id, details ]); },
    },
};
const { gotoURL } = await import('../platform/mv3/extension/js/ext-utils.js');
await gotoURL('/dashboard.html#filters');
assert.deepEqual(calls, [
    [ 'query', { url: 'chrome-extension://test/dashboard.html', windowType: 'normal' } ],
    [ 'focus', 2, { focused: true } ],
    [ 'update', 7, { active: true, url: 'chrome-extension://test/dashboard.html#filters' } ],
]);
calls.length = 0;
existing[0].url = 'chrome-extension://test/dashboard.html#filters';
await gotoURL('/dashboard.html#filters');
assert.deepEqual(calls.at(-1), [ 'update', 7, { active: true } ]);
calls.length = 0;
existing = [];
await gotoURL('/dashboard.html#siteRules');
assert.deepEqual(calls.at(-1), [ 'create', {
    active: true, url: 'chrome-extension://test/dashboard.html#siteRules',
} ]);

// Managed `disabledFeatures` locks: the tabs are hidden, and neither a click,
// a link hash nor the remembered pane may select a locked pane.
{
    const { readFile } = await import('node:fs/promises');
    const {
        FakeDocument, FakeElement, createExtension, settle, stageModules,
    } = await import('./dashboard-test-harness.mjs');
    const document = new FakeDocument();
    for ( const pane of [ 'settings', 'rulesets', 'filters', 'siteRules', 'diagnostics', 'develop', 'about' ] ) {
        const button = new FakeElement('button');
        button.dataset.pane = pane;
        button.ancestors.set('.tabButton', button);
        document.register('.tabButton[data-pane]', button);
    }
    document.body.dataset.pane = 'settings';
    document.body.dataset.forbid = 'develop picker';
    const extension = createExtension({ storage: { 'dashboard.activePane': 'develop' } });
    const staged = await stageModules({
        modules: [ 'dashboard.js' ],
        document,
        extension,
        location: 'chrome-extension://test/dashboard.html',
    });
    const click = pane => document.trigger('#dashboard-nav', 'click', {
        target: document.all('.tabButton[data-pane]').find(node => node.dataset.pane === pane),
    }, '.tabButton');
    try {
        const { isForbiddenPane } = await staged.load('dashboard.js');
        await settle(10);
        assert.equal(document.body.dataset.pane, 'settings',
            'A remembered locked pane must not be restored');
        await click('develop');
        assert.equal(document.body.dataset.pane, 'settings');
        assert.equal(location.hash, '');
        await click('filters');
        assert.equal(document.body.dataset.pane, 'settings');
        location.hash = '#develop';
        for ( const { type, callback } of document.windowListeners ) {
            if ( type === 'hashchange' ) { callback(); }
        }
        assert.equal(document.body.dataset.pane, 'settings');
        await click('siteRules');
        assert.equal(document.body.dataset.pane, 'siteRules');
        document.body.dataset.forbid = 'dashboard';
        assert.deepEqual(
            [ 'settings', 'rulesets', 'filters', 'siteRules', 'diagnostics', 'develop', 'about' ]
                .filter(pane => isForbiddenPane(pane)),
            [ 'settings', 'rulesets', 'filters', 'siteRules', 'diagnostics', 'develop' ]
        );
        document.body.dataset.forbid = 'constructor __proto__ filteringMode';
        assert.equal(isForbiddenPane('settings'), false);
    } finally {
        await staged.cleanup();
    }

    const hiddenSelectors = new Set();
    for ( const name of [ 'settings.css', 'power-settings.css' ] ) {
        const css = await readFile(new URL(`../platform/mv3/extension/css/${name}`, import.meta.url), 'utf8');
        for ( const rule of css.split('}') ) {
            const [ selectors, declarations ] = rule.split('{');
            if ( /display:\s*none/.test(declarations || '') === false ) { continue; }
            for ( const selector of selectors.split(',') ) {
                hiddenSelectors.add(selector.replace(/\s+/g, ' ').trim());
            }
        }
    }
    for ( const selector of [
        'body[data-forbid~="develop"] #dashboard-nav [data-pane="develop"]',
        'body[data-forbid~="develop"] section[data-pane="develop"]',
        'body[data-forbid~="dashboard"] #dashboard-nav [data-pane="develop"]',
        'body[data-forbid~="dashboard"] section[data-pane="develop"]',
        'body[data-forbid~="filteringMode"] #protectionProfiles',
        'body[data-forbid~="filteringMode"] #filteringSiteRules',
    ] ) {
        assert.ok(hiddenSelectors.has(selector), `Missing managed lock rule: ${selector}`);
    }
}
console.log('Dashboard pane navigation tests passed');
