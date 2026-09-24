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
7. **Extension ↔ native companion:** process cục bộ vẫn là một principal khác, giao tiếp qua protocol versioned và allowlist. Phạm vi đã phát hành đầu tiên là trình cập nhật Windows (chỉ cập nhật gói), mô tả trong [AUTO-UPDATE.md](AUTO-UPDATE.md) và mục [Trình cập nhật Windows](#trình-cập-nhật-windows) bên dưới.
8. **GitHub Releases ↔ trình cập nhật:** release list, gói, `.sha256` và `.sig` tải về là dữ liệu không tin cậy cho đến khi qua checksum, chữ ký (khi đã ghim khóa), giới hạn archive, danh tính manifest và kiểm tra phiên bản mới hơn.
9. **Trình cập nhật ↔ thư mục extension và người dùng khác trên máy:** updater chạy với quyền của user hiện tại và chỉ thay thư mục đã đăng ký. Thư mục đó phải không bị người dùng khác sửa, và mọi file bị xóa phải thuộc gói đã cài hoặc backup.
10. **Browser popup/tab events ↔ compiled popup matcher:** event có thể đến thiếu frame/opener context hoặc sau service-worker restart; typed cache vẫn phải được validate trước khi match.
11. **Extension artifact ↔ custom browser build:** extension không được tin một API/patch chỉ vì browser tự xưng tương thích; build identity và capability phải probe/audit riêng.
12. **Build ↔ Chrome trên máy build:** từ bước 2, build Chromium mở Google Chrome headless để hỏi `isRegexSupported` cho mọi regex stock sẽ đóng gói static. Mô tả ở [bên dưới](#chrome-headless-lúc-build).
13. **Trang web ↔ trang strict-block:** URL bị chặn là dữ liệu của trang web (có thể chứa path, query, token). Trang strict-block chèn nó vào DOM dưới dạng text, không phải HTML, và chỉ tạo liên kết hay điều hướng tới URL `http(s)`.

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
- người dùng khác trên cùng máy Windows sửa thư mục extension hoặc thay một thư mục bằng junction để trình cập nhật ghi, xóa sai chỗ hoặc cài code của họ;
- lỗi thiết kế làm giữ cache/list/telemetry quá lâu và tăng RAM.

Local malware hoặc browser/OS đã bị chiếm hoàn toàn nằm ngoài khả năng bảo vệ tuyệt đối, nhưng release verification và native peer validation vẫn phải giảm thiểu hậu quả.

## Bảng rủi ro và kiểm soát

| Rủi ro | Kiểm soát bắt buộc | Residual risk |
| --- | --- | --- |
| Remote-code injection | Cấm `eval`, remote module/Wasm/scriptlet; scriptlet, matcher và redirect resource đóng gói; CSP nghiêm; filter/catalog HTTPS chỉ là hostile data qua parser hữu hạn | Bug trong packaged scriptlet/compiler. |
| Catalog/source takeover | HTTPS, provenance/ownership review, release-pinned catalog, diff anomaly gate, quarantine/rollback | Nội dung hợp lệ về cú pháp nhưng gây false positive/allow tracking. |
| Parser/regex/resource bomb | Size/time/count limit, streaming/chunked parse, abort, DNR validation; popup regex unbounded không neo đầu bị từ chối, glob/regex dùng cache và aggregate 8.000.000-step/4.096-filter/16-realm budget; regex hostname của scriptlet trong imported list được ước lượng tĩnh số bước khớp tối đa trên một hostname 253 ký tự (mọi quantifier và alternation, kể cả `?`/`{0,15}`, đều nhân số nhánh; điểm bắt đầu của regex không neo cũng vậy; lookbehind tính theo chiều ngược). Regex có thể backtrack theo hàm mũ (nhóm lặp mơ hồ, backreference), dài quá 256 ký tự hoặc vượt 2^18 bước, cùng các regex vượt ngân sách chung 256 regex/2^20 bước của mọi imported list, không bao giờ tới trang: scope dương bị bỏ, exception được nới thành regex literal bắt buộc hoặc `*` (fail-open, không mất exception) và được báo trong chẩn đoán scriptlet | List lớn hợp lệ vẫn có thể làm hết budget của một event: khi một ngoại lệ còn có thể khớp thì `defer`, còn không thì block compiled chưa xét bị bỏ qua và chỉ Smart/Strict quyết định. |
| Broad allow/priority abuse | Risk class, semantic diff, two-reviewer gate cho allow/header/scriptlet, precedence tests | Sai sót logic reviewer. |
| DNR quota exhaustion | Static budget riêng; dynamic/session rule-count riêng nhưng regex pool dùng chung; dedupe/semantic-safe merge, quota preflight, atomic update và báo deferred/rejected. Từ bước 2: regex stock ở pool static (174/1.000 với list mặc định); pool dùng chung được đếm theo chủ sở hữu (`dnr-namespaces.js`, `regex-capacity.js`); khi đầy chỉ regex không phải ngoại lệ của list nhập thêm bị bỏ, từ cuối, kèm cảnh báo, rồi mới tới lỗi fatal giữ rule cũ; kế hoạch strict-block chỉ dùng phần còn lại và bỏ rule stock trước; mục **Chẩn đoán** (Diagnostics) của dashboard hiện số thật | Quota khác nhau giữa browser/version; browser khác có thể từ chối regex đã qua preflight. Strict-block tăng từ 826 lên khoảng 1.106 session rule với list mặc định, nên còn ít chỗ hơn trong 5.000 session rule cho firewall. |
| Static regex làm Chrome từ chối nạp gói unpacked | Một regex sai cú pháp trong bất kỳ static ruleset nào, kể cả ruleset không bật, làm cả extension không nạp được. Bốn lớp: tập con RE2 portable (`re2-portable.js`, bắt buộc; loại named group, backreference, lookaround, escape lạ và lặp đếm quá lớn); `isRegexSupported` của Chrome thật lúc build (bắt buộc với build phát hành); `tools/validate-mv3.mjs` kiểm lại tập con portable, tổng không quá 1.000 và digest của `regex-details.json`; CI nạp gói trong Chrome thật và bật 50 list có nhiều regex nhất | Chrome cũ hơn (tối thiểu 130) có thể phân tích khác Chrome dùng lúc build. Giới hạn bộ nhớ 2 KB phụ thuộc phiên bản: regex vượt giới hạn không làm hỏng việc nạp gói nhưng bị bỏ qua im lặng, chỉ thấy qua **Kiểm tra ngay** trong mục Chẩn đoán. Build development không có Chrome chỉ có verdict đã cache và tập con portable. |
| Redirect che block (fail-open khi thiếu quyền host) | Đo trên Chrome 153: khi quyền truy cập site là “Khi nhấp” (On click), một session redirect khớp mà không có quyền host sẽ che block có priority thấp hơn, và trang tải. Redirect strict-block chỉ được cài khi có quyền truy cập mọi trang web; bộ redirect được dựng lại khi `permissions.onAdded`/`onRemoved` và đối chiếu lại mỗi lần worker khởi động. Block dynamic của filter `$doc` người dùng không bao giờ bị sửa, nên vẫn chặn khi redirect bị gỡ. Redirect người dùng ở P+1 để allow cùng list vẫn thắng | Vài mili giây sau khi quyền đổi, trước khi bộ rule được dựng lại. Policy doanh nghiệp `runtime_blocked_hosts` có thể giữ quyền trên một số host trong khi `<all_urls>` vẫn hiện là đã cấp: chưa xử lý. Allow loại trừ của Bộ lọc của tôi (priority khoảng 1.000.010) cũng hủy rule cấp trang có priority thấp hơn (chèn CSP, removeparam, xóa response header) trên document của site được loại trừ; allow `main_frame` ở 29 của list stock có cùng loại tác dụng phụ như trước. |
| Phụ thuộc API gỡ lỗi `onRuleMatchedDebug` | Chrome chỉ gửi sự kiện này cho bản cài unpacked có `declarativeNetRequestFeedback`, và gửi cho **mọi** rule khớp. Listener chỉ được đăng ký khi có redirect strict-block, không có `webRequest` và không ở low-memory profile (ở profile đó worker phải được nghỉ; nguồn khi ấy là lúc bắt đầu điều hướng, gần đúng); khi quyền `webRequest` tùy chọn được cấp (nút trong mục Chẩn đoán, luôn có trong Experimental), listener `main_frame` rẻ hơn thay thế nó. Sau server redirect Chrome không phát `onBeforeRedirect` cho bước redirect DNR, chỉ phát `onBeforeRequest` cho `strictblock.html` với cùng `requestId`, nên listener nhớ địa chỉ web trước đó của mỗi request `main_frame` (chỉ trong bộ nhớ, tối đa 64). Không có nguồn chính xác thì trang ghi địa chỉ là gần đúng hoặc không có, và filter `$doc` của người dùng vẫn là block thường. Capability chỉ báo nguồn thật sự đã đăng ký | Chrome có thể giới hạn hoặc gỡ API này. Chi phí đo trên một máy (Chrome 153, trang có 300 ảnh bị chặn): probe thiết kế +14,6 ms tải trang (khoảng 49 µs mỗi rule khớp, khoảng 2,5 ms CPU worker); test Chrome +12 đến +26 ms tải trang và +0,3 đến +0,5 ms thời gian JS worker mỗi trang. Worker không dừng trong suốt 40 s / 60 s khi trang yêu cầu một ảnh bị chặn mỗi 2 s, so với dừng sau 30,1 s khi không có listener. Chi tiết: [POWER-RUNTIME.md](POWER-RUNTIME.md#chi-phí-của-strict-block-cho-service-worker). |
| Service-worker eviction | Listener top-level, immutable generation, persist checkpoint/state, idempotent startup/migration, không giữ truth chỉ trong memory | Task đang chạy có thể bị ngắt và phải resume; checkpoint cố ý không giữ full browsing URL lâu dài. Ngoại lệ có giới hạn: tracker strict-block giữ URL đầy đủ của document bị chặn gần nhất mỗi tab trong `storage.session` để worker khởi động lại vẫn trả lời được trang strict-block, cho tới khi trang đã đọc nó (tối đa 64 tab, xóa ngay khi trang đọc xong hoặc khi đóng tab, mất khi thoát trình duyệt; xem [PRIVACY.md](PRIVACY.md#strict-blocking)). `storage.session` mở cho content script (`TRUSTED_AND_UNTRUSTED_CONTEXTS`), nên một renderer bị chiếm quyền có thể đọc hoặc ghi bản ghi đang chờ; bản ghi có thời điểm trong tương lai bị bỏ qua, và trang chỉ mở URL `http(s)`. Địa chỉ gần đúng (lúc bắt đầu điều hướng) có thể là trang redirect đứng trước site bị chặn: trang không cho chọn “Đừng cảnh báo tôi lần nữa” trên host đoán ra đó. |
| Popup false positive do thiếu context | Classifier giới hạn condition; initiator condition cần completeness bit; original-opener không khôi phục đủ thì popunder fail open; allow/block precedence và transition có regression test | Fail-open có thể bỏ sót popup độc hại, nhưng tránh broad block sai. |
| Corrupt/stale compiled popup cache | Schema version, route code, condition classifier và generation pointer phải khớp; chỉ `popup-observer-runtime` được ra quyết định exact. `popup-compiler-required` block chỉ để chẩn đoán; allow được giữ tối thiểu như guard superset chỉ có thể trả `defer` | Logic validator/compiler cùng có bug hoặc storage bị browser làm hỏng. |
| Extension-page XSS/message spoof | Không dùng HTML không sanitize; schema validate; kiểm tra `sender.id`, frame/origin và action capability. Message được chia tầng người gửi (`tools/test-sender-trust.mjs`): trang của extension được nhận theo ID và tiền tố URL (trên Firefox, nơi `sender.origin` không có, cũng vậy, và content script không bao giờ được tin); `getRegexCapacity` chỉ cho trang của extension; `getStrictBlockDetails` chỉ cho `strictblock.html` trong frame trên cùng của một tab; user script chỉ gọi được các message trong allowlist. Trang strict-block chèn URL bị chặn dưới dạng text và chỉ tạo liên kết hay điều hướng tới URL `http(s)` | Browser bug hoặc logic thiếu case. |
| Compromised dependency/CI | Lockfile + `npm ci`, pin action theo immutable commit, minimal permissions, dependency review, SBOM/provenance | Maintainer chủ động merge dependency độc hại. |
| Artifact substitution | Reproducible build target; SHA-256 kèm tên asset; từ 1.2.0 workflow Release build, attest provenance và phát hành; workflow không bao giờ thay asset đã phát hành, asset đã có mà khác bản build mới thì workflow dừng; chữ ký release khi đã công bố khóa; hai người duyệt release | Lộ khóa ký: `retire` chỉ sửa file khóa trong repo, updater đã cài vẫn tin khóa lộ cho tới khi áp dụng một release đã ký mang bộ khóa generation cao hơn không còn khóa đó (xoay khóa ngắn qua hai release: thêm khóa mới và phát hành bản ký bằng cả hai khóa, rồi `retire` khóa lộ và phát hành tiếp), hoặc người dùng chạy lại `updater\install-updater.cmd` từ gói mới hơn; updater bỏ lỡ các release đó vẫn tin khóa lộ (xem [Trình cập nhật Windows](#trình-cập-nhật-windows) và [AUTO-UPDATE.md](AUTO-UPDATE.md#release-signing-keys-for-maintainers)); release trước 1.2.0 không có attestation; khi chưa công bố khóa, updater chỉ kiểm checksum, còn attestation provenance chỉ kiểm tra thủ công được (`gh attestation verify`). |
| Enterprise overreach | Build riêng, admin docs, capability probe, audit log cục bộ, least privilege | Tổ chức quản lý có quyền cao theo policy của họ. |
| Native-host compromise | Cài riêng/consent; host chạy với quyền user hiện tại, không cần admin, không service/scheduled task/autostart; exact origin allowlist trong host manifest và kiểm tra lại với `config.json`; IPC versioned, 4 lệnh, request tối đa 64 KiB; host chỉ tự thay mình bằng script trong gói có chữ ký đã xác minh | Host là script PowerShell không ký Authenticode, chạy với `-ExecutionPolicy Bypass`; malware cùng user sửa được nó. Native process có quyền OS của user và tăng attack surface. |
| Kênh cập nhật tự động bị lợi dụng | Chỉ trang extension gửi được lệnh cập nhật; IPC chỉ mang lệnh và số phiên bản; host tự dựng URL HTTPS từ `config.json`; SHA-256; chữ ký RSA với khóa ghim, không trust-on-first-use; cùng edition/`key`, phiên bản phải mới hơn; kiểm tra quyền thư mục, junction/symlink và file lạ; backup và tự khôi phục; không có process chạy nền. Chi tiết: [Trình cập nhật Windows](#trình-cập-nhật-windows), [AUTO-UPDATE.md](AUTO-UPDATE.md) | Hiện chưa công bố khóa ký: tài khoản GitHub/CI bị chiếm có thể đưa code extension độc hại tới mọi bản cài tự động trong một lần kiểm tra. Khi đã bật ký: lộ khóa ký. |
| Privacy/RAM regression | Không telemetry mạng; local counters; retention/size budget; benchmark low-memory; cleanup explicit | Chrome và website thay đổi hành vi. |

## Filter compiler safety contract

- Input không được coi là UTF-8/line structure hợp lệ cho đến khi validate.
- Không filter nào có thể tạo tên scriptlet/resource ngoài registry đóng gói.
- Unsupported syntax được ghi nhận với reason code; không “dịch gần đúng” nếu đổi semantics.
- `$popup`/`$popunder` supported condition tạo route `popup-observer-runtime`, `accepted+routed` và không bị ghi như rejection. Unsupported condition tạo `popup-compiler-required` với reason cụ thể; popup-only deferred/rejected, còn resource half hợp lệ của filter kết hợp có thể accepted đúng một lần.
- Cache chỉ chấp nhận runtime route khi `classifyPopupCondition()` xác nhận shape hỗ trợ. Compiler-required block không được masquerade thành runtime filter; compiler-required allow chỉ được dùng như uncertain guard sau khi bỏ predicate chưa hỗ trợ theo hướng match rộng hơn, nên kết quả duy nhất của guard là buộc fail-open.
- Corpus stock phải là resource đóng gói, khớp `ruleset-details`, schema/count/provenance/classifier; lỗi hoặc vượt giới hạn phải suppress toàn corpus, không dùng một phần có thể làm mất allow exception.
- URL popup dài hơn 8 KB chỉ giữ canonical origin và completeness bit: broad/domain rule vẫn xét được; ngoại lệ chỉ phần path đã bỏ mới khớp được thì `defer`, còn block chỉ phần path đó mới khớp được thì bị bỏ qua. Matcher xét allow trước block. Khi aggregate budget (4.096 filter, 16 realm, 8.000.000 match-step) hết, kết quả là `defer` nếu một ngoại lệ còn có thể khớp, hoặc nếu một block `important` chưa xét có thể thắng ngoại lệ đã khớp. Ngoài hai trường hợp đó, block chưa xét bị bỏ qua và chính sách Smart/Strict vẫn quyết định. Matcher không bao giờ block gần đúng.
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

Hiện trạng từ 1.2.0: workflow `release.yml` build từ tag trong checkout sạch với action pin theo commit, chạy test, lint và validate trong job read-only, tạo SHA-256, ký khi đã công bố khóa, attest build provenance rồi mới phát hành (gate 3–5 một phần). Từ bước 2, job build (và workflow `mv3-chromium.yml` cho mỗi push và pull request) còn nạp cả hai gói trong Chrome thật có sẵn trên runner Windows: kiểm regex static và strict-block (`tools/test-static-regex-chrome.mjs`, `tools/test-strictblock-chrome.mjs`). Workflow chưa tạo SBOM, chưa chạy memory benchmark, và job publish chưa dùng GitHub environment riêng: secret ký chỉ được đọc trong job đó. Repository chưa có file CODEOWNERS; protected branch và review bắt buộc là cấu hình trên GitHub, không kiểm tra được từ mã nguồn.

### Chrome headless lúc build

Từ bước 2, `make-rulesets.js` (qua `platform/mv3/regex-verdicts.mjs`) mở Google Chrome trên máy build để hỏi `declarativeNetRequest.isRegexSupported` cho mọi regex stock sẽ được đóng gói static, vì một regex sai cú pháp trong static ruleset làm Chrome từ chối nạp cả gói unpacked. Hai test Chrome của CI dùng cùng cách chạy (`tools/chrome-cdp-harness.mjs`).

Kiểm soát:

- Chrome luôn chạy headless với `--user-data-dir` là một thư mục tạm mới tạo dưới thư mục tạm của hệ điều hành, không bao giờ với profile của người dùng. Trên Windows, ngay cả `chrome.exe --version` cũng mở profile mặc định, nên không có lời gọi nào thiếu tham số này. Harness của test từ chối chạy nếu thư mục profile không phải thư mục rỗng nó vừa tạo.
- Điều khiển qua `--remote-debugging-pipe`, không mở cổng mạng. Extension thử là một thư mục tạm chỉ xin `declarativeNetRequest`.
- Chỉ đóng cây process do chính build mở (đóng qua CDP, rồi buộc dừng đúng PID đó sau thời gian chờ), xóa cả hai thư mục tạm, kể cả khi build dừng sớm. Mỗi lệnh gửi Chrome có giới hạn thời gian, và mỗi test Chrome có giới hạn thời gian cứng cho cả lần chạy.
- Không sửa registry, policy hay cài đặt hệ thống; không tải file thực thi. Chrome được tìm trong thư mục cài chuẩn hoặc qua `CHROME_PATH`.
- Verdict được cache trong `dist/build/mv3-data/regex-verdicts.json` và chỉ dùng khi không có Chrome (build development). Build phát hành bắt buộc hỏi Chrome thật (`regexVerdicts=required`). Dù có hay không có verdict, tập con RE2 portable vẫn bắt buộc, và `tools/validate-mv3.mjs` kiểm lại gói.

Rủi ro còn lại: build tin binary Chrome có trên máy build (hoặc runner CI); một Chrome bị thay có thể trả verdict sai, nhưng tập con portable và validator vẫn chặn regex sai cú pháp đã biết. Một Chrome treo hoặc crash làm build thất bại sau thời gian chờ. Build phát hành nay cần Chrome trên máy build.

## Các tier tùy chọn

### Managed Enterprise

[`webRequestBlocking` trong MV3 chỉ dành cho extension policy-installed](https://developer.chrome.com/docs/extensions/reference/api/webRequest). Chỉ bật capability mạnh khi cả ba điều kiện đúng: build có adapter, extension được cài bằng policy, và runtime capability probe thành công. UI phải nêu tổ chức quản lý setting nào. Không fallback sang quyền rộng hơn khi policy lỗi.

### Native Companion / Power Mode

Trước implementation cần RFC riêng mô tả threat model, IPC schema, install/uninstall, auto-update, signature verification, proxy/DNS trust, log retention và memory budget. RFC cho phạm vi cập nhật gói là [AUTO-UPDATE.md](AUTO-UPDATE.md); mọi capability proxy/DNS vẫn cần RFC riêng. Extension phải hoạt động hữu ích khi không có companion. Uninstall companion không được làm mất cấu hình filter core.

Native host không làm extension thành policy-installed, không cấp `webRequestBlocking` và không tăng quota DNR. Nếu companion cung cấp proxy/DNS enforcement, UI phải chỉ rõ traffic nào rời browser API boundary và cách dừng hoàn toàn process đó.

### Trình cập nhật Windows

Đây là phần Native Companion đã phát hành từ 1.2.0. Thiết kế đầy đủ nằm ở [AUTO-UPDATE.md](AUTO-UPDATE.md); mục này ghi ranh giới tin cậy, kiểm soát và rủi ro còn lại theo code hiện tại.

Ranh giới và kiểm soát:

- **Trang web/content script ↔ worker:** chỉ trang của chính extension gửi được message cập nhật; worker kiểm tra `sender.id`, URL và origin. Content script và user script không gọi được.
- **Worker ↔ host:** Chrome chỉ khởi động host `io.github.kayurachann.ublock_plus.updater` cho origin có trong `allowed_origins`. Host kiểm tra lại origin với `config.json` và từ chối một ID được đăng ký cho nhiều thư mục (`ambiguous-installation`). Request tối đa 64 KiB, chỉ có 4 lệnh `hello`, `stage`, `apply`, `rollback` và chỉ mang số phiên bản. URL, thư mục và repo lấy từ cấu hình local do installer ghi.
- **GitHub ↔ host:** URL phải là HTTPS (HTTP chỉ cho loopback khi test) và redirect phải giữ HTTPS. Gói tối đa 256 MiB, `.sha256` 4 KiB, `.sig` 8 KiB. File `.sha256` phải có dạng `<hash>  <tên asset>`, với đúng tên asset. Archive tối đa 20.000 entry và 768 MiB giải nén, tính theo số byte thật sự ghi ra; path tuyệt đối, `..`, backslash, ký tự ổ đĩa và entry trùng bị từ chối. Manifest phải là uBlock Plus+ MV3 cùng edition và cùng `key` (extension ID không đổi), với version đúng bằng version yêu cầu và mới hơn bản đã cài.
- **Khóa ghim:** `release-signing-keys.json` ghim khóa RSA công khai (JWK, tối thiểu 2048 bit; `generate` tạo khóa 3072 bit). `.sig` chứa tối đa 8 chữ ký RSA PKCS#1 v1.5 trên SHA-256 của gói, mỗi dòng một chữ ký; chỉ cần một dòng xác minh được với một khóa đang tin. Khi đã có khóa tin cậy, gói thiếu chữ ký hợp lệ bị từ chối (`signature-missing`, `signature-invalid`), và gói đã stage trước khi có khóa phải tải lại.
- **Không trust-on-first-use:** updater chỉ nhận bộ khóa mới và chỉ tự thay script của mình từ một gói có chữ ký đã xác minh. Nó đọc bản staging đã kiểm tra trong `%LOCALAPPDATA%`, không đọc thư mục extension, và ghi đúng các byte đã kiểm tra. Script mới phải parse được và khai báo version cao hơn. Updater không bao giờ nhận bộ khóa rỗng. Khi chưa có khóa nào, updater không bao giờ đổi khóa hay chính nó: chỉ việc người dùng chạy lại `updater\install-updater.cmd` từ gói mới hơn mới ghim khóa và nâng cấp updater.
- **Xoay khóa:** mỗi bộ khóa có số `generation` (thiếu thì là 0). Lệnh `generate` và `retire` của `tools/release-signing.mjs` tăng số này. Updater không bao giờ nhận bộ khóa có generation thấp hơn. Installer chỉ thay bộ khóa đang tin trong các trường hợp sau: chưa có khóa nào; bộ mới không rỗng và có generation cao hơn; hoặc cùng generation và chứa mọi khóa đang tin. `-ResetKeys` bỏ qua quy tắc này và chỉ dùng để khôi phục có chủ ý. Quy trình xoay: thêm khóa mới, ký bằng cả hai khóa trong một thời gian chồng dài, rồi `retire` khóa cũ. Nếu release trước đã có khóa mà không khóa nào của nó xác minh được gói mới, workflow phát hành dừng.
- **Thư mục extension:** updater từ chối (`unsafe-extension-dir`):
  - ổ đĩa gốc và mọi đường dẫn mạng UNC (`\\máy\share\…`);
  - chính các thư mục hệ thống và thư mục hồ sơ, ví dụ `%USERPROFILE%`, `%LOCALAPPDATA%`, `%TEMP%`, Desktop, Documents, Downloads (thư mục con mới tạo bên trong vẫn được, nếu qua các kiểm tra dưới đây);
  - thư mục chứa, hoặc nằm trong, thư mục của updater;
  - junction hoặc symlink ở bất kỳ đâu trên đường dẫn hay trong thư mục;
  - thư mục mà các nhóm dùng chung (Everyone, Users, Authenticated Users, Interactive, Guests, Domain Users, …) sửa được, kể cả mọi thư mục con, và thư mục có thư mục cha mà các nhóm đó đổi tên hoặc thay được.

  Thư mục tạo thẳng dưới `C:\` thừa hưởng quyền Modify của Authenticated Users nên bị từ chối. Không đọc được quyền thì cũng từ chối. Installer chạy đúng hàm kiểm tra này trước khi đăng ký bất kỳ thứ gì.
- **File lạ:** mỗi gói có `updater/package-files.json`. Update và rollback chỉ xóa file mà danh sách của gói đang cài liệt kê. Khi hoàn tác một apply bị ngắt, updater còn được xóa file mà danh sách của backup liệt kê hoặc gói đã tải (vẫn giữ trong `staging`) chứa. File khác làm thao tác dừng với `unexpected-files` và không đổi gì. `_metadata` và `Thumbs.db`, `desktop.ini`, `.DS_Store` được để nguyên trong những thư mục mà gói mới (hoặc backup) cũng có.
- **Giao dịch:** `updater.lock` tuần tự hóa stage, apply và rollback (`update-busy`). Apply tạo và xác minh backup trước, ghi marker `applying`, chép `manifest.json` sau cùng rồi xác minh version; nếu thất bại thì khôi phục backup. Nếu apply bị ngắt giữa chừng, lần chạy sau lấy được khóa (`hello`, `stage`, `apply`, `rollback`, `-Status`, `-Update`, `-Install`, `-Rollback`) khôi phục backup. `hello` và `-Status` chỉ lấy khóa khi có việc cần hoàn tác và bỏ qua nếu khóa đang bị giữ. Khi mục **Cập nhật** (Updates) của dashboard hỏi trạng thái updater, extension báo `update-undone` và reload nếu version được khôi phục khác version đang chạy; một lần cài gặp apply bị ngắt thì để updater hoàn tác rồi cài tiếp. Nếu backup không còn, lệnh `-Rollback` trên dòng lệnh chỉ xóa marker khi thư mục vẫn là uBlock Plus+ và khai báo một trong hai version. Phía extension, cài, khôi phục và restart cho updater chờ tối đa 60 giây cho giao dịch lọc đang chạy rồi từ chối (`filters-busy`); lần cài tự động bị từ chối vì lý do này được thử lại sau 5 phút.
- **Phát hành:** job build chạy `npm ci --ignore-scripts`, test, lint, build và validate với quyền read-only và không có secret. Job publish không cài dependency; chỉ job này thấy secret ký, OIDC token và quyền ghi release. Asset đã có trên release phải giống hệt từng byte với bản vừa build, nếu không workflow dừng.

Rủi ro còn lại:

- Kiểm tra link và quyền chạy ở những thời điểm cố định. Chúng chỉ đủ vì không người dùng nào khác sửa được thư mục trong lúc robocopy chạy. Chỉ entry Allow của các nhóm dùng chung được tính; entry Deny và quyền cấp riêng cho từng tài khoản khác không được xét. Kiểm tra chưa được thử trên ổ mạng được gán ký tự ổ đĩa và ổ FAT/exFAT; ổ không có ACL nhiều khả năng bị từ chối. OneDrive placeholder và các reparse point khác không phải junction hay symlink không bị coi là link (theo thiết kế), nhưng chưa được thử thực tế. Đường dẫn UNC luôn bị từ chối.
- Hiện `release-signing-keys.json` chưa có khóa nào (`"keys": []`), nên updater chỉ kiểm tra checksum SHA-256, mà tệp này nằm cạnh gói trên cùng release; installer in `Signed releases  : not configured (checksum only)`. Attestation build provenance chỉ kiểm tra được bằng tay (`gh attestation verify`); updater, installer và extension không kiểm tra nó. Tài khoản GitHub hoặc CI bị chiếm có thể phát hành gói độc hại. Mọi bản cài ở chế độ cài tự động nhận gói đó trong một lần kiểm tra (khoảng 6 giờ), dưới dạng code extension với toàn bộ quyền host của extension. Updater không tự thay mình bằng gói chưa ký, nhưng thư mục `updater\` của extension khi đó chứa bản của kẻ tấn công: chạy lại `install-updater.cmd` từ đó sẽ cài native code và ghim khóa của kẻ tấn công.
- Sau khi khóa được công bố, bản cài hiện có vẫn chỉ kiểm checksum cho tới khi người dùng chạy lại installer từ gói mới hơn. Bản cài bỏ lỡ giai đoạn ký kép cũng phải chạy lại installer.
- Installer một bước tải `install-updater.ps1`, updater và khóa từ nhánh `main` qua `raw.githubusercontent.com`. Lần cài đó tin HTTPS của GitHub và nội dung nhánh tại thời điểm tải.
- Job build vẫn chạy devDependency của bên thứ ba và tạo ZIP trước khi ký. Việc tách job bảo vệ secret và OIDC token, không bảo vệ nội dung gói trước một dependency bị compromise.
- Release trước 1.2.0 được tải lên thủ công và không có attestation.
- Host là script PowerShell không ký Authenticode, chạy với `-ExecutionPolicy Bypass` dưới quyền user. Malware chạy cùng user có thể sửa script, cấu hình hoặc khóa trong `%LOCALAPPDATA%\uBlockPlus\Updater`; trường hợp này nằm ngoài phạm vi bảo vệ (xem phần adversaries).

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
