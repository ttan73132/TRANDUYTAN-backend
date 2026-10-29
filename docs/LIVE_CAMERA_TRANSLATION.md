# Dịch camera trực tiếp và lịch sử riêng

Camera preview → chụp khung hình tự động có giới hạn tần suất → OCR ML Kit → dịch trên thiết bị. Chọn nguồn/đích Việt, Anh hoặc Trung. Chỉ có một khung đang xử lý; ảnh tạm được xóa sau xử lý. Không gửi luồng video/ảnh lên API. Kết quả nhận dạng/dịch có thể sai và cần người dùng đối chiếu.

Khi người dùng bấm **Lưu**, frontend gửi văn bản gốc/bản dịch tới backend bằng phiên đăng nhập thật. Lịch sử chỉ chủ tài khoản đọc/xóa, kể cả khi người khác là admin. Có thể mở lại để sao chép hoặc soạn bàn giao; lưu bản dịch không tự xác nhận dữ kiện của bàn giao.

## Hợp đồng API

Các route yêu cầu Bearer token và tài khoản active. Base là `/v1`.

- `POST /camera-translations`: `{clientRequestId: UUID, sourceLanguage: vi|en|zh, targetLanguage: vi|en|zh, originalText: string, translatedText: string}`. Hai ngôn ngữ khác nhau; mỗi văn bản sau trim có1–6000ký tự. Không nhận trường ảnh hoặc trường ngoài schema.
- Trả `201` lần đầu, `200` khi gửi lại cùng requestId và cùng nội dung. Cùng requestId nhưng khác nội dung trả `409 CAMERA_REQUEST_CONFLICT`; không ghi đè bản cũ. Mỗi lần lưu kết quả mới phải dùng UUID mới, nhưng thử lại sau lỗi mạng phải giữ UUID cũ.
- `GET /camera-translations`: tối đa20kết quả mới nhất của chính tài khoản, thứ tự createdAt giảm dần. Không có query để đọc người khác.
- `DELETE /camera-translations/:id`: xóa của chính tài khoản; thành công `{data:{deleted:true}}`; mã không tồn tại/khác chủ trả404.
- Bản ghi trả: `{id,sourceLanguage,targetLanguage,originalText,translatedText,createdAt}` trong envelope `data`. Không chứa ảnh, userId, khóa hoặc token.

## Dữ liệu và triển khai

Migration **005_camera_translations.sql** thêm bảng/index riêng; không sửa migration cũ hoặc dữ liệu chấm công. Khóa unique `(user_id,client_request_id)` bảo vệ gửi đồng thời; SQL luôn ràng buộc owner và tham số hóa. Rollback code cũ có thể để bảng này nguyên trạng, không cần xóa dữ liệu.

Backend kiểm dữ liệu/quyền/lưu trữ; **không xác minh độ chính xác OCR hoặc bản dịch do client gửi**. Xác nhận dữ kiện bàn giao vẫn là luồng độc lập có phiên bản.

Kiểm tra mới:5API tests và12checks PostgreSQL thật gồm TLS, schema thử không có fallback public, migration1–5lặp, gửi đồng thời, owner isolation,20bản ghi mới nhất, dữ liệu không hợp lệ và xóa đúng chủ; schema thử đã dọn. Toàn bộ backend **96/96**. Native camera/độ chính xác OCR qua camera cần đối chiếu báo cáo app cuối; các kiểm tra backend không thay thế bằng chứng đó.
