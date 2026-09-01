# Filter Store và community filter repository

Filter Store của uBlock Plus+ là **catalog danh sách lọc**, không phải extension store, plugin store hay nơi chạy code từ repository bên ngoài. Catalog giúp người dùng tìm, đánh giá và bật filter phù hợp; mọi filter tải ở runtime vẫn đi qua parser/compiler nội bộ.

## Mô hình phân phối

```text
Maintainer/list author
        │ submission + license + source ownership
        v
GitHub issue/PR ──> automated validation ──> human review
        │                                      │
        └──────── reject/request changes <─────┘
                                               v
                                packaged catalog in release
                                               │
                                user explicitly enables entry
                                               v
                              HTTPS filter data → local compiler
```

Catalog chính thức nằm tại:

```text
platform/mv3/extension/filter-store/catalog.json
```

Catalog mặc định được đóng gói và chỉ cập nhật qua release của uBlock Plus+. Trong release đầu, toàn bộ entry mặc định được ghi nhãn trung thực là `community`; digest SHA-256 chỉ chứng minh đúng snapshot dữ liệu, không thay thế evidence quản trị để nâng trust tier. Power Edition cũng cho người dùng tự thêm tối đa 8 URL catalog JSON qua HTTPS. Catalog tùy chỉnh luôn bị hạ nhãn xuống `community`, phải qua schema/size/quota validation và không bao giờ cung cấp mã thực thi.

## Schema v1

Top-level:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-01T00:00:00Z",
  "entries": []
}
```

Mỗi entry bắt buộc có:

| Field | Kiểu | Quy tắc |
| --- | --- | --- |
| `id` | string | ID ổn định, chữ thường/kebab-case, không tái sử dụng sau khi xóa. |
| `title` | string | Tên hiển thị, không mạo danh dự án khác. |
| `description` | string | Mục tiêu và phạm vi ngắn gọn, không quảng cáo gây hiểu nhầm. |
| `category` | string | Nhóm catalog đã biết, ví dụ ads/privacy/annoyances/regional/security. |
| `languages` | string[] | BCP-47 hoặc `*` khi không phụ thuộc ngôn ngữ. |
| `sourceURLs` | string[] | Chỉ HTTPS; URL đầu tiên là primary source. |
| `homepage` | string | Trang chủ/repository công khai của list. |
| `license` | string | SPDX identifier hoặc mô tả/license URL đã review. |
| `trustTier` | string | Chỉ `verified` hoặc `community`. |

Ví dụ:

```json
{
  "id": "example-vietnamese-privacy",
  "title": "Example Vietnamese Privacy",
  "description": "Minh họa schema; không phải đề xuất catalog thực tế.",
  "category": "privacy",
  "languages": ["vi"],
  "sourceURLs": ["https://example.invalid/filters.txt"],
  "homepage": "https://example.invalid/project",
  "license": "GPL-3.0-or-later",
  "trustTier": "community"
}
```

Validator phải từ chối unknown field có ảnh hưởng bảo mật, ID/URL trùng, URL không HTTPS, mọi HTTP redirect và schema version không hỗ trợ. Catalog/source phải dùng URL HTTPS đích trực tiếp; entry được sắp xếp ổn định để diff có thể review.

## Trust tiers

### `verified`

Dự án đã kiểm tra tối thiểu:

- nguồn và danh tính maintainer có thể xác minh;
- license/quyền phân phối hoặc quyền tham chiếu;
- lịch sử duy trì và kênh báo lỗi;
- compiler report, false-positive sample và security lint;
- không có remote executable code hoặc chỉ dẫn tải code;
- thay đổi capability cao đã có hai reviewer độc lập.

`verified` không có nghĩa list hoàn hảo, không có false positive hoặc được uBlock Origin chứng thực.

### `community`

Entry vượt qua schema, HTTPS, compile và kiểm tra an toàn cơ bản nhưng chưa được uBlock Plus+ chứng thực đầy đủ về chủ sở hữu/chất lượng. UI phải hiển thị nhãn và cảnh báo rõ. Lựa chọn bật luôn thuộc về người dùng.

Trust tier không được nâng chỉ vì nhiều lượt vote; phải có evidence và review record.

## Risk classes khi review

| Class | Ví dụ | Yêu cầu |
| --- | --- | --- |
| L0 | block network/cosmetic selector phạm vi hẹp | Automated lint + một reviewer catalog. |
| L1 | allow rule, broad domain, header/CSP, redirect tới packaged resource | Test precedence/false positive + reviewer có quyền security/filter. |
| L2 | procedural cosmetic hoặc packaged scriptlet invocation | Hai reviewer; xác nhận scriptlet nằm trong allowlist và không nhận code từ filter. |
| Reject | remote JavaScript, `eval`, data URL code, credential collection, bypass security control, obfuscated payload | Không nhận vào catalog. Báo security nếu có dấu hiệu độc hại. |

## Quy trình duyệt entry mới

1. Tác giả mở **Filter Store submission** và cung cấp mọi field schema, ví dụ site bị ảnh hưởng, license và cách liên hệ.
2. Bot/CI fetch trong môi trường cô lập với timeout, giới hạn kích thước, redirect count và content type.
3. Chuẩn hóa và compile bằng cùng compiler dùng trong release.
4. Xuất report: tổng filter, supported/rejected, regex/DNR cost, duplicate ratio, cosmetic/scriptlet capability và thời gian/bộ nhớ compile.
5. Reviewer kiểm tra nguồn, license, scope, false positive, anti-adblock breakage và risk class.
6. Entry mới bắt đầu ở `community`. Nâng lên `verified` qua PR riêng kèm evidence.
7. Merge catalog không tự phát hành ngay; entry đến người dùng trong release kế tiếp và được ghi trong release notes.

Không đặt SLA cứng cho volunteer. Security removal được ưu tiên; submission thông thường được xử lý theo khả năng maintainer.

## Update, rollback và revocation

- URL primary có thể đổi nội dung; mỗi lần CI/release phải compile snapshot mới và so diff thống kê với bản trước.
- Biến động lớn về số allow rule, scriptlet, regex hoặc domain phải chặn tự động để review thủ công.
- Source takeover, malware hoặc license withdrawal dẫn đến quarantine/removal và security release; cache liên quan phải có đường invalidate.
- Rollback dùng catalog/ruleset của release tốt gần nhất, không tải một catalog “hotfix” chưa ký từ server.
- Nếu entry bị gỡ, UI phải giải thích. Không âm thầm thay list khác có semantics khác.
- Người dùng vẫn có thể import URL riêng ngoài catalog, nhưng nhận cảnh báo và entry đó không mang trust badge.

## Bật/tắt và dữ liệu cục bộ

Khi người dùng bật entry, runtime dùng `installation.sourceURL` làm nguồn chính và compile như imported list. Nguồn pinned có SHA-256 được kiểm lại trong compiler; chỉ sau khi compile và cập nhật DNR thành công UI mới ghi nhận digest đã kích hoạt. Digest khớp không tự nâng entry lên `verified`. Mỗi import từ Filter Store có ngân sách tối đa 5 MiB/list, tối đa 32 lần fetch/include và ngân sách batch 15 MiB. Khi tắt, metadata imported được giữ để người dùng có thể bật lại, còn compiled cache được giải phóng theo chính sách hiện hành. Filter Store không gửi danh sách site người dùng truy cập cho maintainer catalog.

## License và attribution

Metadata/catalog do cộng đồng đóng góp được phân phối theo GPL-3.0-or-later cùng repository. Mỗi filter list bên ngoài giữ license và copyright riêng; việc xuất hiện trong catalog không đổi license của list và không ngụ ý uBlock Origin/Raymond Hill chứng thực. Nội dung bắt nguồn từ upstream phải giữ attribution và lịch sử tương ứng.
