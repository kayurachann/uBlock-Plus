/* uBlock Plus+ — logger English/Vietnamese copy. GPL-3.0-or-later. */
export function loggerUIText(language = 'en') {
    if ( language.toLowerCase().startsWith('vi') ) {
        return {
            language: 'vi', title: 'Nhật ký',
            intro: 'Thu thập chẩn đoán cho một tab. Dữ liệu chỉ nằm trong phiên tiện ích và được xóa khi đóng cửa sổ nhật ký cuối cùng. Không tải lên máy chủ hay lưu lịch sử duyệt web.',
            tab: 'Tab', start: 'Bắt đầu', pause: 'Tạm dừng', clear: 'Xóa', export: 'Xuất JSON đã lược dữ liệu',
            search: 'Tìm kiếm', searchPlaceholder: 'URL, ID quy tắc, selector hoặc nguồn', kind: 'Loại',
            kinds: { '': 'Mọi sự kiện', network: 'Mạng', dnr: 'Khớp DNR gốc', cosmetic: 'Lọc giao diện', dom: 'DOM', scriptlet: 'Scriptlet', system: 'Hệ thống' },
            columns: [ 'Thời gian', 'Loại / giai đoạn', 'Nguồn bằng chứng', 'Request / chẩn đoán' ],
            initial: 'Chưa thu thập. Chọn một tab rồi bấm Bắt đầu.',
            summary: 'Nhật ký này xác nhận được những gì',
            details: [
                'Mạng là quan sát chỉ đọc từ trình duyệt, bao gồm request đã hoàn tất. Chỉ riêng một lỗi không xác định được tiện ích nào đã chặn. Request bị trình duyệt ẩn hoặc bị chặn trước thời điểm quan sát có thể không xuất hiện.',
                'Khớp DNR gốc xác định quy tắc của tiện ích này mà Chrome đã chọn. Việc đọc nội dung quy tắc diễn ra riêng, không phải ảnh chụp nguyên tử cùng sự kiện. Khả năng nhận sự kiện phụ thuộc API phản hồi và loại bản cài đặt.',
                'Lọc giao diện xác nhận stylesheet đã được chèn, chưa chứng minh phần tử đã bị ẩn. DOM phân biệt thao tác procedural thực sự đã áp dụng với ảnh chụp xác nhận selector CSS có phần tử khớp. Mỗi stylesheet được kiểm tra tối đa 32 nhóm selector; kết quả không chứng minh trạng thái hiển thị hay điều kiện media. Tối đa 32 báo cáo/giây/frame; không bao quát tác động trước khi bộ quan sát được nạp.',
                'Scriptlet ghi nhận việc đăng ký và ngoại lệ/fallback. Bản hiện tại chưa phát báo cáo thử thực thi hoặc xác nhận tác động của từng scriptlet. Thông điệp từ trang không phải bằng chứng thực thi MAIN world đáng tin cậy. Sự kiện đăng ký chung dùng tab −1.',
                'Bắt đầu sẽ xin quyền quan sát mạng tùy chọn. Từ chối vẫn cho phép chẩn đoán DNR và nội dung khi khả dụng. Tối đa 512 bản ghi dùng chung cho bốn cửa sổ nhật ký. Đóng tab hoặc tạm dừng sẽ ngừng thu thập; đóng nhật ký xóa dữ liệu không còn được cửa sổ khác dùng. Chrome có thể dừng service worker và xóa lịch sử tạm này.',
                'URL trong cửa sổ có thể chứa tham số riêng tư. Tệp xuất bỏ thông tin đăng nhập, query, fragment và nội dung chẩn đoán tự do; đường dẫn URL vẫn có thể chứa thông tin cá nhân. Hãy kiểm tra tệp trước khi chia sẻ.',
            ],
            empty: 'Chưa có sự kiện. Bắt đầu thu thập, sau đó tải lại trang đã chọn hoặc sử dụng các nút trên trang.',
            capturing: 'Đang thu thập.', paused: 'Đã tạm dừng.',
            network: 'Quan sát mạng', native: 'Bộ nhận sự kiện DNR gốc', available: 'có', unavailable: 'không có',
            records: 'bản ghi', discarded: 'bản ghi cũ đã bỏ', frame: 'frame',
            permissionRefused: 'Chưa cấp quyền mạng; các chẩn đoán khác vẫn khả dụng.',
            disconnected: 'Kết nối nhật ký đã kết thúc. Lịch sử tạm đã được xóa. Bấm Bắt đầu để kết nối lại.',
            phases: { requested: 'bắt đầu request', completed: 'hoàn tất', error: 'lỗi', redirected: 'chuyển hướng', matched: 'khớp quy tắc',
                'stylesheet-inserted': 'đã chèn stylesheet', 'css-selector-present': 'selector có phần tử khớp',
                'procedural-applied': 'đã áp dụng procedural', registered: 'đã đăng ký', 'exception-applied': 'đã áp dụng ngoại lệ' },
        };
    }
    return {
        language: 'en', title: 'Logger',
        intro: 'Capture diagnostics for one tab. Records stay in this extension session and are erased when its last logger closes. No upload or browsing-history storage.',
        tab: 'Tab', start: 'Start capture', pause: 'Pause', clear: 'Clear', export: 'Export redacted JSON',
        search: 'Search', searchPlaceholder: 'URL, rule ID, selector or source', kind: 'Kind',
        kinds: { '': 'All events', network: 'Network', dnr: 'Native DNR matches', cosmetic: 'Cosmetic', dom: 'DOM', scriptlet: 'Scriptlets', system: 'System' },
        columns: [ 'Time', 'Kind / phase', 'Evidence source', 'Request / diagnostic' ],
        initial: 'Capture is off. Choose a tab and start.',
        summary: 'What this logger can prove',
        details: [
            'Network is a read-only browser observation, including requests that completed. An error alone does not identify a blocking extension. Browser-hidden requests and some requests intercepted before observation may be absent.',
            'Native DNR match identifies this extension’s rule selected by Chrome. Rule-body lookup is separate and not atomic. Availability depends on Chrome’s feedback API and installation type.',
            'Cosmetic means a stylesheet was inserted; it does not prove that a node was hidden. DOM distinguishes actual procedural application from a plain CSS selector-present snapshot. Snapshots test at most 32 selector groups in a stylesheet and do not prove visibility or media activation. Reports are limited to 32 per second per frame; effects before the observer loads are not covered.',
            'Scriptlet reports cover registration and exception/fallback handling. This build does not emit execution-attempt reports or confirm individual scriptlet effects. Page messages are not trusted evidence of MAIN-world execution. Global registration events use tab −1.',
            'Capture requests the optional network-observation permission. Refusing it still permits available DNR and content diagnostics. At most 512 records are retained across up to four logger windows. Closing the tab or pausing stops collection; closing the logger clears its unshared records. Chrome may suspend the worker and clear this temporary history.',
            'Live URLs can contain private query strings. Export removes credentials, query strings, fragments and diagnostic free text; URL paths can still contain personal identifiers. Review exported files before sharing.',
        ],
        empty: 'No events yet. Start capture, then reload the selected page or use its controls.',
        capturing: 'Capturing.', paused: 'Paused.',
        network: 'Network observation', native: 'Native DNR listener', available: 'attached', unavailable: 'unavailable',
        records: 'records', discarded: 'older records discarded', frame: 'frame',
        permissionRefused: 'Network permission was not granted; other diagnostics remain available.',
        disconnected: 'Logger connection ended. Temporary history was cleared. Start capture to reconnect.',
        phases: {},
    };
}
