/* uBlock Plus+ - dynamic firewall editor. GPL-3.0-or-later. */
import { FIREWALL_REQUEST_TYPES } from './firewall-core.js';
import { sendMessage } from './ext.js';

const vi = navigator.language.startsWith('vi');
const labels = vi ? {
    title: 'Firewall động',
    description: 'Mỗi dòng: nguồn đích loại hành-động. Dùng * cho mọi tên miền; block chặn, allow cho phép, noop chỉ bỏ qua firewall và vẫn áp dụng danh sách lọc.',
    scope: 'Áp dụng cho request mạng trong tab, kể cả iframe, trên Chrome 145+. Chế độ Off được ưu tiên. Không áp dụng cho inline-script, điều hướng trang chính hoặc request ngoài tab. Quy tắc 1p/3p dùng trang cấp cao nhất và Public Suffix List; request đầu tiên tới trang mới có thể đi qua trong lúc Chrome cập nhật phạm vi.',
    preview: 'Kiểm tra', temporary: 'Áp dụng trong phiên', save: 'Lưu lâu dài',
    revert: 'Nạp bản lâu dài', import: 'Nhập tệp', export: 'Xuất tệp',
    placeholder: '* * 3p-script block\nexample.com * 3p-script noop',
    active: 'quy tắc Chrome đang hoạt động', domains: 'miền đã nhận diện trong phiên',
    deferred: 'ô cần ngữ cảnh trang; không chặn suy đoán',
    temporaryState: 'Đang dùng bản tạm', permanentState: 'Đang dùng bản lâu dài',
    unsupported: 'Firewall cần Chrome 145 trở lên. Các chức năng lọc hiện có vẫn hoạt động.',
    testTitle: 'Thử và giải thích quy tắc',
    testScope: 'Thử bản nháp trong ô soạn thảo với chế độ Off hiện tại. Không gửi request, không lưu URL và không thay đổi bảo vệ. Kết quả chỉ giải thích firewall; không mô phỏng toàn bộ danh sách lọc, quyền trình duyệt, hạn mức hoặc thời điểm áp dụng.',
    source: 'Trang cấp cao nhất: hostname hoặc URL HTTP(S)',
    destination: 'Tài nguyên đích: hostname hoặc URL HTTP(S)',
    type: 'Loại request', test: 'Thử request', changed: 'Dữ liệu đã đổi; hãy thử lại.',
    firstParty: 'Cùng bên (1p)', thirdParty: 'Bên thứ ba (3p)',
    outcomes: {
        block: 'Bản nháp: block — ô thắng yêu cầu chặn.',
        allow: 'Bản nháp: allow — ô thắng yêu cầu cho phép.',
        noop: 'Bản nháp: noop — bỏ qua firewall; danh sách lọc vẫn có thể chặn.',
        'no-match': 'Không có ô firewall khớp; danh sách lọc vẫn có thể chặn.',
        off: 'Off đang áp dụng cho trang này; được ưu tiên hơn bản nháp firewall.',
        unknown: 'Chưa đủ ngữ cảnh chế độ hoặc miền để kết luận; fail-open.',
    },
} : {
    title: 'Dynamic firewall',
    description: 'One row: source destination type action. Use * for all hostnames; block denies, allow permits, noop bypasses only the firewall while filter lists still apply.',
    scope: 'Network requests inside tabs, including iframes, on Chrome 145+. Off takes precedence. Inline scripts, main-page navigation and requests outside tabs are excluded. Party rules use the top page and the Public Suffix List; initial requests on a new site may pass while Chrome updates its scope.',
    preview: 'Validate', temporary: 'Apply for this session', save: 'Save permanently',
    revert: 'Load permanent rules', import: 'Import file', export: 'Export file',
    placeholder: '* * 3p-script block\nexample.com * 3p-script noop',
    active: 'active Chrome rules', domains: 'domains recognized this session',
    deferred: 'cells need page context; no speculative blocking',
    temporaryState: 'Temporary rules active', permanentState: 'Permanent rules active',
    unsupported: 'The firewall requires Chrome 145 or later. Existing filtering remains available.',
    testTitle: 'Test and explain a rule',
    testScope: 'Test the editor draft with current Off settings. No request is sent, no URL is saved and protection is unchanged. This explains only the firewall; it does not simulate all filter lists, browser permissions, quotas or activation timing.',
    source: 'Top page: hostname or HTTP(S) URL',
    destination: 'Destination resource: hostname or HTTP(S) URL',
    type: 'Request type', test: 'Test request', changed: 'Inputs changed; test again.',
    firstParty: 'First party (1p)', thirdParty: 'Third party (3p)',
    outcomes: {
        block: 'Draft: block — the winning cell requests blocking.',
        allow: 'Draft: allow — the winning cell requests allowing.',
        noop: 'Draft: noop — bypass the firewall; filter lists may still block.',
        'no-match': 'No firewall cell matches; filter lists may still block.',
        off: 'Off applies to this page and takes precedence over the firewall draft.',
        unknown: 'Mode or domain context is unavailable; no speculative decision (fail-open).',
    },
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
add('h3', labels.title);
add('p', labels.description);
add('p', labels.scope);
const editor = add('textarea', '');
editor.id = 'firewallRules';
editor.spellcheck = false;
editor.rows = 9;
editor.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace';
editor.placeholder = labels.placeholder;
editor.setAttribute('aria-label', labels.title);
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
    if ( result.supported === false ) { status.textContent = labels.unsupported; return; }
    status.textContent = `${result.ruleCount} ${labels.active}; ` +
        `${result.learnedDomains ?? state?.learnedDomains ?? 0} ${labels.domains}. ` +
        (result.deferredCells ? `${result.deferredCells} ${labels.deferred}. ` : '') +
        (result.temporary ? labels.temporaryState : labels.permanentState);
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
button('firewallValidate', labels.preview, async () => {
    const result = await sendMessage({ what: 'previewFirewallRules', text: editor.value });
    status.textContent = `${labels.preview}: ${result.ruleCount} ` +
        (vi ? 'quy tắc dự kiến' : 'proposed native rules') +
        (result.deferredCells ? `; ${result.deferredCells} ${labels.deferred}` : '');
});
async function apply(permanent) {
    const draft = editor.value;
    const result = await sendMessage({ what: 'applyFirewallRules', text: draft, permanent });
    state = result;
    // A response must never replace edits made while activation was pending.
    if ( editor.value === draft ) { editor.value = result.sessionText; }
    display(result);
}
button('firewallApply', labels.temporary, () => apply(false));
button('firewallSave', labels.save, () => apply(true));
button('firewallRevert', labels.revert, async () => {
    state = await sendMessage({ what: 'getFirewallState' });
    editor.value = state.permanentText;
    status.textContent = vi ? 'Đã nạp bản lâu dài vào bản nháp; bấm Áp dụng để kích hoạt.'
        : 'Permanent rules loaded into the draft; apply to activate.';
});
const input = document.createElement('input');
input.type = 'file'; input.accept = 'text/plain'; input.hidden = true;
panel.append(input);
input.addEventListener('change', () => run(async () => {
    const file = input.files[0];
    if ( file === undefined ) { return; }
    if ( file.size > 131072 ) { throw new Error('Maximum file size: 128 KiB'); }
    const text = await file.text();
    await sendMessage({ what: 'previewFirewallRules', text });
    editor.value = text;
    input.value = '';
}));
button('firewallImport', labels.import, () => input.click());
button('firewallExport', labels.export, () => {
    const url = URL.createObjectURL(new Blob([ editor.value ], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'ublock-plus-firewall.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelector('section[data-pane="siteRules"]').append(panel);
const tester = document.createElement('details');
tester.id = 'firewallTester';
const summary = document.createElement('summary');
summary.textContent = labels.testTitle;
tester.append(summary);
const explanation = document.createElement('p');
explanation.textContent = labels.testScope;
tester.append(explanation);
const fields = [];
for ( const [ name, tag, placeholder ] of [
    [ 'source', 'input', 'example.com' ],
    [ 'destination', 'input', 'https://ads.example.net/script.js' ],
    [ 'type', 'select', '' ],
] ) {
    const label = document.createElement('label');
    label.textContent = labels[name];
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
testButton.textContent = labels.test;
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
            testResult.textContent = labels.changed;
            return;
        }
        const lines = [ labels.outcomes[result.action], `${result.source} → ${result.destination}` ];
        if ( result.thirdParty !== null ) {
            lines.push(result.thirdParty ? labels.thirdParty : labels.firstParty);
        }
        if ( result.rule ) { lines.push(result.rule); }
        testResult.textContent = lines.join('\n');
    } catch ( reason ) {
        testResult.textContent = JSON.stringify(input) === JSON.stringify(testInputs())
            ? reason.message : labels.changed;
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
