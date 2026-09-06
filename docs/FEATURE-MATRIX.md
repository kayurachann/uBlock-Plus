# Bảng tương thích uBlock Origin MV2 → uBlock Plus+ MV3

Đây là bản đồ capability, **không phải lời hứa parity 100%**. Chrome MV3 buộc extension công khai dùng Declarative Net Request cho phần lớn tác vụ chặn; sideload không gỡ quota DNR và không biến service worker thành background page MV2.

Ký hiệu: **Có** = bản hiện tại có đường triển khai hữu ích; **Một phần** = semantics/quota khác MV2; **Không** = chưa có trong bản hiện tại; **R&D** = hướng mở rộng cần artifact và đánh giá riêng. “Không” không khẳng định mọi API hoặc cách triển khai khác đều bất khả thi.

Gói [Experimental WebRequest](EXPERIMENTAL-WEBREQUEST.md) hiện có **lớp bổ sung chặn firewall đồng bộ**, với launcher/profile riêng và kiểm tra quyền thực cấp. Nó dùng cùng quy tắc firewall, giữ DNR/Off/allow/noop và không tăng quota hay khôi phục toàn bộ engine static uBO. Bảng dưới mô tả bản DNR tiêu chuẩn trừ khi ghi rõ khác.

Theo [Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), static ruleset được đóng gói và có ngân sách riêng với dynamic/session. Từ Chrome 120/121, giới hạn **số rule** dynamic và session được tách, nhưng [Chromium CL ngày 2023-10-18](https://chromium.googlesource.com/chromium/src/+/eab7fc99e59b69e929d02e43bdcf8bbd75333869%5E%21/) xác nhận quota **regex dynamic + session vẫn dùng chung một pool tối đa 1.000**; enabled static rulesets có aggregate pool tối đa 1.000 regex riêng. Con số cụ thể thay đổi theo browser/version, nên đây là mô hình budget chứ không phải bảo đảm mọi máy có cùng capacity.

| Capability | uBO MV2 | Power Edition MV3 | Tầng tùy chọn tương lai | Ghi chú trung thực |
| --- | --- | --- | --- | --- |
| Static network blocking | Có | **Có**, packaged static DNR | Không cần | Chrome hiện cho khai báo tối đa 100 static ruleset, bật 50 và bảo đảm tối thiểu 30.000 static rules trên tập đang bật; phần vượt mức phụ thuộc `getAvailableStaticRuleCount()`. |
| Custom/imported network lists | Có | **Có**, dynamic DNR trong subset hỗ trợ | Có thể bổ sung compiler native | Dynamic/session có rule-count budget riêng nhưng chia sẻ regex pool; filter không biểu diễn được phải được báo, không cắt im lặng. |
| Per-site filtering mode | Có | **Có** | Không cần | Persist setting và sinh rule theo namespace. |
| Dynamic firewall matrix | Có, quyết định runtime | **Một phần**, native network cells với block/allow/noop, bản tạm/lâu dài | Managed adapter có thể mở rộng | Chrome 145+ dùng topDomains; party theo trang cấp cao nhất và PSL. Trang mới có thể cần cập nhật bất đồng bộ. Chưa có full popup matrix, inline-script hoặc main-frame firewall. [Chi tiết](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). |
| Cosmetic filtering | Có | **Có** | Không cần | CSS/content script đăng ký theo site/ruleset. |
| Procedural cosmetic filter | Có | **Một phần** | Native không giúp DOM trực tiếp | Chỉ hỗ trợ operator an toàn có trong packaged code. |
| Scriptlets | Có | **Một phần** | Không tải scriptlet qua companion | Chỉ scriptlet đóng gói/allowlist; cấm remote executable code. |
| Element picker/zapper | Có | **Có** | Không cần | Filter tạo ra được lưu cục bộ. |
| Strict/popup blocking | Có | **Có/Một phần** | Có thể bổ sung policy | Smart policy vẫn xử lý opener/target/gesture. Observer thực thi corpus stock `$popup` đóng gói và subset `$popup`/`$popunder` của sandbox/imported: URL/regex đã kiểm tra cùng include/exclude request, initiator và top domains. Stock DNR export chưa giữ kind `$popunder`, nên metadata ghi `omitted` thay vì giả lập. Condition như `domainType`, method, resource type hoặc response header được giữ ở typed route `popup-compiler-required` với status `deferred`; deferred allow còn tạo guard superset chỉ có quyền buộc fail-open, không được tự allow/block. Thiếu context hoặc hết work budget cũng phải fail open. |
| Redirect resource | Có | **Một phần** | Không cần | Chỉ redirect tới resource đóng gói/được manifest cho phép. |
| Request/response header rules | Có | **Một phần** | Managed mode có thể mở rộng | DNR `modifyHeaders` không tương đương mọi thao tác `webRequestBlocking`. |
| Full live request logger | Có | **Một phần**, logger hợp nhất opt-in | **R&D** qua managed/native diagnostics | Quan sát network với quyền tùy chọn, native DNR, CSS/DOM và chẩn đoán scriptlet; 512 bản ghi, có search/export. Không thấy mọi request browser hoặc bảo đảm đầy đủ hiệu ứng MAIN world. |
| Response body/HTML rewriting | Có trên engine hỗ trợ | **Không** | **R&D** qua debugger/Fetch theo tab hoặc local proxy | DNR và managed `webRequestBlocking` không cung cấp body rewrite. Debugger có Fetch nhưng cần quyền không thể xin tùy chọn, quản lý request tạm dừng và target riêng. [Phân tích API](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). |
| CNAME uncloaking/DNS resolution | Có trên engine hỗ trợ | **Không** | **R&D** qua DNS-aware companion | `chrome.dns` hiện chỉ dành cho Dev channel, trả IP chứ không chuỗi CNAME; chưa giải quyết Chrome Stable. |
| Chặn media theo kích thước response | Có | **Không tương đương chính xác** | **R&D** qua debugger/proxy | Header nếu có chưa bảo đảm kích thước body thực tế; bản hiện tại không triển khai bộ lọc kích thước đầy đủ. |
| Backup/restore | Có | **Có** | Có thể export policy riêng | Không bao gồm secret/native config nếu chưa có schema mã hóa. |
| Internationalization | Có | **Có/Một phần** | Không cần | 10 locale ưu tiên có bộ chuỗi Power trước đây; 61 locale dùng English fallback build-time. Firewall/logger/capability mới có EN/VI, các ngôn ngữ khác tạm dùng English. |
| Filter Store/catalog | Không phải core store | **MVP có** | Không cần | Catalog đóng gói và tối đa 8 catalog HTTPS do người dùng thêm; filter là dữ liệu, không phải plugin/code store. |
| Low-memory profile | Tối ưu runtime MV2 | **MVP có** | Companion có budget riêng | Compile tuần tự, cache có ngân sách và số liệu storage cục bộ; chưa có benchmark heap/RSS trên máy 2–4 GiB. |

## Những điều sideload không thay đổi

- quota static/dynamic/session/regex do Chrome áp đặt; static không thể được “mượn” để tăng pool regex dynamic + session;
- extension service worker thường bị dừng sau idle và có thể bị chấm dứt ngoài dự kiến; state quan trọng không được chỉ giữ trong global variables;
- API DNR chỉ biểu diễn được một tập con semantics của engine MV2;
- extension MV3 bình thường không được dùng blocking `webRequest`; Chrome hỗ trợ chính thức quyền này cho policy-installed. Gói thử nghiệm còn kiểm chứng tham số allowlist trên Chrome 152, nhưng quyền đó không làm bản cài thành policy-installed và không mở toàn bộ API;
- JavaScript/Wasm từ xa không được thực thi. Filter/catalog tải qua HTTPS chỉ là dữ liệu hostile đi qua parser hữu hạn; không được biến thành remote scriptlet/module.

Quota thay đổi theo phiên bản Chrome, vì vậy compiler phải đọc capability/quota khi có API và CI phải kiểm tra trên browser được hỗ trợ. Nguồn tham khảo: [Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), [blocking webRequest migration](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests), [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [MV3 remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code), [uAssets #30545 về regex MV3](https://github.com/uBlockOrigin/uAssets/issues/30545) và [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md).

## Semantics của compiled popup route

- Một popup-only filter được classifier hỗ trợ được tính **một input accepted**, tăng `routed`, không tăng `deferred` và không cần tạo DNR rule.
- Filter kết hợp, ví dụ `$popup,script`, có thể tạo cả DNR resource rule lẫn typed popup runtime route nhưng input chỉ được tính accepted một lần.
- Condition chưa hỗ trợ vẫn giữ typed route `popup-compiler-required` với reason cụ thể. Popup-only khi đó là deferred/rejected; filter kết hợp vẫn có thể accepted ở phần DNR và đồng thời có deferred popup route.
- Build phát sinh corpus stock bất biến tại `rulesets/popup/<rulesetId>.json`; runtime chỉ nạp lazy corpus của ruleset đang bật. Validator đối chiếu schema, provenance, count và classifier trước khi release.
- Runtime cache matcher/regex theo identity bất biến và giới hạn 4.096 filter, 16 realm cùng 65.536 match-step cho mỗi event. Regex unbounded không neo đầu chuyển sang compiler-required; hết budget trả `defer`, không treo worker hoặc block gần đúng.
- Runtime không block khi context cần thiết không đầy đủ. Đây là kiểm soát false positive, phù hợp với bài học từ [uBlock #2094](https://github.com/gorhill/uBlock/issues/2094) và [uAssets #7012](https://github.com/uBlockOrigin/uAssets/issues/7012), không phải lời hứa bắt được mọi popup.

## Các tầng tùy chọn không hoán đổi cho nhau

- **Managed Enterprise** là extension MV3 được browser cài bằng policy và có thể đủ điều kiện cho `webRequestBlocking`; capability chỉ active khi adapter đóng gói và probe thành công.
- **Native Companion** là process cục bộ cài riêng qua Native Messaging. Nó không làm extension thành policy-installed và không tự tăng quota DNR.
- **Custom Chromium** là một browser build riêng với patch riêng. Capability của build đó không được ghi như capability của Google Chrome hoặc artifact MV3 mặc định.

## Release gate

Một ô “Có” chỉ được đánh dấu shipped trong release note khi có:

1. test chức năng và test regression;
2. compile report không có silent drop;
3. đo RAM/CPU trên profile máy yếu;
4. permission và threat-model review;
5. tài liệu fallback khi quota/API không đủ.
