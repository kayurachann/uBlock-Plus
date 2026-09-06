/*******************************************************************************

    uBlock Plus+ - an original-first MV3 fork
    Based on uBlock Origin upstream sources
    Copyright (C) 2014-present Raymond Hill
    Modifications Copyright (C) 2026-present uBlock Plus+ contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    modesFromText,
    textFromModes,
} from './mode-parser.js';
import { i18n$ } from './i18n.js';
import { sendMessage } from './ext.js';

/******************************************************************************/

export class ModeEditor {
    constructor(editor) {
        this.editor = editor;
        this.bc = null;
    }

    on() {
        if ( this.bc !== null ) { return; }
        this.bc = new self.BroadcastChannel('uBlockPlus');
        this.bc.onmessage = ev => {
            const message = ev.data;
            if ( message instanceof Object === false ) { return; }
            if ( message.filteringModeDetails === undefined ) { return; }
            // A background commit may be followed by a script-registration
            // failure. Keep an edited draft until its own save succeeds.
            if ( this.editor.editorTextChanged() ) { return; }
            const text = textFromModes(message.filteringModeDetails);
            this.editor.setEditorText(text, true);
        };
    }

    off() {
        if ( this.bc === null ) { return; }
        this.bc.onmessage = null;
        this.bc.close();
        this.bc = null;
    }

    async getText() {
        const modes = await sendMessage({ what: 'getFilteringModeDetails' });
        return textFromModes(modes);
    }

    async saveEditorText(editor) {
        const draft = editor.getEditorText();
        const { modes } = modesFromText(draft);
        if ( modes instanceof Object === false ) {
            this.updateView(editor);
            return false;
        }
        const modesAfter = await sendMessage({ what: 'setFilteringModeDetails', modes });
        if ( editor.getEditorText() !== draft ) { return false; }
        const text = textFromModes(modesAfter);
        editor.setEditorText(text);
        return true;
    }

    updateView(editor) {
        const { doc } = editor.view.state;
        // Parse the whole draft: a changed hostname line still needs its mode
        // header, and default/duplicate errors can affect another line.
        const text = editor.getEditorText();
        const { bad } = modesFromText(text, true);
        self.cm6.lineErrorClear(editor.view, 1, doc.lines);
        if ( Array.isArray(bad) && bad.length !== 0 ) {
            self.cm6.lineErrorAdd(editor.view, bad.map(i => i + 1));
        }
    }

    newlineAssistant = {
        'no filtering:': '  - ',
        'basic:': '  - ',
        'optimal:': '  - ',
        'complete:': '  - ',
        [`${i18n$('filteringMode0Name')}:`]: '  - ',
        [`${i18n$('filteringMode1Name')}:`]: '  - ',
        [`${i18n$('filteringMode2Name')}:`]: '  - ',
        [`${i18n$('filteringMode3Name')}:`]: '  - ',
    };

    ioAccept = '.json,application/json';
};
