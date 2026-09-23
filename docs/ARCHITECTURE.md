# Kiến trúc uBlock Plus+ Power Edition

> Trạng thái: tài liệu thiết kế. Một capability chỉ được coi là đã phát hành khi có implementation, test và release note tương ứng.

uBlock Plus+ là một fork độc lập, sideload-first, chạy trên Manifest V3. Sideload giúp dự án phát hành minh bạch ngoài Chrome Web Store, nhưng **không** làm mất quota Declarative Net Request (DNR), không khôi phục background page MV2 và không tự cấp `webRequestBlocking`.

## Nguyên tắc

1. Chặn bằng API công khai trước: DNR xử lý request mà không đánh thức service worker cho từng request.
2. Không tải hay thực thi mã từ xa. [MV3 remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) yêu cầu extension logic self-contained và định nghĩa JavaScript/Wasm ngoài package được browser thực thi là remotely hosted code. Dự án không dùng các API exception hẹp để phân phối remote project code. Filter list và catalog từ HTTPS vẫn là dữ liệu hostile; scriptlet/redirect resource/matcher phải được đóng gói, định danh và kiểm duyệt.
3. Quyền tăng dần theo capability. Tính năng cần quyền mạnh phải ở module/tầng riêng và cần đồng ý rõ ràng.
4. Trạng thái quan trọng phải lưu bền vững. [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) cho phép worker ngủ sau idle và chấm dứt task dài; global variables không phải source of truth.
5. Tối ưu RAM phải đo được, không đánh đổi bằng việc âm thầm tắt filter người dùng đã bật.
6. Không ghép rule nếu làm thay đổi priority, exception hoặc phạm vi domain.

## Bốn tầng capability không hoán đổi

| Tầng | Cách triển khai | Capability | Đồng ý và rủi ro |
| --- | --- | --- | --- |
| **Power Edition** | MV3 sideload/unpacked hoặc gói phát hành từ GitHub | DNR, cosmetic filtering, packaged scriptlets, compiled popup observer, Filter Store, custom/imported lists, per-site policy, picker/zapper, low-memory profile | Tầng mặc định. Vẫn chịu quota DNR, giới hạn regex và lifecycle service worker của Chrome. |
| **Managed Enterprise** *(tương lai, tùy chọn)* | Build/manifest riêng, cài bằng Chrome enterprise policy | Có thể dùng API chỉ dành cho extension policy-installed, nếu trình duyệt thực tế báo hỗ trợ; quản trị tập trung và policy cấu hình | Chỉ dành cho thiết bị do tổ chức quản lý. Admin phải triển khai policy; không giả mạo trạng thái managed. Quyền quan sát request rộng hơn nên cần audit và tài liệu vận hành riêng. |
| **Native Companion / Power Mode** *(tùy chọn; phần cập nhật đã phát hành, DNS/proxy vẫn R&D)* | Native Messaging host mã nguồn mở, cài riêng. Phạm vi đã phát hành: [trình cập nhật Windows](AUTO-UPDATE.md) tải, xác minh và thay gói unpacked; DNS/proxy cục bộ chỉ theo thiết kế được duyệt sau | Có thể bổ sung DNS visibility, diagnostics hoặc enforcement ngoài phạm vi API extension | Không mặc định, không tự cài, không chạy ẩn khi chưa có consent. IPC phải versioned, allowlist command, xác thực peer và giới hạn dữ liệu. Một native process làm tăng attack surface và chi phí RAM. |
| **Custom Chromium** *(R&D, tùy chọn)* | Browser build/patch riêng, cài và cập nhật độc lập | Chỉ capability được patch và test trong browser đó | Không phải Native Companion hay Managed Enterprise. Cần profile/support matrix riêng; không gán capability cho Google Chrome và không tắt sandbox/Site Isolation/Safe Browsing. |

Managed/native/custom-browser là ba hướng bổ sung khác nhau, không phải đường tắt để vô hiệu hóa sandbox, tải remote code hoặc vượt quota một cách không được Chrome hỗ trợ. Nếu capability probe hoặc adapter registration thất bại, extension phải hạ cấp an toàn về Power Edition.

Capability probe và phạm vi các browser flag/policy được định nghĩa tại [POWER-RUNTIME.md](POWER-RUNTIME.md). Runtime chỉ báo một engine là `eligible`; việc kích hoạt còn yêu cầu adapter tương ứng đã được đóng gói và đăng ký thành công.

## Luồng build

1. Lấy source/filter từ nguồn được pin hoặc khai báo trong build input. `make-rulesets.js` giữ list đã tải trong `dist/build/mv3-data` để thử lại offline, nhưng chỉ dùng lại bản tải chưa quá 7 ngày; bản cũ hơn được tải lại để bản phát hành build muộn không âm thầm chứa list cũ. Đặt `UBLOCK_PLUS_LIST_CACHE_MAX_AGE_DAYS` (hoặc tham số `listCacheMaxAgeDays=`) để đổi giới hạn; `Infinity` dùng lại bộ input đã lưu khi cần build lại đúng input cũ. `log.txt` ghi thời điểm tải của mỗi list dùng lại. Checkout sạch (CI) không có cache nên không bị ảnh hưởng.
2. Parser chuẩn hóa filter, loại trùng và phân loại capability.
3. Compiler tạo static/dynamic DNR, cosmetic data và tham chiếu tới packaged scriptlet.
4. Build stock tạo corpus typed bất biến `rulesets/popup/<rulesetId>.json`; compiler sandbox/imported tạo route generation-scoped. Condition subset hỗ trợ dùng `popup-observer-runtime`, condition chưa hỗ trợ giữ `popup-compiler-required` cùng reason cụ thể. Stock DNR export hiện chỉ bảo toàn kind `$popup`; `$popunder` được ghi `omitted`, không đổi nhãn.
5. Validator kiểm tra schema, ID range, quota, regex, resource reference, permission, route/condition consistency và remote-code policy.
6. Build report công bố số filter đầu vào, số rule đầu ra, route runtime/deferred, rule bị loại và lý do.
7. CI tạo artifact, checksum và provenance; phát hành chỉ từ commit/tag đã review. Workflow `release.yml` chạy khi push tag `v<version>` (tạo pre-release) hoặc khi maintainer chạy tay cho một tag có sẵn, và có hai job. Job build (read-only, không secret) chạy `npm ci --ignore-scripts`, test, lint, build và validate hai gói; mỗi gói có `updater/` và `updater/package-files.json`. Job publish không cài dependency: nó kiểm tra artifact, ký gói khi đã công bố khóa, kiểm tra khóa của release trước chấp nhận gói mới, attest build provenance và đăng asset với tên cố định mà [trình cập nhật](AUTO-UPDATE.md) sử dụng. Workflow không bao giờ thay asset: asset đã có trên release phải giống hệt từng byte với bản vừa build, nếu không workflow dừng, nên chạy tay lại cho một release đã đăng sẽ thất bại (ZIP build lại không giống từng byte); phát hành dở thì dùng **Re-run failed jobs**. Cờ pre-release chỉ được đặt khi workflow tạo release và không bao giờ bị đổi trên release đã có: muốn release thành stable, bỏ cờ trên GitHub (`gh release edit v<version> --prerelease=false`).

## Tối ưu và ghép rule

Rule optimizer được phép:

- chuẩn hóa URL/domain và loại rule trùng hoàn toàn;
- gộp domain chỉ khi action, condition, priority và exception tương đương;
- shard ruleset theo nhóm ngôn ngữ/chủ đề để chỉ bật phần người dùng cần;
- ưu tiên static ruleset cho dữ liệu đóng gói, dynamic rules cho lựa chọn/import của người dùng;
- budget quota theo [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest): static tách khỏi runtime; số rule dynamic/session có giới hạn riêng nhưng regex dynamic + session dùng chung pool tối đa 1.000, còn enabled static rulesets có aggregate pool 1.000 riêng, theo [Chromium CL 4903267](https://chromium.googlesource.com/chromium/src/+/eab7fc99e59b69e929d02e43bdcf8bbd75333869%5E%21/);
- hỏi quota khả dụng tại runtime và đưa ra lỗi có thể hành động thay vì cắt rule im lặng;
- cập nhật rule theo namespace ID và giao dịch remove/add có thể phục hồi.

Optimizer không được đổi thứ tự allow/block, làm rộng domain, bỏ exception, hạ priority hoặc chuyển filter không biểu diễn được thành rule “gần giống”. Filter không hỗ trợ phải được báo là deferred/rejected/partial trong compile report theo đúng output còn dùng được.

## Luồng runtime

- DNR xử lý network filtering mà không cần service worker chạy cho mọi request.
- Service worker quản lý setting, ruleset, migration, catalog và update idempotent; listener ở top level, state/generation/checkpoint được persist để wake/restart không dựa vào global memory cũ.
- Journal khôi phục không được chặn khởi động. Nếu khôi phục journal ruleset/compiled activation thất bại, lỗi được ghi vào console chẩn đoán và `startup.lastRecoveryError`, journal được giữ để thử lại ở lần khởi động sau, còn content script, popup blocker và firewall vẫn khởi động. Journal của package cũ (worker dừng giữa giao dịch rồi extension được cập nhật, kể cả qua auto-update) không phát lại static rule ID cũ: phần không phụ thuộc package (imported list, generation, lựa chọn ruleset, DNR của người dùng) được rollback. Chính bước rollback áp lựa chọn ruleset đã khôi phục cho package mới trước khi dựng lại DNR của người dùng, vì lần thử lại khi worker thức dậy không có `startSession()` chạy theo sau; áp lựa chọn thất bại thì journal được giữ để thử lại.
- Compiled filter cập nhật thất bại (mất mạng, host list lỗi) được retry sau khi khởi động xong, trong hàng đợi mutation, không trong đường khởi động mà mọi message phải chờ. Retry lùi dần từ 5 phút, nhân đôi tới tối đa 6 giờ; một thay đổi nguồn mới đặt lại backoff.
- Với `"incognito": "split"`, worker ẩn danh dùng chung `storage.local` nhưng không chung hàng đợi mutation trong bộ nhớ. Chỉ worker thường khôi phục journal, dọn generation staging/mồ côi và retry compiled filter; worker ẩn danh dùng chế độ lọc đã commit mà không rollback giao dịch chế độ lọc có thể đang chạy. Khi alarm `deferredJobs` đến, worker ẩn danh không lease, không đổi lịch và không chạy job lọc trong danh sách job dùng chung (cập nhật imported list, retry compiled filter); các job đó luôn do worker thường chạy. Worker ẩn danh chỉ dọn cache CSS của chính nó khi job `pruneCSSCache` đến hạn. Giới hạn còn lại: mutation do chính worker ẩn danh khởi tạo từ thao tác của người dùng (ví dụ trang extension mở trong cửa sổ ẩn danh) vẫn không được tuần tự hóa với worker thường, và việc ghi danh sách job từ hai worker vẫn là read-modify-write không nguyên tử (tệ nhất là một job chạy lặp lại).
- Mọi lần cập nhật DNR của người dùng đều áp bản nháp DNR developer đã lưu nếu cài được. Chỉ thao tác lưu tường minh (editor, hoặc khôi phục backup qua `updateUserDnrRules`) mới từ chối bản nháp không cài được; khi đó rule cũ được giữ. Các cập nhật khác (compiled activation, rollback, recovery, khởi động) chỉ khi bản nháp không cài được mới dùng lại rule developer đã ghi trong `userDnrRules.applied` (rule đã cài ở lần thành công gần nhất) kèm cảnh báo, thay vì thất bại. Khi chưa có bản ghi này (profile nâng cấp từ bản cũ đang giữ bản nháp lỗi), lỗi vẫn được trả về để không đoán sai và làm mất exception.
- Profile chưa từng đổi chế độ lọc được ghi chế độ mặc định vào `storage.local` một lần để content script đọc được; chế độ hiệu lực không đổi. Khi mất quyền host, site Optimal/Complete nằm dưới site cha đã tắt lọc được đưa về mức kế thừa thay vì ném lỗi guard dành cho thao tác người dùng.
- Content script ở `document_start` xử lý cosmetic filtering và gọi scriptlet đã đóng gói.
- Offscreen document chỉ sống trong phiên compile cần DOM API; hoàn tất phải đóng.
- Imported list được compile cục bộ thành DNR/cosmetic data; không `eval`, không import JavaScript từ URL. List hết hạn (`Expires`) được tải lại trong lần compile kế tiếp, và bản compile tốt gần nhất chỉ bị thay khi bản mới đã tải và compile xong. Tải/compile thất bại thì giữ bản cũ, không làm hỏng các lần compile khác, và lần thử sau lùi dần từ 1 giờ tới tối đa 1 ngày. Bản mới compile được nhưng làm generation không kích hoạt được (ví dụ vượt quota DNR) chỉ được dùng lại trong 1 giờ; sau đó bản đã kích hoạt gần nhất (giữ trong sidecar metadata cho tới khi bản mới commit) được khôi phục để filter cá nhân kích hoạt lại, và lần tải sau cũng lùi dần. Nguyên nhân lỗi gần nhất được lưu trong `refreshError` của list (đọc qua `getImportedLists`) cho tới khi cập nhật thành công. Nguồn pinned bằng SHA-256 là bất biến nên không tải lại theo thời hạn.
- Catalog Filter Store nằm tại `platform/mv3/extension/filter-store/catalog.json`, được đóng gói và chỉ đổi qua release đã review.
- Cache/report giữ cả kết quả runtime và deferred. Immutable active generation materialize route exact `popup-observer-runtime` cùng **deferred allow guard** tối thiểu từ `popup-compiler-required`; deferred block chỉ ở metadata. Guard không được phép allow/block: matcher bỏ predicate chưa biểu diễn theo hướng superset, và nếu phần còn lại có thể match thì trả `defer` trước block thường/heuristic để không làm mất exception. Observer nạp lazy generation sandbox/imported và chỉ các corpus stock đang bật sau service-worker wake.
- Popup condition cần initiator chỉ match khi context được đánh dấu complete. Popunder mất full original-opener context qua restart phải fail open để tránh broad false positive.
- Opener root/source frame được snapshot trước khi chờ gesture; `about:blank`/`about:srcdoc` leo parent, `blob:` giữ embedded origin và origin mơ hồ phải pending. No-filtering ở opener hoặc tab sắp đóng luôn thắng observer.
- Matcher cache validation/regex theo object bất biến và có aggregate budget. Regex unbounded không neo đầu bị deferred; URL quá dài giữ canonical origin để broad/domain rule không bị bypass. Ngoại lệ chỉ phần path đã bỏ mới khớp được thì `defer`; block chỉ phần đó mới khớp được thì bị bỏ qua. Hết budget thì `defer` chỉ khi một ngoại lệ còn có thể khớp (hoặc một block `important` chưa xét có thể thắng ngoại lệ đã khớp); ngoài ra block chưa xét bị bỏ qua và Smart/Strict vẫn quyết định.

Một input filter kết hợp có thể sinh DNR resource rule và typed popup route nhưng chỉ tính một input accepted. Popup-only supported vẫn accepted dù không sinh DNR; popup-only unsupported là deferred/rejected, còn phần DNR hợp lệ của filter kết hợp vẫn có thể accepted. Chi tiết và nguồn upstream nằm tại [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md).

## Cập nhật tự động

Hướng dẫn người dùng, protocol và chuỗi xác minh nằm tại [AUTO-UPDATE.md](AUTO-UPDATE.md); ranh giới tin cậy nằm tại [THREAT-MODEL.md](THREAT-MODEL.md#trình-cập-nhật-windows). Phần này mô tả cách worker nối các thành phần.

- **Module:**
  - `update-core.js`: hàm thuần, gồm parse/so sánh version, chọn release theo edition và kênh, backoff, chuẩn hóa reply của updater và policy.
  - `update-manager.js`: state, alarm, kiểm tra release và gọi native host.
  - `update-ui.js`: mục **Cập nhật** (Updates, `#autoUpdate`) trong **Cài đặt** (Settings) của dashboard.
  - `popup.js`: nút `#updateAvailable` (**Cập nhật x.y.z**, Update x.y.z), mở `dashboard.html#settings/autoUpdate`.
- **Khởi tạo độc lập với `start()`:** `background.js` tạo `updateManager` ở top level. Promise `updateReady` gọi `updateManager.initialize()` ngay khi worker bắt đầu và không chờ `isFullyInitialized`, vì một bản phát hành mới thường là cách thoát khỏi một lần khởi động lỗi hoặc chậm. Worker ẩn danh (`"incognito": "split"`) không khởi tạo, không ghi state dùng chung và không tạo alarm; mục Cập nhật mở trong cửa sổ ẩn danh chỉ hiển thị, các nút bị khóa. `initialize()` làm các việc sau:
  - đối chiếu `pendingReload` với version đang chạy, ghi `lastUpdate` hoặc lỗi `reload-mismatch`; sau một lần restore thì ghi `heldVersion`;
  - đánh dấu install còn dở là `interrupted`, và bỏ `available` đã cũ hoặc bị policy `off` chặn;
  - tạo alarm còn thiếu, kể cả `autoUpdateRetry` bị mất cùng phiên trình duyệt khi backoff chưa hết, hoặc xóa cả hai alarm khi kiểm tra bị tắt;
  - khi có `reopenSettings`, mở `dashboard.html#settings/autoUpdate` sau khi worker khởi động xong.
- **Message:** `UPDATE_MESSAGES` (`activateUpdater`, `getUpdateStatus`, `setUpdateSettings`, `checkForUpdatesNow`, `installUpdateNow`, `rollbackUpdate`) được xử lý trước mọi message khác và chỉ chờ `updateReady`. Chúng chỉ được nhận từ trang của chính extension (`sender.id`, URL và origin), không từ content script hay user script. Lỗi mang mã ổn định để trang hiển thị văn bản đã dịch. `installUpdateNow` trả lời ngay `{ started: true }`; tiến độ và kết quả nằm trong state, và sau các thay đổi state, worker phát `{ autoUpdate: true }` trên `BroadcastChannel('uBlockPlus')` để trang đọc lại.
- **Alarm:** listener alarm gọi `updateReady.then(() => updateManager.onAlarm(alarm))`.
  - `autoUpdateCheck` chạy định kỳ 360 phút, lần đầu sau ít nhất 2 phút.
  - `autoUpdateRetry` chạy một lần: khi backoff sau một lần kiểm tra lỗi hết hạn (15 phút, nhân đôi tới tối đa 1 ngày; mốc reset rate limit của GitHub thắng nếu muộn hơn), hoặc 5 phút sau khi một lần cài tự động bị từ chối vì giao dịch lọc đang chạy. Lần thử lại cài đặt không gọi lại GitHub.
  - Development build (số version đầu từ 2000), `check: false` và policy `off` xóa cả hai alarm.
- **Kiểm tra:** `fetch` release list với `If-None-Match` (ETag, 304 dùng lại danh sách đã lưu), `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, timeout 15 giây và giới hạn 2 MiB. Kiểm tra theo lịch cách nhau ít nhất 30 phút; sau một lần lỗi thì chờ hết backoff; **Kiểm tra ngay** (Check now) tối đa một lần mỗi phút, trừ ngay sau một lần kiểm tra lỗi không do rate limit hoặc ngay sau khi đổi kênh. Setting nằm ở `storage.local['autoUpdate.settings']`, state ở `storage.local['autoUpdate.state']`. Cả hai được chuẩn hóa lại mỗi lần đọc, vì content script đọc và ghi được `storage.local`, và không nằm trong backup. Policy managed `autoUpdate` (`off`, `notify`, `auto`) được đọc qua `adminReadEx`; `disabledFeatures: ["dashboard"]` hoặc một giá trị không hợp lệ được coi như `notify`.
- **Điều kiện cài:** không phải worker ẩn danh; không phải development build; `installType` là `development`; hệ điều hành là Windows (nếu không thì `unsupported-os`, nhưng bản mới vẫn được báo); policy khác `off`; quyền `nativeMessaging` đã được cấp và worker có binding. Chrome chỉ gắn `connectNative`/`sendNativeMessage` vào context tạo sau khi quyền được cấp, nên `activateUpdater` reload extension một lần rồi mở lại mục Cập nhật. Sau một lần khôi phục, chế độ cài tự động không tự cài `heldVersion` và các bản cũ hơn cho tới khi có release mới hơn, người dùng chọn **Cài đặt ngay** (Install now), hoặc version đang chạy đạt tới `heldVersion`.
- **Không thay thư mục khi đang lọc:** `isBusy` dùng `isUpdateBlocked()`. Hàm này chờ tối đa 60 giây cho startup và cho các giao dịch lọc đang xếp hàng hoặc đang chạy (`enqueueFilteringMutation.transactions`); với split incognito, nó còn chờ journal của worker ẩn danh trong cùng giới hạn. Hết giờ thì trả `filters-busy`. Journal còn lại sau một lần recovery lỗi không chặn cập nhật. Cài đặt kiểm tra điều kiện này trước khi tải và trước khi apply; khôi phục và restart cho updater cũng vậy.
- **Native host:** `io.github.kayurachann.ublock_plus.updater`, protocol v1.
  - `hello`, `apply` và `rollback` đi qua `sendNativeMessage`.
  - `stage` đi qua `connectNative`: port giữ worker sống trong lúc tải và mang sự kiện tiến độ.
  - Extension chỉ gửi lệnh và số phiên bản; host tự dựng URL, xác minh gói và thay thư mục.
  - Sau `apply` hoặc `rollback`, worker ghi `pendingReload` và gọi `runtime.reload()`.
  - Nếu `hello` của lần hỏi trạng thái (`getUpdateStatus` với `probe` khi mục Cập nhật mở, hoặc `activateUpdater`) báo `recovered` (host đã khôi phục backup sau một lần apply bị ngắt), state ghi lỗi `update-undone`, và extension reload nếu version được khôi phục khác version đang chạy. `hello` trong luồng cài bỏ qua trường này: updater đã hoàn tác và việc cài tiếp tục.
  - Worker chỉ chạy một install hoặc rollback tại một thời điểm; host tuần tự hóa bằng `updater.lock`.

## Memory profiles

Setting bền vững `memoryProfile` có ba giá trị:

- `auto`: dùng `navigator.deviceMemory`; thiết bị báo `<= 4 GiB` chọn `low-memory`, còn lại chọn `balanced`. Nếu API không có, dùng `balanced`.
- `balanced`: ưu tiên độ trễ UI/compile hợp lý.
- `low-memory`: compile imported list tuần tự; hạ ngưỡng CSS session cache xuống low/high `64/72`; dọn generation/cache mồ côi và prune theo watermark với nhịp kiểm tra 5 phút.

Message API hiện có: `getMemoryProfile`, `setMemoryProfile`, `getMemoryTelemetry`, `runMemoryCleanup`. Số liệu storage chỉ lưu/hiển thị cục bộ và không phải phép đo heap/RSS. Low-memory không tự tắt ruleset hay filter; hiệu quả RAM thực tế vẫn cần benchmark trên máy 2–4 GiB trước khi đưa ra con số quảng bá.

## Ranh giới dữ liệu

```text
Packaged catalog/filter data ──> compiler ──> static DNR + cosmetic cache
User-imported HTTPS list ──────> validator/compiler ──> dynamic DNR
                                             └───────> typed popup data
Page request ───────────────────────────────> Chrome DNR
Popup/tab events ──> service worker observer ───────> stock + generation typed popup matcher
DOM document ───────────────────────────────> packaged content scripts
Service worker ──HTTPS GET release list──────> api.github.com (chỉ đọc metadata công khai)

Optional (Windows, user cài riêng):
Extension ──Native Messaging v1 (lệnh + version)──> trình cập nhật
Trình cập nhật ──HTTPS .sha256/.zip/.sig──> GitHub Releases ──> xác minh ──> thư mục unpacked

Optional future:
Extension <── versioned Native Messaging IPC ──> local DNS/proxy/diagnostics companion
Custom Chromium artifact ──────────────────────> separately patched browser
```

Không đưa browsing history, nội dung trang hay telemetry ra khỏi máy. Endpoint mạng của phần cập nhật được liệt kê trong [PRIVACY.md](PRIVACY.md). Khi một feature mới cần truyền dữ liệu, feature đó phải cập nhật [THREAT-MODEL.md](THREAT-MODEL.md) và [PRIVACY.md](PRIVACY.md) trước khi merge.

## Đồng bộ upstream và giấy phép

Fork giữ lịch sử, copyright, source header và license GPL-3.0-or-later của [uBlock Origin](https://github.com/gorhill/uBlock). Code cộng đồng phải tương thích GPL và không dùng identity, signing key hay release channel chính thức của upstream. uBlock Plus+ là dự án độc lập tại `kayurachann/uBlock-Plus`, không phải sản phẩm được Raymond Hill bảo trợ.
