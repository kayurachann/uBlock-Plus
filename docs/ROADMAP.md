# Roadmap cộng đồng

Roadmap dùng các nhóm **Now / Next / Later**, không hứa ngày phát hành. Mỗi mục chỉ chuyển trạng thái khi có owner, design, test và ngân sách hiệu năng.

Thứ tự ưu tiên được cập nhật ngày 2026-09-06 qua [rà soát với uBlock Origin đầy đủ, AdGuard và Brave](MV3-CAPABILITY-AUDIT-2026-09-06.md), bổ sung hồ sơ [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md). Issue upstream là tín hiệu thiết kế, không tự động trở thành cam kết của fork.

Ngày 2026-09-24, [nghiên cứu gỡ giới hạn MV3](MV3-LIMITS-RESEARCH-2026-09-24.md) phân loại 41 giới hạn so với uBO đầy đủ và đề xuất lộ trình 11 bước. Kết luận: Google Chrome không thể chạy mà không còn giới hạn nào, nhưng phần lớn khoảng trống thu hẹp được, trước ở bản Standard, sau đó ở bản Experimental; gỡ hết giới hạn chỉ có thể trên Firefox. **Bước 1 (báo cáo trung thực và sửa compiler) đã xong.** Các bước sau được xếp vào Next/Later bên dưới, vẫn theo quy tắc owner/design/test/ngân sách.

## Now — nền tảng Power Edition

- Hoàn tất identity uBlock Plus+ và build sideload có checksum/provenance.
- Giữ parity MV3 hiện có: DNR, cosmetic filtering, packaged scriptlets, per-site modes, picker/zapper, custom/imported lists và backup/restore.
- Filter Store schema v1, catalog đóng gói, issue form, validator, trust badge `verified|community` và tìm kiếm/lọc category/language.
- Memory profiles `auto|balanced|low-memory`, local telemetry và cleanup an toàn.
- [Bảng tra firewall và công cụ thử bản nháp](GITHUB-UPGRADES-2026-09-06.md): giải thích ô thắng, 1p/3p và Off theo yêu cầu; cùng evaluator cho compiler và lớp chặn tùy chọn. Không theo dõi nền hoặc gửi request thử ra mạng.
- Compiler phát mã lý do ổn định và số dòng cho network filter import bị từ chối/deferred. Build stock cũng đếm filter không chuyển được sang DNR theo lý do trong `log.txt` và `ruleset-details.json`, và validator từ chối gói có số báo cáo sai; trước đây build ghi `Unsupported: 0` trong khi hơn một nghìn filter bị bỏ. Tooltip của mỗi list stock hiện số filter đã chuyển và số filter bị từ chối (gồm cả filter không hợp lệ mà uBO cổ điển cũng từ chối); dashboard chi tiết theo lý do và export báo cáo vẫn cần hoàn thiện.
- Hai compiler khớp nhau ở `$empty`, `$mp4`, bare `$removeparam` và resource redirect. Các mã lý do dùng chung được viết giống nhau (ví dụ `unsupported-redirect-rule`, `unsupported-requestheader`), nhưng domain và header vẫn khác mã. Runtime từ chối `$requestheader`, `@@…$uritransform` và ngoại lệ redirect thay vì sinh rule rộng hơn. `##^responseheader()` stock áp cho response của chính hostname trong filter và tôn trọng ngoại lệ.
- Smart Popup Blocker theo opener/target/trusted gesture/burst, policy exact-host `Allow|Smart|Strict`, chẩn đoán đã redaction và backup/restore policy.
- Compiled popup observer cho corpus stock `$popup` đóng gói và subset sandbox/imported `$popup`/`$popunder` đã classifier chấp nhận. Supported popup-only là accepted+routed dù không có DNR; unsupported condition giữ typed route `popup-compiler-required` với status `deferred`. Deferred allow có guard superset fail-open để không làm mất exception; context/budget không đầy đủ cũng fail open. Stock `$popunder` vẫn được ghi `omitted` vì DNR export không bảo toàn kind.
- [Tự động cập nhật](AUTO-UPDATE.md): kiểm tra GitHub Releases định kỳ (có thể tắt, có policy managed `autoUpdate`), trình cập nhật Windows cài riêng với consent, xác minh checksum và danh tính gói, kiểm tra quyền thư mục, backup và rollback; workflow phát hành theo tag kèm provenance. Chữ ký release đã được hỗ trợ. Khi maintainer công bố khóa, chỉ bản cài mà installer đã ghim khóa (chạy `install-updater.cmd` từ một bản phát hành có khóa, hoặc installer một bước khi nhánh `main` đã có khóa) mới bắt buộc chữ ký; không có trust-on-first-use, nên bản cài hiện có vẫn chỉ kiểm checksum cho tới khi người dùng chạy lại installer. Hiện chưa có khóa nào.
- Budget static riêng với runtime DNR; regex dynamic + session dùng pool chung. Đã có test browser/service-worker restart, immutable generation và quota failure; benchmark trên máy `<= 4 GiB` còn ở Next.

Các bổ sung ngày 6/9/2026: [firewall network với noop đúng nghĩa, logger hợp nhất và ngoại lệ giữa các nguồn](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). `$badfilter` imported/personal đã hủy trước khi gộp; stock hỗ trợ hủy toàn rule và dựng lại phần còn lại của nhóm hostname chặn có đủ ánh xạ nguồn. Phép gộp chưa đủ bằng chứng và secondary corpus vẫn ở Next.

## Next — chất lượng và trải nghiệm cộng đồng

- Mở rộng logger hiện có bằng ánh xạ đầy đủ từ DNR về list/dòng nguồn; tiếp tục giữ ranh giới giữa match native, insertion, execution-attempt và effect.
- Quota preview đối chiếu browser trước khi bật/cập nhật list: static, dynamic, session và shared dynamic+session regex; phân biệt estimate/compiled/active và giữ last-known-good khi cập nhật bị từ chối.
- Mở rộng `$badfilter` stock cho phần còn lại của các phép gộp phức tạp chưa đủ ánh xạ, regex, strict-block và corpus popup; không vô hiệu hóa phần không liên quan để thay cho việc chưa hỗ trợ.
- Ngoại lệ tạm theo URL/resource type/tab bằng session DNR, có preview/Undo và dọn metadata khi đóng tab hoặc kết thúc phiên; không dùng allow rộng thay ngữ nghĩa `noop` của uBO.
- Semantic-safe dedupe/merge/sharding với equivalence test và rollback.
- Filter Store diff review, lịch sử/độ mới nguồn, automation và quarantine workflow.
- Parse stock popup/popunder trực tiếp từ source compiler để bảo toàn kind `$popunder`, không phụ thuộc DNR export lossy.
- Mở rộng popup condition subset chỉ sau equivalence/false-positive/performance test; thêm diagnostics cho initiator/top/target completeness, budget exhaustion và deferred reason theo source line.
- Benchmark dashboard trong CI: cold start, idle memory, list compile peak, CSS cache và p95 update time; bộ so sánh ngữ nghĩa với uBO/AdGuard/Brave trên tập cú pháp chung.
- Khôi phục backup có journal/tiến độ cấp toàn profile; restore hiện tại vẫn tuần tự, chưa nguyên tử trên mọi thành phần.
- Accessibility/i18n, import conflict UX và cảnh báo list không được chứng thực.
- Upstream sync automation có human review cho compiler/security-sensitive conflicts.
- Các bước 2–5 của [nghiên cứu ngày 24/9](MV3-LIMITS-RESEARCH-2026-09-24.md#lộ-trình-11-bước), đều làm được trong bản DNR:
  - strict-block bằng redirect `extensionPath` không dùng regex, và chuyển regex stock sang static ruleset để giải phóng pool 1.000 regex dynamic + session;
  - công tắc theo site no-remote-fonts, no-csp-reports, no-scripting và no-large-media (hai rule `Content-Length`), cùng `$inline-script`/`$inline-font` bằng CSP;
  - một compiler cho stock, list nhập thêm và bộ lọc cá nhân;
  - logger truy về list/dòng nguồn, picker có ứng viên network filter, `$popup` có điều kiện party, stock `$popunder` và `$ipaddress` cho `main_frame`.
- Việc còn mở sau bước 1: báo cáo (hoặc từ chối) filter có hostname entity/regex bị phủ định, như `domain=~example.*`, hiện bị bỏ im lặng và làm rule rộng hơn (187 filter stock trong bản chụp ngày 23/9/2026); trang xem filter bị từ chối theo lý do; đếm hostname entity bị bỏ khi filter chỉ chuyển một phần; và thêm `##^responseheader()` cho list nhập thêm.

## Later — capability tùy chọn sau RFC

- Experimental: engine mạng của uBO đầy đủ (`static-net-filtering.js`) chạy trong một listener `webRequest` đồng bộ, rồi firewall động, URL rule và công tắc hostname từ `src/js`. DNR vẫn là lớp nền: Chrome có thể được mở mà không có tham số allowlist, trạng thái người dùng vẫn đọc bất đồng bộ, và lần khởi động nguội của cả trình duyệt chưa được đo. Engine sẵn sàng sau 60–95 ms mỗi lần worker khởi động (số đo trên một máy). Bước 6–7 của nghiên cứu.
- Bản Firefox của Plus+ với engine đầy đủ: con đường duy nhất gỡ cả lọc body dạng stream, CNAME chính xác và quyết định bất đồng bộ. Bước 8.
- Managed Enterprise build/adapter và policy deployment guide.
- Native Companion/Power Mode (DNS/proxy/diagnostics) proof-of-concept, dùng lại versioned Native Messaging IPC của trình cập nhật. Companion CNAME chỉ dùng resolver của hệ điều hành, không dùng DoH.
- R&D bản riêng dùng `chrome.debugger` cho HTML filtering và `$replace`, giữ thanh cảnh báo debugger; tỷ lệ giá trị/công sức thấp nhất.
- Custom Chromium RFC/artifact riêng với patch audit, profile riêng và support matrix; không dùng custom capability để quảng cáo Google Chrome build.
- Nghiên cứu DNS-aware diagnostics/local proxy chỉ sau privacy/security/performance review.
- Federated catalog metadata chỉ khi có signature, provenance, revocation và UX trust rõ; không tải code.

## Không nằm trong roadmap

- tuyên bố tương thích MV2 100% khi Chrome MV3 không có API;
- bypass sandbox/quota bằng hack không được trình duyệt hỗ trợ;
- mặc định hoặc âm thầm ẩn cảnh báo của trình duyệt (ví dụ thêm `--silent-debugger-extension-api`, vốn ẩn cảnh báo debugger cho mọi extension), hoặc cài proxy chặn TLS/chứng chỉ gốc để sửa body;
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
