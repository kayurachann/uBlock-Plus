# Firewall, logger và ngoại lệ trên Chrome MV3

Đợt triển khai tiếp theo [báo cáo rà soát](MV3-CAPABILITY-AUDIT-2026-09-06.md), ngày 6 tháng 9 năm 2026. Chuẩn đối chiếu là **uBlock Origin đầy đủ**. Tài liệu này thay thế các nhận định “chưa triển khai” tương ứng trong báo cáo trước; không thay đổi kết quả kiểm thử lịch sử.

## Firewall động

Mở **Dashboard → Site rules → Dynamic firewall**. Dùng cú pháp bốn cột của uBO:

```text
* * 3p-script block
example.com * 3p-script noop
* tracker.example * block
example.com needed.example * allow
```

- `block` chặn request; `allow` ưu tiên cho phép trước các danh sách lọc thông thường.
- `noop` kết thúc đối chiếu firewall nhưng giữ nguyên quyết định của danh sách lọc. Compiler tạo các phạm vi không giao nhau; không thay `noop` bằng một quy tắc allow.
- Hỗ trợ hostname nguồn/đích, kế thừa subdomain, `*`, `image`, `1p-script`, `3p`, `3p-script`, `3p-frame`. Đích cụ thể phải dùng loại `*`, như uBO. Tên miền quốc tế được chuẩn hóa IDN.
- Quy tắc theo đích ưu tiên trước loại request; sau đó xét nguồn cụ thể và loại/party theo thứ tự của engine uBO. `3p-frame` gồm `sub_frame` và `object`.
- **Validate** kiểm tra bản nháp và số DNR dự kiến. **Apply for this session** áp dụng tạm đến khi kết thúc phiên browser, tồn tại qua lần worker ngủ/khởi động lại. **Save permanently** lưu qua lần khởi động browser; bản lâu dài được đưa vào backup. Có nhập/xuất tệp văn bản.
- Dòng sai, ô trùng hoặc vượt quota làm toàn bộ bản thay thế bị từ chối; không kích hoạt một phần bản nháp. Journal khôi phục cấu hình trước nếu lỗi xảy ra giữa activation và lưu dữ liệu.

Đường thực thi dùng **session DNR native của Chrome 145+**, với `topDomains`/`excludedTopDomains`, không lấy initiator của iframe để giả làm trang cấp cao nhất. [Chrome RuleCondition](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#type-RuleCondition). Chrome cũ vẫn dùng các chức năng lọc trước đây; editor báo thiếu khả năng firewall này.

Party được xác định từ trang cấp cao nhất và **Public Suffix List đóng gói**, bao gồm private suffix như `github.io`. Không gửi hostname đến dịch vụ DNS/DoH bên ngoài. Phạm vi nhận diện tối đa 128 registrable domain được giữ trong phiên; 256 ô cấu hình và tối đa 4.096 DNR rule, đồng thời tôn trọng quota session còn lại của Chrome. Khi gặp trang mới, observer cập nhật phạm vi; request đầu tiên có thể đi qua trong khoảng cập nhật bất đồng bộ. Chỗ thiếu ngữ cảnh party không được rơi xuống một block rộng hơn. Reload trang sau khi áp dụng giúp kiểm tra với phạm vi đã cập nhật.

**Off được ưu tiên hơn firewall.** Không áp dụng firewall này cho main-frame navigation, request ngoài tab hoặc `inline-script`. Editor hỗ trợ IPv6 nguồn/đích trong ngoặc vuông, ví dụ `[::1]`, chuẩn hóa địa chỉ và coi mỗi địa chỉ là một bên riêng khi phân biệt first-party/third-party; không nhận địa chỉ trần, zone ID hoặc port. Các thao tác DNR tự viết trong Advanced vẫn là công cụ cấp thấp, có thể đặt priority riêng. Đây là tập con network có ngữ nghĩa được kiểm tra, chưa phải ma trận popup/full engine MV2.

Đối chiếu [cú pháp và precedence uBO](https://github.com/gorhill/uBlock/wiki/Dynamic-filtering%3A-rule-syntax) với chính `src/js/dynamic-net-filtering.js` trong repository: 10.500 trường hợp, gồm 9.600 trường hợp sinh có seed và 900 trường hợp kết hợp IPv6/DNS; bao phủ host cha/con, private suffix, đích cụ thể, script/frame/image, allow/block/noop. Ca lifecycle kiểm tra quota, storage failure, recovery journal và preview không được tự khai báo phạm vi đã active.

## `$badfilter`

Trong bộ lọc cá nhân hoặc list nhập thêm, có thể viết:

```text
||ads.example^$script
||ads.example^$script,badfilter
```

Compiler xác định danh tính từ AST trước khi chuyển đổi/gộp DNR, chuẩn hóa alias, thứ tự option/domain và loại ngoại lệ. Vì vậy `$badfilter` có thể hủy đúng filter trong cùng list, giữa các imported list, hoặc giữa imported và personal. Xóa `$badfilter` khôi phục đóng góp nguồn được giữ trong cache. Có xử lý phép tách positive domain mà uBO mô tả cho các mẫu được hỗ trợ. Không tạo allow cho toàn tên miền để mô phỏng hủy một filter. [uBO `$badfilter`](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax#badfilter).

Đối với **stock**, build giữ ánh xạ danh tính nguồn qua cả hostname bucket của engine gốc và DNR minimization. Runtime có thể hủy toàn bộ native static rule, hoặc hủy riêng một nguồn trong nhóm hostname chặn đã chứng minh được cách dựng lại chính xác. Trường hợp thứ hai sẽ disable rule gốc và tạo dynamic rule cho phần còn lại từ từng điều kiện gốc: hủy filter `$script` của một hostname vẫn giữ filter `$image` độc lập và các hostname khác. Validator kiểm tra các nhóm nguồn dựng lại đúng native rule trước khi đóng gói; các nhóm chưa đủ bằng chứng không được dùng để dựng phần còn lại.

Digest gắn ID với đúng file ruleset, kể cả build `-Before` salvage ID. Journal phối hợp cập nhật dynamic/static và khôi phục khi service worker dừng giữa chừng, giữ các ID do chủ thể khác đã disable, tránh replay ID từ package cũ, và xử lý quota regex dùng chung khi rollback. Nếu Chrome từ chối vì quota, giao dịch giữ bộ lọc đã hoạt động trước đó. Thay đổi lựa chọn stock list cũng tính lại các nguồn hủy đang có.

**Còn giới hạn:** dựng phần còn lại chỉ hỗ trợ các nhóm hostname có action `block` và điều kiện nguồn được chứng minh đầy đủ; các phép gộp phức tạp hoặc action khác vẫn cần thêm ánh xạ. Source có ảnh hưởng sang regex, strict-block hoặc corpus popup riêng cũng cần xử lý đồng bộ. Yêu cầu hủy các nguồn chưa đủ điều kiện bị hoãn; bộ lọc gốc tiếp tục hoạt động kèm cảnh báo. Cảnh báo có số source/rule chưa hủy được, ruleset/ID và lý do; không được coi “lưu được văn bản” là “Chrome đã hủy mọi filter được yêu cầu”.

## Ngoại lệ scriptlet chung

Stock, imported và personal dùng chung dữ liệu ngoại lệ theo hostname/entity/regex, tên scriptlet đã chuẩn hóa alias và đối số chính xác. Hỗ trợ ngoại lệ cụ thể `#@#+js(tên, đối-số)` và ngoại lệ rộng `#@#+js()`; khác đối số không được gộp thành cùng ngoại lệ. Các list bị tắt không đóng góp ngoại lệ.

Khi **Allow User Scripts** khả dụng, registry dùng `userScripts` để đưa dữ liệu ngoại lệ vào mã scriptlet đã đóng gói trước lúc script chạy. Không tải JavaScript/Wasm từ xa. Bật Allow User Scripts và **Reload extension** theo hướng dẫn cài đặt; sau thay đổi filter cần reload trang vì tác động của scriptlet đã chạy không tự được hoàn tác.

Chrome `userScripts` chưa có `matchOriginAsFallback` như `scripting.registerContentScripts`. Vì vậy stock giữ thêm một bản native chỉ dành cho frame có URL `about:`, `data:` hoặc `blob:` mà Chrome đối chiếu được với origin khởi tạo. Wrapper thoát ngay trên HTTP/HTTPS/file để không chạy stock hai lần trên tài liệu thông thường. Với những frame đặc biệt này, ngoại lệ chéo nguồn được bảo vệ bằng loại trừ hostname hoặc hoãn file scriptlet chịu ảnh hưởng; mức loại trừ có thể rộng hơn một invocation và được cảnh báo. Đây là fallback có chủ ý để giữ phạm vi frame và fail-open, chưa phải đối chiếu động chính xác mọi ngoại lệ trong mọi opaque origin. [Chrome userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts), [Chrome content script origin fallback](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#frames).

Khi API chưa khả dụng, registry native loại trừ phạm vi chịu ảnh hưởng của ngoại lệ mà nó chưa biểu diễn chính xác; logger hiển thị cảnh báo về phạm vi được hoãn. Nếu compiler migration chưa thành công, generation cũ thiếu schema/marker ngoại lệ sẽ hoãn scriptlet, giữ cache/network/cosmetics và retry, thay vì chạy mã cũ không có guard. **Basic** giữ bộ lọc do người dùng tự viết nhưng không bật lại extended filtering của stock/imported; **Off** tắt cả bộ lọc cá nhân.

## Logger hợp nhất

Mở biểu tượng logger trong popup, chọn tab và bấm **Start capture**. Mở logger chưa bắt đầu thu thập. Quyền **webRequest** là tùy chọn, chỉ được yêu cầu khi chủ động bắt đầu; từ chối quyền vẫn cho phép các nguồn chẩn đoán còn khả dụng.

| Loại sự kiện | Ý nghĩa được chứng minh |
| --- | --- |
| Network | Chrome quan sát request bắt đầu, hoàn tất, redirect hoặc lỗi. Lỗi mạng không tự chứng minh extension đã chặn. |
| Native DNR | Chrome xác nhận rule của extension match. Stock tra về DNR đóng gói theo manifest; dynamic/session đọc qua API riêng, không phải snapshot nguyên tử. Nội dung DNR chưa phải biểu thức gốc của mọi filter. |
| Cosmetic | CSS đã được chèn thành công; chưa tự chứng minh phần tử bị ẩn. |
| DOM | Phân biệt selector CSS hiện diện trong trang và procedural filter thực sự áp dụng. Snapshot tối đa 32 selector/style, không suy luận media/visibility. |
| Scriptlet | Ghi nhận đăng ký và ngoại lệ/fallback. Bản hiện tại chưa phát báo cáo thử thực thi hoặc xác nhận tác động của từng scriptlet; thông điệp từ trang không phải bằng chứng MAIN world đáng tin cậy. |

Có tìm kiếm, lọc loại, chọn tab, Pause, Clear và export JSON đã bỏ credentials/query/fragment/free text. URL path vẫn có thể chứa dữ liệu cá nhân, cần xem lại trước khi chia sẻ. Không tự upload. Giới hạn 512 bản ghi, bốn cửa sổ logger, 16 lookup DNR đang chờ và 32 content report/giây/frame. Đóng cửa sổ cuối xóa lịch sử; dừng capture gỡ observer. Worker bị dừng cũng có thể làm mất lịch sử tạm.

Tra cứu stock chỉ đọc file được manifest khai báo; không dựng URL fetch từ request hoặc thông điệp trang. Các lượt đọc đồng thời cùng ruleset được gộp, chỉ giữ tối đa 128 bản tóm tắt ngắn sau khi đọc, không giữ toàn bộ map ruleset. Cache này được xóa khi không còn capture.

Đây chưa phải tất cả request browser: Chrome không công bố mọi request nội bộ, cached/service-worker response hay từng WebSocket message. Tác động `document_start` diễn ra trước observer có thể không được ghi lại. [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest).

## Giới hạn của cấu hình hiện tại và các đường mở rộng

- `webRequest` dùng quan sát ở trên không cấp quyền blocking đồng bộ; `webRequestBlocking` MV3 thông thường chỉ có trong trường hợp cài bằng enterprise policy phù hợp.
- Cấu hình DNR/`webRequest` hiện tại không có bộ lọc response body tổng quát, CNAME uncloaking hay chặn theo toàn bộ kích thước response tương đương uBO trên Firefox. Đây là giới hạn của đường thực thi đang dùng, không phải khẳng định mọi cách triển khai Chrome extension đều bất khả thi.
- Scriptlet có thể xử lý một số API/DOM trong trang bằng primitive đóng gói; không thể dùng nó thay một response filter toàn cục hoặc khẳng định thấy request ngoài phạm vi Chrome cho phép.
- Tầng native, proxy hoặc browser tùy biến là sản phẩm triển khai khác, cần cài đặt/quyền/phân tích riêng. Đợt này không cài companion, chứng chỉ, sửa policy hoặc tắt sandbox/quota.

Tham khảo [uBO trên Firefox](https://github.com/gorhill/uBlock/wiki/uBlock-Origin-works-best-on-Firefox), [Brave giải quyết CNAME ở tầng browser](https://brave.com/privacy-updates/6-cname-trickery/) và [Chrome remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

**Đường debugger có khả năng kỹ thuật, nhưng chưa được triển khai:** `chrome.debugger` cho phép dùng các domain `Network`, `Fetch`, `DOM` và `Runtime` trên target được attach. CDP `Fetch.getResponseBody` có thể đọc response đang tạm dừng, rồi `Fetch.fulfillRequest` cung cấp body thay thế. Vì vậy có thể nghiên cứu công cụ chẩn đoán sâu hoặc sửa response theo tab; không nên gọi việc sửa body là bất khả thi tuyệt đối trong MV3. [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger), [CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/).

Tuy nhiên, Chrome **không cho khai báo `debugger` trong `optional_permissions`**. Một nút bật chế độ nâng cao trong cùng extension vẫn cần quyền debugger từ manifest khi cài đặt, kèm cảnh báo truy cập debugger và đọc/thay đổi dữ liệu website. Bản phát hành này không thêm quyền đó. Phương án cần đánh giá riêng là một bản developer/companion mà người dùng chủ động cài, hoặc phiên CDP bên ngoài do người dùng khởi chạy; không tự attach tab trong bản hiện tại. [Quyền không thể là optional](https://developer.chrome.com/docs/extensions/reference/api/permissions#step-2-declare-optional-permissions-in-the-manifest), [Cảnh báo quyền debugger](https://developer.chrome.com/docs/extensions/reference/permissions-list#debugger).

Đề xuất triển khai có giới hạn: bắt đầu bằng logger `Network` cho đúng tab người dùng chọn, không tạm dừng request; có nút Stop/detach, giới hạn bản ghi và không lưu body mặc định. Body rewrite phải là thử nghiệm riêng với loại nội dung/phạm vi cụ thể và kiểm thử tải lớn, redirect, nén, iframe, worker, hủy phiên và phục hồi. `Fetch` giữ request cho tới khi client trả lời; đọc body trả về toàn bộ chuỗi, còn lấy stream khiến request không thể tiếp tục nguyên trạng. Tài liệu cũng cảnh báo trạng thái không xác định nếu thay đổi request/tắt Fetch trong khi đang đọc body: không thể hứa một watchdog đơn giản luôn bảo đảm fail-open. [Ràng buộc Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-getResponseBody).

Phiên debugger có thể bị Chrome kết thúc khi mở DevTools hoặc đóng tab; target iframe khác process cần xử lý riêng. Debugger đang hoạt động còn giữ service worker sống, nên đây không phải nâng cấp miễn phí về tài nguyên. Các điểm này cần benchmark và giao diện trạng thái trước khi phát hành, không được đánh đồng với logger nhẹ hiện có. [Vòng đời debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onDetach), [Vòng đời service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#chrome-118).

Chrome còn có `chrome.dns`, nhưng tài liệu hiện giới hạn API này ở **Dev channel**; `resolve()` trả về địa chỉ IP và mã kết quả, không cung cấp chuỗi CNAME. API đó không phải giải pháp CNAME uncloaking cho gói nhắm Chrome Stable hiện tại. [Chrome DNS](https://developer.chrome.com/docs/extensions/reference/api/dns).

**Giới hạn regex đã quan sát trong snapshot bộ lọc ngày 6/9/2026:** Chrome 152 từ chối sáu ngoại lệ `allow` trong corpus regex `ublock-filters` (ID 47, 48, 49, 50, 52, 53) với lý do `memoryLimitExceeded`. Các ngoại lệ này áp dụng cho ảnh first-party trong phạm vi `pussyspace.com`/`pussyspace.net`. Đây là ID của snapshot hiện tại, không phải danh sách cố định cho các lần cập nhật sau. Chrome giới hạn mỗi regex sau biên dịch dưới 2 KB, riêng với quota số rule. Runtime kiểm tra đúng cờ phân biệt hoa/thường và yêu cầu capture của rule; cài unpacked không gỡ giới hạn đó. [Chrome regex limits](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules), [RegexOptions](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#type-RegexOptions).

Nếu một lựa chọn stock list yêu cầu ngoại lệ regex mà Chrome từ chối, giao dịch báo lỗi kèm lý do native, ID và đoạn đầu biểu thức, rồi khôi phục snapshot native trước đó. Không bỏ ngoại lệ để áp dụng các rule chặn mới, cũng không thay nó bằng ngoại lệ URL rộng hơn. Vì vậy một số thay đổi lựa chọn list có thể bị từ chối cho đến khi corpus hoặc trình duyệt biểu diễn được đầy đủ ngoại lệ; đây là giới hạn đang có, không được ghi là thay đổi đã áp dụng thành công.

## Xác minh

### Mã nguồn và pipeline

Đã chạy đúng môi trường và các bước của [MV3 Chromium CI](../.github/workflows/mv3-chromium.yml) trên Windows: **Node 22.22.0, npm 11.19.1**, `npm ci`, `npm test`, `npm run lint`, build Chromium có phiên bản và validator `--release`. Cả **41 chương trình kiểm thử** đều đạt. Sau build còn kiểm tra authority của popup observer trong mã đã đóng gói và đối chiếu từng file trong ZIP với thư mục unpacked.

```powershell
npm ci
npm test
npm run lint
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
./tools/make-mv3.ps1 -Platform chromium -Version $version
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
node tools/test-popup-observer-authority.mjs dist/build/uBlockPlus.chromium
```

Các test mã nguồn gồm 10.500 đối chiếu firewall với engine uBO đầy đủ; nguồn `$badfilter` trước/sau gộp; ma trận ngoại lệ scriptlet; quota, fault injection và recovery. Các lỗi mới tìm thấy đã có ca hồi quy: minimizer bỏ sai hostname con trong chuỗi nhiều cấp; rollback cố biên dịch lại regex allow mà Chrome vốn đã từ chối; stock selection không tính lại ngoại lệ; cập nhật managed/popup/strict-block chen ngang generation đang commit. Rollback mới lấy snapshot **quy tắc native thực tế**, giữ namespace của Off/firewall và chỉ xóa journal khi khôi phục xong. Journal cũ chưa có snapshot vẫn dùng đường recovery cũ có guard; không tự dựng bằng chứng còn thiếu.

Lỗi storage/quota tại nhiều điểm được tiêm vào môi trường test mã nguồn để kiểm tra nhánh phục hồi; không mô tả các ca đó là sự cố đã cưỡng bức trực tiếp vào storage engine của Chrome. Logger cũng có test từ chối/thu hồi quyền ở lớp API giả lập. Chrome thật đã thử cấp quyền `webRequest`, nhưng chưa ghi nhận một ca chủ động từ chối hộp thoại cấp quyền native.

### Chrome cài đặt thật

**53/53 tình huống đạt** trên Google Chrome **152.0.7977.76**, Windows, chạy có cửa sổ trong profile riêng. Không dùng `--headless`, `--no-sandbox`, `--disable-web-security` hoặc `--disable-popup-blocking`. Playwright/CDP điều khiển Chrome cài đặt, không dùng Chromium giả lập. `Extensions.loadUnpacked` nạp bản sao đã đối chiếu từng byte với gói build; không sửa mã extension để chạy test.

| Nhóm | Kết quả | Phạm vi |
| --- | --- | --- |
| Firewall và logger mới | 9/9 | Block/allow/noop với static filter; nguồn trang cấp cao nhất qua iframe; IPv6; Off; bản nháp/tạm/lâu dài; worker restart; native network/DNR/DOM, export và cleanup. |
| `$badfilter` | 9/9 | Imported/personal hai chiều; hủy cả stock rule; phần còn lại chính xác; bỏ chỉ thị để khôi phục; stock selection; cảnh báo hoãn; journal sau worker restart. |
| Ngoại lệ scriptlet | 11/11 | Stock/imported/personal mọi chiều; alias, đối số, ngoại lệ rộng; cha/con, Basic/Off; stock `about:blank`; migration; tắt Allow User Scripts bằng UI native. |
| Hồi quy trước đó | 17/17 | Native matched-rule history/lookup; mode editor IPv6/IDN; imported/personal scripts và cosmetics theo scope; compiler migration; từ chối regex allow an toàn. |
| Popup và trang công khai | 7/7 | Popup toolbar native, bàn phím On/Off, click chủ động, popup không gesture, stock popup policy và mạng trên `example.com`. |

53 là số tình huống của harness, có cả kiểm tra môi trường và ca lỗi dự kiến; không phải 53 website độc lập. Các fixture mạng được kiểm soát và có phép thử đối chứng cho phép/chặn. Không có lỗi page exception hoặc extension console không mong đợi trong vòng cuối. Lỗi request được chủ động chặn và thông báo bảo mật của trang test không được tính là lỗi code extension.

Ví dụ native `$badfilter`: `||123date.me^$third-party,badfilter` làm Chrome disable EasyList rule 2 của snapshot này và cài rule dynamic 9000002, priority gốc 10, giữ 1.577 domain còn lại. Request mục tiêu đi qua, domain cùng nhóm `152media.com` vẫn bị chặn; xóa chỉ thị khôi phục rule 2 và gỡ phần thay thế. Đây là fixture dùng hostname cụ thể để kiểm chứng DNR, không duyệt nội dung các website đó.

Ca đổi stock list có corpus regex bị Chrome từ chối được đánh dấu đạt **vì khôi phục đúng enabled/static/dynamic/session và xóa journal**, không phải vì lựa chọn mới đã được áp dụng. Ca thay đổi stock list thành công dùng tập danh sách được Chrome hỗ trợ trong profile thử nghiệm riêng, không thay cấu hình mặc định của sản phẩm.

Ca public-site dùng script preload trên `https://example.com/`: tài nguyên adsbygoogle hợp lệ chuyển đến bản thay thế đóng gói; một URL quảng cáo kiểm thử bị `ERR_BLOCKED_BY_CLIENT` khi On. Khi Off, request tới server và nhận HTTP 404; Chrome sau đó từ chối HTML ở ngữ cảnh script bằng ORB. Phân biệt lỗi ORB với extension block; bật lại khôi phục `ERR_BLOCKED_BY_CLIENT`. Không thực thi script quảng cáo tải từ mạng.

### Gói đã kiểm tra và hồ sơ

| Thuộc tính | Giá trị |
| --- | --- |
| ZIP cục bộ | `dist/build/uBlock-Plus_1.0.0.chromium.zip` |
| Dung lượng ZIP | 31.072.900 byte, khoảng 29,63 MiB |
| File ZIP | 1.113, tất cả khớp thư mục unpacked đã validate |
| Ruleset / DNR | 55 / 70.163 |
| Dữ liệu JSON đóng gói | 359 file, 65,4 MiB |
| Thư mục nạp vào Chrome | 1.114 file, gồm `log.txt` build không nằm trong ZIP; bỏ qua index `_metadata` do browser tự sinh khi đối chiếu |

SHA-256 của ZIP cục bộ:

```text
4f1c3aac514951e2c2f3b19f05f446925e2d32e5df54cd05015e87f482f2c28c
```

Cả năm nhóm Chrome cùng xác nhận tree SHA-256 `aac037811dfba1309ca7fea5e2c05b30f2705e9f71920dd4ea3df5e725b882ca`, tính từ danh sách path/hash file đã sắp xếp, gồm `log.txt`. Đây không phải checksum ZIP.

Hồ sơ thô và harness được giữ cục bộ trong `tmp/`, không đưa browser profile/cache hay các bản sao extension vào Git. Các report của vòng cuối ngày 6/9/2026, khoảng 14:24–14:26 UTC:

- Pipeline: `tmp/parity-remediation-2026-09-06/pipeline.json`, cùng log riêng cho từng bước.
- Firewall/logger: `tmp/parity-remediation-2026-09-06/chrome-2026-09-06T14-24-14-626Z/report.json`.
- `$badfilter`: `tmp/parity-remediation-2026-09-06/chrome-2026-09-06T14-23-55-812Z/report.json`.
- Scriptlet: `tmp/capability-audit-2026-09-06/scriptlets-2026-09-06T14-24-06-792Z/report.json`.
- Hồi quy: `tmp/capability-audit-2026-09-06/chrome-2026-09-06T14-24-14-624Z/report.json`.
- Popup/native: `tmp/capability-audit-2026-09-06/normal-2026-09-06T14-24-12-221Z/report.json`.

[Ảnh firewall](assets/readme/dynamic-firewall.png) và [ảnh logger](assets/readme/unified-logger.png) trong README được lấy nguyên file từ lần chạy firewall/logger cuối này. [Nguồn ảnh và cấu hình chụp](assets/readme/README.md).

Metadata danh tính nguồn và scriptlet làm tăng dung lượng gói. Dung lượng ZIP/JSON là số đo file, **không phải RAM**; chưa có benchmark tài nguyên đại diện cho máy cấu hình thấp. Các cache runtime có giới hạn không đủ để suy ra tỷ lệ giảm RAM hay so sánh hiệu năng với uBO đầy đủ.

Kết quả CI trên GitHub được xem riêng theo đúng commit; build dùng dữ liệu lọc bên ngoài và giá trị sinh khi đóng gói nên hai lần build độc lập không bắt buộc có cùng checksum. Push mã nguồn và upload artifact CI không thay thế ZIP v1.0.0 pre-release cũ trên trang Releases.
