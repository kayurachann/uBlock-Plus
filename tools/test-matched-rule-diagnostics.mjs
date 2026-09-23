/* uBlock Plus+ — matched-rule diagnostics ownership regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The unified logger is the only onRuleMatchedDebug consumer. Developer mode
// must not keep an unread ring buffer or issue DNR lookups for every match.
const listeners = new Set();
const reads = [];
globalThis.self = globalThis;
globalThis.chrome = {
    runtime: {
        getManifest: () => ({ permissions: [ 'declarativeNetRequestFeedback' ] }),
        getURL: path => `chrome-extension://fixture/${path}`,
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: {
        DYNAMIC_RULESET_ID: '_dynamic',
        SESSION_RULESET_ID: '_session',
        getDynamicRules: async options => { reads.push(options); return []; },
        getSessionRules: async options => { reads.push(options); return []; },
        getMatchedRules: async options => { reads.push(options); return { rulesMatchedInfo: [] }; },
        onRuleMatchedDebug: {
            addListener: listener => listeners.add(listener),
            removeListener: listener => listeners.delete(listener),
        },
    },
};
globalThis.fetch = async url => { throw new Error(`Unexpected fetch: ${url}`); };

const { getMatchedRules, isSideloaded, toggleDeveloperMode } = await import(
    '../platform/mv3/extension/js/debug.js'
);
assert.equal(isSideloaded, true);
toggleDeveloperMode(true);
assert.equal(listeners.size, 0, 'Developer mode registers no matched-rule listener');
assert.deepEqual(await getMatchedRules(12), []);
toggleDeveloperMode(false);
assert.equal(listeners.size, 0);
assert.equal(reads.length, 0, 'Developer mode issues no DNR rule lookups');

const extensionRoot = new URL('../platform/mv3/extension/', import.meta.url);
const logger = await readFile(new URL('js/logger.js', extensionRoot), 'utf8');
assert.match(logger, /bind\(api\.declarativeNetRequest\?\.onRuleMatchedDebug, matched\)/,
    'The logger observes native matches only while capture is configured');
const page = await readFile(new URL('js/matched-rules.js', extensionRoot), 'utf8');
assert.doesNotMatch(page, /getMatchedRules/, 'The logger page reads its own port, not the legacy buffer');
console.log('Matched-rule diagnostics: logger-owned native matches, no Developer-mode buffer.');
