/* uBlock Plus+ — Site Rules parser and editor regressions. GPL-3.0-or-later. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-mode-editor-'));
const channels = [];
const markedLines = [];
const messages = [];
let dispatch;
globalThis.self = globalThis;
globalThis.cm6 = {
    lineErrorClear() { markedLines.length = 0; },
    lineErrorAdd(_view, lines) { markedLines.push(...lines); },
};
globalThis.BroadcastChannel = class {
    constructor() { channels.push(this); }
    close() { this.closed = true; }
};
globalThis.modeEditorTestSend = async request => {
    messages.push(structuredClone(request));
    return dispatch(request);
};

try {
    // Load actual production modules with only browser messaging and localized
    // strings replaced. Source checkouts receive i18n/punycode at build time.
    await Promise.all([
        ...[
            'mode-parser.js', 'mode-editor.js', 'backup-schema.js',
            'power-ui-core.js', 'popup-policy.js',
        ].map(name => fs.copyFile(
            path.join(root, 'platform/mv3/extension/js', name),
            path.join(staging, name)
        )),
        fs.copyFile(path.join(root, 'src/lib/punycode.js'), path.join(staging, 'punycode.js')),
        fs.writeFile(path.join(staging, 'package.json'), '{"type":"module"}'),
        fs.writeFile(path.join(staging, 'ext.js'),
            'export const sendMessage = request => globalThis.modeEditorTestSend(request);'),
        fs.writeFile(path.join(staging, 'i18n.js'), `
            const names = {
                filteringMode0Name: 'No filtering', filteringMode1Name: 'Basic',
                filteringMode2Name: 'Optimal', filteringMode3Name: 'Complete',
            };
            export const i18n$ = key => names[key];
        `),
    ]);
    const { modesFromText, textFromModes } = await import(pathToFileURL(path.join(staging, 'mode-parser.js')));
    const { ModeEditor } = await import(pathToFileURL(path.join(staging, 'mode-editor.js')));
    const original = {
        none: [ 'trusted.example', '[::1]', 'xn--bcher-kva.example' ],
        basic: [], optimal: [ 'all-urls' ], complete: [ 'protected.example' ],
    };
    const savedText = textFromModes(original);
    const editor = {
        text: savedText,
        lastSavedText: savedText,
        view: { state: { doc: { lines: 20 } } },
        getEditorText() { return this.text; },
        setEditorText(text, saved) {
            this.text = text;
            if ( saved ) { this.lastSavedText = text; }
        },
        editorTextChanged() { return this.text !== this.lastSavedText; },
    };
    let active = structuredClone(original);
    dispatch = request => {
        active = structuredClone(request.modes);
        return structuredClone(active);
    };
    const modeEditor = new ModeEditor(editor);
    modeEditor.on();

    for ( const invalid of [
        savedText.replace('trusted.example', '*.trusted.example'),
        savedText.replace('trusted.example', 'https://trusted.example/path'),
        savedText.replace('  - trusted.example', ' - trusted.example'),
        savedText.replace('[::1]', '[invalid::address]'),
        savedText.replace('  - all-urls\n', ''),
        savedText.replace('Basic:\n', 'Basic:\n  - all-urls\n'),
        savedText.replace('Basic:\n', 'Basic:\n  - TRUSTED.EXAMPLE\n'),
        savedText.replace('Basic:\n', 'Basic:\n  - xn--bcher-kva.example\n'),
        '', '# Only a comment\n',
    ] ) {
        editor.text = invalid;
        const result = modesFromText(invalid);
        assert.equal(result.modes, undefined, 'Invalid input must not expose a partial mode map');
        assert.ok(result.bad.length > 0);
        assert.equal(await modeEditor.saveEditorText(editor), false);
        assert.equal(editor.text, invalid, 'An invalid draft stays editable');
        assert.equal(messages.length, 0, 'No invalid draft may reach the mutation handler');
        assert.deepEqual(active, original, 'Trusted sites and other modes remain active');
        assert.ok(markedLines.length > 0, 'Invalid saves identify the offending lines');
    }

    for ( const defaultMode of [ 'none', 'basic', 'optimal', 'complete' ] ) {
        const modes = {
            none: [ 'trusted.example', 'child.trusted.example', '[::1]' ],
            basic: [ 'basic.example' ], optimal: [ 'optimal.example' ],
            complete: [ 'complete.example', 'xn--bcher-kva.example' ],
        };
        modes[defaultMode].push('all-urls');
        const text = textFromModes(modes);
        assert.deepEqual(modesFromText(text), { modes },
            'Every saved default and its explicit entries must round-trip');
        assert.deepEqual(modesFromText(text, true), {});
    }

    const literalText = 'none:\n  - [0:0:0:0:0:0:0:1]\n  - 127.0.0.1\n' +
        '  - BÜCHER.example\n\n# Comment\noptimal:\n  - all-urls\n';
    assert.deepEqual(modesFromText(literalText).modes, {
        none: [ '[::1]', '127.0.0.1', 'xn--bcher-kva.example' ],
        basic: [], optimal: [ 'all-urls' ], complete: [],
    });

    // CodeMirror's newline assistant inserts `  - ` after Enter, including
    // the trailing newline in a paste. This is not an empty hostname rule.
    for ( const placeholder of [ '  -', '  - ', '  -   ' ] ) {
        editor.text = `${literalText}${placeholder}\n`;
        assert.deepEqual(modesFromText(editor.text).modes, modesFromText(literalText).modes);
        assert.deepEqual(modesFromText(editor.text, true), {});
        assert.equal(await modeEditor.saveEditorText(editor), true);
        assert.deepEqual(active, modesFromText(literalText).modes);
        assert.ok(Object.values(active).every(hostnames => hostnames.includes('') === false));
    }
    assert.equal(modesFromText('none:\n  - \n').modes, undefined,
        'A placeholder does not replace the required global default');
    assert.equal(modesFromText(`${literalText}- \n`).modes, undefined,
        'An empty list marker is valid only inside a mode section');

    editor.text = savedText.replace('protected.example', 'new.example');
    // A partial editor redraw must retain the mode header/default context.
    modeEditor.updateView(editor, { from: 10, number: 2 }, { to: 30 });
    assert.deepEqual(markedLines, []);
    assert.equal(await modeEditor.saveEditorText(editor), true);
    assert.deepEqual(active, { ...original, complete: [ 'new.example' ] });

    // The mode transaction may broadcast its commit before downstream script
    // registration rejects. That must not turn a rejected save into a saved UI.
    editor.text = savedText.replace('protected.example', 'retry.example');
    const failedDraft = editor.text;
    dispatch = request => {
        channels.at(-1).onmessage({ data: { filteringModeDetails: request.modes } });
        throw new Error('script registration failed');
    };
    await assert.rejects(modeEditor.saveEditorText(editor), /registration failed/);
    assert.equal(editor.text, failedDraft);
    assert.equal(editor.lastSavedText, savedText);
    dispatch = request => structuredClone(request.modes);
    assert.equal(await modeEditor.saveEditorText(editor), true, 'A failed save can be retried');

    // A completed earlier save cannot erase or mark later typing as saved.
    let release;
    dispatch = request => new Promise(resolve => {
        release = () => resolve(structuredClone(request.modes));
    });
    const pending = modeEditor.saveEditorText(editor);
    editor.text += '# Keep newer typing\n';
    const newerDraft = editor.text;
    release();
    assert.equal(await pending, false);
    assert.equal(editor.text, newerDraft);
    modeEditor.off();
    assert.equal(channels.at(-1).closed, true);
    console.log('Site Rules parser and editor regressions passed.');
} finally {
    await fs.rm(staging, { recursive: true, force: true });
    delete globalThis.modeEditorTestSend;
}
