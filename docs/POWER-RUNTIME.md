# Power Runtime và giới hạn trình duyệt

uBlock Plus+ không dùng từ “Power” để che giấu một engine tối giản. Mục tiêu của dự án là giữ toàn bộ trải nghiệm uBlock Origin có thể biểu diễn an toàn trên Chromium MV3, rồi bổ sung capability mạnh hơn khi **chính trình duyệt** xác nhận extension đủ điều kiện.

## Bốn tầng runtime riêng biệt

| Runtime | Cách cài | Engine đang hoạt động | Năng lực bổ sung |
| --- | --- | --- | --- |
| **Power MV3** | Artifact đóng gói/sideload hoặc Developer mode → Load unpacked | DNR + cosmetic/scriptlet đóng gói + compiled popup observer | Filter Store, imported list, per-site mode, picker/zapper, smart policy, stock `$popup` cùng subset sandbox/imported `$popup`/`$popunder` đã classifier chấp nhận và profile bộ nhớ. |
| **Managed Power** | Chrome/Edge enterprise policy | DNR; `webRequest` chỉ được đưa vào danh sách engine đủ điều kiện sau capability probe | Chrome cho phép extension MV3 policy-installed dùng `webRequestBlocking`; adapter programmatic vẫn phải có implementation, test và audit riêng trước khi được kích hoạt. |
| **Native Companion** *(R&D)* | Native Messaging host mã nguồn mở, cài và gỡ riêng | Power MV3 trong extension; capability native nằm ở process riêng | Có thể nghiên cứu DNS/proxy/diagnostics cục bộ sau RFC. Không làm extension thành managed và không tăng quota DNR của Chrome. |
| **Custom Chromium** *(R&D)* | Browser mã nguồn mở do người dùng cài riêng | Tùy patch/build của browser đó | Artifact, profile và support matrix riêng. Không được ghi capability của custom build như capability của Google Chrome; không tắt sandbox, Site Isolation hay Safe Browsing để đổi lấy feature. |

Chrome xác nhận [`webRequestBlocking` trong MV3 chỉ dành cho extension policy-installed](https://developer.chrome.com/docs/extensions/reference/api/webRequest). Trạng thái cài đặt được đọc bằng [`management.getSelf()`](https://developer.chrome.com/docs/extensions/reference/api/management), không suy đoán từ registry hoặc một flag do extension tự đặt.

Managed, native và custom browser là ba ranh giới quyền khác nhau. Một Native Messaging port có thể ảnh hưởng lifecycle worker trong một số Chrome version, nhưng không cấp blocking listener. Một custom browser có thể sửa API, nhưng patch đó không đi vào artifact MV3 mặc định.

## Quota DNR mà Power MV3 phải budget

[Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) phân static, dynamic và session thành các ruleset khác nhau:

- Static rules được đóng gói. Chrome hiện cho khai báo tối đa 100 static ruleset, bật 50 cùng lúc và bảo đảm tối thiểu 30.000 static rules trên tập đang bật; capacity vượt mức phụ thuộc các extension khác và được hỏi bằng `getAvailableStaticRuleCount()`. Enabled static rulesets dùng aggregate pool tối đa 1.000 regex riêng.
- Session có tối đa 5.000 rules. Dynamic có tối đa 30.000 rules, nhưng không quá 5.000 rule thuộc nhóm `unsafe`; safe actions hiện gồm `block`, `allow`, `allowAllRequests` và `upgradeScheme`. Đây là giới hạn số rule, không phải bảo đảm mọi filter uBO đều biểu diễn được.
- [Chromium CL 4903267, 2023-10-18](https://chromium.googlesource.com/chromium/src/+/eab7fc99e59b69e929d02e43bdcf8bbd75333869%5E%21/) tách rule-count dynamic/session nhưng giữ **một pool tối đa 1.000 regex dùng chung cho dynamic + session**. [Chromium source snapshot kiểm tra 2026-09-01](https://chromium.googlesource.com/chromium/src/+/215ff4a79b1f9f613d71a27300e0fdc94a79b8c5/extensions/browser/api/declarative_net_request/rules_monitor_service.cc#776) vẫn trừ regex count của ruleset runtime còn lại khi tính capacity.
- Regex còn phải qua `isRegexSupported()`/browser validation và giới hạn compiled size. Compiler phải giữ last-known-good, báo reason/source line và không nới pattern chỉ để vừa quota.

Do constant và implementation có thể khác giữa Chrome version hoặc Chromium fork, UI chỉ công bố giá trị runtime probe được; tài liệu này không hứa một tổng rule cố định trên mọi browser.

## Service worker không phải background page

Theo [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), worker thường bị dừng sau khoảng 30 giây idle; một event/API call kéo dài khoảng 5 phút hoặc `fetch()` response quá khoảng 30 giây cũng có thể bị chấm dứt. Event mới có thể đánh thức worker, nhưng global variables cũ đã mất.

Vì vậy Power Runtime:

- đăng ký listener ở top level, không chờ async initialization mới đăng ký;
- persist generation pointer, popup candidate tối thiểu, policy và compile checkpoint;
- đọc lại immutable compiled generation sau wake và không trộn hai generation;
- làm update/migration idempotent, có rollback/cleanup khi worker bị dừng;
- fail open nếu popup/popunder cần initiator hoặc original-opener context mà checkpoint không thể khôi phục đầy đủ.

## Compiled popup observer

Compiler phân loại typed `$popup`/`$popunder` data trước khi lưu:

- Condition subset an toàn gồm request/initiator/top domain include-exclude và URL/regex pattern đã validator chấp nhận. Route `popup-observer-runtime` được tính accepted+routed, không phải deferred; popup-only không cần tạo DNR.
- Condition như `domainType`, method, resource type, response header hoặc key chưa hỗ trợ giữ route `popup-compiler-required` với reason cụ thể. Popup-only deferred được tính rejected; filter kết hợp vẫn có thể accepted ở phần DNR và deferred ở phần popup. Deferred allow được rút thành guard superset: guard chỉ trả `defer` khi exception có thể áp dụng, không bao giờ tự biến thành allow hoặc block gần đúng.
- Observer chỉ đánh giá typed data trong immutable compiled generation đã commit cục bộ (hiện là các realm `sandbox`/`imported`). Context thiếu hoặc không chắc chắn không được biến thành broad block. Đây là semantics fail-open có chủ ý, không phải parity với engine popup MV2.

Bài học upstream: [uAssets #33581](https://github.com/uBlockOrigin/uAssets/issues/33581) cho thấy popup exception collation cần regression test; [uBlock #2094](https://github.com/gorhill/uBlock/issues/2094) cho thấy blanket-block URL trung gian dễ false positive.

## Flag làm được gì?

| Cơ chế | Dùng cho | Không làm được |
| --- | --- | --- |
| **Developer mode / Allow User Scripts** | Load unpacked và mở `userScripts` theo UI của browser | Không cấp `webRequestBlocking`, không tăng quota DNR. |
| `--load-extension` / `--disable-extensions-except` | Tự động nạp extension trong một số Chromium/dev build | Không đổi install type thành `admin`; các Chrome build mới có thể vô hiệu hóa command-line loading. |
| `--enable-experimental-extension-apis` | Thử API extension đang phát triển trên browser hỗ trợ | Không bỏ manifest permission, install-location check hay quota. |
| `--extensions-on-extension-urls` | Cho phép extension làm việc trên URL `chrome-extension://` trong browser hỗ trợ | Không khôi phục quyền trên `chrome://` và không mở khóa network engine MV2. Chromium đã [loại bỏ tác dụng của `--extensions-on-chrome-urls` khỏi Google Chrome](https://chromium.googlesource.com/chromium/src/+/e156ccff5dc879607ca48817e638e361406e4170) vì rủi ro lạm dụng. |
| `--no-sandbox`, tắt Site Isolation hoặc vô hiệu hóa cơ chế bảo mật | **Không được dự án hỗ trợ** | Đây không phải capability của content blocker và làm yếu toàn bộ browser. |

Các switch extension có trong [Chromium source](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/switches.cc); việc Google Chrome hạn chế một số switch được thể hiện trong [extension service](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/extension_service.cc). Dự án kiểm tra API thực tế thay vì giả định flag luôn có hiệu lực.

## Capability negotiation

Module `runtime-capabilities.js` thu thập:

- `installType` thực tế (`development`, `admin`, `normal`, `sideload` hoặc `other`);
- permission được khai báo **và** được browser cấp;
- sự tồn tại của DNR, `webRequest`, `webNavigation`, tabs và offscreen; riêng `userScripts` được probe bằng lời gọi API thật để không báo nhầm khi người dùng tắt **Allow User Scripts**;
- quota DNR mà browser hiện tại công bố, gồm cả `getAvailableStaticRuleCount()`.

Kết quả luôn giữ `activeNetworkEngine: "dnr"` cho tới khi một managed adapter hoàn chỉnh được đăng ký. Việc thấy `managed-webrequest` trong `eligibleNetworkEngines` chỉ có nghĩa môi trường đủ điều kiện; nó không âm thầm bật code chưa được kiểm thử.

## Không có remote executable code

[Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) loại bỏ remotely hosted code khỏi extension logic; [Chrome guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) định nghĩa JavaScript/Wasm được tải ngoài package rồi browser thực thi là remote code. Power Runtime chỉ tải filter/catalog như **dữ liệu không tin cậy** qua parser hữu hạn. Scriptlet, redirect resource, matcher và compiler đều phải nằm trong artifact; dự án không dùng các API exception hẹp để phân phối remote project code và không `eval`, remote module, remote Wasm hay remote scriptlet ở bất kỳ tier nào.

## Policy không phải flag cá nhân

Chrome Enterprise cung cấp [`ExtensionSettings`](https://chromeenterprise.google/policies/extension-settings/) và [`ExtensionInstallForcelist`](https://chromeenterprise.google/policies/extension-install-forcelist/) để cài extension theo policy. Trên Windows và macOS, force-install ngoài Chrome Web Store còn phụ thuộc máy đã được quản lý bằng AD/Azure AD/Chrome Enterprise Core hoặc MDM theo tài liệu Chrome. Vì vậy một file `.reg` trên máy cá nhân không được dự án quảng cáo như đường mở khóa phổ quát.

Managed build chỉ được phát hành khi có đủ:

1. manifest riêng với identity/update channel của fork;
2. programmatic filtering adapter dùng core parser/matcher được pin;
3. fallback DNR khi probe hoặc listener registration thất bại;
4. benchmark CPU/RAM và kiểm tra service-worker restart;
5. threat-model, privacy disclosure và hướng dẫn gỡ policy hoàn chỉnh.

Native Companion và Custom Chromium không dùng checklist managed này thay cho review riêng. Mỗi hướng cần RFC, artifact/update channel, install/uninstall, rollback, permission/IPC hoặc patch audit, benchmark và threat model độc lập trước khi có thể chuyển khỏi trạng thái R&D.
