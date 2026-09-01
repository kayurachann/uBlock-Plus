# Quản trị cộng đồng uBlock Plus+

Mục tiêu quản trị là tiếp nhận yêu cầu đa dạng mà vẫn giữ privacy, hiệu năng máy yếu, khả năng review và tương thích GPL/upstream. Số vote là tín hiệu quan trọng, không phải quyền ghi đè security/API constraint.

## Mô hình repository

- `kayurachann/uBlock-Plus` là repository chính của fork.
- Remote upstream uBlock Origin được giữ để lấy parser/security fix và giữ lịch sử attribution.
- Filter Store dùng catalog đóng gói trong repository; filter list bên ngoài ở repository của maintainer riêng.
- Experimental code nằm trong branch/PR của fork, không được extension tải trực tiếp từ “community repo”.
- Không có cơ chế cài plugin/code tùy ý từ Git URL. Extension point phải là data schema hoặc registry code đã build/review.

## Vai trò

| Vai trò | Trách nhiệm | Không tự động có quyền |
| --- | --- | --- |
| User/community member | Báo lỗi, đề xuất, test, vote | Merge/release hoặc gắn trust badge. |
| Contributor | Code/docs/filter metadata theo GPL, test thay đổi | Bypass review/security gate. |
| Triage member | Phân loại, yêu cầu reproduction, deduplicate | Chấp nhận kiến trúc/release. |
| Filter reviewer | Review schema, semantics, false positive và list provenance | Release core code nếu không có quyền tương ứng. |
| Module maintainer | Review module được giao, giữ test/budget | Tự mở rộng permission hoặc native protocol. |
| Security/release maintainer | Advisory, release gate, key/provenance | Merge một mình thay đổi do chính mình viết ở vùng critical, trừ emergency có audit sau. |

Quyền được cấp theo lịch sử đóng góp, review chất lượng và principle of least privilege; được thu hồi khi không còn hoạt động hoặc có rủi ro tài khoản.

## Vòng đời feature request

```text
idea → triaged → needs-evidence/RFC → accepted → planned
     └→ duplicate/declined                    └→ in-progress → beta → shipped
```

Một đề xuất hợp lệ cần nêu user problem, browser/version, workflow hiện tại, lợi ích, privacy/permission, ảnh hưởng RAM/CPU, MV3 feasibility và acceptance criteria. “Làm y hệt MV2” không đủ nếu thiếu mapping API.

Thay đổi permission, storage schema, compiler semantics, Filter Store trust, enterprise/native hoặc >10% memory regression cần RFC trong issue/PR và cập nhật tài liệu liên quan.

## Vote và xếp ưu tiên

- Vote dùng reaction 👍 trên issue canonical; comment “+1” bị dọn để giữ thảo luận hữu ích.
- Vote của tài khoản không quyết định trust tier, security exception hay GPL/license.
- Maintainer công bố lý do khi ưu tiên khác số vote.
- Duplicate được liên kết về issue canonical để cộng tín hiệu, không chia phiếu.
- Không trả tiền/mua vote, spam hoặc vận động bằng thông tin sai.

Điểm triage tham khảo (0–5 mỗi mục): user impact, số nhóm người dùng, MV3 feasibility, privacy benefit, accessibility và upstream compatibility; trừ security risk, RAM/CPU cost, permission cost và maintenance burden. Điểm chỉ giúp sắp hàng, không thay review kỹ thuật.

## Quyết định

- Thay đổi nhỏ: một maintainer module duyệt sau CI.
- Thay đổi capability/security/catalog risk L1+: tối thiểu hai reviewer phù hợp.
- RFC thông thường mở thảo luận công khai đủ lâu để các múi giờ tham gia; mục tiêu 7 ngày, kiến trúc lớn 14 ngày.
- Security emergency có thể merge nhanh bởi release/security maintainer, sau đó phải có public audit/postmortem khi an toàn.
- Khi không đồng thuận, maintainer ghi decision record gồm lựa chọn, evidence, trade-off và cách xem xét lại.

## Feature acceptance gates

Không merge feature mới nếu thiếu:

1. owner/module boundary và kế hoạch bảo trì;
2. test positive/negative, migration/rollback;
3. memory/CPU benchmark trên profile máy yếu nếu tác động runtime;
4. permission/privacy/threat-model review;
5. UI/accessibility/i18n khi có giao diện;
6. mapping FEATURE-MATRIX, không quảng cáo capability MV2 mà MV3 không thể cung cấp;
7. GPL-compatible contribution và attribution upstream/third party.

## Filter governance

Submission/catalog review theo [FILTER-STORE.md](FILTER-STORE.md). Maintainer của filter chịu trách nhiệm nội dung và kênh báo lỗi. uBlock Plus+ có thể quarantine/remove entry vì compromise, abandon, license conflict, abuse, excessive breakage hoặc resource cost. Quyết định phải kèm evidence và đường appeal, trừ khi công khai chi tiết sẽ làm tăng rủi ro trước khi vá.

## License và attribution

Project dùng GPL-3.0-or-later. Trừ khi có thỏa thuận khác được công bố trước, contribution được cấp phép theo cùng license (inbound = outbound). Không xóa copyright/source header/historical attribution. Tên uBlock Plus+ không được dùng để ngụ ý đây là release chính thức của uBlock Origin hay được Raymond Hill bảo trợ.

## Hành xử và xung đột

Thảo luận tập trung vào evidence, reproduction và trade-off; không công kích, quấy rối hoặc công bố dữ liệu riêng tư. Người có conflict of interest với một list/vendor phải khai báo và không làm reviewer quyết định duy nhất. Appeal được mở bằng issue governance, dẫn tới reviewer không tham gia quyết định ban đầu khi có thể.
