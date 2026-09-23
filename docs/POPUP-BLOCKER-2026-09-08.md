# Kiểm tra và sửa popup blocker — 8 September 2026

Phạm vi là tab/cửa sổ do website mở và các quyết định `$popup`/`$popunder`, không phải giao diện bảng điều khiển của extension. Mục tiêu là chặn popup không mong muốn mà vẫn giữ đăng nhập, thanh toán và biểu mẫu hợp lệ. Không dùng số popup bị đóng tối đa làm thước đo duy nhất.

## Lỗi đã tái hiện khi rà soát

- Một tab được mở bằng link hợp lệ có thể bị xét lại khi Chrome báo tải xong sau hơn 5 giây. Gesture đã hết hạn nên Smart có thể đóng nhầm tab đang tải chậm, dù URL không đổi.
- Hai lần bấm thật vào cùng link cách nhau dưới 750 ms bị gộp thành một gesture. Lần mở thứ hai có thể bị coi là popup không có thao tác người dùng.
- Candidate `$popunder` còn lưu có thể tiếp tục đóng tab sau khi tắt popup blocker. Một quyết định đang chờ bộ lọc cũng có thể tiếp tục chặn sau khi tắt bảo vệ trang.
- `about:blank#fragment` và `about:blank?query` giữ nguồn gốc kế thừa trong Chrome thật, nhưng việc so sánh chuỗi chính xác trước đây bỏ sót chúng, ảnh hưởng ngoại lệ theo nguồn mở.
- Khi mở tab liên tiếp, `tabs.onCreated.openerTabId` có thể trỏ vào popup trước, trong khi `webNavigation.onCreatedNavigationTarget.sourceTabId` chỉ đúng trang thực sự gọi `window.open`. Gán nhầm nguồn làm lọt burst và làm sai chẩn đoán. Chrome thật đã ghi nhận cả hai sự kiện với cùng tab đích để xác minh lỗi.

Các regression đơn vị cố ý điều khiển thời gian và thời điểm hoàn tất tác vụ bất đồng bộ để thử các race mà một lần duyệt web khó lặp lại ổn định.

## Cách sửa và giới hạn công việc

Nguồn do sự kiện điều hướng xác minh được ưu tiên hơn opener tạm thời. Khi nguồn thay đổi, candidate cũ cùng quyền gesture/burst gán nhầm được thu hồi; kết quả bất đồng bộ cũ không được đóng tab mới. Ngay trước khi đóng, runtime kiểm tra candidate, URL, trạng thái bật/tắt, mức lọc và chính sách ngữ cảnh hiện tại. Chuyển sang Allow trong khi chờ có hiệu lực với heuristic; compiled block vẫn giữ ưu tiên đã công bố.

Các cập nhật title/status/audio không biến một đích đã chấp nhận thành popup mới chỉ vì gesture hết hạn. Redirect thật vẫn xóa quyết định đích cũ và được xét lại. Sau khi worker bị Chrome thu hồi, candidate có đích tin cậy đã chấp nhận được bỏ qua khi phục hồi: checkpoint không giữ đường dẫn/query nên không đủ chứng cứ để phân biệt tải chậm với redirect. Đây là lựa chọn fail-open có chủ ý, không phải bảo đảm theo dõi mọi redirect xuyên worker restart.

Collector phân biệt lần nhấn riêng với các pha `pointerdown`/`click` của cùng thao tác. Đích biểu mẫu lấy từ các sự kiện `submit`/`formdata` thực tế, tôn trọng `formaction`, `formmethod`, trường GET và thay đổi của trang; không gọi thêm `FormData()` hay quét form. Công việc GET giới hạn 256 mục và URL 8192 ký tự; trường hợp mã hóa không xác minh được không được đoán thành exact target. POST không thu nội dung gửi. Có tối đa một callback chờ cho mỗi lô sự kiện submit, không thêm timer lặp.

Truy vấn gesture vẫn giới hạn 64 frame; frame thực sự mở popup được ưu tiên và việc frame khác trả lời không thay thế bằng chứng của frame nguồn. Chuỗi frame kế thừa vẫn giới hạn 32 mức. Nếu không đọc được trạng thái lưu, runtime không dùng Smart mặc định thay cho Allow chưa đọc được và giao diện báo lỗi đọc trạng thái.

## Phương pháp kiểm tra Chrome

Harness [test-popup-blocker-chrome.mjs](../tools/test-popup-blocker-chrome.mjs) chạy Google Chrome được cài trên máy, profile tạm riêng và bản extension đóng gói. Nó dùng máy chủ HTTP cục bộ với hostname `.localhost`, tab thật, click bàn phím/chuột thật và API Chrome thật. Không thay engine trong extension hoặc giả lập phản hồi mạng.

Một lượt giữ bộ chặn popup mặc định của Chrome. Một lượt phòng thử có `--disable-popup-blocking` để xác minh phần đóng tab của extension, kèm Off làm đối chứng. Cờ này chỉ áp dụng cho profile thử. Những popup bị Chrome ngăn tạo ra không được tính là thành công của extension.

Kết quả phải đồng thời ghi nhận tab đã được tạo, tab còn sống hay đã đóng, diagnostic đóng thành công của extension và request máy chủ nhận được. `window.open()` trả `null` không tự chứng minh bị chặn: `noopener` cũng có hành vi đó. Một request có thể bắt đầu trước khi observer MV3 nhận đủ thông tin để đóng tab.

Các lệnh đọc trước thao tác dùng CDP `Runtime.evaluate` với `userGesture:false`; lệnh evaluate phục vụ kiểm tra không được vô tình cấp activation cho trang. Mỗi ca automatic xác nhận `navigator.userActivation.isActive` và `hasBeenActive` đều false. Các lượt dựng harness ban đầu có lỗi đếm tên diagnostic và activation do công cụ kiểm tra tạo ra đã bị loại khỏi kết quả so sánh; lượt baseline cuối đã chạy lại với đối chứng sạch.

## Kết quả Standard 1.1.2 trên Chrome 152.0.7977.76

**54/54 ca đạt:** 27 với bộ chặn mặc định của Chrome và 27 trong profile phòng thử riêng. Không bật Allow User Scripts; không có page error được harness ghi nhận. Gói nạp là bản giải nén nguyên vẹn của ZIP release, 1117 file; SHA-256 của toàn bộ cây file được kiểm tra trước/sau khi chạy.

| Ca phòng thử, bộ chặn tích hợp đã tắt | Tab còn mở | Extension đóng thành công |
| --- | ---: | ---: |
| Một popup tự động khác hostname | 0 | 1 |
| Burst 3 cửa sổ tự động cùng nguồn | 1 | 2 |
| Một click thật mở 4 cửa sổ | 1 | 3 |
| Cửa sổ hợp lệ tải hơn 6 giây | 1 | 0 |

Các ca còn lại bao gồm link, Enter, hai lần bấm cách nhau dưới 750 ms, GET/POST, `formaction`, blank-document, blank rồi điều hướng, `noopener`, iframe có tên, nguồn iframe, opener chuyển sang trang Strict, Basic, Allow, Strict, compiled block/exception, site Off và tắt riêng tính năng popup. Các assertion kiểm tra đúng chính sách từng chế độ, không yêu cầu mọi popup đều bị đóng.

Pipeline dùng đúng Node 22.22.0/npm 11.19.1 của `.github/workflows/mv3-chromium.yml`: `npm ci`, **48 chương trình source test**, lint, build Standard/Experimental và cả hai validator release đều đạt. `npm audit` không có vulnerability. Mỗi entry ZIP được đối chiếu byte/hash với thư mục build và checksum sidecar. Có thêm **50 kiểm tra gesture** trong source suite và **6/6 probe DOM/server Chrome** cho thời điểm sự kiện form; probe nhỏ này là bằng chứng bổ sung, không thay cho harness extension đầy đủ.

Bộ lọc đóng gói được tái sử dụng từ cache đầu vào đã tải ngày 8 September cho release 1.1.1; lần sửa popup không thay nội dung các danh sách đó. Không gọi cache cũ là một lượt tải lại từ upstream. Quyền manifest và dependency runtime không tăng.

## So sánh cuối và artifact

| Bản giải nén được nạp vào Chrome | Chrome mặc định | Profile phòng thử | Tổng |
| --- | ---: | ---: | ---: |
| Standard 1.1.1 đã phát hành, baseline | 23/27 | 21/27 | 44/54 |
| Standard 1.1.2 | 27/27 | 27/27 | 54/54 |
| Experimental 1.1.2 | 27/27 | 27/27 | 54/54 |

10 ca baseline không đạt gồm **4 sai kết quả tab** và **6 sai dữ liệu intent**: tab tải chậm bị đóng trong hai profile; burst/flood lọt trong profile phòng thử; hai ca dùng lại sequence gesture; bốn ca nhận sai `formaction`. Trong baseline, cả hai tab từ hai click nhanh vẫn mở do lỗi nguồn làm che khuất lỗi gesture; không tuyên bố đã quan sát tab thứ hai bị đóng trên Chrome trong ca này. Regression đơn vị riêng chứng minh hậu quả khi nguồn đúng. Sau sửa, click cách nhau 60/73 ms có sequence `1→2`, thay vì `1→1` trước đó.

Tổng cộng **108/108 ca trên hai gói 1.1.2**. Gói Experimental được kiểm tra popup bằng API thông thường, không bật quyền WebRequest blocking trong harness này; kết quả không phải một chứng nhận lại riêng cho engine synchronous WebRequest. Các profile đều không bật Allow User Scripts và không có page error được harness ghi nhận.

Bằng chứng máy đọc được, gồm case results, đối chứng activation, native event nguồn mở và hash: [popup-blocker-2026-09-08.json](benchmarks/popup-blocker-2026-09-08.json). Không đưa profile Chrome, đường dẫn cá nhân hay dữ liệu duyệt web vào bản ghi public. Các report đầy đủ cục bộ nằm trong `tmp/popup-blocker-2026-09-08/{baseline-native-final,final-native-standard,final-native-experimental}/report.json`.

| ZIP release | SHA-256 |
| --- | --- |
| `uBlock-Plus_1.1.2.chromium.zip` | `fc1eee5a8f962a00a45ce140ec76952d8bfa941406dc91b3d6539a84a0e9c8aa` |
| `uBlock-Plus_1.1.2.experimental.chromium.zip` | `17314eaa71e3303cdc3df85ebd8f40467794ca35581191e9bad920a18959adef` |

Tree SHA-256 Standard: `9517175294c1e87de9bec52797bb0aa4184a7f483cf8a41b58d444515a5057a0`; Experimental: `e1c265624fa44b23ac4bf65254db90c5fdfd2b30ec227a657bdd867cec31e482`. Tree hash tính trên danh sách file được sắp xếp gồm path và hash nội dung; chỉ bỏ `_metadata` do Chrome tạo.

Baseline cuối và Experimental dùng harness SHA-256 `38cdd5fcf06d13fde7e57a9527927751607a940b358bffc75330ef4dc7d1c6d3`. Lượt Standard khởi chạy trước khi thêm duy nhất trường `harnessSHA256` vào report; mã hành vi/assertion giống nhau. Hash của phiên bản trước dòng metadata đó là `dee6a4598e6eca7d3ac65535a57831e5aee53ca4903b9ab7e3e1cf3ff1ef015b`. Thay đổi chỉ ghi nguồn report, không đổi extension hay kết quả thử.

GitHub CI xây lại mã nguồn của commit; đầu vào upstream tại thời điểm CI có thể khác cache local. ZIP release phải là đúng ZIP đã thử và có hash ở trên, không thay bằng artifact CI chưa được thử với harness.

Chạy lại với các đường dẫn tuyệt đối trên máy có Chrome và Playwright Core:

```powershell
node tools/test-popup-blocker-chrome.mjs --extension 'C:/Extensions/uBlock-Plus' --chrome 'C:/Program Files/Google/Chrome/Application/chrome.exe' --playwright 'C:/Tools/node_modules/playwright-core/index.mjs' --output 'C:/Tests/popup-results'
```

## Nguyên tắc tương thích giữ nguyên

- Off của popup blocker hoặc bảo vệ trang phải được tôn trọng, kể cả trong tác vụ đang chờ.
- Smart ưu tiên giữ thao tác người dùng hợp lệ; thiếu thông tin thì fail-open. Basic không có gesture collector nên không được diễn giải việc thiếu collector là bằng chứng popup xấu.
- Allow là ngoại lệ của chính sách ngữ cảnh; compiled popup filters vẫn có thứ tự ưu tiên riêng. Ngoại lệ lọc không bị bỏ chỉ để tăng số popup chặn được.
- Strict được người dùng chọn rõ ràng; cửa sổ đăng nhập/thanh toán khác hostname có thể bị chặn theo chính sách này.
- URL mới, redirect và `about:blank` rồi điều hướng vẫn cần được xét. Không cấp quyền mở vô hạn popup chỉ vì từng có một lần click.
- Không thêm engine userscript, quyền mới, vòng quét DOM định kỳ hoặc dịch vụ chạy nền thường trực. Bộ nhớ và lượng công việc phải có giới hạn.

## Cập nhật 23 September 2026

- Tab do người dùng mở, tức đích đã được chấp nhận nhờ gesture, có thể tiếp tục điều hướng sau khi gesture hết hạn. Ví dụ là bước đăng nhập hoặc thanh toán chuyển trang sau 10–20 giây. Nếu URL mới vẫn cùng hostname hoặc là hostname tổ tiên/hậu duệ (mọi cấp) của đích đã chấp nhận, lần điều hướng đó chỉ còn được xét bằng compiled popup filter. Heuristic không coi nó là popup mới. Hostname đã chấp nhận được giữ cố định, nên một chuỗi điều hướng không thể trôi dần sang site khác. Điều hướng sang hostname không liên quan vẫn bị xét lại như trước. Câu "Redirect thật vẫn xóa quyết định đích cũ" ở phần trên nay chỉ áp dụng cho trường hợp này.
- Chỉ đổi fragment (`#...`) không tải tài liệu mới. Việc này không kích hoạt xét lại và không hủy quyết định compiled đang chờ. Bước kiểm tra URL ngay trước khi đóng tab cũng bỏ qua fragment.
- Collector gửi tối đa 8 activation gần nhất còn trong 5 giây, mỗi activation giữ đích riêng. Observer ưu tiên activation có đích trùng với tab mới, sau đó mới dùng activation mới nhất chưa dùng. Nhờ vậy, nhiều click nhanh được xử lý muộn (ví dụ khi worker khởi động lạnh) không còn làm đóng tab thứ hai. Mỗi activation vẫn chỉ cho phép mở một tab.
- Matcher compiled xét allow trước block. URL landing dài bình thường không còn làm Smart/Strict bị bỏ qua. URL dài hơn 8 KB cũng vậy, trừ khi một ngoại lệ vẫn có thể khớp phần path đã bỏ. Block thường chưa xét được không còn giữ lại một ngoại lệ đã khớp. Chi tiết budget nằm trong [FEATURE-MATRIX](FEATURE-MATRIX.md).
- Tab do người dùng mở có thể đi theo link hoặc form mà người dùng kích hoạt trong chính tab đó để sang hostname khác, kể cả sau 5 giây. Khi Chrome báo URL mới qua `tabs.onUpdated`, content script của tài liệu cũ đã bị thay. Vì vậy `popup-blocker.js` có hook `onBeforeNavigate(details)` cho frame 0. Lúc điều hướng bắt đầu, tài liệu cũ vẫn còn, nên observer hỏi activation của chính tab đó. Chỉ activation chưa dùng, còn trong 5 giây và có đích trùng đúng URL điều hướng mới được tính. Server redirect sau đó vẫn thuộc cùng lần điều hướng. Hostname đích trở thành hostname được chấp nhận mới, và đích vẫn được xét bằng compiled popup filter. Redirect do script, meta refresh hoặc click không liên quan vẫn bị xét lại. Cập nhật URL đến trong lúc đang hỏi sẽ chờ câu trả lời và giữ nguyên thứ tự.
- Giới hạn còn lại: `background.js` chuyển tiếp `webNavigation.onBeforeNavigate` của frame 0 tới `popupBlocker.onBeforeNavigate(details)`, nên liên kết hoặc form người dùng bấm trong chính tab đó được giữ. Các trường hợp vẫn bị xét lại như popup không có gesture: hostname anh em (ví dụ `checkout.shop.example` → `pay.shop.example`), redirect bằng script hoặc meta-refresh sang host khác sau 5 giây, và URL người dùng gõ hoặc chọn từ bookmark (không có activation trong trang).

Các kết quả Chrome ở trên thuộc bản 1.1.2, trước các thay đổi này. Harness Chrome chưa được chạy lại cho bản cập nhật này; các thay đổi được kiểm tra bằng regression đơn vị trong `tools/test-popup-policy.mjs`, `tools/test-popup-gesture-context.mjs` và `tools/test-compiled-popup-matcher.mjs`.

## Nguồn đối chiếu

- [Full uBlock Origin issue #3945](https://github.com/uBlockOrigin/uBlock-issues/issues/3945): tab mở hợp lệ bị đóng sau khi opener đổi trang. Dùng làm thiết kế ca vòng đời, không mặc định mọi chi tiết của issue đều có trong fork.
- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): nguồn mở có `sourceTabId`/`sourceFrameId`; thứ tự với webRequest không được bảo đảm.
- [MDN window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open): `noopener`, named target và giá trị trả về.
- [WebBrowserTools popup mechanisms](https://webbrowsertools.com/popup-blocker/) và [mã nguồn bộ thử](https://github.com/schomery/popup-blocker/blob/1d9edf75e31190608abd86d634ba71e8d2fb84c7/test/popup-blocker.html): tham khảo loại cơ chế, không coi chặn tất cả các nút là điểm chất lượng.

Đây là kiểm thử cơ chế có kiểm soát, không phải chứng nhận chặn mọi popup trên Internet hoặc đạt tương đương toàn bộ MV2.
