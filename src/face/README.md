# Nhận diện khuôn mặt ở backend

Module JavaScript/Node.js thực hiện phát hiện và đối chiếu danh tính từ ảnh. Không chạy Python, không nhận một cờ `faceDetected` hoặc vector do client tự gửi làm bằng chứng đăng nhập.

## Cài đặt và chạy

Backend cần `onnxruntime-node` **1.31.1** và `sharp` **0.35.5**; các phiên bản này đã được kiểm tra trên Node.js 24.14.0/Windows x64. ONNX Runtime có binary CPU chính thức cho Windows và Linux. Bản deploy Linux vẫn cần kiểm chứng tại dịch vụ hosting thực tế.

Từ thư mục `backend`:

```sh
node tool/fetch-face-models.js
node --test --test-concurrency=1 test/face-geometry.test.js test/face-input.test.js test/face-inference.test.js
```

Trên Render CPU, đặt biến môi trường `ONNXRUNTIME_NODE_INSTALL=skip` khi chạy `npm ci` để không tải binary CUDA không cần thiết. CPU runtime đã được đóng gói trong npm package. Có thể đặt `FACE_MODELS_DIR` thành đường dẫn thư mục model do người vận hành quản lý; mặc định là `src/face/models`.

Script tải sử dụng hai URL HTTPS cố định từ OpenCV, ghim commit và kiểm tra cả kích thước lẫn SHA-256 trước khi đổi tên tệp tạm. Khi một tệp hiện có sai hash, script dừng và giữ lại tệp đó để kiểm tra. Runtime không tự tải model: thiếu model, sai hash hoặc lỗi runtime sẽ trả lỗi dịch vụ, không chấp nhận đăng nhập.

## Hợp đồng tích hợp

```js
import { extractEmbedding, compareEmbeddings } from './face/recognizer.js';

const vector = await extractEmbedding(imageBase64); // mảng 128 số đã chuẩn hóa
const result = compareEmbeddings(storedVector, vector);
// { matches: boolean, score: number, threshold: 0.363 }
```

Ảnh đầu vào là base64 chuẩn của JPEG/PNG, hoặc data URL tương ứng, tối đa **2 MiB** dữ liệu ảnh. Không nhận URL từ client. Chỉ nhận ảnh tĩnh có kích thước mỗi chiều 80–4096 pixel, tối đa 16 triệu pixel. Client nên gửi ảnh toàn khung đã nén; server tự tìm mặt và căn chỉnh, không tin điểm mốc do client cung cấp.

Chuỗi xử lý: kiểm tra định dạng → giải mã, áp dụng EXIF orientation, chuyển sRGB → giới hạn cạnh dài 320 pixel → YuNet BGR/NCHW, padding bội số 32 → confidence 0,9 và NMS 0,3 → yêu cầu đúng một mặt đủ rõ → biến đổi tương đồng 5 điểm về 112×112 → SFace RGB/NCHW → chuẩn hóa L2 → so sánh cosine. Các tensor được giải phóng sau từng yêu cầu; session và model giữ ấm. Mỗi process chỉ suy luận một ảnh tại một thời điểm và cho phép tối đa hai ảnh chờ; quá tải trả 429.

`FaceRecognitionError` có `status`, `code`, `message` an toàn để hiển thị và `expose=true`. Mã lỗi: `FACE_IMAGE_INVALID`, `FACE_NOT_FOUND`, `FACE_MULTIPLE_FACES`, `FACE_IMAGE_QUALITY`, `FACE_TEMPLATE_INVALID` (422), `FACE_SERVICE_BUSY` (429), `FACE_SERVICE_UNAVAILABLE` (503). Module không ghi ảnh hoặc vector vào log và không lưu ảnh đầu vào xuống đĩa. Backend lưu template cho đúng tài khoản đã xác thực, kiểm soát quyền đăng ký lại, và chỉ cấp phiên đăng nhập sau OTP email theo hợp đồng của app.

## Model và nguồn

Nguồn được ghim tại [OpenCV Zoo commit 48b10fa](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7). Manifest có URL/kích thước/hash tại `models.js`.

| Tệp | Byte | SHA-256 | Giấy phép |
|---|---:|---|---|
| `face_detection_yunet_2026may.onnx` | 229738 | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` | MIT |
| `face_recognition_sface_2021dec.onnx` | 38696353 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | Apache-2.0 |

YuNet May 2026 là bản đầu vào động của mô hình 2023; lựa chọn này cho phép ONNX Runtime dùng kích thước ảnh đã padding mà không làm méo tỷ lệ ảnh. Xem [mô tả YuNet](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet) và [mô tả SFace](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_recognition_sface).

Giải mã detector và căn chỉnh theo hành vi được công bố của [FaceDetectorYN](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_detect.cpp) và [FaceRecognizerSF](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_recognize.cpp). Ngưỡng cosine **0,363** là điểm vận hành LFW trong [hướng dẫn OpenCV](https://docs.opencv.org/4.x/d0/dd4/tutorial_dnn_face.html), không phải ngưỡng được hiệu chỉnh riêng cho nhân viên của app. Các bản giấy phép kèm theo ở `licenses/`.

## Bằng chứng và giới hạn

15 kiểm thử cục bộ đã qua: so sánh/chuẩn hóa vector và biên ngưỡng, căn chỉnh hình học, giải mã detector, dữ liệu ảnh sai, hai ảnh khác nhau của cùng một người, người khác, ảnh trắng, nhiều mặt, kích thước ảnh, quá tải/hồi phục hàng đợi và thiếu model phải từ chối. Các kiểm thử suy luận chạy model ONNX thật, không giả lập kết quả nhận dạng.

Fixture duy nhất là [ảnh minh họa chính thức của SFace](https://github.com/opencv/opencv_zoo/blob/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_recognition_sface/example_outputs/demo.jpg), thuộc thư mục được công bố Apache-2.0. SHA-256 `0f879881a598fea6fec74e047e6a1d00e36d81de63bf0ed392b628e6ab6c2fc4`, 156282 byte. Các crop trong kiểm thử được tạo trực tiếp trong RAM từ ảnh mẫu; không dùng ảnh cá nhân của người dùng và không thêm bản ghi mẫu vào cơ sở dữ liệu.

Một phép đo trên host Windows: cùng người cosine 0,5432; người khác 0,2128; lần đầu khoảng 966 ms gồm tải session, hai lần đã ấm 34/31 ms; RSS process khoảng 129 MiB. Đây là bằng chứng trên một mẫu chính thức, không phải cam kết độ chính xác, RAM đỉnh hay độ trễ của Render hoặc điện thoại thật.

Nhận diện ảnh 2D này **không có chống giả mạo được chứng nhận**: ảnh in/màn hình của một người có thể qua bước đối chiếu. OTP email vẫn là bước bắt buộc của đăng nhập khuôn mặt. Cần kiểm thử người thật, góc nhìn, ánh sáng và thiết bị của nhóm trước khi tuyên bố chất lượng vận hành thực tế. Mô-đun này chưa kiểm chứng camera giả lập hay API đã deploy; các phần đó thuộc tích hợp app/backend.
