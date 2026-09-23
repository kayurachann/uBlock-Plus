/* uBlock Plus+ - dynamic firewall editor. GPL-3.0-or-later. */
import { i18n, sendMessage } from './ext.js';
import { FIREWALL_REQUEST_TYPES } from './firewall-core.js';

const i18n$ = (key, ...substitutions) => i18n.getMessage(key,
    substitutions.length ? substitutions.map(String) : undefined);
const outcomes = {
    block: 'firewallOutcomeBlock', allow: 'firewallOutcomeAllow',
    noop: 'firewallOutcomeNoop', 'no-match': 'firewallOutcomeNoMatch',
    off: 'firewallOutcomeOff', unknown: 'firewallOutcomeUnknown',
};

const panel = document.createElement('div');
panel.id = 'dynamicFirewall';
panel.className = 'powerPanel';
const add = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    panel.append(node);
    return node;
};
add('h3', i18n$('firewallTitle'));
add('p', i18n$('firewallDescription'));
add('p', i18n$('firewallScope'));
const editor = add('textarea', '');
editor.id = 'firewallRules';
editor.spellcheck = false;
editor.rows = 9;
editor.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace';
editor.placeholder = '* * 3p-script block\nexample.com * 3p-script noop';
editor.setAttribute('aria-label', i18n$('firewallTitle'));
const actions = add('p', '');
const status = add('p', '');
status.id = 'firewallStatus';
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
const buttons = [];
let state;
let busy = false;
function display(result) {
    if ( result.error ) { status.textContent = result.error; return; }
    if ( result.supported === false ) { status.textContent = i18n$('firewallUnsupported'); return; }
    const learned = result.learnedDomains ?? state?.learnedDomains ?? 0;
    status.textContent = [
        i18n$('firewallStatusRules', result.ruleCount, learned),
        result.deferredCells ? i18n$('firewallStatusDeferred', result.deferredCells) : '',
        result.omittedDomains ? i18n$('firewallStatusOmitted', learned) : '',
        result.scopeError ? i18n$('firewallStatusScopeError', result.scopeError) : '',
        i18n$(result.temporary ? 'firewallStatusTemporary' : 'firewallStatusPermanent'),
    ].filter(Boolean).join(' ');
}
async function run(task) {
    if ( busy ) { return; }
    testResult.textContent = '';
    busy = true;
    buttons.forEach(button => { button.disabled = true; });
    try { await task(); }
    catch ( reason ) { status.textContent = reason.message; }
    finally {
        busy = false;
        buttons.forEach(button => { button.disabled = false; });
    }
}
function button(id, label, task) {
    const node = document.createElement('button');
    node.type = 'button'; node.id = id; node.textContent = label;
    node.addEventListener('click', () => { run(task); });
    actions.append(node, ' ');
    buttons.push(node);
}
button('firewallValidate', i18n$('firewallValidate'), async () => {
    const result = await sendMessage({ what: 'previewFirewallRules', text: editor.value });
    status.textContent = [
        i18n$('firewallPreviewRules', result.ruleCount),
        result.deferredCells ? i18n$('firewallStatusDeferred', result.deferredCells) : '',
        result.omittedDomains ? i18n$('firewallPreviewOmitted', result.omittedDomains) : '',
    ].filter(Boolean).join(' ');
});
async function apply(permanent) {
    const draft = editor.value;
    const result = await sendMessage({ what: 'applyFirewallRules', text: draft, permanent });
    state = result;
    // A response must never replace edits made while activation was pending.
    if ( editor.value === draft ) { editor.value = result.sessionText; }
    display(result);
}
button('firewallApply', i18n$('firewallApplySession'), () => apply(false));
button('firewallSave', i18n$('firewallSavePermanent'), () => apply(true));
button('firewallRevert', i18n$('firewallLoadPermanent'), async () => {
    state = await sendMessage({ what: 'getFirewallState' });
    editor.value = state.permanentText;
    status.textContent = i18n$('firewallPermanentLoaded');
});
const input = document.createElement('input');
input.type = 'file'; input.accept = 'text/plain'; input.hidden = true;
panel.append(input);
input.addEventListener('change', () => {
    const file = input.files[0];
    // Reset before any await or error, so choosing the same corrected file
    // again fires another change event.
    input.value = '';
    run(async () => {
        if ( file === undefined ) { return; }
        if ( file.size > 131072 ) { throw new Error(i18n$('firewallImportTooLarge')); }
        const text = await file.text();
        await sendMessage({ what: 'previewFirewallRules', text });
        editor.value = text;
    });
});
button('firewallImport', i18n$('firewallImportFile'), () => input.click());
button('firewallExport', i18n$('firewallExportFile'), () => {
    const url = URL.createObjectURL(new Blob([ editor.value ], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'ublock-plus-firewall.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelector('section[data-pane="siteRules"]').append(panel);
const tester = document.createElement('details');
tester.id = 'firewallTester';
const summary = document.createElement('summary');
summary.textContent = i18n$('firewallTestTitle');
tester.append(summary);
const explanation = document.createElement('p');
explanation.textContent = i18n$('firewallTestScope');
tester.append(explanation);
const fields = [];
for ( const [ name, tag, placeholder, key ] of [
    [ 'source', 'input', 'example.com', 'firewallTestSource' ],
    [ 'destination', 'input', 'https://ads.example.net/script.js', 'firewallTestDestination' ],
    [ 'type', 'select', '', 'firewallTestType' ],
] ) {
    const label = document.createElement('label');
    label.textContent = i18n$(key);
    label.style.cssText = 'display:block;margin-block:0.8em';
    const field = document.createElement(tag);
    field.id = `firewallTest-${name}`;
    field.style.cssText = 'display:block;width:100%;box-sizing:border-box';
    if ( tag === 'input' ) {
        field.type = 'text'; field.placeholder = placeholder;
        field.maxLength = 4096; field.autocomplete = 'off'; field.spellcheck = false;
    } else {
        for ( const type of FIREWALL_REQUEST_TYPES ) {
            const option = document.createElement('option');
            option.value = type; option.textContent = type;
            field.append(option);
        }
        field.value = 'script';
    }
    label.append(field); tester.append(label); fields.push(field);
}
const testButton = document.createElement('button');
testButton.type = 'button'; testButton.id = 'firewallTestRequest';
testButton.textContent = i18n$('firewallTestRequest');
const testResult = document.createElement('pre');
testResult.id = 'firewallTestResult';
testResult.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
testResult.setAttribute('role', 'status');
testResult.setAttribute('aria-live', 'polite');
const testInputs = () => [ editor.value, ...fields.map(field => field.value) ];
testButton.addEventListener('click', () => run(async () => {
    const input = testInputs();
    const [ text, source, destination, type ] = input;
    try {
        const result = await sendMessage({ what: 'testFirewallRequest', text, source, destination, type });
        if ( JSON.stringify(input) !== JSON.stringify(testInputs()) ) {
            testResult.textContent = i18n$('firewallTestChanged');
            return;
        }
        const lines = [ i18n$(outcomes[result.action]), `${result.source} → ${result.destination}` ];
        if ( result.thirdParty !== null ) {
            lines.push(i18n$(result.thirdParty ? 'firewallTestThirdParty' : 'firewallTestFirstParty'));
        }
        if ( result.rule ) { lines.push(result.rule); }
        testResult.textContent = lines.join('\n');
    } catch ( reason ) {
        testResult.textContent = JSON.stringify(input) === JSON.stringify(testInputs())
            ? reason.message : i18n$('firewallTestChanged');
    }
}));
for ( const field of [ editor, ...fields ] ) {
    field.addEventListener('input', () => { testResult.textContent = ''; });
}
buttons.push(testButton);
tester.append(testButton, testResult);
panel.append(tester);

run(async () => {
    const draft = editor.value;
    state = await sendMessage({ what: 'getFirewallState' });
    if ( editor.value === draft ) { editor.value = state.sessionText; }
    display(state);
});
