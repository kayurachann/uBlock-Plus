# Roadmap cộng đồng

Roadmap dùng các nhóm **Now / Next / Later**, không hứa ngày phát hành. Mỗi mục chỉ chuyển trạng thái khi có owner, design, test và ngân sách hiệu năng.

Thứ tự ưu tiên được cập nhật ngày 2026-09-06 qua [rà soát với uBlock Origin đầy đủ, AdGuard và Brave](MV3-CAPABILITY-AUDIT-2026-09-06.md), bổ sung hồ sơ [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md). Issue upstream là tín hiệu thiết kế, không tự động trở thành cam kết của fork.

## Now — nền tảng Power Edition

- Hoàn tất identity uBlock Plus+ và build sideload có checksum/provenance.
- Giữ parity MV3 hiện có: DNR, cosmetic filtering, packaged scriptlets, per-site modes, picker/zapper, custom/imported lists và backup/restore.
- Filter Store schema v1, catalog đóng gói, issue form, validator, trust badge `verified|community` và tìm kiếm/lọc category/language.
- Memory profiles `auto|balanced|low-memory`, local telemetry và cleanup an toàn.
- Compiler phát mã lý do ổn định và số dòng cho network filter import bị từ chối/deferred; dashboard chi tiết và export báo cáo vẫn cần hoàn thiện.
- Smart Popup Blocker theo opener/target/trusted gesture/burst, policy exact-host `Allow|Smart|Strict`, chẩn đoán đã redaction và backup/restore policy.
- Compiled popup observer cho corpus stock `$popup` đóng gói và subset sandbox/imported `$popup`/`$popunder` đã classifier chấp nhận. Supported popup-only là accepted+routed dù không có DNR; unsupported condition giữ typed route `popup-compiler-required` với status `deferred`. Deferred allow có guard superset fail-open để không làm mất exception; context/budget không đầy đủ cũng fail open. Stock `$popunder` vẫn được ghi `omitted` vì DNR export không bảo toàn kind.
- Budget static riêng với runtime DNR; regex dynamic + session dùng pool chung. Đã có test browser/service-worker restart, immutable generation và quota failure; benchmark trên máy `<= 4 GiB` còn ở Next.

## Next — chất lượng và trải nghiệm cộng đồng

- Chẩn đoán ánh xạ từ DNR về list/dòng nguồn, mở rộng matched-rule view hiện có; phân biệt kết quả browser xác nhận với mô phỏng, có redaction và export do người dùng chủ động.
- Quota preview đối chiếu browser trước khi bật/cập nhật list: static, dynamic, session và shared dynamic+session regex; phân biệt estimate/compiled/active và giữ last-known-good khi cập nhật bị từ chối.
- `$badfilter` chính xác qua source map, kể cả rule gộp và nhiều list; không vô hiệu hóa phần không liên quan để thay cho việc chưa hỗ trợ.
- Ngoại lệ tạm theo URL/resource type/tab bằng session DNR, có preview/Undo và dọn metadata khi đóng tab hoặc kết thúc phiên; không dùng allow rộng thay ngữ nghĩa `noop` của uBO.
- Semantic-safe dedupe/merge/sharding với equivalence test và rollback.
- Filter Store diff review, lịch sử/độ mới nguồn, automation và quarantine workflow.
- Parse stock popup/popunder trực tiếp từ source compiler để bảo toàn kind `$popunder`, không phụ thuộc DNR export lossy.
- Mở rộng popup condition subset chỉ sau equivalence/false-positive/performance test; thêm diagnostics cho initiator/top/target completeness, budget exhaustion và deferred reason theo source line.
- Benchmark dashboard trong CI: cold start, idle memory, list compile peak, CSS cache và p95 update time; bộ so sánh ngữ nghĩa với uBO/AdGuard/Brave trên tập cú pháp chung.
- Khôi phục backup có journal/tiến độ cấp toàn profile; restore hiện tại vẫn tuần tự, chưa nguyên tử trên mọi thành phần.
- Accessibility/i18n, import conflict UX và cảnh báo list không được chứng thực.
- Upstream sync automation có human review cho compiler/security-sensitive conflicts.

## Later — capability tùy chọn sau RFC

- Managed Enterprise build/adapter và policy deployment guide.
- Native Companion/Power Mode proof-of-concept với versioned Native Messaging IPC.
- Custom Chromium RFC/artifact riêng với patch audit, profile riêng và support matrix; không dùng custom capability để quảng cáo Google Chrome build.
- Nghiên cứu DNS-aware diagnostics/local proxy chỉ sau privacy/security/performance review.
- Federated catalog metadata chỉ khi có signature, provenance, revocation và UX trust rõ; không tải code.

## Không nằm trong roadmap

- tuyên bố tương thích MV2 100% khi Chrome MV3 không có API;
- bypass sandbox/quota bằng hack không được trình duyệt hỗ trợ;
- remote executable JavaScript/Wasm, remote scriptlet/module hoặc plugin từ URL/Git repo; filter/catalog HTTPS chỉ được xử lý như data, không được thực thi;
- telemetry/browsing-history upload mặc định;
- native companion tự cài/chạy mà không có consent;
- tăng feature bằng cách âm thầm tắt filter trên máy yếu.

## Cách một đề xuất vào roadmap

1. Mở Feature request theo template và gom duplicate/vote ở issue canonical.
2. Triage xác nhận problem, MV3 capability, privacy/permission và nhóm người dùng.
3. Với thay đổi lớn, viết RFC + prototype/benchmark; không dùng vote thay technical evidence.
4. Maintainer chấm impact/feasibility/risk/cost và ghi quyết định công khai.
5. Gắn owner, milestone và acceptance criteria; nếu mất owner hoặc premise thay đổi, mục có thể quay lại backlog.

## Definition of done

Một mục chỉ được ghi **shipped** khi:

- code, docs, tests và migration/rollback đã merge;
- security/privacy/license review qua;
- không còn silent degradation; fallback/error có thể hiểu;
- test service-worker eviction và popup context loss chứng minh incomplete context fail open, không làm rộng block;
- benchmark không vượt ngân sách đã duyệt. Mặc định, regression >10% về peak memory hoặc p95 runtime so với stable baseline phải được giải thích và chấp thuận rõ;
- artifact từ clean build có checksum/provenance và release note nêu giới hạn còn lại.

Con số benchmark là regression gate của dự án, không phải cam kết RAM tuyệt đối trên mọi browser/máy. Baseline phải ghi Chrome version, OS, RAM, list set và sample size.

## Dashboard công khai tối thiểu

Mỗi milestone nên công bố: số issue opened/closed, feature vote top, unsupported filter count, filter catalog changes, median/p95 benchmark, security advisory đã công khai và upstream commit đang theo. Không công bố browsing data hay telemetry người dùng.
