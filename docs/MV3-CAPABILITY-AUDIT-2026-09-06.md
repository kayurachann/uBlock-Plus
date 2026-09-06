# Rà soát chức năng so với uBlock Origin đầy đủ

Ngày kiểm tra: **6 tháng 9 năm 2026**. Mốc mã trước rà soát: `140ccdb9dcd8fcc3677d6cf2de65de15e97e60e1`.

Theo yêu cầu của người dùng, đợt này lấy **uBlock Origin đầy đủ** làm mốc chức năng và tham khảo **AdGuard** cùng **Brave**. Không dùng uBlock Origin Lite làm chuẩn so sánh. Các tài liệu kiểm thử lịch sử vẫn giữ nguồn và kết quả tại thời điểm thực hiện.

Kết luận: tiện ích đã có nền tảng chặn mạng, lọc giao diện, scriptlet đóng gói, popup, công cụ chọn/xóa phần tử, danh sách nhập thêm và cấu hình theo trang. Tuy nhiên, chưa thể gọi là tương đương uBO đầy đủ. Có cả lỗi triển khai có thể sửa, tính năng chưa xây dựng và khả năng Chrome MV3 thông thường không cung cấp.

## Phương pháp và phạm vi

- Chạy lại bộ kiểm thử đang có, đọc đường đi thực tế từ giao diện đến lưu trữ, compiler, đăng ký script và DNR.
- Tạo ca hồi quy từ đầu vào có thể tái hiện; không coi một issue upstream là bằng chứng tiện ích này mắc cùng lỗi.
- Đối chiếu tài liệu/mã chính thức của uBO, AdGuard, Brave và Chrome. Ý tưởng từ dự án khác cần phù hợp với quyền và cơ chế thực thi của extension này.
- Kiểm tra browser bằng Google Chrome cài trên máy, profile thử nghiệm riêng. Mô phỏng lỗi API trong kiểm thử mã được ghi riêng với hành vi xác nhận trong Chrome.

Kết quả chạy đạt của bộ kiểm thử cũ không chứng minh hết lỗi: những đường đi dưới đây chưa được bộ kiểm thử đó bao phủ đầy đủ. Đây là một đợt rà soát có phạm vi, không phải chứng nhận mọi website, mọi filter hoặc mọi công nghệ hỗ trợ truy cập.

## Lỗi đã tái hiện trong đợt rà soát

| Nhóm | Điều kiện gây lỗi trước sửa | Tác động và yêu cầu khắc phục |
| --- | --- | --- |
| Ngoại lệ network regex | Trình duyệt từ chối regex của một allow rule nhưng compiler tiếp tục với các block rule cùng đợt | Có thể mất ngoại lệ và chặn rộng hơn ý định. Phải hủy bản thay thế nếu không bảo toàn được allow, giữ bộ đang hoạt động. |
| Phạm vi script nhập thêm và bộ lọc cá nhân | Default None/Basic hoặc cấu hình kế thừa làm nhánh đăng ký script bỏ mất danh sách loại trừ; bộ lọc lưu ở parent có thể không tới enabled child | Cosmetic/scriptlet có thể được đăng ký sai scope. Đã kiểm tra riêng imported/sandbox và cosmetic lưu từ picker, giao phạm vi theo hai chiều và ngoại lệ Off. Chrome còn xác nhận toolbar xóa `all-urls` trong Set dùng chung trước khi hàm đăng ký cosmetic đọc xong storage; sửa thành phép kiểm tra không biến đổi dữ liệu và thêm ca chạy đồng thời. |
| Ngoại lệ scriptlet | Bộ lọc `#@#+js(...)` tương ứng không được giữ trong đường biên dịch | Scriptlet vẫn có thể chạy trên trang được miễn. Cần đối chiếu đúng tên/đối số và phạm vi hostname, không nới ngoại lệ một cách gần đúng. |
| Cosmetic theo hostname regex | Nhánh tra cứu truyền sai đối số vào hàm chọn selector | Quy tắc hostname regex có thể lỗi lúc chạy. Cần chạy mã đã sinh, kiểm tra cả hostname khớp/không khớp và ngoại lệ. |
| Trình sửa văn bản Filtering modes trong Advanced | Dòng sai được đánh dấu nhưng Save vẫn gửi phần đã parse; IPv6 hợp lệ có thể bị parser cũ loại bỏ | Khi lưu, scope đáng tin cậy có thể biến mất. Dự thảo không hợp lệ phải chặn lưu, giữ nguyên văn bản và cấu hình; scope hợp lệ cần round-trip ổn định. |
| Nhật ký matched rules | `_session` bị tra như file JSON đóng gói; dynamic rule ID tái sử dụng vẫn dùng cache cũ | Bỏ sót match hoặc hiển thị điều kiện cũ. Dùng đúng API session/dynamic, giữ chi tiết đã đọc cho từng sự kiện và giữ ID khi không đọc được rule. |
| Nội dung giải thích quyền | Basic/Baseline nói không cần quyền rộng trong khi manifest yêu cầu `<all_urls>` | Người dùng có thể hiểu sai quyền đã cấp. Bỏ lời mô tả sai; mức lọc không phải thao tác thu hồi quyền website. |
| Thời hạn cập nhật list | `Expires: 1w` bị chuyển thành 168 ngày; đơn vị viết hoa được parse nhưng xử lý sai | Sửa `1w` thành 7 ngày, xử lý hoa/thường nhất quán, giữ giới hạn tối thiểu 4 giờ. Đây là lỗi kế thừa, không phải thiếu API MV3. |
| Cache sau thay đổi compiler | Cache chỉ kiểm tra cấu trúc, không có revision của compiler | Cache cũ có thể giữ kết quả mất ngoại lệ. Thêm revision cho envelope, rebuild từ nguồn khi lệch và migration có dirty marker/retry; chỉ ghi migration hoàn tất sau activation và đăng ký content script thành công. |

Các bản sửa, kiểm thử và giới hạn xác minh được ghi ở phần cuối. Việc sửa lỗi không thay đổi nguyên tắc popup **fail-open**: thiếu ngữ cảnh, ngoại lệ chưa biểu diễn được hoặc hết ngân sách không được biến thành quyết định chặn suy đoán.

Basic có một phân biệt có chủ đích: tắt extended filtering từ danh sách đóng gói/nhập thêm, nhưng vẫn cho phép bộ lọc do người dùng tự viết trong sandbox và cosmetic lưu từ picker trên trang đang bật. **Off** tắt cả các bộ lọc cá nhân đó. Bản sửa giữ hành vi này.

Sau khi bật **Allow User Scripts** trong Chrome, vẫn cần **Reload extension** theo hướng dẫn cài đặt để worker nhận trạng thái API và thiết lập messaging cho user-script world. Kiểm tra bỏ qua bước này đã tái hiện lỗi messaging; làm đủ bước tải lại thì cosmetic/scriptlet hoạt động. Tự nhận thay đổi quyền ngay trong worker đang chạy là cải tiến UX còn có thể bổ sung, chưa được tuyên bố hỗ trợ trong đợt này.

## Các khoảng trống vẫn còn

| Chức năng | So với uBO đầy đủ | Phần có thể cải thiện trong fork |
| --- | --- | --- |
| Firewall động | Chưa có ma trận nguồn/đích/loại tài nguyên với đầy đủ ngữ nghĩa `block`, `allow`, `noop` | Có thể triển khai tập con DNR với phạm vi công bố rõ. `noop` để static filtering tiếp tục, nên không được thay bằng một allow rộng. [Ngữ nghĩa uBO](https://github.com/gorhill/uBlock/wiki/Dynamic-filtering%3A-rule-syntax). |
| Logger và công cụ sửa trang lỗi | Có matched-rule view và diagnostics giới hạn; chưa phải logger hợp nhất network/DOM/scriptlet kèm nguồn và thao tác tạo rule | Hoàn thiện ánh xạ nguồn, bộ lọc tìm kiếm, trạng thái thật/mô phỏng và export do người dùng chủ động. [Logger uBO](https://github.com/gorhill/uBlock/wiki/The-logger). |
| `$badfilter` | Parser hiện báo `unsupported-badfilter` | Cần ánh xạ ngược chính xác để tắt đúng rule nguồn, kể cả khi DNR đã gộp nhiều filter. Không thay bằng exception cho toàn domain. [Cú pháp uBO](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax#badfilter). |
| Popup/popunder | Observer thực thi subset đã kiểm tra; stock `$popunder` còn thiếu vì nguồn DNR xuất ra không giữ loại ban đầu | Parse trực tiếp nguồn stock; chỉ mở rộng condition sau kiểm thử ngoại lệ và false positive. Không đóng mọi tab chỉ vì thiếu thông tin opener. |
| Scriptlet/procedural filtering | Có hỗ trợ nhưng chưa bao phủ toàn bộ cú pháp và ngữ nghĩa uBO | Mở rộng từng primitive được đóng gói và kiểm thử. Danh sách từ xa vẫn là dữ liệu; không tải JavaScript/Wasm để thực thi. [Chrome về remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code). |
| Ngoại lệ giữa các nguồn scriptlet | Bản sửa giữ ngoại lệ trong cùng compiled realm và giữa các imported list; stock, imported và sandbox vẫn có output riêng | Chưa thể coi exception viết trong sandbox là override thống nhất mọi scriptlet đóng gói. Cần thiết kế hợp nhất ngoại lệ với provenance và test trước khi hứa parity. |
| Hạn mức và cập nhật danh sách | Runtime đã có kiểm tra quota và xử lý lỗi; giao diện chưa trình bày đầy đủ chi phí đang hoạt động và tác động của lần cập nhật | Hiển thị riêng static/dynamic/session, regex, phần bị từ chối/deferred và bản đang hoạt động. Không coi estimate của catalog là số đã được Chrome chấp nhận. |
| Khôi phục backup | Có preflight và recovery từng thao tác, nhưng toàn bộ restore vẫn tuần tự | Một lỗi muộn có thể để lại các phần đã khôi phục trước đó. Cần journal cấp toàn profile hoặc kết quả tiến độ/khôi phục rõ ràng; chưa gọi là giao dịch nguyên tử toàn bộ. |
| Hiệu năng và accessibility | Có memory profiles và kiểm thử thao tác bàn phím; chưa có benchmark RAM/p95 đầy đủ hay chứng nhận screenreader | Xây baseline lặp lại được, kiểm tra focus/nhãn/thông báo lỗi, bàn phím và ít nhất một screenreader thật. |

Nhật ký sau sửa vẫn là lịch sử tối đa 256 sự kiện trong worker, không phải toàn bộ lịch sử duyệt web. Chrome gửi ID match rồi extension đọc nội dung rule bằng API riêng; đây không phải snapshot nguyên tử do trình duyệt cung cấp. Không thể bảo đảm nội dung lịch sử tuyệt đối nếu rule bị thay đúng giữa hai thời điểm đó. Tối đa 32 lookup runtime được chạy đồng thời; khi không đọc được hoặc hết ngân sách chỉ giữ tham chiếu thay vì xếp hàng tra muộn/suy đoán điều kiện. Tắt Developer mode xóa lịch sử và vô hiệu hóa kết quả đọc đang chờ.

## Ranh giới của Chrome MV3 thông thường

1. **Programmatic blocking và hạn mức DNR:** `webRequestBlocking` dành cho extension cài bằng policy trong MV3. Extension sideload thông thường vẫn phải tuân thủ DNR; viết lại engine không cấp thêm API. [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest).
2. **DNR có ngân sách và thứ tự ưu tiên riêng:** cần dùng khả năng browser công bố, kiểm tra tổng hoạt động và bảo toàn ngoại lệ. Một số điều kiện response header chỉ được đánh giá sau khi request đã gửi. DNR cũng không xử lý response tự sinh từ service worker/CacheStorage như một request mạng bình thường. [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest).
3. **CNAME/DNS và sửa response body:** uBO trên Firefox có khả năng bổ sung nhờ API trình duyệt. Brave giải quyết CNAME bằng tích hợp ở tầng browser. Không thể hứa mang nguyên các khả năng đó vào extension Google Chrome chỉ bằng thay JavaScript bằng Rust/Wasm. [uBO trên Firefox](https://github.com/gorhill/uBlock/wiki/uBlock-Origin-works-best-on-Firefox), [Brave CNAME](https://brave.com/privacy-updates/6-cname-trickery/).

Không có kết luận rằng toàn bộ giới hạn trên đều là lỗi của dự án, hoặc mọi nội dung không chặn được đều cần thêm filter. Trước khi sửa phải biết nguyên nhân là cú pháp, scope, ngoại lệ, dữ liệu cũ, API hay trang web.

## Hướng nâng cấp đề xuất

Thứ tự dưới đây ưu tiên giảm chặn nhầm và giúp người dùng hiểu nguyên nhân. Đây là đề xuất, chưa phải chức năng đã phát hành.

| Ưu tiên | Nâng cấp | Tiêu chí hoàn tất |
| --- | --- | --- |
| 1 | **Chẩn đoán truy ngược về nguồn** | Mỗi kết quả có list, dòng nguồn, loại rule, trạng thái `accepted/deferred/rejected` và lý do; phân biệt match Chrome xác nhận với mô phỏng. Export phải chủ động, che URL riêng tư và giữ source map đúng sau rebuild/restart. |
| 2 | **Preview quota và thay đổi trước khi cập nhật** | Phân biệt ước tính, đã biên dịch và đang hoạt động; hiển thị phần tăng/giảm cùng nguồn chưa biết chi phí. Lỗi cập nhật không làm mất bản đang hoạt động. |
| 3 | **`$badfilter` chính xác** | Chỉ vô hiệu hóa bộ lọc được chỉ định, kể cả danh sách trùng nhau, include/exclude domains và rule đã gộp. Nếu chưa biểu diễn chính xác thì báo unsupported. |
| 4 | **Ngoại lệ tạm theo tab** | Chọn URL, loại tài nguyên và tab; xem trước phạm vi, có Undo; dọn khi đóng tab/kết thúc phiên; restart worker không mất metadata; tab khác không thay đổi. |
| 5 | **Kiểm thử ngữ nghĩa và benchmark công khai** | Tập đầu vào chung với uBO/AdGuard/Brave, ghi rõ khác biệt; đo cold start, compile peak, idle và p95 với browser/version, list set, máy và số mẫu. Có regression gate thay vì tuyên bố “nhẹ hơn” thiếu phép đo. |

AdGuard có source maps, thông tin lỗi/hạn mức và cơ chế tính static rule cần vô hiệu hóa. Đây là tham khảo tốt cho các mục 1–3, nhưng tài liệu của họ cũng ghi giới hạn với giao của domain; fork không nên sao chép phép xấp xỉ làm rộng tác động. [AdGuard DNR converter](https://github.com/AdguardTeam/tsurlfilter/tree/master/packages/dnr-converter).

Luồng temporary rules/exceptions của uBO gợi ý mục 4. Chrome hỗ trợ `tabIds` cho session DNR, cho phép thiết kế một tập ngoại lệ tạm có phạm vi rõ. [uBO temporary exceptions](https://github.com/gorhill/uBlock/wiki/The-logger#temporary-exception-filters), [Chrome RuleCondition](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#type-RuleCondition).

Brave duy trì benchmark riêng cho matching, cosmetic, memory, regex và serialization; có thể học cách tổ chức phép đo mà không cần thay engine của fork. [Brave benchmarks](https://github.com/brave/adblock-rust/tree/master/benches).

Filter Store **đã có** tìm kiếm, category và language trong mã hiện tại. Roadmap được cập nhật để không liệt kê lại các mục đó như tính năng mới. Phần còn cần làm là diff review, độ mới/lịch sử cập nhật, quarantine và diagnostics.

## Xác minh bản sửa

Pipeline theo `.github/workflows/mv3-chromium.yml` đã chạy đạt với Node **22.22.0**, npm **11.19.1**:

```powershell
npm ci
npm test
npm run lint
./tools/make-mv3.ps1 -Platform chromium -Version 1.0.0
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

- **35 chương trình kiểm thử** đạt. Ca cũ không bị bỏ hay nới điều kiện; fixture cache hỏng được gắn revision hiện tại để vẫn kiểm tra nhánh sửa dữ liệu hỏng, tách với ca rebuild cache cũ.
- Bổ sung [kiểm thử script/ngoại lệ/cache/expiry](../tools/test-compiled-script-safety.mjs), [trình sửa mode](../tools/test-mode-editor.mjs), [nhật ký](../tools/test-matched-rule-diagnostics.mjs) và [migration compiler](../tools/test-compiler-revision.mjs). Mở rộng [runtime durability](../tools/test-runtime-durability.mjs) và [offscreen integration](../tools/test-offscreen-storage.mjs).
- Thử lỗi API gồm regex allow bị từ chối, lưu revision thất bại, API tra rule bị giữ chờ với 3.000 sự kiện và tắt Developer mode khi đang đọc. Đây là failure injection, không phải tuyên bố Chrome thường xuyên gặp các lỗi đó.
- Lint, release validator và packaged popup-authority regression đạt; đối chiếu từng file trong ZIP với thư mục đã validate đạt.
- Artifact: **55 ruleset**, **70.163 DNR rule**, **976 file ZIP**, **10.075.053 byte**.
- SHA-256 của `uBlock-Plus_1.0.0.chromium.zip` được kiểm tra trong đợt này:

```text
cf51669bd3adad93031157ed3b80c04ee3678fad707378b8c654dd6bd7c6438d
```

Log cục bộ: `tmp/capability-audit-2026-09-06/pipeline.json`, các stage log và `package-verification.json`. Thư mục `tmp/` không được đưa vào Git.

**Google Chrome 152.0.7977.76 cài trên máy**, cửa sổ thật, profile riêng, sandbox và trình chặn popup gốc vẫn bật:

- **17/17 ca hồi quy mới đạt**, không có lỗi JavaScript chưa xử lý. Gói nạp có đúng SHA-256 ở trên; 977 file thư mục được đối chiếu với build, gồm `log.txt` không nằm trong ZIP.
- Xác nhận match native cho session/dynamic, ID tái sử dụng, lịch sử 256 sự kiện và giới hạn lookup khi có burst request. Hai ca cố tình làm lookup lỗi/chậm được ghi rõ là failure injection.
- Nhập/sửa/lưu trong CodeMirror thật: hostname sai, default thiếu/trùng bị từ chối; IPv6/IDN lưu đúng; dòng giữ chỗ tự thêm khi Enter được chấp nhận.
- Xác nhận phạm vi imported/sandbox/saved cosmetic trên parent, child và sibling. Selector cá nhân riêng biệt giúp loại trừ nhầm lẫn với CSS từ stock list; native `css-user.matches` chỉ bao gồm phạm vi được bật.
- Xác nhận scriptlet exception cùng list và khác imported list, cosmetic hostname regex, regex allow bị từ chối giữ nguyên generation/DNR đang hoạt động.
- Hạ revision của cache trong profile thử rồi dừng/đánh thức worker: nguồn được lấy lại, generation và revision mới được lưu, hành vi script/cosmetic/exception vẫn đúng. Đây là kiểm tra migration bằng dữ liệu trạng thái được chủ động sửa trong profile thử.

Chi tiết: `tmp/capability-audit-2026-09-06/chrome-2026-09-06T12-56-08-629Z/report.json` và `REPORT.md`. Trang localhost và response nguồn HTTPS được dựng có kiểm soát; kết quả này không khẳng định mọi website thực tế đã được kiểm tra.

**7/7 ca Chrome thông thường cũng đạt**, không có lỗi JavaScript chưa xử lý: popup native 340 × 600 CSS px không tràn ngang, bật/tắt bằng bàn phím giữ focus và đổi việc chặn request thật, popup được người dùng chủ động mở vẫn hoạt động, Chrome chặn popup tự bật, compiled popup rule và phép thử chặn/redirect trên trang công khai hoạt động. Cùng artifact và cấu hình sandbox/popup blocker ở trên. Báo cáo: `tmp/capability-audit-2026-09-06/normal-2026-09-06T12-57-00-104Z/report.json`.

Tổng lượt xác nhận của bản sửa: **24/24 tình huống Chrome đạt**. Các profile thử đã đóng. Không đổi quyền extension, không nới quota hoặc bỏ các nhánh fail-open để làm cho kiểm thử đạt.
