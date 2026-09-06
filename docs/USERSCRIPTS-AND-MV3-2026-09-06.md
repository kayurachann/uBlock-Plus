# Userscript, giới hạn MV3 và hướng nâng cấp

Rà soát ngày **6/9/2026**, đối chiếu với **uBlock Origin đầy đủ**. Mã nền được xem tại commit `56fd95f`; đợt này bổ sung logo nhận diện, regression theo issue và thí nghiệm Chrome. Các đề xuất dưới đây chưa tự trở thành tính năng đã phát hành.

## Userscript có thể bỏ qua mọi giới hạn không?

**Không.** Userscript là một lớp thực thi JavaScript trong trang, không phải quyền điều khiển toàn bộ network stack. Nó có thể mở rộng đáng kể bộ lọc theo website, nhưng quyền chặn mạng và quota vẫn do trình duyệt quyết định. Bản này đã dùng `chrome.userScripts.register()` ở `document_start` cho scriptlet; không cần cài thêm một userscript manager để có lớp thực thi đó. [Chrome userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

API này còn cho phép mã do người dùng cung cấp, nhưng bản hiện tại vẫn dùng nó cho tập filter/scriptlet được hỗ trợ; chưa triển khai một manager tương thích toàn bộ `GM_*`. Cho phép nhập JavaScript tùy ý cũng không làm thay đổi quyền network của extension.

| Nhu cầu | Userscript giúp được gì | Phần vẫn còn giới hạn |
| --- | --- | --- |
| DOM, anti-adblock, scriptlet theo website | Sửa DOM, hook API JavaScript, xử lý dữ liệu trang | Cần scope/ngoại lệ đúng; không bảo đảm mọi trang và thời điểm đều được bao phủ |
| `fetch`/XHR/JSON trong trang | Chặn lời gọi hoặc sửa response đi qua hook đã đăng ký | Request từ parser, context chưa được hook, Worker/Service Worker và tài liệu HTML chính không tự đi qua hook đó |
| CSP và isolated world | `USER_SCRIPT` có môi trường/CSP riêng; `MAIN` can thiệp môi trường trang | Đổi world không cấp thêm quyền network; MAIN chia sẻ môi trường với trang |
| Firewall, DNR/regex quota | Có thể bổ sung quyết định ở API trong trang | Không tăng quota hay thay phép quyết định network đồng bộ của trình duyệt |
| Sửa HTML trước parser, DNS/CNAME | Không có API userscript tương đương trong bản này | Cần API/tầng khác; phải phân biệt uBO trên Chromium với khả năng riêng của Firefox |
| Logger | Có thể bổ sung attempt/hook/effect có kiểu rõ ràng | Sự kiện từ MAIN không tự là bằng chứng độc lập; thiếu record không chứng minh scriptlet không chạy |

Nguồn cho các ranh giới: [Chrome content scripts và frames](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [DNR limits](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#rule-limits), [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest), [uBO trên Firefox](https://github.com/gorhill/uBlock/wiki/uBlock-Origin-works-best-on-Firefox).

Tampermonkey cũng chịu sự phân chia này: tài liệu ghi `GM_webRequest` không còn ở bản MV3 từ 5.2+, còn `GM_xmlhttpRequest` tạo request qua lớp nền của extension. Nó không chặn/sửa mọi request vốn đã phát sinh từ trang. Chuyển lời gọi qua bridge còn có thể làm khác cookie, origin, cache hoặc streaming; phải kiểm thử từng trường hợp. [GM_webRequest](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_webRequest), [GM_xmlhttpRequest](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest).

Đăng ký trước navigation với `document_start` giúp tránh độ trễ gửi lệnh từ worker sau khi trang bắt đầu. Ngược lại, `execute({ injectImmediately: true })` không bảo đảm chạy trước trang; một script chạy muộn không thu hồi được request đã gửi. `allFrames` cũng không có nghĩa mọi opaque origin đều đủ điều kiện injection. [Chrome execute](https://developer.chrome.com/docs/extensions/reference/api/userScripts#method-execute), [Violentmonkey run-at](https://violentmonkey.github.io/api/metadata-block/#run-at).

## Có đường giữ engine gần bản gốc hơn không?

**Có hướng managed riêng đáng đánh giá.** Chrome cho extension cài bằng policy phù hợp dùng `webRequestBlocking` trong MV3. Engine có thể quyết định request bằng mã thay vì buộc chuyển mọi filter sang DNR. Đây là quyền network riêng, không do userscript cấp. [Chrome webRequest permission](https://developer.chrome.com/docs/extensions/reference/api/webRequest#permissions).

[r58Playz/uBlock-mv3](https://github.com/r58Playz/uBlock-mv3#how-it-works) là ví dụ cụ thể: theo README/source của dự án, engine gốc chạy trong service worker qua `webRequest`, injection dùng scripting/userScripts, WebWorker được chuyển sang offscreen. Dự án mô tả hai cách cài với điều kiện khác nhau: policy và flag allowlist đặc biệt. Cách dùng flag không có toàn bộ hành vi startup của policy install; project mô tả cancel/reload trong lúc engine khởi tạo. Windows/macOS còn có hạn chế nguồn cài và quản lý thiết bị. Đây là kết quả đọc mã/tài liệu, **chưa chạy hoặc chứng nhận fork đó**.

[Thảo luận uBO #3561](https://github.com/uBlockOrigin/uBlock-issues/discussions/3561) đã nêu riêng hai vấn đề: quyền blocking và thay thế `tabs.executeScript`. Comment về `userScripts.execute` xử lý phần injection, không chứng minh chỉ userscript khôi phục toàn bộ quyền MV2. Phương án hợp lý nếu phát triển tiếp là một build Managed có danh tính/gói riêng và kiểm thử cold start, worker sleep, request lúc khởi động, rollback và quyền bị thu hồi. Không nhập nguyên cơ chế cancel/reload đó vào bản hiện tại vì sẽ đổi hành vi fail-open đã cam kết.

Ngay cả managed blocking cũng không tự cung cấp API response-body stream hay CNAME giống Firefox. `chrome.dns` hiện dành cho Dev channel và trả IP, không trả chuỗi CNAME. Debugger/CDP có thể đọc/sửa body theo target nhưng cần quyền và cơ chế pause/stream khác; xem [phân tích các đường mở rộng](MV3-PARITY-IMPLEMENTATION-2026-09-06.md). [Chrome DNS](https://developer.chrome.com/docs/extensions/reference/api/dns), [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger).

## Issue và góp ý đã đối chiếu

Trạng thái dưới đây được kiểm tra ngày 6/9/2026. Issue đã đóng được dùng làm nguồn ca hồi quy, không được mô tả là lỗi upstream vẫn chưa sửa.

| Nguồn | Điều học được | Áp dụng cho bản này |
| --- | --- | --- |
| [uBO #4037](https://github.com/uBlockOrigin/uBlock-issues/issues/4037), đóng 23/6/2026, wontfix | Inline fetch có thể thắng injection trong framework Chromium MV2; maintainer phân biệt với cơ chế MV3 | Kiểm tra fetch ở đầu HTML, cold/warm worker và reload; không suy ra mọi race MV3 đã hết |
| [uBO #1893](https://github.com/uBlockOrigin/uBlock-issues/issues/1893), còn mở | Đổi thứ tự scriptlet cùng hook một property có thể đổi kết quả | Thử hoán vị stock/imported/personal và hook trùng; IIFE riêng không giải quyết thứ tự hành vi |
| [Brave #56797](https://github.com/brave/brave-browser/issues/56797), sửa 1/7/2026 | Hai engine có thể va chạm khai báo trong scope scriptlet | Template hiện đã có IIFE; vẫn cần ca nhiều scriptlet và hook cùng API |
| [uBO #3811](https://github.com/uBlockOrigin/uBlock-issues/issues/3811), đóng 17/7/2026 | Cùng iframe CMP được dùng ở nhiều trang với hành động click khác nhau | Mở rộng fixture ancestor/nested/sandboxed frame; không coi cú pháp đề xuất trong issue là chuẩn đã có |
| [uBO #3787](https://github.com/uBlockOrigin/uBlock-issues/issues/3787), còn mở | JSON pruning giữa uBO và AdGuard có tham số khác nhau | Repo có `json-edit`/JSONPath; chỉ chuyển đổi cú pháp khi fixture chứng minh tương đương, tránh alias mù |
| [AdGuard #3164](https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3164), sửa 19/8/2026 | Scriptlet có thể thiếu trong logger | Ghi rõ registration/attempt/effect; bản hiện tại mới xác nhận đăng ký, ngoại lệ và fallback |
| [AdGuard #3428](https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3428), sửa 27/1/2026 | `$badfilter` từng hủy nhầm rule chỉ khác `$denyallow` | **Đã thêm regression trong đợt này**, qua compiler và phục hồi nguồn thật |
| [TSWebExtension changelog](https://github.com/AdguardTeam/tsurlfilter/blob/master/packages/tswebextension/CHANGELOG.md), mục 17/4 và 28/7/2026 | Bản beta tháng 4 lazy-load/giải phóng metadata; **5.0.0 tháng 7 đã giữ lại `badFilterRules` và `rulesHashMap` sau `configure()`** vì cached ruleset có thể trả metadata rỗng ở lần cấu hình tiếp theo; lazy reload từ IDB còn theo dõi AG-53262 | Không sao chép mù tối ưu tháng 4. Đo cấp phát, kiểm tra cấu hình lần hai, `$badfilter`, ngoại lệ và khôi phục worker; xem [đợt rà soát hiệu suất](PERFORMANCE-2026-09-06.md) |

Các scriptlet sửa response hiện có cũng có nguồn đối chiếu thực tế: [uBO #2742](https://github.com/uBlockOrigin/uBlock-issues/issues/2742) và [Resources Library](https://github.com/gorhill/uBlock/wiki/Resources-Library). Ưu tiên fixture `Request`/`Response`, lỗi parse, stream và ngoại lệ, thay vì thêm alias rồi coi số lượng scriptlet là thước đo tương thích.

## Công việc đã làm và ưu tiên tiếp theo

1. **Đã khóa ngữ nghĩa `$denyallow` bằng regression.** Hai filter khác tập ngoại lệ không hủy nhau; cùng tập nhưng đổi thứ tự option/hostname vẫn hủy; gỡ `$badfilter` khôi phục action, priority và đầy đủ predicate. Có parent/child/sibling và đảo thứ tự dòng/nguồn. Compiler hiện tại vốn xử lý đúng; thay đổi mới là test bảo vệ hành vi, không phải sửa lỗi production vừa tái hiện.
2. **Kiểm chứng injection/hook trên Chrome cài đặt.** Dùng inline fetch, request parser và điều khiển Off/ngoại lệ để phân biệt hook trong trang với engine mạng. Kết quả và gói thử được ghi bên dưới.
3. **Ưu tiên kế tiếp:** thứ tự hook, frame/CSP, JSONPath liên dự án và logger có mức bằng chứng. Chỉ nâng cấp thành tính năng sau khi có phép thử đối chứng và giữ ngoại lệ/fail-open.
4. **Managed engine là nhánh kiến trúc riêng.** Đánh giá khả năng giữ engine gốc và chi phí vòng đời/quyền; không ghi nó là capability đang bật trong gói DNR hiện tại.

## Xác minh đợt này

Pipeline cục bộ dùng Node 22.22.0/npm 11.19.1: `npm ci`, **41 chương trình trong `npm test`**, lint, Chromium build có phiên bản, validator `--release` và đối chiếu từng file ZIP đều đạt. Tool xuất logo cũng nằm trong lint; normal build không phụ thuộc sharp. Có 1.113 file ZIP, 55 ruleset, 70.163 DNR rule, 359 JSON file/65,4 MiB. ZIP mới: **31.080.744 byte**.

```text
uBlock-Plus_1.0.0.chromium.zip
SHA256 05cdc0ac19b9676ae63f380f4bd6b0f75dc53580a214f3b28d19f7777cee497c
```

**Branding và smoke test: 8/8 đạt** trên Chrome 152.0.7977.76 cài đặt thật, gồm dashboard/manifest icon, On/Off, popup native và chặn/chuyển hướng trên trang công khai. Từng PNG được giải mã và kiểm tra vùng màu, kích thước, alpha; ảnh thẻ extension đã được nhìn lại trực tiếp. [Ảnh và cấu hình kiểm tra](BRANDING.md#kiểm-tra-trong-chrome).

**Thí nghiệm scriptlet: 7/7 đạt trên cùng ZIP logo mới**, tổng cộng **15/15 ca Chrome** cho đợt này. Fixture HTTP cục bộ có CSP nonce, chạy `fetch(new Request(...))` và XHR trong script inline đầu tiên khi `document.readyState === 'loading'`. Có thêm `<img>`, iframe cùng origin và Worker; server ghi request nhận được thật, không dùng Playwright route hoặc CDP fulfill để thay response.

| Cấu hình | Request probe server còn nhận |
| --- | --- |
| Không thêm scriptlet | Fetch trang, XHR, ảnh parser, fetch iframe, fetch Worker |
| `no-fetch-if` | XHR, ảnh parser, fetch Worker |
| Thêm `no-xhr-if` | Ảnh parser, fetch Worker |
| Ngoại lệ alias `prevent-fetch` | Fetch trang, fetch iframe, ảnh parser, fetch Worker |
| Off | Cả năm đường request |
| Bật lại | Ảnh parser, fetch Worker |

Fetch/XHR bị hook nhận response tổng hợp status 200/body rỗng trước khi gửi request, không phải lỗi network DNR. Như vậy lớp scriptlet hiện có đã bắt được lời gọi sớm trong fixture này và tôn trọng ngoại lệ/Off; ảnh parser và Worker vẫn chứng minh rằng hook trong trang không bao phủ toàn bộ mạng. Kết quả không chứng nhận mọi CSP, Worker, cross-origin frame, redirect, stream, thời điểm cold start hoặc website.

Cả hai nhóm dùng Chrome **152.0.7977.76**, profile riêng và sandbox/popup blocker bình thường; nhóm scriptlet bật Allow User Scripts qua control native. Không page exception; nhóm branding không có extension console error, nhóm scriptlet không có lỗi chụp ảnh. Hai bản sao cùng xác nhận 1.114 file với tree SHA-256 `8cf0ef50ea2ecdb6c214d3022f5db86034d7ff307d4a41c8b8a19a37d650e1dc`, gồm `log.txt` build ngoài ZIP.

Hồ sơ thô giữ cục bộ ngoài Git:

- Pipeline: `tmp/parity-remediation-2026-09-06/pipeline.json` cùng log từng bước.
- Branding: `tmp/branding-2026-09-06/normal-2026-09-06T14-41-41-174Z/report.json`.
- Scriptlet cuối: `tmp/userscript-research-final-2026-09-06/chrome-2026-09-06T14-43-40-064Z/report.json`, kèm server log và ảnh.
- Harness scriptlet: `tmp/userscript-research-2026-09-06/chrome-probe.mjs`, nhận `--root` và `--expected-sha256` để xác định bản sao/gói thử. Lần chạy thăm dò trước logo rebuild được giữ riêng, không cộng vào 15 ca cuối.

Các số đo dùng đúng gói/report được chỉ định. Báo cáo [53 ca Chrome trước đó](MV3-PARITY-IMPLEMENTATION-2026-09-06.md#xác-minh) giữ nguyên phạm vi và checksum lịch sử. Build độc lập trên CI có thể khác hash do dữ liệu lọc/giá trị được sinh lúc đóng gói; xem Actions theo commit, không dùng hash ZIP cục bộ để kiểm tra một artifact CI khác.
