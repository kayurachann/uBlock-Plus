# Bảng tương thích uBlock Origin MV2 → uBlock Plus+ MV3

Đây là bản đồ capability, **không phải lời hứa parity 100%**. Chrome MV3 buộc extension công khai dùng Declarative Net Request cho phần lớn tác vụ chặn; sideload không gỡ quota DNR và không biến service worker thành background page MV2.

Ký hiệu: **Có** = MV3 có đường triển khai tương đương hữu ích; **Một phần** = semantics/quota khác MV2; **Không** = Chrome MV3 không có API tương đương; **R&D** = chỉ xem xét ở tầng enterprise/native tùy chọn.

| Capability | uBO MV2 | Power Edition MV3 | Enterprise/native tương lai | Ghi chú trung thực |
| --- | --- | --- | --- | --- |
| Static network blocking | Có | **Có**, static DNR | Không cần | Compile ở build-time; chịu quota ruleset/rule của trình duyệt. |
| Custom/imported network lists | Có | **Có**, dynamic DNR | Có thể bổ sung compiler native | Filter không biểu diễn được phải được báo, không cắt im lặng. |
| Per-site filtering mode | Có | **Có** | Không cần | Persist setting và sinh rule theo namespace. |
| Dynamic firewall matrix | Có, quyết định runtime | **Một phần** | Managed adapter có thể mở rộng | MV3 cần khai báo rule trước request; không có quyết định đồng bộ tùy ý như MV2. |
| Cosmetic filtering | Có | **Có** | Không cần | CSS/content script đăng ký theo site/ruleset. |
| Procedural cosmetic filter | Có | **Một phần** | Native không giúp DOM trực tiếp | Chỉ hỗ trợ operator an toàn có trong packaged code. |
| Scriptlets | Có | **Một phần** | Không tải scriptlet qua companion | Chỉ scriptlet đóng gói/allowlist; cấm remote executable code. |
| Element picker/zapper | Có | **Có** | Không cần | Filter tạo ra được lưu cục bộ. |
| Strict/popup blocking | Có | **Có/Một phần** | Có thể bổ sung policy | Smart Popup Blocker dùng opener, target, trusted gesture, burst và policy exact-host `Allow/Smart/Strict`; filter popup đóng gói vẫn được ưu tiên fail-closed. `$popup`/`$popunder` từ list import được phân loại và báo cáo nhưng chưa nối vào matcher runtime. |
| Redirect resource | Có | **Một phần** | Không cần | Chỉ redirect tới resource đóng gói/được manifest cho phép. |
| Request/response header rules | Có | **Một phần** | Managed mode có thể mở rộng | DNR `modifyHeaders` không tương đương mọi thao tác `webRequestBlocking`. |
| Full live request logger | Có | **Một phần** | **R&D** qua managed/native diagnostics | DNR feedback bị giới hạn; không được bật giám sát rộng mặc định. |
| Response body/HTML rewriting | Có trên engine hỗ trợ | **Không** | **R&D** qua local proxy, rủi ro cao | DNR không sửa arbitrary response body. Managed `webRequestBlocking` cũng không tự cung cấp body rewrite. |
| CNAME uncloaking/DNS resolution | Có trên engine hỗ trợ | **Không** | **R&D** qua DNS-aware companion | Chrome extension không có đường DNS tương đương. |
| Chặn media theo kích thước response | Có | **Không tương đương chính xác** | **R&D** qua proxy | DNR quyết định trước khi có đủ thông tin response. |
| Backup/restore | Có | **Có** | Có thể export policy riêng | Không bao gồm secret/native config nếu chưa có schema mã hóa. |
| Internationalization | Có | **Có** | Không cần | 10 locale ưu tiên có toàn bộ chuỗi Power; 61 locale còn lại dùng English fallback build-time thay cho control trống. |
| Filter Store/catalog | Không phải core store | **MVP có** | Không cần | Catalog đóng gói và tối đa 8 catalog HTTPS do người dùng thêm; filter là dữ liệu, không phải plugin/code store. |
| Low-memory profile | Tối ưu runtime MV2 | **MVP có** | Companion có budget riêng | Compile tuần tự, cache có ngân sách và số liệu storage cục bộ; chưa có benchmark heap/RSS trên máy 2–4 GiB. |

## Những điều sideload không thay đổi

- quota static/dynamic/session/regex do Chrome áp đặt;
- service worker có thể bị dừng khi idle;
- API DNR chỉ biểu diễn được một tập con semantics của engine MV2;
- extension MV3 bình thường không được dùng blocking `webRequest`; capability policy-installed chỉ có hiệu lực khi trình duyệt thực sự quản lý extension bằng enterprise policy;
- remote JavaScript/remote executable code vẫn bị dự án cấm vì an toàn supply chain.

Quota thay đổi theo phiên bản Chrome, vì vậy compiler phải đọc capability/quota khi có API và CI phải kiểm tra trên browser được hỗ trợ. Nguồn tham khảo: [Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), [migrate blocking web requests](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests), [extension service workers](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers) và [uBO Lite FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ)).

## Release gate

Một ô “Có” chỉ được đánh dấu shipped trong release note khi có:

1. test chức năng và test regression;
2. compile report không có silent drop;
3. đo RAM/CPU trên profile máy yếu;
4. permission và threat-model review;
5. tài liệu fallback khi quota/API không đủ.
