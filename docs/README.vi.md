# uBlock Plus+

uBlock Plus+ là fork cộng đồng độc lập, mã nguồn mở GPL-3.0-or-later, phát triển từ cây mã nguồn uBlock Origin và tập trung vào Chrome/Chromium Manifest V3. Repository chính thức của fork: [kayurachann/uBlock-Plus](https://github.com/kayurachann/uBlock-Plus).

> [!IMPORTANT]
> Dự án không phải bản phát hành chính thức của uBlock Origin/uBO Lite và không được Raymond Hill bảo trợ. Chrome MV3 không có đủ API để tái tạo uBlock Origin MV2 chính xác 100%. Sideload cũng không loại bỏ quota DNR hoặc giới hạn service worker.

## Hướng sản phẩm

- **Power Edition, sideload-first:** DNR, cosmetic filtering, packaged scriptlets, per-site policy, picker/zapper, custom/imported filters và backup/restore.
- **Filter Store:** catalog filter cộng đồng được đóng gói, review nguồn/license/an toàn; filter chỉ là dữ liệu, không phải code/plugin từ xa.
- **Máy yếu:** profile `auto`, `balanced`, `low-memory`; compile tuần tự và cache có ngân sách, không tự tắt filter.
- **Tầng tùy chọn tương lai:** managed enterprise và native companion mã nguồn mở, cài riêng, consent rõ ràng và threat-model riêng.

## Build và sideload trên Windows

Yêu cầu Chrome/Chromium hoặc Edge 130+, Git, Node.js 22 trở lên và kết nối mạng:

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
.\tools\make-mv3.ps1 -Platform chromium
```

Mở `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked**, rồi chọn `dist/build/uBOLite.chromium`.

Các quyền DNR, host access, scripting, storage, alarms, offscreen và userScripts là quyền lõi để bộ chặn hoạt động. Chỉ nhóm điều khiển cài đặt riêng tư của Chrome dùng quyền `privacy` tùy chọn và có thể thu hồi.

Sau khi **Load unpacked** trên Chrome/Chromium/Edge, hãy mở trang **Chi tiết** của tiện ích và bật **Cho phép tập lệnh người dùng** nếu trình duyệt hiển thị công tắc này; nếu không, bộ lọc giao diện và scriptlet đóng gói từ danh sách nhập sẽ không được đăng ký. Chỉ cài artifact từ GitHub repository/release chính thức của fork và kiểm tra file checksum SHA-256 đi kèm. Bản sideload không tự cập nhật như Chrome Web Store; người dùng cần theo release note của dự án.

## Tài liệu thiết kế và cộng đồng

- [ARCHITECTURE.md](ARCHITECTURE.md): Power Edition, enterprise/native tùy chọn, rule optimizer và memory profiles.
- [FEATURE-MATRIX.md](FEATURE-MATRIX.md): những gì MV3 làm được, làm được một phần hoặc không có tương đương.
- [FILTER-STORE.md](FILTER-STORE.md): schema catalog, trust tiers và quy trình duyệt filter.
- [THREAT-MODEL.md](THREAT-MODEL.md): tài sản, trust boundary, supply-chain risk và biện pháp phòng vệ.
- [COMMUNITY-GOVERNANCE.md](COMMUNITY-GOVERNANCE.md): vai trò, RFC, biểu quyết và xử lý xung đột.
- [ROADMAP.md](ROADMAP.md): tiêu chí xếp ưu tiên và release gates.
- [MODULE-PLAN.md](MODULE-PLAN.md): ranh giới module để tiếp nhận yêu cầu cộng đồng mà không làm core phình vô hạn.
- [PRIVACY.md](PRIVACY.md): dữ liệu cục bộ, network access và quyền trình duyệt.

## Ghi công

Fork giữ nguyên lịch sử Git, bản quyền và giấy phép của Raymond Hill cùng toàn bộ cộng tác viên upstream. Xem [NOTICE.md](../NOTICE.md). Lỗi riêng của fork được báo tại repository uBlock Plus+; lỗi nội dung của một filter list nên báo cho maintainer của danh sách đó theo metadata trong Filter Store.
