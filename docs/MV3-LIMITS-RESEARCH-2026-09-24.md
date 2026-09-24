# Nghiên cứu gỡ giới hạn MV3 của uBlock Plus+

Ngày nghiên cứu: **24 tháng 9 năm 2026**, nhánh `feature/compiler-honesty`. Chuẩn so sánh là **uBlock Origin đầy đủ**: mã nguồn `src/js` trong repository là tham chiếu ngữ nghĩa cho mọi filter option. Tài liệu này bổ sung [bảng tương thích](FEATURE-MATRIX.md), [rà soát ngày 6/9](MV3-CAPABILITY-AUDIT-2026-09-06.md) và [đợt triển khai parity ngày 6/9](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). Các tài liệu ngày 6/9 vẫn giữ kết quả lịch sử của chúng. Những nhận định đã lỗi thời được liệt kê ở [phần cuối](#đính-chính-tài-liệu-cũ); trong [bảng tương thích](FEATURE-MATRIX.md) và [đợt triển khai parity](MV3-PARITY-IMPLEMENTATION-2026-09-06.md) chúng còn được đính chính tại chỗ.

Câu hỏi: MV3 hạn chế nhiều tính năng của uBlock Origin gốc. Giới hạn nào gỡ được, bằng cách nào và với giá nào?

**Kết luận ngắn:**

- Trong Google Chrome **không thể gỡ mọi giới hạn**. MV2 đã bị tắt vô điều kiện. Blocking `webRequest` cần tham số khởi động hoặc cài bằng policy. Quyết định chặn bất đồng bộ (Promise) cần cài bằng policy. Chrome không có API lọc body dạng stream hay trả chuỗi CNAME cho extension.
- Phần lớn khoảng trống thực tế **vẫn thu hẹp được**. Nhiều mục chỉ là lỗi compiler hoặc tính năng chưa làm, không phải giới hạn trình duyệt: báo cáo filter bị bỏ, `$empty`/`$mp4`, lỗi biên dịch `$requestheader` thành rule chặn vô điều kiện (bản thân option vẫn cần engine Experimental), `##^responseheader()`, remote font, CSP report, media lớn, strict-block không tốn regex.
- Thứ tự đề xuất: sửa trong bản **Standard** trước (bước 1–5), rồi đưa engine mạng cổ điển vào bản **Experimental** (bước 6–7). Ai muốn gỡ hết giới hạn thì con đường trung thực là **bản Firefox** (bước 8). Cài bằng policy, companion CNAME và bản debugger chỉ là tầng tùy chọn, có ghi rõ rủi ro, không bao giờ âm thầm thay đổi hệ thống.
- **Bước 1 đã hoàn tất trong thay đổi này:** compiler báo phần lớn filter không chuyển được và các lỗi runtime/stock đã sửa. Những gì còn bỏ im lặng được liệt kê cuối phần [lộ trình](#lộ-trình-11-bước).

## Phương pháp

- **Mã nguồn Chromium 153** (tag `153.0.8010.53`): đọc cổng quyền, hằng số DNR, đường xử lý Promise của `webRequest`, API debugger và DNS. Các dẫn chứng dưới đây trỏ đúng dòng trên GitHub.
- **Google Chrome 153.0.8010.53 trên Windows 11**, với extension thử nhỏ viết riêng cho từng câu hỏi. Mỗi probe dùng một profile tạm mới dưới `%TEMP%` (`--user-data-dir`) và xóa sau khi xong. Chạy cả có lẫn không có `--allowlisted-extension-id`, headless (`--headless=new`) và có cửa sổ. Request đi tới server HTTP/HTTPS cục bộ qua `--host-resolver-rules`, nên không phụ thuộc website thật. Probe không cài chứng chỉ, không sửa registry hay policy. Lưu ý cho người chạy lại: trên Windows, ngay cả `chrome.exe --version` cũng mở trình duyệt với profile mặc định, nên luôn truyền một `--user-data-dir` mới.
- **Node 24.15.0:** biên dịch 55 list stock đã cache (443.276 filter, trong đó 244.330 network filter), khôi phục engine `static-net-filtering.js` từ snapshot và đo so khớp trên 15.301 URL request thật thu từ 46 website công khai (1.326 host).
- **Chạy lại cả hai compiler** (stock lúc build và runtime `ubo-parser.js`) trên cùng các list cache để đếm filter bị bỏ.
- **Kiểm chứng độc lập:** năm lượt kiểm chứng chạy lại các kết luận quan trọng nhất. Khi số liệu khác nhau, tài liệu dùng số đã kiểm chứng; các chỗ sửa được ghi rõ.
- Máy đo: AMD Ryzen 5 5600H, 8 GB RAM. Hồ sơ thô nằm trong `tmp/research/` (không đưa vào Git): `plan.json` (bảng giới hạn, lộ trình), `step1-claims.json` (bằng chứng theo file:dòng), các thư mục probe `gap-inventory`, `platform-facts`, `engine`, `bodies`, `synth` và `verify-0` … `verify-4`.

## Kết luận

### Những điều không thể làm trong Google Chrome

1. **Chạy uBO cổ điển hay bất kỳ extension MV2 nào** trong Chrome 153+. [`ShouldDisableLegacyExtensions()`](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/browser/manifest_v2_handler.cc#L111-L118) luôn trả `true`; ngoại lệ duy nhất là một biến chỉ mã test bật được, không có tham số dòng lệnh hay policy nào. Nạp một extension MV2 qua CDP thất bại với lỗi `unsupported manifest version`. [Lịch ngừng MV2](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline).
2. **Tự cấp blocking `webRequest` từ bên trong extension.** Quyền [`webRequestBlocking`](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/common/api/_permission_features.json#L783-L792) trong MV3 chỉ dành cho `location: policy`; ngoài policy chỉ còn tham số `--allowlisted-extension-id` truyền lúc mở trình duyệt. Bản cài thường gọi `addListener(..., ['blocking'])` không bị lỗi, nhưng không nhận sự kiện nào.
3. **Quyết định chặn bất đồng bộ (Promise)** khi không cài bằng policy. Chrome [chỉ cho phép phản hồi bất đồng bộ](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/renderer/api/web_request_natives.cc#L92-L102) với MV3 cài từ policy, nên engine không thể chờ dữ liệu đọc bất đồng bộ trước khi trả lời. Dựng engine đồng bộ ngay khi worker nạp khiến Chrome giữ request lại chờ engine (xem [số đo](#engine-mạng-cổ-điển-trong-service-worker-experimental)), nhưng trạng thái người dùng vẫn đọc bất đồng bộ, nên vẫn còn một khoảng fail-open sau khi worker thức dậy. uBO cổ điển trên Chromium cũng không giữ được request, nhưng background page của nó không bao giờ ngủ.
4. **Nâng hạn mức DNR:** 50 static ruleset bật, 30.000 static rule bảo đảm, 30.000 dynamic (5.000 unsafe), 5.000 session, 1.000 regex mỗi pool, chương trình RE2 tối đa 2 KB, không lookaround hay backreference.
5. **Để `webRequest` đảo ngược quyết định DNR.** DNR block/redirect chạy trước và thắng; thay đổi header của DNR cũng thắng. Engine đặt trên DNR chỉ có thể chặn thêm.
6. **Lọc body dạng stream** (tương đương `filterResponseData`). Trong API extension, đường duy nhất tới body là `chrome.debugger`: đệm toàn bộ body, không chạm được response do service worker của trang tạo ra, quyền không thể là tùy chọn và có thanh cảnh báo.
7. **Phân giải CNAME trong trình duyệt.** Không API extension nào của Chrome trả chuỗi CNAME. Ngay cả khi được cấp, [`chrome.dns`](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/common/api/dns.webidl) chỉ trả một địa chỉ IP. Chỉ một process native bên ngoài làm được, và bản cài không phải policy không thể chờ nó trước request đầu tiên.
8. **Chặn subresource theo IP trước khi gửi** (`$ipaddress`). IP chỉ biết được sau khi response bắt đầu; uBO cổ điển trên Chromium cũng chỉ áp dụng cho `main_frame` sau thời điểm đó.
9. **Tự bật công tắc Allow User Scripts, biến bản cài thành policy-installed qua tham số dòng lệnh, hoặc ẩn thanh cảnh báo cờ không được hỗ trợ.**
10. **Lọc trang `chrome://`, Chrome Web Store hoặc trang của extension khác.** Đây không phải thụt lùi: uBO cổ điển trên Chrome cũng không làm được.

### Ba tầng sản phẩm

| Tầng | Cách chạy | Gỡ được | Không gỡ được |
| --- | --- | --- | --- |
| **Standard** (bản hiện tại) | Extension unpacked, DNR, không tham số đặc biệt | Báo cáo trung thực; sửa lỗi compiler; strict-block không tốn regex và giải phóng pool regex; công tắc remote font, CSP report, scripting, media lớn; `$inline-script`/`$inline-font`; một compiler cho mọi nguồn; logger, picker, popup, `$ipaddress` cho `main_frame` | Hạn mức DNR, RE2, `$redirect-rule`, regex/negated `$removeparam`, `$strict1p`/`$strict3p`. Chỉ gỡ một phần: entity/regex domain ([dòng 17](#bảng-41-giới-hạn), chưa thử), cập nhật stock list không qua bản phát hành (dòng 39) |
| **Experimental** | Launcher Windows mở profile riêng với `--allowlisted-extension-id` | Thêm engine mạng cổ điển (`static-net-filtering.js`) chạy trong một listener đồng bộ duy nhất: `$redirect-rule`, regex/negated `$removeparam`, ngoại lệ `$csp` chính xác, regex `$header=`, `$requestheader`, `$strict1p`/`$strict3p`, `$uritransform`, `$urlskip` tự động, entity/regex domain, regex ngoài RE2, không còn hạn mức rule, cập nhật list lúc chạy, firewall/URL rule/công tắc hostname cổ điển | Body/HTML filtering, CNAME, quyết định bất đồng bộ. DNR vẫn phải chạy làm nền |
| **Firefox** (bản mới) | Bản Plus+ cho Firefox với adapter engine | Các giới hạn còn lại của hai tầng trên, gồm [`filterResponseData`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData) cho `##^` và `$replace`, [`dns.resolve`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/dns/resolve) có `canonical_name`, và phản hồi Promise | Người dùng phải đổi trình duyệt; cần ký AMO. Mozilla giữ blocking `webRequest` trong MV3 ([thông báo 3/2024](https://blog.mozilla.org/addons/2024/03/13/manifest-v3-manifest-v2-march-2024-update/)) |

Bản Firefox MV3 hiện có của Plus+ chỉ dùng DNR và không xin quyền `webRequest`, `dns` hay `webRequestFilterResponse`.

### Tầng tùy chọn có rủi ro

Không tầng nào dưới đây được bật mặc định. Mỗi tầng cần người dùng chủ động chọn, sau khi đọc tài liệu và rủi ro.

- **Cài bằng policy (managed):** trên máy người dùng vốn đã quản lý (AD/Azure AD hoặc Chrome Enterprise Core), MV3 cài từ policy được phản hồi Promise, không cần tham số hay thanh cảnh báo, và debugger không hiện thanh cảnh báo. Đổi lại, console quản lý có quyền rộng trên trình duyệt. Extension và launcher không bao giờ tự enroll hay ghi policy. Chưa kiểm thử trên máy managed thật.
- **Companion CNAME native:** một process cài riêng dùng resolver của hệ điều hành. `Resolve-DnsName` trả đủ chuỗi, lookup đã cache mất khoảng 4 ms. Bản không cài bằng policy vẫn để lọt request đầu tiên tới host mới. Không dùng DoH: nó gửi mọi hostname cho bên thứ ba, và câu trả lời khác resolver hệ điều hành.
- **Bản “Body” dùng `chrome.debugger`** cho `##^` và `$replace`: xem các [lưu ý của đường debugger](#lưu-ý-về-đường-debugger).
- **Proxy chặn TLS cục bộ:** probe sửa được document, script, JSON, worker và iframe. Nhưng Chrome chỉ chấp nhận chứng chỉ khi chạy với `--ignore-certificate-errors-spki-list` (cũng nằm trong [danh sách cờ cảnh báo](https://github.com/chromium/chromium/blob/153.0.8010.53/chrome/browser/ui/startup/bad_flags_prompt.cc#L103-L107)) hoặc khi cài chứng chỉ gốc vào hệ thống. Không làm: đây là hạ cấp bảo mật HTTPS.
- **Trình duyệt Chromium còn MV2:** Brave tự lưu trữ uBO MV2 ([Brave về MV3](https://brave.com/blog/brave-shields-manifest-v3/)); các bản vá như [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium) giữ MV2. Hỗ trợ MV2 ở các trình duyệt này chỉ là best-effort. Đây là sản phẩm khác, không phải capability của Google Chrome. Các nhận định trong mục này lấy từ nguồn thứ cấp và chưa được kiểm chứng: nghiên cứu không cài trình duyệt nào trong số đó.

### Lưu ý về đường debugger

Quyền `debugger` [không thể là optional](https://github.com/chromium/chromium/blob/153.0.8010.53/chrome/common/extensions/permissions/chrome_api_permissions.cc#L210-L213), nên cần một bản build riêng. Probe trên Chrome 153 xác nhận viết lại được document chính, document gzip, document 2,16 MB và iframe khác process, nhưng:

- Chrome hiện thanh “đang gỡ lỗi trình duyệt này” trừ khi dùng `--silent-debugger-extension-api` hoặc cài bằng policy ([debugger_api.cc](https://github.com/chromium/chromium/blob/153.0.8010.53/chrome/browser/extensions/api/debugger/debugger_api.cc#L581-L586)). Tham số đó ẩn cảnh báo cho mọi extension trong process, nên không được tự thêm.
- **Iframe tới địa chỉ mạng cục bộ** kích hoạt hộp thoại [Local Network Access](https://developer.chrome.com/blog/local-network-access). Với cài đặt mặc định, trang thử không tải xong trong thời gian chờ; tắt kiểm tra LNA thì chạy bình thường.
- **Response do service worker của trang tạo ra** không đi qua Fetch của tab, nên bị bỏ sót.
- **Document đầu tiên của tab mở kèm URL** bị bỏ sót, vì attach đến muộn 5–13 ms.
- **Subresource của iframe khác site** chỉ bị chặn khi dùng auto-attach ([`Target.setAutoAttach`](https://chromedevtools.github.io/devtools-protocol/tot/Target/)) cho target con.
- Body được đệm toàn bộ (121–141 ms cho 2,16 MB), nên mất hiển thị dần. Phiên attach giữ worker sống. Theo tài liệu Chrome, mở DevTools sẽ detach extension (chưa thử).

## Số liệu đo

Mọi số dưới đây là của **một bản Chrome (153.0.8010.53) trên một máy (Ryzen 5 5600H, 8 GB RAM)**. Máy chậm hơn sẽ có khoảng chờ dài hơn.

### Engine mạng cổ điển trong service worker (Experimental)

Hai hồ sơ list: *mặc định* (6 list, 138.922 filter) và *nặng* (23 list, 203.598 filter). Engine được khôi phục từ snapshot structured-clone trong IndexedDB.

| Đại lượng | Kết quả |
| --- | --- |
| Engine sẵn sàng sau mỗi lần worker khởi động thật | **60–75 ms** (mặc định), **75–95 ms** (nặng) |
| Tính từ lúc bắt đầu điều hướng | khoảng **92–109 ms** (mặc định), **107–122 ms** (nặng) |
| Request đi qua engine trước khi sẵn sàng | luôn có `main_frame`; tối đa **44** trong khoảng 150 request của trang thử, với khoảng nghỉ thực tế 5 s hoặc 35 s giữa các lần tải. Chỉ DNR nền lọc các request này |
| So khớp trong Chrome | **30–150 µs/request** trong vài trăm request đầu sau khi khởi động; **6–8 µs** khi đã nóng |
| So khớp trong Node (15.301 URL thật, sau khi JIT đã nóng) | chỉ so khớp: trung bình **5,55 µs/request** (p50 3,8 µs, p99 20,3 µs); cả pipeline (block, redirect-rule, removeparam, urlskip, csp/permissions, header=): trung bình 7,56 µs (p50 5,8 µs). Hồ sơ nặng: 7,96 / 10,39 µs |
| Bộ nhớ worker tăng thêm | **9–16 MiB** (JS heap cộng backing store) |
| Worker dừng khi rảnh | sau khoảng 30 s; mọi sự kiện `webRequest` đặt lại bộ đếm, nên worker ở lại trong lúc duyệt web |

Kiểm chứng đã sửa các số ban đầu của nhóm nghiên cứu: thời gian sẵn sàng 48–67 ms thành 60–95 ms (đo với worker thực sự dừng rồi khởi động lại); khoảng chỉ có DNR “25–65 ms” thành engine sẵn sàng khoảng 92–122 ms sau khi bắt đầu điều hướng, tùy hồ sơ list; so khớp “tối đa khoảng 10 µs” thành 30–150 µs trong vài trăm request đầu (6–8 µs khi nóng); bộ nhớ “7–25 MB” thành 9–16 MiB.

Hai phép đo quyết định thiết kế:

- **Phản hồi Promise bị bỏ qua** khi không cài bằng policy. Cả bốn biến thể trả Promise (hủy ngay, hủy sau một lúc, hàm `async`, redirect) đều để request tới server, trong khi cùng quyết định trả đồng bộ thì có hiệu lực. Khi engine nạp bất đồng bộ (300 ms), cả 32/32 request của một đợt burst đánh thức worker đi qua listener trước khi engine sẵn sàng.
- **Dựng engine đồng bộ ở top level của worker** (từ JS literal, không đọc IndexedDB) khiến Chrome giữ request chờ: **0/32** request đi qua trước khi engine sẵn sàng, đổi lại trễ khoảng **100–115 ms** (chỉ đo với list mặc định). Dù vậy DNR nền vẫn cần: Chrome có thể được mở mà không có tham số allowlist, trạng thái người dùng (chế độ lọc, danh sách bật) vẫn đọc bất đồng bộ, và lần khởi động nguội của cả trình duyệt chưa được đo.

Thứ tự quyết định: DNR block/redirect thắng `webRequest` (DNR block cộng `webRequest` redirect cho kết quả `ERR_BLOCKED_BY_CLIENT`; DNR allow priority 100 không cản được `webRequest` cancel). Rule DNR có điều kiện response header chạy ở giai đoạn `onHeadersReceived`, tức là sau khi request đã gửi.

### Hằng số DNR trên Chrome 153

Theo [declarative_net_request.webidl](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/common/api/declarative_net_request.webidl#L884-L926), [constants.h](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/browser/api/declarative_net_request/constants.h#L296-L305) và probe vượt mỗi hạn mức thêm một rule:

| Hạn mức | Giá trị |
| --- | --- |
| Static ruleset khai báo / bật | 100 / 50 |
| Static rule bảo đảm cho mỗi extension | 30.000 |
| Pool static toàn profile | 300.000 (`getAvailableStaticRuleCount()` trả 330.000 trên profile mới, tức 300.000 + 30.000 bảo đảm; 311.397 khi đã nạp Plus+) |
| Dynamic rule | 30.000, trong đó 5.000 unsafe |
| Session rule | 5.000 (5.000 unsafe) |
| Regex | 1.000 dùng chung cho dynamic + session; static ruleset đang bật có pool 1.000 riêng |
| Static rule bị tắt bằng `updateStaticRules` | 5.000 |
| Kích thước regex sau biên dịch | 2 KB; không lookaround, không backreference |

Với sáu list mặc định: Chrome từ chối **80/254** regex rule stock (79 `memoryLimitExceeded`, 1 `syntaxError`). 174 regex còn lại cài thành dynamic rule, cộng 826 session rule của strict-block là đúng **1.000**. 278 strict-block rule hợp lệ bị bỏ, và filter nhập thêm hay cá nhân không còn chỗ cho regex.

Probe pool regex: sau khi bật các static ruleset có tổng 902 regex, vẫn thêm được 1.000 dynamic regex. Với bản cài unpacked (cách Plus+ được phân phối), một regex sai cú pháp trong bất kỳ static ruleset nào, kể cả ruleset không bật, làm Chrome từ chối nạp cả extension. Ruleset làm tổng regex vượt 1.000 thì không được bật, và regex quá lớn bị bỏ qua mà không có cảnh báo.

### Báo cáo compiler stock sau bước 1

Trước thay đổi này, `log.txt` ghi `Unsupported: 0` cho cả 55 list, còn `ruleset-details.json` ghi `rejected: 0`. Chạy lại cùng compiler trên cùng list cho thấy 1.310 **rule entry** có `_error` bị bỏ im lặng. Nay đơn vị đếm là **filter nguồn**: một filter sinh nhiều entry chỉ được đếm một lần, theo lỗi đầu tiên của nó.

| Lý do | Số filter |
| --- | ---: |
| `unsupported-redirect-rule` | 530 |
| `unsupported-domain` (entity/regex trong `domain=`, `to=`, `denyallow=`) | 337 |
| `unsupported-regex` | 92 |
| `unsupported-removeparam-regex` | 76 |
| `unsupported-ipaddress` | 54 |
| `invalid-filter` | 53 |
| `unsupported-strict-first-party` | 22 |
| `unsupported-urltransform-regex` | 17 |
| `unsupported-strict-third-party` | 14 |
| `unsupported-header-value` | 6 |
| `invalid-network-filter` | 5 |
| `unsupported-redirect-resource` | 4 |
| `unsupported-removeparam-negated` | 2 |
| `unsupported-requestheader` | 1 |
| **Tổng, trong 32/55 list** | **1.213** |

Tổng này gồm hai loại. Khoảng **1.155** filter hợp lệ nhưng DNR không biểu diễn được. **58** filter còn lại (`invalid-filter` 53, `invalid-network-filter` 5) là filter không hợp lệ mà uBO cổ điển cũng từ chối; 51 trong số đó không phải network filter mà là cosmetic hoặc scriptlet filter có lỗi cú pháp, ví dụ `gamepadla.com#?#.pMain:has(div:-abp-properties(Partner))`.

Build đạt validator: 55 ruleset, 70.310 static DNR rule (cộng 607 regex rule đóng gói trong `rulesets/regex`, cài thành dynamic rule lúc chạy khi list được bật). Rule được sinh ra giữ nguyên, trừ các chỗ sửa có chủ ý: hai rule removeparam phủ định trong `adguard-spyware-url` bị bỏ, rule `##^responseheader()` trong `ublock-filters`, `irn-0` và `rus-0` được dựng lại, và hai rule removeparam `main_frame` quá rộng trong `ublock-filters` bị bỏ.

## Bảng 41 giới hạn

Cột **Kết luận** giữ nguyên phán quyết của nghiên cứu: **Standard** (gỡ được trong bản DNR), **Experimental** (cần bản có blocking `webRequest`), **Một phần**, **Companion** (cần process native), **Trình duyệt khác**. “Bước 1” đánh dấu các dòng đã sửa trong thay đổi này.

| # | Giới hạn | Hiện trạng | Kết luận | Cách gỡ và lưu ý |
| ---: | --- | --- | --- | --- |
| 1 | uBO cổ điển (MV2) không chạy được trong Chrome | Không áp dụng; Plus+ buộc phải là MV3 | Trình duyệt khác | Firefox, Brave, bản Chromium vá MV2. Trong Chrome chỉ gỡ từng giới hạn theo các dòng dưới |
| 2 | Không có blocking `webRequest` | Standard: không. Experimental: có qua launcher, chỉ dùng cho firewall `block` | Experimental | Đặt engine cổ điển lên đường launcher (bước 6). Đã xác minh cancel, redirect tới `data:` và resource web-accessible, redirect `main_frame`, thêm/xóa response header, thêm request header |
| 3 | Không có background page thường trực; không giữ được request | Standard: DNR luôn chạy. Experimental: Promise bị bỏ qua, worker ngủ sau khoảng 30 s | Một phần | Đăng ký listener đồng bộ; khôi phục engine từ IndexedDB (60–95 ms) hoặc dựng đồng bộ ở top level (Chrome giữ request, trễ khoảng 100–115 ms với list mặc định); luôn giữ DNR nền. Tránh top-level `await` (worker không khởi động) và import JSON module (khởi động lại liên tục) |
| 4 | Hạn mức rule DNR | Xem [hằng số](#hằng-số-dnr-trên-chrome-153) | Experimental | Engine cổ điển không có hạn mức (đã đo 203.598 filter); thêm 9–16 MiB bộ nhớ worker. Standard không nâng được |
| 5 | Pool 1.000 regex dynamic + session đã đầy với list mặc định | 174 + 826 = 1.000; 278 strict-block rule bị bỏ | Standard | (a) Strict-block bằng redirect `extensionPath` tới `/strictblock.html`, lấy URL gốc từ `webNavigation.onBeforeNavigate`: không cần regex. (b) Chuyển regex stock hợp lệ sang static ruleset (pool riêng). Build phải kiểm cú pháp regex; runtime phải báo ruleset/regex không được bật. Trang strict-block chỉ hiện đúng URL với điều hướng `main_frame` trực tiếp. Sau server redirect nó hiện URL ban đầu của điều hướng (trang chuyển hướng) thay vì URL bị chặn; sau back/forward có thể hiện URL của một điều hướng khác; tab nhân bản (Duplicate) không có URL và hiện `null` |
| 6 | RE2: không lookaround/backreference, tối đa 2 KB | 80/254 regex mặc định bị từ chối | Experimental | Engine cổ điển dùng `RegExp` của JavaScript; chỉ có hiệu lực sau khi engine sẵn sàng |
| 7 | `$redirect-rule` (530 filter) | Không hỗ trợ; nay được đếm và báo | Experimental | Engine chỉ redirect khi request vốn bị chặn. Rule DNR block trùng request phải bị loại khỏi bản này, vì DNR block thắng redirect của `webRequest` |
| 8 | Resource `$redirect=` cho filter nhập thêm/cá nhân (10/47 chưa đóng gói) | **Đã sửa (bước 1):** đóng gói và khai báo web-accessible 46 resource cùng alias. `click2load.html` bị cả hai compiler từ chối và ghi trong `rulesets/redirect-resources.json` | Standard | Build dừng nếu thiếu file resource. Filter `redirect=` trỏ resource không dùng được bị bỏ (uBO cổ điển vẫn chặn request đó) |
| 9 | `$empty`, `$mp4` ở runtime | **Đã sửa (bước 1):** redirect tới `empty` và `noop-1s.mp4` như stock thay vì chặn mọi loại request | Standard | Ngoại lệ `@@…$empty/$mp4/$redirect` bị từ chối (`unsupported-redirect-exception`) |
| 10 | `$requestheader` | **Đã sửa ở Standard (bước 1):** runtime từ chối thay vì chặn vô điều kiện; stock đếm và báo | Experimental | Engine ghi header ở `onBeforeSendHeaders` rồi hủy ở `onHeadersReceived` như uBO cổ điển; request đã được gửi đi |
| 11 | `$removeparam` regex, phủ định, không giá trị | **Bước 1:** bare `$removeparam` xóa cả query (`query: ''`); stock báo giá trị phủ định thay vì sinh rule không bao giờ khớp. Regex vẫn không hỗ trợ | Experimental | Engine xóa tham số bằng redirect; tránh vòng lặp redirect nếu DNR cũng có rule đó |
| 12 | Ngoại lệ `$csp`/`$permissions` quá rộng | Ngoại lệ thành allow priority 1, hủy cả rule header/removeparam khác | Experimental | Standard (một phần): trừ domain của ngoại lệ lúc biên dịch. Experimental: chèn CSP chính xác ở `onHeadersReceived`, bỏ rule csp/permissions khỏi DNR |
| 13 | `$header=` regex/phức tạp | Chỉ giá trị chính xác hoặc glob | Experimental | So khớp ở `onHeadersReceived` rồi hủy |
| 14 | `$uritransform` | Bị từ chối; `@@…$uritransform` ở runtime nay bị từ chối (bước 1) thay vì thành redirect | Experimental | Redirect trong `onBeforeRequest`, chỉ cho nguồn tin cậy. Standard có thể dùng `regexSubstitution` khi pool regex được giải phóng |
| 15 | `$urlskip` | Chỉ list stock, dạng liên kết thủ công trên trang strict-block | Experimental | Tự chuyển hướng `main_frame` bằng `src/js/urlskip.js`, có kiểm tra độ tin cậy của nguồn |
| 16 | `$strict1p`/`$strict3p` | Không hỗ trợ (DNR không có điều kiện hostname bằng nhau) | Experimental | Engine cổ điển |
| 17 | Entity (`example.*`) và regex trong `domain=`, `to=`, `denyallow=` | 337 filter stock bị bỏ, có filter khác được “salvage” bằng cách bỏ phần không hỗ trợ. Hostname entity/regex bị phủ định (`domain=~example.*`) bị bỏ im lặng, không cảnh báo, không đếm, làm rule rộng hơn: 187 filter trong bản chụp này, ví dụ `/data/banner.json?$domain=~nintendo.*` (`kor-1`) thành rule chặn trên mọi site, kể cả site bị loại trừ | Experimental | Engine khớp chính xác. Standard (chưa thử): mở rộng `example.*` theo public suffix lúc build |
| 18 | `$ipaddress` | Không hỗ trợ | Standard | Như uBO trên Chromium: đọc `details.ip` ở `onResponseStarted` (quyền `webRequest` tùy chọn) rồi đưa tab tới trang strict-block. Chỉ cho `main_frame`, sau khi document bắt đầu tải. Chưa xây dựng. Đây là thụt lùi thật so với uBO cổ điển trên Chromium |
| 19 | `$popup` có điều kiện party, `$popunder` stock | 45 filter mặc định bị hoãn; stock bỏ `$popunder` | Standard | uBO cổ điển cũng chặn popup qua `webNavigation`. Dùng matcher đầy đủ trong observer, nạp lười |
| 20 | `$inline-script`, `$inline-font`, ô firewall inline-script | Bị từ chối/bỏ | Standard | Chèn CSP bằng DNR `modifyHeaders` trên `main_frame`/`sub_frame`, giới hạn bằng `topDomains`; đã xác minh |
| 21 | `$ghide`/`$ehide`/`$shide` ở runtime | Runtime từ chối (1.743 trong corpus) | Standard | Sinh generic-cosmetic exclusion như stock (bước 4) |
| 22 | `$badfilter` nhắm rule stock | Chỉ dựng lại nhóm hostname chặn; phần khác hoãn | Standard | Áp mọi `$badfilter` stock-stock lúc build; `disableRuleIds` cho filter người dùng (tối đa 5.000) |
| 23 | Build stock bỏ rule im lặng | **Đã sửa (bước 1):** đếm theo lý do trong `log.txt`, `ruleset-details.json`, tổng lúc build; validator đối chiếu; tooltip của dashboard hiện số filter không chuyển được thành quy tắc Chrome | Standard | Vẫn chưa được đếm: hostname entity bị bỏ khỏi filter chuyển một phần, hostname entity/regex bị phủ định (dòng 17, bỏ im lặng) và hai trường hợp `$urlskip` |
| 24 | Strict-block cho `$doc` nhập thêm/cá nhân | Chặn DNR thường, không có nút tiếp tục | Standard | Như dòng 5, cộng allow session tạm để tiếp tục |
| 25 | Generic cosmetic, ngoại lệ generic, hostname chỉ phủ định, `*##` trong list nhập thêm | Runtime bỏ | Standard | Dùng lại pipeline generic-cosmetic của stock, chèn qua `userScripts` |
| 26 | Cosmetic/scriptlet runtime cần công tắc Allow User Scripts | Extension không tự bật được | Một phần | Phát hiện và hướng dẫn; đường stock vẫn chạy khi tắt. Trên Chrome 153 API xuất hiện trong worker đang chạy mà không cần reload. [userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts) |
| 27 | Scriptlet `trusted-*` từ list nhập thêm | Không bao giờ tin | Standard | Tin list có URL khớp đúng tiền tố tin cậy của build, như uBO |
| 28 | HTML filtering (`##^`, 232 filter). Chỉ có trên Firefox ngay cả với uBO cổ điển | Bỏ im lặng | Một phần | Chỉ qua debugger (bản riêng, bước 11 của lộ trình). Tương đương stream cần Firefox |
| 29 | `$replace` (15 filter trong list mặc định). Chỉ có trên Firefox với uBO cổ điển | Bị từ chối | Một phần | Như dòng 28, phạm vi rộng hơn (XHR, script, JSON, HLS, DASH), khoảng +1 ms mỗi request bị `Fetch` tạm dừng để xử lý (đo trên loopback) |
| 30 | Ngữ nghĩa `##^responseheader()` | **Stock đã sửa (bước 1):** khóa theo hostname của chính response (`requestDomains`), áp mọi loại tài nguyên, tôn trọng ngoại lệ. Runtime vẫn bỏ im lặng | Standard | Còn gần đúng: ngoại lệ chỉ áp trong cùng list; `@@` mạng khớp cùng request hủy việc xóa header. Thêm nhánh runtime ở bước 4. Khác với HTML filtering, đây là thụt lùi thật so với uBO cổ điển trên Chromium |
| 31 | CNAME uncloaking. Chỉ có trên Firefox với uBO cổ điển | Không có. `chrome.dns` được cấp dưới tham số allowlist cho extension khai báo `dns` trong manifest (gói Experimental không khai báo), nhưng chỉ trả một IP | Companion | Companion native dùng resolver hệ điều hành (bước 10); bản policy có thể chờ lookup |
| 32 | Công tắc no-remote-fonts, no-csp-reports, no-scripting | Chưa làm | Standard | Mỗi công tắc một dynamic rule với `topDomains` (Chrome 145+): chặn `font`; chặn `csp_report`; chặn `script` và thêm CSP. Đã xác minh cả ba. Upload Reporting API (`report-to`) không hiện với DNR lẫn `webRequest` |
| 33 | Công tắc no-large-media | Chưa làm | Standard | Hai rule DNR theo `Content-Length` trên image/media chặn đúng từ 50.000 byte, một ngưỡng gần đúng: mẫu glob của probe chỉ xét chữ số đầu, còn uBO mặc định 50 KiB (51.200 byte) và người dùng đổi được giá trị này. Ngưỡng chính xác cần liệt kê thêm mẫu theo từng chữ số, chưa thử. Là kích thước đã nén; response chunked không có header nên lọt, như uBO khi thiếu header; request đã được gửi khi rule chạy. Kết hợp với `topDomains` chưa thử |
| 34 | Công tắc no-popups, no-cosmetic-filtering, no-strict-blocking | Có cơ chế gần tương đương | Standard | Đưa ra giao diện công tắc kiểu cổ điển, ghi rõ khác biệt |
| 35 | Ma trận firewall (tối đa 256 ô, không inline-script, không `main_frame`, không ma trận trong popup) | Một phần, trình soạn văn bản | Standard | Nâng giới hạn ô trong ngân sách 30.000 dynamic rule; inline-script qua CSP; giao diện ma trận. Experimental: port `dynamic-net-filtering.js` |
| 36 | URL rule với ngữ nghĩa `noop` | Chưa làm | Experimental | Port `url-net-filtering.js` và `hnswitches.js` theo thứ tự URL rule → firewall → static |
| 37 | Độ chi tiết logger | 512 bản ghi, hiện JSON rule DNR | Standard | Bản đồ rule ID → list, dòng, filter từ cả hai compiler; tạo filter từ logger |
| 38 | Picker chỉ tạo cosmetic filter | Chưa có ứng viên network | Standard | Port `netFilterCandidates` từ `src/js/scriptlets/epicker.js` |
| 39 | List stock chỉ cập nhật cùng bản phát hành | Không có Diff-Path | Experimental | Engine biên dịch list tải về trong offscreen. Standard (một phần): tắt rule stock đã xóa bằng `updateStaticRules`, thêm rule mới thành dynamic |
| 40 | Hai compiler khác nhau | Runtime từ chối/hoãn 4.231 filter của corpus stock (đo trước bước 1) | Standard | Chạy `static-net-filtering.js`/`static-dnr-filtering.js` trong offscreen cho mọi nguồn (bước 4). Bước 1 đã đồng bộ `$empty`, `$mp4`, `$requestheader` và resource redirect; các mã lý do dùng chung được viết giống nhau, nhưng domain và header vẫn khác mã (stock `unsupported-domain`, `unsupported-header-value`; runtime `invalid-from-domain-list`, `unsupported-response-header-regex`…) |
| 41 | Năng lực đầy đủ như Firefox: lọc body stream, CNAME chính xác, giữ request | Bản Firefox MV3 hiện có chỉ dùng DNR | Trình duyệt khác | Bản Firefox với adapter engine (bước 8) |

## Lộ trình 11 bước

| Bước | Nội dung | Công sức ước tính | Trạng thái |
| ---: | --- | --- | --- |
| 1 | Báo cáo trung thực và sửa lỗi compiler (cả hai bản) | 3–5 ngày | **Đã xong trong thay đổi này**, xem bên dưới |
| 2 | Giải phóng pool regex ở Standard: strict-block không dùng regex, regex stock sang static ruleset | 5–8 ngày | Cần kiểm cú pháp regex lúc build và job CI nạp gói trong Chrome thật |
| 3 | Công tắc theo site và option dựa trên CSP ở Standard: fonts, CSP report, scripting, media lớn, `$inline-script`/`$inline-font` | 6–10 ngày | Cần Chrome 145+ (`topDomains`) |
| 4 | Một compiler cho stock, list nhập thêm và bộ lọc cá nhân | 10–15 ngày | Cần ghim phiên bản engine `src/js` và test đối chiếu hai đường |
| 5 | Logger, picker và popup ngang uBO; `$ipaddress` cho `main_frame` | 7–10 ngày | Sau bước 4 |
| 6 | Experimental: engine mạng cổ điển chạy trong một listener đồng bộ | 20–30 ngày | Engine sẵn sàng 60–95 ms sau mỗi lần worker khởi động (hoặc dựng đồng bộ, trễ khoảng 100–115 ms, chỉ đo với list mặc định); +9–16 MiB; vẫn cần DNR nền |
| 7 | Experimental: firewall động, URL rule và công tắc hostname từ `src/js` | 5–10 ngày | Sau bước 6 |
| 8 | Bản Firefox của Plus+ với engine đầy đủ | 15–25 ngày (ước đoán) | Cần ký AMO, rà soát ID và thương hiệu |
| 9 | Adapter cài bằng policy, chỉ tài liệu | 5–10 ngày và một môi trường managed | Không bao giờ tự enroll hay ghi policy |
| 10 | Companion CNAME native opt-in (RFC trước) | 15–20 ngày | Cần rà soát quyền riêng tư; chỉ resolver hệ điều hành |
| 11 | R&D: bản “Body” dùng `chrome.debugger` cho `##^` và `$replace` | 20–40 ngày | Tỷ lệ giá trị/công sức thấp nhất |

**Bước 1 đã giao:**

- **Build stock:** filter không chuyển được được đếm theo lý do trong `log.txt`, `ruleset-details.json` (`rules.rejected`, `rules.rejectedReasons`, `filters.converted`) và tổng cuối build. `tools/validate-mv3.mjs` đối chiếu các số đó với file đã đóng gói. Tooltip của mỗi list stock trên dashboard dùng số filter đã chuyển thật (ví dụ `ublock-filters` 10.498 → 7.847) và thêm một dòng nêu số filter bị từ chối (`rules.rejected`), có bản dịch cho 10 ngôn ngữ được duy trì. Chuỗi hiển thị gọi đó là network filter mà Chrome không hỗ trợ, nhưng tổng này gồm cả 58 filter không hợp lệ mà uBO cổ điển cũng từ chối (51 là cosmetic/scriptlet, xem [bảng lý do](#báo-cáo-compiler-stock-sau-bước-1)).
- **`##^responseheader()` stock** khóa theo hostname của response, tôn trọng ngoại lệ, áp cho mọi loại tài nguyên. Filter chỉ có hostname entity/regex bị đếm là không hỗ trợ.
- **`removeparam=~name`** stock được báo thay vì sinh rule không bao giờ khớp. Khi filter removeparam có `domain=` cùng hostname pattern hoặc `to=`, rule cho lượt tải trang chỉ giữ hostname nằm trong cả hai danh sách; rule không thể khớp bị bỏ (cả stock lẫn runtime).
- **Resource redirect:** 46 resource đóng gói và web-accessible; `click2load.html` bị từ chối ở cả hai compiler.
- **Compiler runtime:** `$requestheader` bị từ chối; `$empty`/`$mp4` thành redirect; bare `$removeparam` xóa query; `@@…$uritransform` bị từ chối; `$permissions` nối nhiều policy bằng `, `; `important` trên removeparam/uritransform lấy priority 2 (dưới mọi block), trên csp/permissions lấy 31; `||host^$to=x` giữ cả hai điều kiện.
- Revision của compiled cache (`COMPILED_FILTERS_REVISION`) tăng lên 4, nên list nhập thêm đã biên dịch bằng compiler cũ được biên dịch lại thay vì giữ rule cũ.
- Test hồi quy: `tools/test-stock-compiler-honesty.mjs`, `tools/test-runtime-filter-options.mjs`.

**Còn mở sau bước 1:**

- Hostname entity/regex bị phủ định trong `domain=`, `to=` và `denyallow=` (ví dụ `domain=~example.*`) bị bỏ im lặng: không cảnh báo, không đếm. Rule còn lại áp cả cho các site lẽ ra được loại trừ. Bản chụp này có 187 filter như vậy (362 rule entry); ví dụ `||appleid.*.no^$domain=~en-svindelside-som-ikke-er-apple.*` (`nor-0`) thành rule chặn không điều kiện domain.
- 433 hostname entity/regex trong 151 rule entry stock (không tính entry đã bị từ chối) bị bỏ khi filter được chuyển một phần; chúng không được đếm là bị từ chối. Cảnh báo chỉ được ghi vào `log.txt` cho rule tĩnh không regex (144 dòng, 421 hostname); rule regex, strict-block và popup không có cảnh báo.
- Hai trường hợp `$urlskip` vẫn bị bỏ không báo.
- Runtime chưa có nhánh `##^responseheader()`.
- Compiler stock biến `||host^$to=x` thành `requestDomains: [host, x]`, tức chặn cả `x`. Probe Node trên 25 filter `to=` dương của list stock hiện tại không thấy rule nào bị ảnh hưởng.
- Ngoại lệ `@@…$redirect=` ở stock thành block priority 21, chặn cả khi không có filter nào khác chặn.
- Tooltip chỉ hiện số tổng cho list stock, và số đó gồm cả filter không hợp lệ dù chuỗi hiển thị gọi là network filter không được hỗ trợ; chưa có trang xem theo lý do hay dòng nguồn.

## Lưu ý trung thực

- **Tham số `--allowlisted-extension-id` là công cụ test.** Chromium kiểm tra nó bằng [`IsAllowlistedForTest`](https://github.com/chromium/chromium/blob/153.0.8010.53/extensions/common/features/simple_feature.cc#L735-L743); tham số nằm trong [danh sách cờ cảnh báo](https://github.com/chromium/chromium/blob/153.0.8010.53/chrome/browser/ui/startup/bad_flags_prompt.cc#L119-L121), nên Chrome hiện thanh cảnh báo mỗi phiên, và có thể bị gỡ ở bất kỳ bản phát hành nào.
- Tham số mở **mọi** tính năng bị chặn theo allowlist hoặc vị trí cài cho ID đó, không chỉ `webRequestBlocking`: probe khai báo `dns` trong manifest cũng nhận được `chrome.dns`. Tham số không cấp quyền mà manifest không khai báo; gói Experimental không khai báo `dns`. Nó không biến bản cài thành policy-installed: `installType` vẫn là `development` và phản hồi Promise vẫn bị bỏ qua.
- Chưa thử mở lại cùng một profile với tham số này qua nhiều lần khởi động, và chưa đo lần khởi động nguội của cả trình duyệt. Launcher hiện chỉ có cho Windows.
- Mọi số đo là của một bản Chrome và một máy, phần lớn với server cục bộ; không phải khảo sát website thực tế. Các kết luận Standard về strict-block, pool regex, `topDomains` và `Content-Length` được xác minh hai lần (probe `synth` và lượt kiểm chứng `verify-3`), trên cùng một máy.
- Công sức là ước tính của nhóm nghiên cứu, không phải cam kết. Bước 8 chưa được khảo sát chi tiết.
- Số filter bị từ chối phụ thuộc bản chụp list ngày 23/9/2026 (build ngày 24/9, dùng lại list đã tải) và sẽ thay đổi khi list cập nhật.

## Đính chính tài liệu cũ

- **`chrome.dns`:** trên Chrome Stable 153, API này được cấp khi chạy với `--allowlisted-extension-id` cho extension khai báo `dns` trong manifest (gói Experimental không khai báo); không có tham số thì manifest báo cần Dev channel. Khi được cấp, `resolve()` chỉ trả một IP và mã kết quả, không bao giờ trả chuỗi CNAME. Đã sửa trong [FEATURE-MATRIX.md](FEATURE-MATRIX.md) và [MV3-PARITY-IMPLEMENTATION-2026-09-06.md](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). [USERSCRIPTS-AND-MV3-2026-09-06.md](USERSCRIPTS-AND-MV3-2026-09-06.md) vẫn ghi `chrome.dns` “hiện dành cho Dev channel”; câu đó chưa được sửa tại chỗ và cần đọc theo đính chính này.
- **no-large-media:** DNR biểu diễn được bằng hai rule `Content-Length`, không cần debugger hay proxy. Giới hạn: kích thước đã nén, response chunked không được xét, và ngưỡng đã thử là 50.000 byte chứ không phải đúng 51.200 byte của uBO.
- **Remote font và CSP report qua `report-uri`:** là khoảng trống sản phẩm mà DNR chặn được, không phải giới hạn trình duyệt. Upload qua Reporting API (`report-to`) không hiện với DNR lẫn `webRequest` trong probe; chặn được hay không vẫn chưa rõ (ví dụ bằng cách xóa header `Reporting-Endpoints`, chưa thử).
- **Đường debugger:** bổ sung các lưu ý Local Network Access, service worker của trang, tab mới và auto-attach ở [trên](#lưu-ý-về-đường-debugger).
- **Regex:** tài liệu ngày 6/9 nêu sáu ngoại lệ regex bị Chrome 152 từ chối; với list mặc định, Chrome 153 từ chối 80/254 regex rule stock.
- **Báo cáo compiler:** bảng tương thích từng coi “không có silent drop” là điều kiện phát hành trong khi build stock vẫn ghi `Unsupported: 0`. Nay số filter bị từ chối được báo và kiểm tra, nhưng điều kiện đó vẫn chưa đạt: hostname entity/regex bị phủ định vẫn bị bỏ im lặng (xem [việc còn mở](#lộ-trình-11-bước)).
