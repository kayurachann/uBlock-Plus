# Kiến trúc uBlock Plus+ Power Edition

> Trạng thái: tài liệu thiết kế. Một capability chỉ được coi là đã phát hành khi có implementation, test và release note tương ứng.

uBlock Plus+ là một fork độc lập, sideload-first, chạy trên Manifest V3. Sideload giúp dự án phát hành minh bạch ngoài Chrome Web Store, nhưng **không** làm mất quota Declarative Net Request (DNR), không khôi phục background page MV2 và không tự cấp `webRequestBlocking`.

## Nguyên tắc

1. Chặn bằng API công khai trước: DNR xử lý request mà không đánh thức service worker cho từng request.
2. Không tải hay thực thi mã từ xa. [MV3 remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) yêu cầu extension logic self-contained và định nghĩa JavaScript/Wasm ngoài package được browser thực thi là remotely hosted code. Dự án không dùng các API exception hẹp để phân phối remote project code. Filter list và catalog từ HTTPS vẫn là dữ liệu hostile; scriptlet/redirect resource/matcher phải được đóng gói, định danh và kiểm duyệt.
3. Quyền tăng dần theo capability. Tính năng cần quyền mạnh phải ở module/tầng riêng và cần đồng ý rõ ràng.
4. Trạng thái quan trọng phải lưu bền vững. [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) cho phép worker ngủ sau idle và chấm dứt task dài; global variables không phải source of truth.
5. Tối ưu RAM phải đo được, không đánh đổi bằng việc âm thầm tắt filter người dùng đã bật.
6. Không ghép rule nếu làm thay đổi priority, exception hoặc phạm vi domain.

## Bốn tầng capability không hoán đổi

| Tầng | Cách triển khai | Capability | Đồng ý và rủi ro |
| --- | --- | --- | --- |
| **Power Edition** | MV3 sideload/unpacked hoặc gói phát hành từ GitHub | DNR, cosmetic filtering, packaged scriptlets, compiled popup observer, Filter Store, custom/imported lists, per-site policy, picker/zapper, low-memory profile | Tầng mặc định. Vẫn chịu quota DNR, giới hạn regex và lifecycle service worker của Chrome. |
| **Managed Enterprise** *(tương lai, tùy chọn)* | Build/manifest riêng, cài bằng Chrome enterprise policy | Có thể dùng API chỉ dành cho extension policy-installed, nếu trình duyệt thực tế báo hỗ trợ; quản trị tập trung và policy cấu hình | Chỉ dành cho thiết bị do tổ chức quản lý. Admin phải triển khai policy; không giả mạo trạng thái managed. Quyền quan sát request rộng hơn nên cần audit và tài liệu vận hành riêng. |
| **Native Companion / Power Mode** *(R&D, tùy chọn)* | Native Messaging host mã nguồn mở, cài riêng; có thể cung cấp DNS/proxy cục bộ theo thiết kế đã duyệt | Có thể bổ sung DNS visibility, diagnostics hoặc enforcement ngoài phạm vi API extension | Không mặc định, không tự cài, không chạy ẩn khi chưa có consent. IPC phải versioned, allowlist command, xác thực peer và giới hạn dữ liệu. Một native process làm tăng attack surface và chi phí RAM. |
| **Custom Chromium** *(R&D, tùy chọn)* | Browser build/patch riêng, cài và cập nhật độc lập | Chỉ capability được patch và test trong browser đó | Không phải Native Companion hay Managed Enterprise. Cần profile/support matrix riêng; không gán capability cho Google Chrome và không tắt sandbox/Site Isolation/Safe Browsing. |

Managed/native/custom-browser là ba hướng bổ sung khác nhau, không phải đường tắt để vô hiệu hóa sandbox, tải remote code hoặc vượt quota một cách không được Chrome hỗ trợ. Nếu capability probe hoặc adapter registration thất bại, extension phải hạ cấp an toàn về Power Edition.

Capability probe và phạm vi các browser flag/policy được định nghĩa tại [POWER-RUNTIME.md](POWER-RUNTIME.md). Runtime chỉ báo một engine là `eligible`; việc kích hoạt còn yêu cầu adapter tương ứng đã được đóng gói và đăng ký thành công.

## Luồng build

1. Lấy source/filter từ nguồn được pin hoặc khai báo trong build input.
2. Parser chuẩn hóa filter, loại trùng và phân loại capability.
3. Compiler tạo static/dynamic DNR, cosmetic data và tham chiếu tới packaged scriptlet.
4. Build stock tạo corpus typed bất biến `rulesets/popup/<rulesetId>.json`; compiler sandbox/imported tạo route generation-scoped. Condition subset hỗ trợ dùng `popup-observer-runtime`, condition chưa hỗ trợ giữ `popup-compiler-required` cùng reason cụ thể. Stock DNR export hiện chỉ bảo toàn kind `$popup`; `$popunder` được ghi `omitted`, không đổi nhãn.
5. Validator kiểm tra schema, ID range, quota, regex, resource reference, permission, route/condition consistency và remote-code policy.
6. Build report công bố số filter đầu vào, số rule đầu ra, route runtime/deferred, rule bị loại và lý do.
7. CI tạo artifact, checksum và provenance; phát hành chỉ từ commit/tag đã review.

## Tối ưu và ghép rule

Rule optimizer được phép:

- chuẩn hóa URL/domain và loại rule trùng hoàn toàn;
- gộp domain chỉ khi action, condition, priority và exception tương đương;
- shard ruleset theo nhóm ngôn ngữ/chủ đề để chỉ bật phần người dùng cần;
- ưu tiên static ruleset cho dữ liệu đóng gói, dynamic rules cho lựa chọn/import của người dùng;
- budget quota theo [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest): static tách khỏi runtime; số rule dynamic/session có giới hạn riêng nhưng regex dynamic + session dùng chung pool tối đa 1.000, còn enabled static rulesets có aggregate pool 1.000 riêng, theo [Chromium CL 4903267](https://chromium.googlesource.com/chromium/src/+/eab7fc99e59b69e929d02e43bdcf8bbd75333869%5E%21/);
- hỏi quota khả dụng tại runtime và đưa ra lỗi có thể hành động thay vì cắt rule im lặng;
- cập nhật rule theo namespace ID và giao dịch remove/add có thể phục hồi.

Optimizer không được đổi thứ tự allow/block, làm rộng domain, bỏ exception, hạ priority hoặc chuyển filter không biểu diễn được thành rule “gần giống”. Filter không hỗ trợ phải được báo là deferred/rejected/partial trong compile report theo đúng output còn dùng được.

## Luồng runtime

- DNR xử lý network filtering mà không cần service worker chạy cho mọi request.
- Service worker quản lý setting, ruleset, migration, catalog và update idempotent; listener ở top level, state/generation/checkpoint được persist để wake/restart không dựa vào global memory cũ.
- Content script ở `document_start` xử lý cosmetic filtering và gọi scriptlet đã đóng gói.
- Offscreen document chỉ sống trong phiên compile cần DOM API; hoàn tất phải đóng.
- Imported list được compile cục bộ thành DNR/cosmetic data; không `eval`, không import JavaScript từ URL.
- Catalog Filter Store nằm tại `platform/mv3/extension/filter-store/catalog.json`, được đóng gói và chỉ đổi qua release đã review.
- Cache/report giữ cả kết quả runtime và deferred. Immutable active generation materialize route exact `popup-observer-runtime` cùng **deferred allow guard** tối thiểu từ `popup-compiler-required`; deferred block chỉ ở metadata. Guard không được phép allow/block: matcher bỏ predicate chưa biểu diễn theo hướng superset, và nếu phần còn lại có thể match thì trả `defer` trước block thường/heuristic để không làm mất exception. Observer nạp lazy generation sandbox/imported và chỉ các corpus stock đang bật sau service-worker wake.
- Popup condition cần initiator chỉ match khi context được đánh dấu complete. Popunder mất full original-opener context qua restart phải fail open để tránh broad false positive.
- Opener root/source frame được snapshot trước khi chờ gesture; `about:blank`/`about:srcdoc` leo parent, `blob:` giữ embedded origin và origin mơ hồ phải pending. No-filtering ở opener hoặc tab sắp đóng luôn thắng observer.
- Matcher cache validation/regex theo object bất biến và có aggregate budget. Regex unbounded không neo đầu bị deferred; URL quá dài giữ canonical origin để broad/domain rule không bị bypass, còn path matcher pending thay vì dùng chuỗi cắt cụt.

Một input filter kết hợp có thể sinh DNR resource rule và typed popup route nhưng chỉ tính một input accepted. Popup-only supported vẫn accepted dù không sinh DNR; popup-only unsupported là deferred/rejected, còn phần DNR hợp lệ của filter kết hợp vẫn có thể accepted. Chi tiết và nguồn upstream nằm tại [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md).

## Memory profiles

Setting bền vững `memoryProfile` có ba giá trị:

- `auto`: dùng `navigator.deviceMemory`; thiết bị báo `<= 4 GiB` chọn `low-memory`, còn lại chọn `balanced`. Nếu API không có, dùng `balanced`.
- `balanced`: ưu tiên độ trễ UI/compile hợp lý.
- `low-memory`: compile imported list tuần tự; hạ ngưỡng CSS session cache xuống low/high `64/72`; dọn generation/cache mồ côi và prune theo watermark với nhịp kiểm tra 5 phút.

Message API hiện có: `getMemoryProfile`, `setMemoryProfile`, `getMemoryTelemetry`, `runMemoryCleanup`. Số liệu storage chỉ lưu/hiển thị cục bộ và không phải phép đo heap/RSS. Low-memory không tự tắt ruleset hay filter; hiệu quả RAM thực tế vẫn cần benchmark trên máy 2–4 GiB trước khi đưa ra con số quảng bá.

## Ranh giới dữ liệu

```text
Packaged catalog/filter data ──> compiler ──> static DNR + cosmetic cache
User-imported HTTPS list ──────> validator/compiler ──> dynamic DNR
                                             └───────> typed popup data
Page request ───────────────────────────────> Chrome DNR
Popup/tab events ──> service worker observer ───────> stock + generation typed popup matcher
DOM document ───────────────────────────────> packaged content scripts

Optional future:
Extension <── versioned Native Messaging IPC ──> local companion
Custom Chromium artifact ──────────────────────> separately patched browser
```

Không đưa browsing history, nội dung trang hay telemetry ra khỏi máy. Khi một feature mới cần truyền dữ liệu, feature đó phải cập nhật [THREAT-MODEL.md](THREAT-MODEL.md) và [PRIVACY.md](PRIVACY.md) trước khi merge.

## Đồng bộ upstream và giấy phép

Fork giữ lịch sử, copyright, source header và license GPL-3.0-or-later của [uBlock Origin](https://github.com/gorhill/uBlock). Code cộng đồng phải tương thích GPL và không dùng identity, signing key hay release channel chính thức của upstream. uBlock Plus+ là dự án độc lập tại `kayurachann/uBlock-Plus`, không phải sản phẩm được Raymond Hill bảo trợ.
