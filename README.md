# Backend chấm công — Nguyễn Hoài Nam, 2380601398, nhóm 8

API Node.js/PostgreSQL dành cho app Flutter. Chỉ triển khai trên dịch vụ có HTTPS để nộp bài; app không được cấu hình API localhost. README mô tả source, cấu hình và bằng chứng kiểm chứng; trạng thái API/email production cần đối chiếu với kết quả triển khai thực tế.

## Chạy và deploy

Yêu cầu Node.js 22 trở lên; đã kiểm tra các lệnh Node và kiểm thử trên Node.js 24.14.0/Windows. Không dùng Python. Từ thư mục `backend`:

```sh
npm ci
npm run models:fetch
node tool/setup-env.js
```

`setup-env.js` chỉ tạo `.env` khi chưa tồn tại, sinh hai khóa ngẫu nhiên khác nhau và không in khóa ra terminal. Điền các trường còn trống trong `.env` cục bộ. Không đưa `.env` vào Git, APK, ảnh chụp hoặc chat.

| Cấu hình | Cần cung cấp |
|---|---|
| `DATABASE_URL` | Kết nối PostgreSQL của dịch vụ hosting |
| `DATABASE_SSL` | `true` cho production; chứng chỉ phải được xác minh |
| `DATABASE_CA_CERT` | PEM CA riêng nếu nhà cung cấp yêu cầu; không tắt kiểm tra chứng chỉ |
| `APP_TIME_ZONE` | Ngày công của dashboard; mặc định `Asia/Bangkok` theo múi giờ phiên làm việc (UTC+7) |
| `JWT_SECRET`, `OTP_SECRET` | Hai khóa khác nhau, tối thiểu 32 ký tự; chỉ ở backend |
| `EMAIL_PROVIDER` | `apps_script` mặc định; `brevo` là phương án tùy chọn |
| `OTP_RELAY_URL` | URL Web App đúng dạng `https://script.google.com/macros/s/<deployment>/exec` |
| `OTP_RELAY_SECRET` | Khóa riêng tối thiểu 32 ký tự, khác hai khóa trên; cùng giá trị với Script property của relay |
| `BREVO_API_KEY` | Chỉ cần nếu chọn `EMAIL_PROVIDER=brevo` |
| `BREVO_SENDER_EMAIL` | Chỉ cần với Brevo: địa chỉ người gửi đã cấu hình/xác minh |
| `BOOTSTRAP_ADMIN_FULL_NAME` | Tên quản trị viên đầu tiên |
| `BOOTSTRAP_ADMIN_USERNAME` | Tên đăng nhập quản trị viên |
| `BOOTSTRAP_ADMIN_EMAIL` | Email thật để nhận OTP |
| `BOOTSTRAP_ADMIN_PASSWORD` | Mật khẩu riêng, 10–128 ký tự; không dùng mật khẩu mẫu |

`npm start` kiểm tra cấu hình, áp dụng migration rồi mở API. Mỗi migration có checksum; không chỉnh SQL đã áp dụng vào database, hãy tạo migration tiếp theo. PostgreSQL advisory lock điều phối việc migrate khi khởi động. Lệnh `npm run migrate` có thể chạy riêng.

Nếu đã đặt các biến `BOOTSTRAP_ADMIN_*`, lần khởi động đầu tạo một admin đang hoạt động **chỉ khi database chưa có admin**. Không ghi đè mật khẩu hoặc nâng quyền tài khoản hiện có. Sau khi đăng nhập thành công, xóa các biến bootstrap khỏi môi trường deploy và khởi động lại. Có thể dùng `npm run bootstrap-admin` khi có quyền chạy CLI trên server; lệnh từ chối nếu đã có admin. Không có tài khoản hoặc mã OTP dùng chung mặc định.

### Render Free

`render.yaml` là cấu hình để xem xét, tự nó không tạo hoặc publish dịch vụ. Repository triển khai hiện là **backend-only ở repository root**: khi tạo Web Service thủ công, để trống Root Directory, không nhập `backend`. Dùng lại database đã tạo `nguyen-hoai-nam-2380601398-db`; không tạo database thứ hai từ blueprint. Build command:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci && npm run models:fetch
```

Start command: `npm start`. Health check: `/v1/health`. Đặt `NODE_ENV=production`, `TRUST_PROXY=true` và các biến bảng trên qua giao diện quản lý bí mật của Render. Điền **External Database URL đầy đủ** vào `DATABASE_URL`, giữ `DATABASE_SSL=true` để xác minh chứng chỉ CA/hostname. [Internal URL của Render](https://render.com/docs/postgresql-creating-connecting#ssl-modes-for-internal-connections) dùng chứng chỉ tự ký và không hỗ trợ verify-ca/full; không tắt xác minh TLS để vượt qua lỗi này. Không đưa URL chứa mật khẩu vào source. `ONNXRUNTIME_NODE_INSTALL=skip` bỏ tải GPU CUDA tùy chọn; backend dùng binary CPU chính thức đã có trong package. Dịch vụ API còn cần thử trên Linux/Render trước khi xác nhận deploy thành công.

[Render Free](https://render.com/docs/free) có cold start sau thời gian không truy cập; filesystem không phải nơi lưu dữ liệu lâu dài; database Free hiện tại hết hạn ngày **28/11/2026**. Dữ liệu nghiệp vụ được lưu PostgreSQL, không lưu trong file của web service. SMTP outbound của Free bị hạn chế nên email dùng relay HTTPS. Chưa đo hiệu năng/giới hạn RAM của nhận diện mặt trên hosting này.

### Email OTP thật

Mặc định dùng Google Apps Script với Gmail hiện có, không cần mua domain. Source relay tại [Code.gs](tool/apps-script/Code.gs), manifest tại [appsscript.json](tool/apps-script/appsscript.json). Manifest chỉ yêu cầu `https://www.googleapis.com/auth/script.send_mail`; không xin quyền đọc Gmail. Source không chứa địa chỉ tài khoản hoặc khóa thật.

Các bước cấu hình cụ thể do chủ tài khoản thực hiện:

1. Chạy `node tool/apps-script/create-secret.js` cục bộ. Script chỉ tạo `.env.relay` bằng khóa ngẫu nhiên 48 byte, không ghi đè tệp đã có và không in khóa. Tệp này bị `.gitignore` loại bỏ. Mở cục bộ để lấy giá trị, không dán vào chat/Git.
2. Trong [Google Apps Script](https://script.google.com/), tạo project với Gmail muốn dùng gửi OTP. Thay nội dung `Code.gs` bằng source relay đã xem xét.
3. Vào **Project Settings**, bật hiển thị manifest `appsscript.json`; thay manifest bằng tệp kèm theo. Trong **Script properties**, thêm `OTP_RELAY_SECRET` với đúng khóa vừa tạo. Không đặt khóa trong Code.gs.
4. Chọn hàm **authorizeRelayOwner** rồi **Run**. Hàm chỉ đọc hạn mức MailApp để yêu cầu scope gửi email, không gửi thư thử và không đọc hộp thư. Chủ tài khoản tự xem xét và hoàn tất cấp quyền Google. Nếu Google hiện cảnh báo ứng dụng chưa xác minh hoặc màn hình xác thực, dừng tự động hóa và để chủ tài khoản xử lý trực tiếp; không tắt hoặc tự động vượt qua bảo vệ.
5. Chọn **Deploy → New deployment → Web app**. **Execute as: Me**; **Who has access: Anyone** (không yêu cầu người gọi đăng nhập Google). Chốt deploy sau khi chủ tài khoản đã xem source/quyền, rồi lấy URL `/exec`; không dùng URL `/dev`. Endpoint mở cho request nhưng chỉ payload có HMAC hợp lệ mới gửi được thư.
6. Trong bí mật môi trường backend/Render, đặt `EMAIL_PROVIDER=apps_script`, `OTP_RELAY_URL` là URL trên và `OTP_RELAY_SECRET` cùng giá trị Script property. URL không được có query, fragment, port hoặc credentials. Nếu chạy cục bộ bằng `.env`, sao chép khóa vào biến tương ứng trong `.env`; script không tự đọc `.env.relay` khi server chạy.
7. Deploy backend, thử đăng nhập/đăng ký với email thật của nhóm và xác nhận thư đến hộp thư. Khi sửa relay, vào **Deploy → Manage deployments → Edit → New version** rồi deploy lại; giữ deployment URL nếu dùng cùng deployment. Việc qua test VM chưa chứng minh Google đã cấp quyền hoặc thư đã được giao.

Backend POST JSON `{payload,signature}`: `payload` là chuỗi JSON chứa đúng `to,code,purpose,issuedAt,nonce,ttlMinutes`, được ký HMAC-SHA256 bằng khóa relay riêng. Relay kiểm chữ ký theo vòng so sánh cố định, thời gian lệch tối đa ±120 giây, người nhận đơn, OTP sáu số, purpose hợp lệ và TTL 1–10 phút. Sau xác minh, ScriptLock bảo vệ nonce/throttle/quota và gửi thư; nonce được lưu bền trước khi kiểm quota/gửi nên cả lần gửi lỗi cũng không được phát lại. Cache nonce tối đa 256 mục, hết hạn sau 5 phút; tối đa 20 request hợp lệ/phút. Payload/OTP/email không lưu trong Script properties hoặc log; phản hồi chỉ `{ok:true}` sau khi MailApp trả về thành công, còn lại `{ok:false}`. GET không gửi thư. Request chưa qua validation hoặc không lấy được lock không gửi và không được nhận vào hàng đợi.

[ContentService](https://developers.google.com/apps-script/guides/content#redirects) trả kết quả qua URL dùng một lần tại `script.googleusercontent.com`. Adapter chỉ theo redirect 302/303 tới host này bằng GET, không gửi lại payload hoặc khóa. Vì relay không đặt HTTP status tùy ý, backend kiểm JSON `ok === true` nghiêm ngặt, giới hạn response 4KiB và timeout 15 giây. Sai chữ ký, hết quota, lỗi gửi hoặc response khác đều thành `503 EMAIL_UNAVAILABLE` và challenge bị vô hiệu hóa; không có chế độ hiện OTP trên màn hình/log.

[Quota Apps Script](https://developers.google.com/apps-script/guides/services/quotas) hiện nêu 100 người nhận/ngày cho tài khoản tiêu dùng như Gmail và có thể thay đổi. Relay kiểm `MailApp.getRemainingDailyQuota()` trước mỗi thư; không hứa gửi không giới hạn, không hứa thư đến tức thì. Gửi thư dùng [MailApp](https://developers.google.com/apps-script/reference/mail/mail-app), không dùng Gmail API/read scope.

Brevo vẫn là phương án tùy chọn: đặt `EMAIL_PROVIDER=brevo`, điền `BREVO_API_KEY/BREVO_SENDER_EMAIL` đã xác minh; adapter dùng [Brevo HTTPS API](https://developers.brevo.com/docs/send-a-transactional-email). Những biến Brevo không bắt buộc khi chọn Apps Script, và không tự chuyển provider khi cấu hình lỗi.

## Hợp đồng API

Mọi endpoint nghiệp vụ dưới `/v1`. Thành công: `{ "data": ... }`. Danh sách là mảng trong `data`, tối đa 500 bản ghi. Lỗi: `{ "error": { "code": "...", "message": "Thông báo tiếng Việt", "details": [...] } }`; `details` chỉ có với lỗi nhập liệu. ID là UUID chuỗi; thời gian ISO 8601/UTC. Gửi access token qua header `Authorization: Bearer ...`. Không gửi refresh token bằng query string.

| Endpoint | Body / ý nghĩa |
|---|---|
| `GET /health`, `GET /v1/health` | Không cần token; 200 chỉ khi query DB thành công, ngược lại 503 |
| `POST /auth/register` | `fullName, username, email, password`; 202 trả challenge OTP |
| `POST /auth/login` | `username, password`; trả challenge OTP, chưa có access token |
| `POST /auth/verify-otp` | `challengeId, code`; trả `accessToken, refreshToken, user` |
| `POST /auth/resend-otp` | `challengeId`; trả thông tin challenge được cập nhật |
| `POST /auth/refresh` | `refreshToken`; xoay token, trả phiên mới |
| `POST /auth/logout` | `refreshToken`; thu hồi cả phiên tương ứng |
| `POST /auth/face-login` | `username, imageBase64`; đối chiếu thật tại server rồi trả challenge OTP |
| `GET /me` | Hồ sơ hiện tại; cho phép tài khoản pending xem trạng thái |
| `GET/POST /employees`, `GET/PATCH/DELETE /employees/:id` | Admin tạo/sửa/xóa; quản lý đọc nhân viên chi nhánh; nhân viên đọc chính mình |
| `GET/POST /branches`, `GET/PATCH/DELETE /branches/:id` | Admin thay đổi; tài khoản khác đọc chi nhánh được phân |
| `GET/POST /shifts`, `GET/PATCH/DELETE /shifts/:id` | Admin/quản lý phân ca trong phạm vi; nhân viên đọc ca của mình |
| `GET /attendance` | Dữ liệu chấm công theo phạm vi quyền |
| `POST /attendance/check-in`, `POST /attendance/check-out` | `shiftId, latitude, longitude, accuracyMeters` |
| `GET /reports/monthly?month=YYYY-MM&employeeId=&branchId=` | Báo cáo một tháng theo ngày bắt đầu ca tại `APP_TIME_ZONE`; các bộ lọc ID là tùy chọn |
| `GET/POST /corrections`, `GET/PATCH/DELETE /corrections/:id` | Nhân viên gửi/sửa/rút đơn pending; quản lý/admin xử lý đơn người khác |
| `POST /location-shares` | `latitude, longitude, accuracyMeters, ttlMinutes`; TTL 1–120 phút |
| `GET /location-shares` | Chỉ vị trí chưa hết hạn của bản thân hoặc nhân viên trong quyền quản lý |
| `DELETE /location-shares/:id` | Chủ thể dừng chia sẻ; không tạo link công khai vị trí |
| `GET /handover-recipients` | Đồng nghiệp cùng chi nhánh đã được duyệt; chỉ `id, fullName, role, branchId` |
| `GET/POST /handovers`, `GET/PATCH/DELETE /handovers/:id` | Bàn giao có version; chỉ bản nháp của chính tác giả được xóa |
| `GET /handovers/:id/revisions` | Lịch sử snapshot và người thực hiện trong phạm vi quyền |
| `GET /face/status`, `POST /face/enroll`, `DELETE /face/enroll` | Trạng thái/đăng ký/xóa mẫu mặt của chính tài khoản đang hoạt động |
| `GET /dashboard` | Số liệu trong phạm vi cùng các ca/chấm công gần đây |

Challenge OTP gồm `challengeId, maskedEmail, expiresAt, retryAfterSeconds, purpose`. `purpose` là `register`, `login` hoặc `face_login`. OTP sáu chữ số, có hiệu lực 10 phút, tối đa 5 lần nhập sai; gửi lại cách nhau 60 giây, tối đa 5 lần/challenge; gửi lại làm mã trước mất hiệu lực. Token chỉ được cấp khi OTP đúng và chưa được dùng. Access token 15 phút, refresh token 30 ngày; token refresh đã xoay mà bị dùng lại sẽ thu hồi cả phiên. Mật khẩu dùng scrypt; OTP dùng HMAC với khóa riêng; database chỉ lưu hash của refresh token.

User trả về: `id, fullName, username, email, role, status, branchId, createdAt, emailVerified`. `role` là `admin/manager/employee`, `status` là `pending/active/suspended`. Tự đăng ký luôn là employee/pending; sau xác minh email vẫn phải chờ admin phê duyệt. Mọi request kiểm tra quyền và trạng thái hiện tại từ DB, không tin role do client gửi. Không thể xóa/hạ quyền admin hoạt động cuối cùng. Xóa nhân viên là xóa mềm để giữ lịch sử, đồng thời thu hồi phiên, xóa mẫu mặt và chia sẻ vị trí.

Branch: `name, address, latitude, longitude, radiusMeters` (20–5000m), thêm `timePolicy` bên dưới. Shift ghi bằng `title, branchId, employeeId, startsAt, endsAt`; giờ kết thúc phải sau giờ bắt đầu, cho phép ca qua ngày. Trạng thái `scheduled/in_progress/completed` do server quản lý từ chấm công/điều chỉnh: ca mới chỉ nhận trạng thái absent hoặc `scheduled`, PATCH từ chối trường `status` với `422 SHIFT_STATUS_READ_ONLY`. Username 3–32 ký tự chữ/số/`.`/`_`; mật khẩu 10–128 ký tự. PATCH chỉ gửi các trường thực sự đổi; trường không gửi được giữ nguyên.

Admin có thể POST/PATCH chi nhánh với toàn bộ đối tượng `timePolicy` (bốn số nguyên 0–1440 phút):

```json
{"checkInEarlyMinutes":30,"lateGraceMinutes":10,"earlyLeaveGraceMinutes":10,"checkOutLateMinutes":120}
```

Đây là mặc định đã được người dùng xác nhận. Mỗi ca lưu bản sao `timePolicySnapshot`; sửa chính sách của chi nhánh không tự đổi ca đã có. Tạo ca mới hoặc thực sự đổi nhân viên/chi nhánh/giờ kế hoạch của ca chưa có công hay đơn điều chỉnh sẽ lấy chính sách hiện tại. Khi đã có attendance hoặc correction, các trường kế hoạch `employeeId, branchId, startsAt, endsAt` bị khóa (`409 SHIFT_PLAN_LOCKED`); chỉ tên hiển thị còn sửa được. GET ca có `hasAttendance, hasCorrections, planLocked, planLockReason` để UI thể hiện khóa này. Quyền server vẫn kiểm tra độc lập với trạng thái nút trên UI.

Chấm công dùng giờ server, người được phân ca và cửa sổ **bao gồm cả hai biên**: giờ vào từ `startsAt − checkInEarlyMinutes` đến `endsAt`; giờ ra cần có giờ vào và không trễ hơn `endsAt + checkOutLateMinutes`. So sánh bằng timestamp đầy đủ nên ca 22:00–06:00 ngày sau không bị xử lý như ca kết thúc trước khi bắt đầu. Ngoài cửa sổ trả `409 PUNCH_WINDOW_CLOSED`, giữ nguyên dữ liệu và yêu cầu người dùng gửi đơn điều chỉnh, không tự sinh giờ ra. GET ca/attendance bổ sung `timeWindow:{checkInOpensAt,checkInClosesAt,checkOutClosesAt}` dạng ISO/UTC.

Sai số GPS phải từ 0–100m, `khoảng cách tới chi nhánh + sai số <= bán kính`. Server chặn ghi trùng giờ vào, giờ ra trước giờ vào và chấm công ca người khác. Tọa độ vẫn là dữ liệu thiết bị cung cấp, không được coi là chứng minh chống giả GPS.

Attendance có giờ hiệu lực `checkInAt/checkOutAt` và vết chấm thiết bị `recordedCheckInAt/recordedCheckOutAt`. Giờ gốc chỉ được ghi khi thực hiện chấm vào/ra lần đầu; phê duyệt điều chỉnh không ghi đè chúng. Bản ghi chỉ tạo bằng đơn điều chỉnh có giờ gốc null, không giả làm dữ liệu thiết bị. Migration002 chỉ khôi phục vết gốc từ các bản ghi cũ có source `device`; lịch sử đã bị điều chỉnh trước migration không có đủ bằng chứng để dựng lại vết gốc.

GET/POST chấm công trả `timing`: `late, earlyLeave, arrivalDelayMinutes, earlyLeaveMinutes, rawSpanMinutes, recordedSpanMinutes, missingCheckOut, state`. Cờ late chỉ bật khi vào sau đầu ca cộng ân hạn, earlyLeave khi ra trước cuối ca trừ ân hạn; đúng biên ân hạn không bị gắn cờ. Hai offset phút giữ độ lệch thực tế, không tự trừ ân hạn. `rawSpanMinutes` là khoảng vào–ra **hiệu lực sau điều chỉnh**, không khấu trừ nghỉ/đi muộn và không phải giờ được trả lương; `recordedSpanMinutes` là khoảng giữa hai vết thiết bị gốc. Chưa có giờ ra thì cả khoảng tương ứng là null. `state` gồm `upcoming/not_checked_in/missing_check_in/in_progress/missing_check_out/completed`; thiếu dữ liệu không được coi là kết luận nhân viên vắng mặt.

Correction tạo bằng `shiftId, requestedCheckIn?, requestedCheckOut?, reason`. Người tạo chỉ sửa thời gian/lý do khi pending; PATCH duyệt gồm `status: approved/rejected, resolutionNote`. Không tự duyệt đơn của mình. Duyệt approved cập nhật giờ hiệu lực attendance thật và lưu `beforeAttendance, afterAttendance, resolvedBy, resolvedAt` trong cùng transaction; không chỉ đổi nhãn đơn, không xóa dấu vết chấm gốc. Các đơn đã xử lý không được sửa hoặc xóa. Không xóa ca/chi nhánh đang có lịch sử tham chiếu.

Báo cáo tháng trả `data:{month,timeZone,rows,totals}`. Nhân viên chỉ xem bản thân, quản lý chỉ chi nhánh được phân, admin được lọc toàn bộ; lọc vượt quyền bị `403 REPORT_SCOPE_FORBIDDEN`. Một ca qua đêm được tính toàn bộ vào ngày/tháng **bắt đầu kế hoạch** theo `APP_TIME_ZONE`, không cộng hai lần vì giờ ra sang tháng sau. Mỗi row có `shiftId,title,employeeId,employeeName,branchId,branchName,workDate,startsAt,endsAt,status,timePolicySnapshot,timeWindow,attendanceId,checkInAt,checkOutAt,recordedCheckInAt,recordedCheckOutAt,source,timing`. `localTimes` cung cấp sáu trường thời gian dạng `YYYY-MM-DD HH:mm` theo `timeZone` cho UI; các trường ISO vẫn là giá trị chính xác. `totals` có số ca theo trạng thái, số ca muộn/về sớm, tổng `rawSpanMinutes/recordedSpanMinutes` chỉ của khoảng đã đóng. Báo cáo không suy diễn lương, công quy đổi, nghỉ được duyệt hoặc làm thêm phải trả. Giới hạn một tháng 1900–2199 và tối đa 5000 ca; quá số lượng yêu cầu lọc thêm, không âm thầm cắt dữ liệu.

Handover tạo bằng `shiftId, recipientId, originalText, translatedText, sourceLanguage, targetLanguage, items, status`. Các ngôn ngữ `vi/en/zh`; `items` gồm `{id,text,translatedText,state}`, state `open/understood/clarify`. Chỉ tạo từ ca của mình và gửi người cùng chi nhánh. PATCH bắt buộc `version` hiện tại. Tác giả chỉnh nội dung sẽ đưa các xác nhận về open. Người nhận chỉ đổi state của các mục và status; không được sửa chữ gốc/bản dịch. `acknowledged` yêu cầu tất cả mục `understood`; sai version trả 409. Phiếu đã acknowledged được giữ nguyên, bổ sung bằng phiếu tiếp theo.

`GET /handovers` và `GET /handovers/:id` bổ sung `createdByName, recipientName, shiftTitle, shiftStartsAt` từ bản ghi liên quan đã được phép xem. Người nhận không cần quyền đọc hồ sơ nhân viên hoặc toàn bộ ca của người gửi để biết ngữ cảnh bàn giao. `GET /shifts` và `GET /shifts/:id` bổ sung `employeeName, branchName`. Đây là metadata chỉ đọc; không nhận các trường tên suy ra này trong POST/PATCH. Các danh sách JOIN trong một truy vấn, không tải riêng từng tên theo mỗi bản ghi; phạm vi quyền không được mở rộng.

Face enrollment nhận JPEG/PNG base64 tối đa 2MiB ảnh; server tự phát hiện/căn chỉnh và tính embedding, không nhận cờ thành công hay vector từ client. Xem [module nhận diện mặt](src/face/README.md) để biết model/hash/license và giới hạn. Đối chiếu 2D không chống được mọi ảnh in/màn hình; OTP email vẫn bắt buộc sau so khớp.

## Kiểm chứng và giới hạn hiện tại

```sh
npm test
npm audit --omit=dev --audit-level=high
```

API tests chạy Express thật, SQL/schema thật qua `pg-mem`, thay riêng việc gửi email bằng mailbox trong test; OTP không bị giả lập ở handler. Các test mặt chạy model ONNX thật với fixture chính thức OpenCV, không thêm nhân viên hoặc template mẫu vào production. Tests relay thực thi Code.gs thật trong Node VM với stub các dịch vụ Google để kiểm chứng HMAC/freshness/replay/quota/throttle; adapter dùng boundary fetch được kiểm soát. Những test này không gửi email thật hoặc cấp quyền Google.

Đã kiểm chứng kết nối tới database **PostgreSQL 17.11 trên Render Singapore** qua External URL với `rejectUnauthorized:true`, chạy `SELECT version()` thành công và chạy `applyMigrations(pool)` hai lần thành công, gồm `001_initial.sql` và `002_attendance_workflow.sql`. Điều này xác nhận kết nối/chứng chỉ, DDL, việc gọi advisory lock và tính idempotent của migration trên DB thật. Không suy rộng thành bằng chứng cho tranh chấp row lock/rollback đồng thời hoặc toàn bộ CRUD production. API Linux/Render, bootstrap admin và gửi/nhận email Google end-to-end còn phải kiểm chứng trong triển khai thực tế; camera/vị trí/micro cần tích hợp app/giả lập.

Lần kiểm chứng cục bộ gần nhất: **65/65 tests đạt**, gồm 51 regression nghiệp vụ/mặt và 14 kiểm thử cấu hình/adapter/giao thức relay mới. Có các kiểm thử biên cửa sổ chấm công, ca qua đêm, ân hạn, snapshot chính sách, khóa kế hoạch, giữ dấu vết khi điều chỉnh và phạm vi báo cáo tháng. Đây không thay thế kiểm thử deployment.

Thông tin kết nối, tài khoản và khóa thật được quản lý ngoài repository, không được đóng gói cùng frontend hoặc APK.
