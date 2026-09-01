# Threat model và supply-chain policy

Tài liệu này dùng cho Power Edition sideload-first và ba tầng tùy chọn tách biệt: Managed Enterprise, Native Companion và Custom Chromium. Mục tiêu là giảm rủi ro có thể kiểm soát; không tuyên bố extension hay filter list “an toàn tuyệt đối”.

## Tài sản cần bảo vệ

- tính toàn vẹn của source, catalog, ruleset, scriptlet và artifact phát hành;
- setting, custom filter và lựa chọn list của người dùng;
- lịch sử duyệt web/nội dung trang mà extension có quyền quan sát;
- identity maintainer, release credential, CI token và native-host identity;
- availability: không treo browser, không làm cạn RAM/CPU/DNR quota;
- tính đúng của compiled generation, popup initiator/top/target context và allow/block precedence;
- khả năng audit/rollback và attribution GPL/upstream.

## Trust boundaries

1. **Trang web ↔ content script:** mọi DOM/string từ page là dữ liệu không tin cậy.
2. **Content script/UI ↔ service worker:** message phải xác thực sender, schema và capability.
3. **Remote filter source ↔ compiler:** HTTPS không làm nội dung trở thành đáng tin; parser phải chịu hostile input.
4. **GitHub PR/dependency ↔ release branch:** contributor và package update không mặc nhiên có quyền phát hành.
5. **CI ↔ artifact/signing:** PR workflow không được truy cập release secret.
6. **Extension ↔ enterprise policy:** chỉ tin policy được Chrome báo qua managed API/capability probe.
7. **Extension ↔ native companion:** process cục bộ vẫn là một principal khác, giao tiếp qua protocol versioned và allowlist.
8. **Browser popup/tab events ↔ compiled popup matcher:** event có thể đến thiếu frame/opener context hoặc sau service-worker restart; typed cache vẫn phải được validate trước khi match.
9. **Extension artifact ↔ custom browser build:** extension không được tin một API/patch chỉ vì browser tự xưng tương thích; build identity và capability phải probe/audit riêng.

## Adversaries và tình huống lỗi

- list maintainer độc hại hoặc tài khoản/source domain bị chiếm;
- PR/catalog entry cố thêm allow rule quá rộng, parser bomb, regex tốn tài nguyên hoặc scriptlet nguy hiểm;
- dependency/CI action bị compromise, lockfile poisoning hoặc artifact bị thay sau build;
- website cố giả message, DOM injection hoặc khai thác extension page XSS;
- rule-ID collision, quota exhaustion, update một phần hoặc state migration hỏng;
- dynamic và session vượt shared regex pool dù từng ruleset còn rule-count capacity; static capacity bị tính nhầm vào runtime budget;
- popup event thiếu/sai initiator, opener đã navigate, stale generation hoặc route code không khớp condition làm broad false positive;
- release credential bị lộ, rollback/downgrade hoặc mirror giả mạo;
- enterprise policy cấu hình sai làm tăng quyền quan sát;
- native companion giả mạo, command injection, IPC replay hoặc proxy/DNS làm lộ traffic;
- lỗi thiết kế làm giữ cache/list/telemetry quá lâu và tăng RAM.

Local malware hoặc browser/OS đã bị chiếm hoàn toàn nằm ngoài khả năng bảo vệ tuyệt đối, nhưng release verification và native peer validation vẫn phải giảm thiểu hậu quả.

## Bảng rủi ro và kiểm soát

| Rủi ro | Kiểm soát bắt buộc | Residual risk |
| --- | --- | --- |
| Remote-code injection | Cấm `eval`, remote module/Wasm/scriptlet; scriptlet, matcher và redirect resource đóng gói; CSP nghiêm; filter/catalog HTTPS chỉ là hostile data qua parser hữu hạn | Bug trong packaged scriptlet/compiler. |
| Catalog/source takeover | HTTPS, provenance/ownership review, release-pinned catalog, diff anomaly gate, quarantine/rollback | Nội dung hợp lệ về cú pháp nhưng gây false positive/allow tracking. |
| Parser/regex/resource bomb | Size/time/count limit, streaming/chunked parse, abort, DNR validation; popup regex unbounded không neo đầu bị từ chối, glob/regex dùng cache và aggregate 65.536-step/4.096-filter/16-realm budget | List lớn hợp lệ vẫn có thể làm event fail open trên máy yếu. |
| Broad allow/priority abuse | Risk class, semantic diff, two-reviewer gate cho allow/header/scriptlet, precedence tests | Sai sót logic reviewer. |
| DNR quota exhaustion | Static budget riêng; dynamic/session rule-count riêng nhưng regex pool dùng chung; dedupe/semantic-safe merge, quota preflight, atomic update và báo deferred/rejected | Quota khác nhau giữa browser/version; browser khác có thể từ chối regex đã qua preflight. |
| Service-worker eviction | Listener top-level, immutable generation, persist checkpoint/state, idempotent startup/migration, không giữ truth chỉ trong memory | Task đang chạy có thể bị ngắt và phải resume; checkpoint cố ý không giữ full browsing URL lâu dài. |
| Popup false positive do thiếu context | Classifier giới hạn condition; initiator condition cần completeness bit; original-opener không khôi phục đủ thì popunder fail open; allow/block precedence và transition có regression test | Fail-open có thể bỏ sót popup độc hại, nhưng tránh broad block sai. |
| Corrupt/stale compiled popup cache | Schema version, route code, condition classifier và generation pointer phải khớp; chỉ `popup-observer-runtime` được ra quyết định exact. `popup-compiler-required` block chỉ để chẩn đoán; allow được giữ tối thiểu như guard superset chỉ có thể trả `defer` | Logic validator/compiler cùng có bug hoặc storage bị browser làm hỏng. |
| Extension-page XSS/message spoof | Không dùng HTML không sanitize; schema validate; kiểm tra `sender.id`, frame/origin và action capability | Browser bug hoặc logic thiếu case. |
| Compromised dependency/CI | Lockfile + `npm ci`, pin action theo immutable commit, minimal permissions, dependency review, SBOM/provenance | Maintainer chủ động merge dependency độc hại. |
| Artifact substitution | Reproducible build target, SHA-256, signed tag/release/provenance, hai người duyệt release | Key compromise; cần revocation procedure. |
| Enterprise overreach | Build riêng, admin docs, capability probe, audit log cục bộ, least privilege | Tổ chức quản lý có quyền cao theo policy của họ. |
| Native-host compromise | Cài riêng/consent, signed/version-pinned host, exact origin allowlist, bounded IPC, sandbox/service account khi có thể | Native process có quyền OS và tăng attack surface. |
| Privacy/RAM regression | Không telemetry mạng; local counters; retention/size budget; benchmark low-memory; cleanup explicit | Chrome và website thay đổi hành vi. |

## Filter compiler safety contract

- Input không được coi là UTF-8/line structure hợp lệ cho đến khi validate.
- Không filter nào có thể tạo tên scriptlet/resource ngoài registry đóng gói.
- Unsupported syntax được ghi nhận với reason code; không “dịch gần đúng” nếu đổi semantics.
- `$popup`/`$popunder` supported condition tạo route `popup-observer-runtime`, `accepted+routed` và không bị ghi như rejection. Unsupported condition tạo `popup-compiler-required` với reason cụ thể; popup-only deferred/rejected, còn resource half hợp lệ của filter kết hợp có thể accepted đúng một lần.
- Cache chỉ chấp nhận runtime route khi `classifyPopupCondition()` xác nhận shape hỗ trợ. Compiler-required block không được masquerade thành runtime filter; compiler-required allow chỉ được dùng như uncertain guard sau khi bỏ predicate chưa hỗ trợ theo hướng match rộng hơn, nên kết quả duy nhất của guard là buộc fail-open.
- Corpus stock phải là resource đóng gói, khớp `ruleset-details`, schema/count/provenance/classifier; lỗi hoặc vượt giới hạn phải suppress toàn corpus, không dùng một phần có thể làm mất allow exception.
- URL popup vượt memory bound phải giữ canonical origin và completeness bit: broad/domain rule vẫn xét được, URL/regex path phải pending. Aggregate matcher budget hết thì `defer`, không block.
- Compile output có namespace rule ID, deterministic ordering và checksum.
- Update chuẩn bị đầy đủ trước khi thay state đang hoạt động; nếu lỗi, giữ last-known-good.
- Không gửi filter, URL duyệt web hay compile report ra server dự án nếu người dùng không chủ động export.

## Supply-chain release policy

Release nên đáp ứng các gate sau trước khi coi là stable:

1. protected branch và review bắt buộc cho manifest, compiler, catalog, scriptlet, CI/release;
2. CODEOWNERS hoặc equivalent cho security-sensitive paths;
3. dependency/action pin bất biến và quét license/vulnerability;
4. clean checkout build, test schema/DNR/locales, memory benchmark và browser smoke test;
5. tạo SBOM, checksum và provenance gắn commit/tag;
6. release credential chỉ có trong protected release environment, không có ở PR từ fork;
7. diễn tập rollback và giữ artifact last-known-good.

## Các tier tùy chọn

### Managed Enterprise

[`webRequestBlocking` trong MV3 chỉ dành cho extension policy-installed](https://developer.chrome.com/docs/extensions/reference/api/webRequest). Chỉ bật capability mạnh khi cả ba điều kiện đúng: build có adapter, extension được cài bằng policy, và runtime capability probe thành công. UI phải nêu tổ chức quản lý setting nào. Không fallback sang quyền rộng hơn khi policy lỗi.

### Native Companion / Power Mode

Trước implementation cần RFC riêng mô tả threat model, IPC schema, install/uninstall, auto-update, signature verification, proxy/DNS trust, log retention và memory budget. Extension phải hoạt động hữu ích khi không có companion. Uninstall companion không được làm mất cấu hình filter core.

Native host không làm extension thành policy-installed, không cấp `webRequestBlocking` và không tăng quota DNR. Nếu companion cung cấp proxy/DNS enforcement, UI phải chỉ rõ traffic nào rời browser API boundary và cách dừng hoàn toàn process đó.

### Custom Chromium

Custom browser cần RFC và artifact/update channel riêng, reproducible patch diff, sandbox/Site Isolation/Safe Browsing giữ nguyên, profile test riêng và hướng dẫn quay lại browser chuẩn. Capability chỉ được công bố cho exact build/version đã test; extension không được tự tải hoặc patch browser.

## Incident response

1. Triage kín qua GitHub Security Advisory cho lỗ hổng chưa vá.
2. Xác định phạm vi commit/release/catalog/list và capability bị ảnh hưởng.
3. Thu hồi credential/entry, đóng băng release, tạo bản vá/rollback từ clean environment.
4. Công bố advisory với phiên bản ảnh hưởng, workaround, checksum và mức dữ liệu có thể bị lộ.
5. Postmortem không đổ lỗi cá nhân; thêm regression test và cập nhật threat model.

Không đăng browsing data, token, full diagnostics hoặc exploit chưa vá trong public issue.

## Review định kỳ

Threat model phải được review khi thêm permission, popup condition key, scriptlet capability, nguồn catalog, external network endpoint, enterprise adapter, native IPC command, custom-browser patch hoặc thay đổi memory/state retention. Review tối thiểu mỗi major release dù không có feature mới.

Nguồn và ngày kiểm tra cho các ràng buộc quota, lifecycle, remote code và bài học popup được lưu tại [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md).
