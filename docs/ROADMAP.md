# Roadmap cộng đồng

Roadmap dùng các nhóm **Now / Next / Later**, không hứa ngày phát hành. Mỗi mục chỉ chuyển trạng thái khi có owner, design, test và ngân sách hiệu năng.

## Now — nền tảng Power Edition

- Hoàn tất identity uBlock Plus+ và build sideload có checksum/provenance.
- Giữ parity MV3 hiện có: DNR, cosmetic filtering, packaged scriptlets, per-site modes, picker/zapper, custom/imported lists và backup/restore.
- Filter Store schema v1, catalog đóng gói, issue form, validator và trust badge `verified|community`.
- Memory profiles `auto|balanced|low-memory`, local telemetry và cleanup an toàn.
- Compile report công khai supported/rejected filter và DNR cost; không silent drop.
- Test browser/service-worker restart, state migration, quota failure và máy `<= 4 GiB`.

## Next — chất lượng và trải nghiệm cộng đồng

- Semantic-safe dedupe/merge/sharding với equivalence test và rollback.
- Filter Store search/category/language, diff review automation và quarantine workflow.
- Diagnostics cục bộ có redaction, matched-rule view và export do người dùng chủ động.
- Benchmark dashboard trong CI: cold start, idle memory, list compile peak, CSS cache và p95 update time.
- Accessibility/i18n, import conflict UX và cảnh báo list không được chứng thực.
- Upstream sync automation có human review cho compiler/security-sensitive conflicts.

## Later — capability tùy chọn sau RFC

- Managed Enterprise build/adapter và policy deployment guide.
- Native Companion/Power Mode proof-of-concept với versioned Native Messaging IPC.
- Nghiên cứu DNS-aware diagnostics/local proxy chỉ sau privacy/security/performance review.
- Federated catalog metadata chỉ khi có signature, provenance, revocation và UX trust rõ; không tải code.

## Không nằm trong roadmap

- tuyên bố tương thích MV2 100% khi Chrome MV3 không có API;
- bypass sandbox/quota bằng hack không được trình duyệt hỗ trợ;
- remote executable code, remote scriptlet hoặc plugin từ URL/Git repo;
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
- benchmark không vượt ngân sách đã duyệt. Mặc định, regression >10% về peak memory hoặc p95 runtime so với stable baseline phải được giải thích và chấp thuận rõ;
- artifact từ clean build có checksum/provenance và release note nêu giới hạn còn lại.

Con số benchmark là regression gate của dự án, không phải cam kết RAM tuyệt đối trên mọi browser/máy. Baseline phải ghi Chrome version, OS, RAM, list set và sample size.

## Dashboard công khai tối thiểu

Mỗi milestone nên công bố: số issue opened/closed, feature vote top, unsupported filter count, filter catalog changes, median/p95 benchmark, security advisory đã công khai và upstream commit đang theo. Không công bố browsing data hay telemetry người dùng.
