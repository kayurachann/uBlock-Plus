# Power Runtime và giới hạn trình duyệt

uBlock Plus+ không dùng từ “Power” để che giấu một engine Lite. Mục tiêu của dự án là giữ toàn bộ trải nghiệm uBlock Origin có thể biểu diễn an toàn trên Chromium MV3, rồi bổ sung capability mạnh hơn khi **chính trình duyệt** xác nhận extension đủ điều kiện.

## Ba trạng thái runtime

| Runtime | Cách cài | Engine đang hoạt động | Năng lực bổ sung |
| --- | --- | --- | --- |
| **Power / unpacked** | Developer mode → Load unpacked | DNR + cosmetic/scriptlet đóng gói | Filter Store, imported list, per-site mode, picker/zapper, smart popup và profile bộ nhớ. |
| **Managed Power** | Chrome/Edge enterprise policy | DNR; `webRequest` chỉ được đưa vào danh sách engine đủ điều kiện sau capability probe | Chrome cho phép extension MV3 policy-installed dùng `webRequestBlocking`; adapter programmatic vẫn phải có implementation, test và audit riêng trước khi được kích hoạt. |
| **Custom Chromium** | Browser mã nguồn mở được người dùng tự cài riêng | Tùy browser build | Chỉ là hướng R&D. Phải dùng profile riêng, patch có thể audit và không được tắt sandbox hoặc Safe Browsing để đổi lấy feature. |

Chrome xác nhận [`webRequestBlocking` trong MV3 chỉ dành cho extension policy-installed](https://developer.chrome.com/docs/extensions/reference/api/webRequest). Trạng thái cài đặt được đọc bằng [`management.getSelf()`](https://developer.chrome.com/docs/extensions/reference/api/management), không suy đoán từ registry hoặc một flag do extension tự đặt.

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

## Policy không phải flag cá nhân

Chrome Enterprise cung cấp [`ExtensionSettings`](https://chromeenterprise.google/policies/extension-settings/) và [`ExtensionInstallForcelist`](https://chromeenterprise.google/policies/extension-install-forcelist/) để cài extension theo policy. Trên Windows và macOS, force-install ngoài Chrome Web Store còn phụ thuộc máy đã được quản lý bằng AD/Azure AD/Chrome Enterprise Core hoặc MDM theo tài liệu Chrome. Vì vậy một file `.reg` trên máy cá nhân không được dự án quảng cáo như đường mở khóa phổ quát.

Managed build chỉ được phát hành khi có đủ:

1. manifest riêng với identity/update channel của fork;
2. programmatic filtering adapter dùng core parser/matcher được pin;
3. fallback DNR khi probe hoặc listener registration thất bại;
4. benchmark CPU/RAM và kiểm tra service-worker restart;
5. threat-model, privacy disclosure và hướng dẫn gỡ policy hoàn chỉnh.
