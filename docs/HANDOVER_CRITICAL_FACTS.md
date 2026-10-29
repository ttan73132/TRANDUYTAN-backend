# Bàn giao có thông tin quan trọng và xác nhận bằng nhập lại

Hợp đồng bổ sung sau khi chủ hệ thống duyệt tính năng. Chỉ backend kiểm dữ liệu và lưu bằng chứng theo version; không có AI/LP/cloud provider mới, không thu phí dịch vụ mới. Các route auth, phân quyền, ca và giờ chấm công giữ nguyên.

## Dữ liệu mới

POST /v1/handovers và author PATCH thêm:

```json
{
  "criticalFacts": [
    {"id":"UUID_1","kind":"equipment","label":"Mã thiết bị","value":"EQ-12"},
    {"id":"UUID_2","kind":"quantity","label":"Số lượng","value":"12.50"},
    {"id":"UUID_3","kind":"deadline","label":"Hạn chót","value":"2026-10-29 17:30"}
  ]
}
```

Kind chỉ equipment/quantity/deadline. ID là UUID, giữ ổn định khi sửa cùng mục; label 1–80 ký tự, value input1–80. ID không trùng; không được có hai mục cùng kind và canonical value dù ID khác. Tối đa3 mục. Response lưu value **đã canonicalize**: ví dụ EQ-12 → eq-12,12.50 →12.5.

Draft có0–3 mục; bỏ criticalFacts khi POST draft mặc định[]. Fact đã khai báo phải typed-valid/unique; draft chưa cần xuất hiện trong cả hai văn bản để có thể soạn dở. Create submitted, submit draft, author sửa active và final acknowledge bắt buộc1–3 fact cùng anchors đầy đủ trong originalText và translatedText.

## Chuẩn hóa và ranh giới token

- Unicode NFKC; chữ thường; trim và gộp whitespace; Unicode dash/minus thành ASCII hyphen; bỏ whitespace quanh hyphen.
- Không bỏ dấu tiếng Việt, không đổi từ đồng nghĩa, không chuyển chữ số viết bằng từ sang số, không dịch giá trị hay tự đoán đơn vị.
- Equipment: mã ASCII a-z0-9, có thể nối bằng dấu - hoặc _, dài2–40. EQ_12 khác EQ-12; leading zero của mã được giữ.
- Quantity: unsigned decimal, tối đa9 chữ số phần nguyên và1–3 chữ số thập phân nếu có; không đơn vị trong value. Dấu phẩy/dấu chấm đều là decimal separator; bỏ zero đầu/trailing fractional zero. １２,５０ →12.5;0012.000 →12;1,000 →1. **Không dùng dấu phân cách hàng nghìn**; nghìn phải ghi1000. UI cần hiển thị canonical preview để tránh hiểu nhầm.
- Deadline: strict HH:mm hoặc YYYY-MM-DD HH:mm, giờ24h có zero padding; dated year1900–2199, ngày thật (kiểm tháng/ngày/năm nhuận). 7:30,17h30,29/10/2026 không được chấp nhận như value. Fullwidth17：30 chuẩn hóa được. Không tự biến giá trị này thành instant UTC hoặc một thời điểm chấm công.
- Deadline có ngày được match như **token ngày+giờ hoàn chỉnh**. Nếu hai văn bản ghi2026-10-29 17:30 thì dùng fact cũng có ngày, không chỉ17:30. Qua ngày cần ghi đầy đủ ngày để không nhập đúng giờ mà bỏ sót ngày.

Anchors so sánh toàn token đã chuẩn hóa. 12 không khớp112,EQ12,12.5,-12,12:30 hoặc12/10. Mã eq-12 không khớp eq-112 hoặc một mã dài hơn. Các chữ Unicode/số/_/-/: nối sát được xem là tiếp nối token; dấu chấm/phẩy kết câu được tách nếu không nối sang chữ/số khác. Với tiếng Trung, giữ phân cách rõ: “数量 12 个”, “设备 EQ-12”, “期限 2026-10-29 17:30”. Một số dính sát đơn vị như12kg hoặc12个 phải thêm khoảng trắng khi muốn dùng quantity fact.

Điều kiện chỉ chứng minh literal/canonical value xuất hiện trong cả hai văn bản, không chứng minh bản dịch đúng ngữ nghĩa, phủ định, quan hệ giữa các câu, hoặc tất cả con số ngoài danh sách đều khớp. UI phải cho xem cả original/translated và tránh nhãn “AI đã xác minh bản dịch”. Nhập lại giúp người nhận đối chiếu fact nhưng không phải chứng nhận hiểu ngôn ngữ hoặc chống tự động copy.

## Người nhận xác nhận cuối

PATCH /v1/handovers/:id:

```json
{
  "version": 4,
  "items": [
    {"id":"UUID_ITEM","text":"Đếm hàng","translatedText":"Count items","state":"understood"}
  ],
  "status": "acknowledged",
  "factAnswers": [
    {"factId":"UUID_1","value":"ｅｑ－１２"},
    {"factId":"UUID_2","value":"１２,５０"},
    {"factId":"UUID_3","value":"2026-10-29 17:30"}
  ]
}
```

Người gửi không được nhập hộ. Admin không có quyền bypass vì là admin. Phải đúng recipient hiện tại; version request phải bằng version hiện tại; nguyên bộ items giữ id/text/bản dịch và đều understood; exact fact ID set, không thiếu/foreign/trùng/thêm. Mỗi câu trả lời canonical phải bằng fact hiện tại.

factAnswers chỉ được gửi lúc final acknowledged. Recipient vẫn có thể cập nhật items state clarify/understood từng lần trước đó (status submitted), không cần/không gửi factAnswers và chưa có confirmation. Nếu đáp án sai, **không cập nhật items, status, version, proof hay revision**; người nhận giữ input local để sửa. Version stale409 yêu cầu GET lại toàn bản mới và nhập lại theo fact mới, không thay số version rồi tự ghi đè.

## Bằng chứng server trả

GET list/detail và response create/PATCH có:

```json
{
  "version": 5,
  "criticalFacts": [
    {"id":"UUID_1","kind":"equipment","label":"Mã thiết bị","value":"eq-12"}
  ],
  "criticalFactConfirmation": {
    "verifiedBy":"UUID_RECIPIENT",
    "verifiedAt":"2026-10-29T10:30:00.000Z",
    "version":5,
    "answers":[{"factId":"UUID_1","value":"eq-12"}]
  }
}
```

Ví dụ minh họa rút gọn số fact; confirmation có đủ answers của phiếu thực tế. verifiedBy/verifiedAt/version/answers do server tạo; không nhận criticalFactConfirmation trong request. Proof version bằng **version sau final PATCH** (requestN → responseN+1). Khi chưa xác nhận hoặc sau tác giả sửa, field là null. Revisions snapshot lưu cả facts/proof tại version cũ để đối soát; endpoint revisions giữ nguyên quyền đọc.

## Tác giả sửa và lịch sử

- Draft save vẫn draft trừ explicit submit; facts0–3 typed-valid, chưa cần anchors.
- Mọi author amendment của submitted hoặc acknowledged được đưa về **submitted**, tất cả item state=open, proof=null, version tăng và lưu snapshot revision.
- Author được sửa phiếu đã acknowledged; recipient không sửa proof đã chốt. Revision trước vẫn giữ proof cũ, không ghi đè timestamp/người xác nhận.
- Active không được downgrade draft (409 HANDOVER_ACTIVE_NO_DRAFT) hoặc bỏ hết facts để bypass. Đổi content/facts phải tiếp tục1–3 anchors trong cả văn bản sau merge.
- Xóa vẫn chỉ draft của tác giả.
- Mỗi author submission/amendment active enqueue handover_submitted cho recipient hiện tại và version mới; draft save hoặc recipient state/answer edit không enqueue.
- Worker bỏ queued submission cũ nếu có author submission event version mới hơn, hoặc recipient/status/binding không còn đúng. Không so event version với generic row.version vì recipient cập nhật state cũng làm row.version tăng.
- Dedupe/transaction, maxattempt/TTL/session validation và payload generic FCM giữ nguyên.

## Legacy và migration

004_handover_critical_facts.sql chỉ thêm handovers.critical_facts JSONB NOT NULL DEFAULT[], handovers.critical_fact_confirmation nullable và index event/entity/version. Migration001–003 không đổi checksum. Các phiếu cũ vẫn đọc được và proof=null; kể cả đã acknowledged từ phiên bản cũ, không được diễn giải là đã qua critical-fact verification.

Legacy submitted với[] không final ack được: tác giả phải sửa bổ sung1–3 fact có anchors. Nếu legacy acknowledged cần thêm/sửa, author amendment mở submitted và reset item/proof như trên. Không tự sinh critical facts từ nội dung cũ hoặc bịa proof backfill.

## Mã lỗi

| HTTP/code | Ý nghĩa |
|---|---|
|422 VALIDATION_ERROR|Sai shape/field/kind/UUID/length hoặc quá3facts|
|422 CRITICAL_FACTS_REQUIRED|Submitted/final không có1–3facts|
|422 CRITICAL_FACT_VALUE_INVALID|Value không đúng equipment/quantity/deadline format|
|422 CRITICAL_FACT_DUPLICATE|Trùng ID hoặc trùng kind+canonicalvalue|
|422 CRITICAL_FACT_NOT_ANCHORED|Fact thiếu ở originalText/translatedText; details có factId/fields|
|422 FACT_ANSWERS_REQUIRED|Finalack chưa gửi answers|
|422 FACT_ANSWERS_INVALID|Không exact IDset, foreign/trùng/thêm/sai shape|
|422 FACT_ANSWER_MISMATCH|Ít nhất một canonical answer sai; details.factIds|
|422 FACT_ANSWERS_FINAL_ONLY|Gửi answers khi chưa finalack|
|403 RECIPIENT_CONFIRMATION_REQUIRED|Tác giả gửi answers/ack hoặc xác nhận hộ|
|403 FORBIDDEN|Người nhận sửa content/facts hoặc manager/admin không phải tác giả/recipient sửa|
|404 NOT_FOUND|Người ngoài scope/không được xem phiếu|
|409 VERSION_CONFLICT|Stale version|
|409 HANDOVER_ACTIVE_NO_DRAFT|Tác giả cố đưa phiếu active về nháp|
|409 HANDOVER_ACKNOWLEDGED|Recipient cố sửa phiếu đã chốt|

Các thử nghiệm phải dùng môi trường/dữ liệu test được phép. Môđun không cần service credential mới; trước deploy cần áp dụng004 và tích hợp frontend theo hợp đồng này. Test cục bộ dùng pg-mem không thay chứng cứ migration/concurrency trên PostgreSQL thật.

