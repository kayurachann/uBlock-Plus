# Kiến trúc uBlock Plus+ Power Edition

> Trạng thái: tài liệu thiết kế. Một capability chỉ được coi là đã phát hành khi có implementation, test và release note tương ứng.

uBlock Plus+ là một fork độc lập, sideload-first, chạy trên Manifest V3. Sideload giúp dự án phát hành minh bạch ngoài Chrome Web Store, nhưng **không** làm mất quota Declarative Net Request (DNR), không khôi phục background page MV2 và không tự cấp `webRequestBlocking`.

## Nguyên tắc

1. Chặn bằng API công khai trước: DNR xử lý request mà không đánh thức service worker cho từng request.
2. Không tải hay thực thi mã từ xa. Filter list và catalog chỉ là dữ liệu; scriptlet/redirect resource phải được đóng gói, định danh và kiểm duyệt.
3. Quyền tăng dần theo capability. Tính năng cần quyền mạnh phải ở module/tầng riêng và cần đồng ý rõ ràng.
4. Trạng thái quan trọng phải lưu bền vững; service worker có thể bị Chrome dừng bất kỳ lúc nào.
5. Tối ưu RAM phải đo được, không đánh đổi bằng việc âm thầm tắt filter người dùng đã bật.
6. Không ghép rule nếu làm thay đổi priority, exception hoặc phạm vi domain.

## Ba tầng capability hợp pháp

| Tầng | Cách triển khai | Capability | Đồng ý và rủi ro |
| --- | --- | --- | --- |
| **Power Edition** | MV3 sideload/unpacked hoặc gói phát hành từ GitHub | DNR, cosmetic filtering, packaged scriptlets, Filter Store, custom/imported lists, per-site policy, picker/zapper, low-memory profile | Tầng mặc định. Vẫn chịu quota DNR, giới hạn regex và lifecycle service worker của Chrome. |
| **Managed Enterprise** *(tương lai, tùy chọn)* | Build/manifest riêng, cài bằng Chrome enterprise policy | Có thể dùng API chỉ dành cho extension policy-installed, nếu trình duyệt thực tế báo hỗ trợ; quản trị tập trung và policy cấu hình | Chỉ dành cho thiết bị do tổ chức quản lý. Admin phải triển khai policy; không giả mạo trạng thái managed. Quyền quan sát request rộng hơn nên cần audit và tài liệu vận hành riêng. |
| **Native Companion / Power Mode** *(R&D, tùy chọn)* | Native Messaging host mã nguồn mở, cài riêng; có thể cung cấp DNS/proxy cục bộ theo thiết kế đã duyệt | Có thể bổ sung DNS visibility, diagnostics hoặc enforcement ngoài phạm vi API extension | Không mặc định, không tự cài, không chạy ẩn khi chưa có consent. IPC phải versioned, allowlist command, xác thực peer và giới hạn dữ liệu. Một native process làm tăng attack surface và chi phí RAM. |

Enterprise/native là adapter bổ sung, không phải đường tắt để vô hiệu hóa sandbox, tải remote code hoặc vượt quota một cách không được Chrome hỗ trợ. Nếu capability probe thất bại, extension phải hạ cấp an toàn về Power Edition.

## Luồng build

1. Lấy source/filter từ nguồn được pin hoặc khai báo trong build input.
2. Parser chuẩn hóa filter, loại trùng và phân loại capability.
3. Compiler tạo static/dynamic DNR, cosmetic data và tham chiếu tới packaged scriptlet.
4. Validator kiểm tra schema, ID range, quota, regex, resource reference, permission và remote-code policy.
5. Build report công bố số filter đầu vào, số rule đầu ra, rule bị loại và lý do.
6. CI tạo artifact, checksum và provenance; phát hành chỉ từ commit/tag đã review.

## Tối ưu và ghép rule

Rule optimizer được phép:

- chuẩn hóa URL/domain và loại rule trùng hoàn toàn;
- gộp domain chỉ khi action, condition, priority và exception tương đương;
- shard ruleset theo nhóm ngôn ngữ/chủ đề để chỉ bật phần người dùng cần;
- ưu tiên static ruleset cho dữ liệu đóng gói, dynamic rules cho lựa chọn/import của người dùng;
- hỏi quota khả dụng tại runtime và đưa ra lỗi có thể hành động thay vì cắt rule im lặng;
- cập nhật rule theo namespace ID và giao dịch remove/add có thể phục hồi.

Optimizer không được đổi thứ tự allow/block, làm rộng domain, bỏ exception, hạ priority hoặc chuyển filter không biểu diễn được thành rule “gần giống”. Filter không hỗ trợ phải được báo là rejected/partial trong compile report.

## Luồng runtime

- DNR xử lý network filtering mà không cần service worker chạy cho mọi request.
- Service worker quản lý setting, ruleset, migration, catalog và update idempotent.
- Content script ở `document_start` xử lý cosmetic filtering và gọi scriptlet đã đóng gói.
- Offscreen document chỉ sống trong phiên compile cần DOM API; hoàn tất phải đóng.
- Imported list được compile cục bộ thành DNR/cosmetic data; không `eval`, không import JavaScript từ URL.
- Catalog Filter Store nằm tại `platform/mv3/extension/filter-store/catalog.json`, được đóng gói và chỉ đổi qua release đã review.

## Memory profiles

Setting bền vững `memoryProfile` có ba giá trị:

- `auto`: dùng `navigator.deviceMemory`; thiết bị báo `<= 4 GiB` chọn `low-memory`, còn lại chọn `balanced`. Nếu API không có, dùng `balanced`.
- `balanced`: ưu tiên độ trễ UI/compile hợp lý.
- `low-memory`: compile imported list tuần tự; hạ ngưỡng CSS session cache xuống low/high `64/72`; dọn generation/cache mồ côi và prune theo watermark với nhịp kiểm tra 5 phút.

Message API hiện có: `getMemoryProfile`, `setMemoryProfile`, `getMemoryTelemetry`, `runMemoryCleanup`. Số liệu storage chỉ lưu/hiển thị cục bộ và không phải phép đo heap/RSS. Low-memory không tự tắt ruleset hay filter; hiệu quả RAM thực tế vẫn cần benchmark trên máy 2–4 GiB trước khi đưa ra con số quảng bá.

## Ranh giới dữ liệu

```text
Packaged catalog/filter data ──> compiler ──> DNR + cosmetic cache
User-imported HTTPS list ──────> validator/compiler ──┘
                                             │
Page request ───────────────────────────────> Chrome DNR
DOM document ───────────────────────────────> packaged content scripts

Optional future:
Extension <── versioned Native Messaging IPC ──> local companion
```

Không đưa browsing history, nội dung trang hay telemetry ra khỏi máy. Khi một feature mới cần truyền dữ liệu, feature đó phải cập nhật [THREAT-MODEL.md](THREAT-MODEL.md) và [PRIVACY.md](PRIVACY.md) trước khi merge.

## Đồng bộ upstream và giấy phép

Fork giữ lịch sử, copyright, source header và license GPL-3.0-or-later của [uBlock Origin](https://github.com/gorhill/uBlock). Code cộng đồng phải tương thích GPL và không dùng identity, signing key hay release channel chính thức của upstream. uBlock Plus+ là dự án độc lập tại `kayurachann/uBlock-Plus`, không phải sản phẩm được Raymond Hill bảo trợ.
