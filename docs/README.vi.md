<div align="center">

<img src="assets/readme/hero.png" alt="Minh họa một tấm khiên lọc quảng cáo, tracker, cookie và các request không mong muốn trước khi trang Chromium tải" width="1100">

<sub>Ảnh minh họa ý tưởng · v1.0.0 là pre-release sideload cập nhật thủ công</sub>

# uBlock Plus+

### Chặn nội dung trên Chromium MV3 — cởi mở, cục bộ và do bạn kiểm soát

**Sideload-first · Local-first · Mã nguồn mở · Không khóa người dùng**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Pre-release v1.0.0](https://img.shields.io/badge/pre--release-v1.0.0-f59e0b)](https://github.com/kayurachann/uBlock-Plus/releases/tag/v1.0.0)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#cài-đặt-pre-release)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[**Tải pre-release v1.0.0**](https://github.com/kayurachann/uBlock-Plus/releases/tag/v1.0.0) · [English](../README.md) · [Tính năng](FEATURE-MATRIX.md) · [Kiến trúc](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [Roadmap](ROADMAP.md)

</div>

---

uBlock Plus+ là bộ chặn nội dung GPL dành cho Chromium MV3, phát triển độc lập từ nền tảng parser/compiler đã được chứng minh của upstream. Dự án bổ sung Filter Store cộng đồng, repository HTTPS tùy chỉnh, cấu hình có thể sao lưu và các profile vận hành có ý thức về bộ nhớ—không có dịch vụ telemetry của dự án hay mã thực thi tải từ xa.

> [!IMPORTANT]
> Đây không phải bản phát hành chính thức của uBlock Origin/uBO Lite và không được Raymond Hill bảo trợ. Chrome MV3 không cung cấp toàn bộ primitive chặn của uBlock Origin MV2. Sideload tránh chính sách phân phối của Chrome Web Store, nhưng **không** xóa quota DNR, lifecycle service worker hoặc sandbox của trình duyệt. Xem [bảng tương thích trung thực](FEATURE-MATRIX.md).

> [!WARNING]
> **v1.0.0 là pre-release để thử nghiệm công khai.** Bản sideload không tự cập nhật qua Store; bạn cần theo dõi trang [Releases](https://github.com/kayurachann/uBlock-Plus/releases), đọc release note và cập nhật thư mục extension thủ công.

## Những gì bạn kiểm soát

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ Chặn nội dung nhiều lớp

Static, dynamic và session DNR phối hợp với cosmetic filtering, scriptlet đóng gói, strict blocking, popup control và chế độ lọc riêng cho từng website.

</td>
<td width="50%" valign="top">

### 🧩 Filter Store cộng đồng

Khám phá catalog có sẵn hoặc thêm tối đa tám repository HTTPS tương thích. Danh sách từ xa chỉ là **dữ liệu filter**, không phải plugin hay JavaScript tải về để chạy.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 Tùy biến và mang theo

Dùng picker, zapper, custom/imported filters và matched-rule diagnostics. Cấu hình lõi, subscription và repository có thể xuất rồi khôi phục.

</td>
<td width="50%" valign="top">

### 🌱 Profile có ý thức về RAM

Chọn `auto`, `balanced` hoặc `low-memory`. Low-memory được thiết kế để giảm áp lực bộ nhớ bằng compile tuần tự, cache có ngân sách và cleanup an toàn—không âm thầm tắt filter đã bật.

</td>
</tr>
</table>

> [!NOTE]
> Dự án chưa quảng cáo một con số RAM tuyệt đối. Hiệu quả thực tế phụ thuộc phiên bản Chromium, số danh sách bật và workload; benchmark có thể tái lập vẫn là release gate của dự án.

<img src="assets/readme/feature-map.svg" alt="Sơ đồ pipeline uBlock Plus+ từ lựa chọn filter tới DNR và cosmetic filtering" width="1200">

## Giao diện thực tế

<sub>Chụp trực tiếp từ artifact v1.0.0 đã Load unpacked trong profile Edge mới · không chứa dữ liệu duyệt web cá nhân</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="Giao diện thật của Filter Store hiển thị ước tính quota DNR, ba bundle và card filter cộng đồng đầu tiên">

<strong>Filter Store</strong><br>
Duyệt entry cộng đồng, xem tác động quota và chủ động bật các bundle được cấu hình sẵn.

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Giao diện thật của Memory Profile hiển thị chế độ Auto, Effective Balanced và số liệu lưu trữ cục bộ">

<strong>Memory Profile</strong><br>
Chọn Auto, Balanced hoặc Low-memory và xem số liệu cache/storage cục bộ—không phải RAM trực tiếp.

</td>
</tr>
</table>

## Cài đặt pre-release

<img src="assets/readme/install-flow.svg" alt="Bốn bước sideload uBlock Plus+: tải và giải nén, kiểm tra SHA-256, Load unpacked và bật User Scripts khi cần" width="1200">

1. Tải file `uBlock-Plus_1.0.0.chromium.zip` và file `.sha256` tương ứng từ [release v1.0.0](https://github.com/kayurachann/uBlock-Plus/releases/tag/v1.0.0).
2. Kiểm tra SHA-256, sau đó giải nén ZIP vào một thư mục cố định. Không xóa hoặc di chuyển thư mục này sau khi load.
3. Mở `chrome://extensions` hoặc `edge://extensions`, bật **Developer mode**, chọn **Load unpacked**, rồi chọn thư mục chứa `manifest.json`.
4. Cấp quyền chạy user script theo phiên bản trình duyệt:
   - **Chrome 130–137:** giữ **Developer mode** bật; đây là cổng cho API User Scripts ở các phiên bản này.
   - **Chrome 138 trở lên:** mở trang **Details/Chi tiết** của extension và bật **Allow User Scripts/Cho phép tập lệnh người dùng**.
   - **Edge hoặc Chromium khác:** bật công tắc tương đương nếu trình duyệt hiển thị.
   - Nếu vừa thay đổi công tắc, bấm **Reload/Tải lại** trên thẻ extension để service worker nhận trạng thái API mới. Xem [hướng dẫn `userScripts` của Chrome](https://developer.chrome.com/docs/extensions/reference/api/userScripts).
5. Mở giao diện uBlock Plus+, kiểm tra danh sách đang bật và chỉ thêm repository/filter từ nguồn bạn tin cậy.

<details>
<summary><strong>Kiểm tra checksum trên Windows</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

Hai chuỗi hexadecimal phải giống nhau; chữ hoa hay chữ thường không ảnh hưởng.

</details>

> [!CAUTION]
> Chỉ cài artifact từ [repository](https://github.com/kayurachann/uBlock-Plus) hoặc [trang Releases](https://github.com/kayurachann/uBlock-Plus/releases) chính thức của fork. Sideload trao cho bạn nhiều quyền lựa chọn hơn, đồng thời yêu cầu bạn tự xác minh nguồn và cập nhật bảo mật.

## Build từ mã nguồn

Yêu cầu: Chrome/Chromium hoặc Edge 130+, Git với submodule, Node.js 22+ và kết nối mạng cho dữ liệu filter tại build-time.

<details open>
<summary><strong>Windows / PowerShell</strong></summary>

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
.\tools\make-mv3.ps1 -Platform chromium -Version $version
```

</details>

<details>
<summary><strong>Linux / macOS</strong></summary>

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
make mv3-chromium

# Tùy chọn: tạo thêm ZIP có version và file SHA-256.
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

Load thư mục `dist/build/uBOLite.chromium`. Lệnh PowerShell có version và lệnh shell tùy chọn ở trên tạo ZIP/checksum trong `dist/build/`; riêng `make mv3-chromium` chỉ tạo thư mục unpacked.

## Ranh giới an toàn

| Phạm vi | Cam kết của dự án |
| --- | --- |
| Nguồn từ xa | Catalog và filter list HTTPS được xử lý như dữ liệu có giới hạn kích thước/fetch; redirect và schema không hợp lệ bị từ chối. |
| Mã extension | JavaScript, scriptlet và redirect resource phải nằm trong gói đã review; không `eval` hoặc chạy code từ repository bên ngoài. |
| Quyền riêng tư | Không có analytics, quảng cáo hay dịch vụ thu thập lịch sử duyệt web của dự án. Quyền Chrome `privacy` là tùy chọn và có thể thu hồi. |
| Filter Store | Entry hiển thị trust tier; catalog tùy chỉnh vẫn là `community`, không tự được xem là verified. |
| Bản phát hành | CI lint, test, build và validate artifact Chromium; release cung cấp checksum SHA-256 để người dùng đối chiếu. |

Lỗ hổng bảo mật cần được báo riêng qua [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new), không đăng exploit lên issue công khai. Xem [SECURITY.md](../SECURITY.md).

## Giới hạn MV3 cần biết

- DNR chịu quota static/dynamic/session/regex do Chromium đặt ra.
- Service worker có thể bị dừng khi idle; dự án dùng state bền vững và giao dịch có rollback thay vì giả định background page chạy mãi.
- Live logger, procedural filter, dynamic firewall và một số header/redirect semantics chỉ tương đương **một phần** MV2.
- Public MV3 API không cung cấp response-body rewrite tùy ý, DNS/CNAME visibility tương đương hoặc chặn chính xác theo kích thước response.
- Tầng Enterprise hoặc Native Companion mới chỉ là hướng nghiên cứu tùy chọn; không tự cài, không phải cách bypass sandbox và không nằm trong lời hứa của pre-release này.

Một phần cú pháp filter MV2 không thể chuyển đổi tương đương trên MV3; hãy đối chiếu [FEATURE-MATRIX.md](FEATURE-MATRIX.md) trước khi giả định tính năng đã được hỗ trợ. Báo cáo tương thích chi tiết đến từng filter vẫn là hạng mục roadmap.

## Tài liệu và cộng đồng

| Tài liệu | Nội dung |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Pipeline MV3, transaction, memory profile và các tầng capability hợp pháp. |
| [FILTER-STORE.md](FILTER-STORE.md) | Schema catalog, trust tier, giới hạn nguồn và quy trình review. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Tài sản, trust boundary và rủi ro supply chain. |
| [PRIVACY.md](PRIVACY.md) | Dữ liệu lưu cục bộ, network access và permission. |
| [ROADMAP.md](ROADMAP.md) | Now/Next/Later cùng definition of done; không phải cam kết ngày phát hành. |
| [COMMUNITY-GOVERNANCE.md](COMMUNITY-GOVERNANCE.md) | RFC, vai trò, biểu quyết và cách xử lý xung đột. |

[Đề xuất tính năng hoặc báo lỗi](https://github.com/kayurachann/uBlock-Plus/issues/new/choose) · [Gửi Filter Store entry](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml) · [Xem toàn bộ roadmap](ROADMAP.md)

## Ghi công và giấy phép

uBlock Plus+ là tác phẩm phái sinh từ [uBlock Origin](https://github.com/gorhill/uBlock) và phần triển khai MV3/uBO Lite. Lịch sử Git, copyright, source header, tác giả và attribution của upstream được giữ lại. Xem [NOTICE.md](../NOTICE.md).

Phát hành theo [GNU General Public License v3.0 hoặc mới hơn](../LICENSE.txt).

<div align="center">

**Mã nguồn mở, minh bạch và được định hình bởi chính người dùng.**

[Trở lại đầu trang ↑](#ublock-plus)

</div>
