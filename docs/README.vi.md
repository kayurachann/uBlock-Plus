# uBlock MV3 Community

Đây là fork cộng đồng độc lập, mã nguồn mở GPL-3.0-or-later, được xây dựng từ cây mã nguồn uBlock Origin hiện hành và tập trung vào Chrome/Chromium Manifest V3.

> [!IMPORTANT]
> Dự án này không phải bản phát hành chính thức của uBlock Origin/uBO Lite và không được Raymond Hill bảo trợ. Chrome MV3 không cung cấp đủ API để tái tạo uBlock Origin MV2 chính xác 100%. Mục tiêu của fork là đạt mức tương đương cao nhất có thể trên MV3, hoạt động ổn định và công khai rõ những phần không thể chuyển đổi.

## Tính năng

- Chặn mạng bằng Declarative Net Request (DNR), gồm ruleset tĩnh, rule động và rule theo phiên.
- Lọc giao diện, scriptlet đóng gói, chế độ lọc theo từng website, chặn nghiêm ngặt, chặn popup, chọn/xóa phần tử, filter tự tạo, nhập danh sách ngoài, sao lưu/khôi phục và xem rule khớp.
- Service worker gọn, chịu được việc Chrome dừng/khởi động lại; trạng thái quan trọng được lưu bền vững.
- Tự bật danh sách vùng phù hợp ngôn ngữ trình duyệt; Chrome tiếng Việt sẽ dùng ABPVN.
- Tùy chọn tăng cường riêng tư: tắt hyperlink auditing, dự đoán mạng, UDP WebRTC ngoài proxy và các API quảng cáo Privacy Sandbox. Quyền `privacy` chỉ được hỏi khi người dùng chủ động bật tính năng.
- Build một lệnh trên Windows và CI tạo artifact MV3 để kiểm thử.

## Build trên Windows

Yêu cầu Git, Node.js 22 trở lên và kết nối mạng:

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-MV3-Community.git
cd uBlock-MV3-Community
.\tools\make-mv3.ps1 -Platform chromium
```

Sau khi build, mở `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked**, rồi chọn thư mục:

```text
dist/build/uBOLite.chromium
```

## Lưu ý về MV3

Chrome Web Store không cho extension MV3 công khai dùng `webRequestBlocking`; API này chỉ còn khả dụng với extension được cài bằng enterprise policy. Vì vậy phần lọc mạng phải được biên dịch sang DNR. Một số khả năng MV2 không có tương đương hoàn chỉnh, như sửa nội dung response/HTML, CNAME uncloaking, logger thời gian thực đầy đủ và một số cú pháp filter động. Xem bảng chi tiết tại [FEATURE-MATRIX.md](FEATURE-MATRIX.md).

## Quyền riêng tư

Fork không thu thập telemetry và không có máy chủ phân tích. Danh sách filter có thể được tải từ các URL mà người dùng bật hoặc nhập. Xem [PRIVACY.md](PRIVACY.md) để biết dữ liệu nào nằm trong trình duyệt và lý do từng quyền.

## Ghi công

Fork giữ nguyên lịch sử Git, bản quyền và giấy phép của Raymond Hill cùng toàn bộ cộng tác viên upstream. Xem [NOTICE.md](../NOTICE.md). Đây là dự án độc lập; vấn đề của fork nên được báo tại repository này, còn lỗi nội dung trong filter list upstream nên báo cho dự án sở hữu danh sách đó.
