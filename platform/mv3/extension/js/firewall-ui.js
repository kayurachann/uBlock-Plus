/* uBlock Plus+ - dynamic firewall editor. GPL-3.0-or-later. */
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
run(async () => {
    state = await sendMessage({ what: 'getFirewallState' });
    editor.value = state.sessionText;
    display(state);
});
