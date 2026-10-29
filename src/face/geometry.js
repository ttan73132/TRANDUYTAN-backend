import { FaceRecognitionError } from './errors.js';

// OpenCV FaceRecognizerSF, LFW operating point. This is not a liveness claim.
export const COSINE_THRESHOLD = 0.363;
export const CANONICAL_LANDMARKS = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

export function normalizeEmbedding(vector) {
  if (!(Array.isArray(vector) || ArrayBuffer.isView(vector)) || vector.length !== 128 ||
      !Array.from(vector).every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new FaceRecognitionError(422, 'FACE_TEMPLATE_INVALID', 'Mẫu khuôn mặt không hợp lệ. Hãy đăng ký lại.');
  }
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
    throw new FaceRecognitionError(422, 'FACE_TEMPLATE_INVALID', 'Mẫu khuôn mặt không hợp lệ. Hãy đăng ký lại.');
  }
  return Array.from(vector, value => value / magnitude);
}

export function compareEmbeddings(stored, probe) {
  const left = normalizeEmbedding(stored), right = normalizeEmbedding(probe);
  const score = Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index], 0)));
  return { matches: score >= COSINE_THRESHOLD, score, threshold: COSINE_THRESHOLD };
}

// A least-squares, orientation-preserving similarity transform, source -> SFace.
export function similarityTransform(source) {
  if (!Array.isArray(source) || source.length !== 5 ||
      source.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
    throw new FaceRecognitionError(422, 'FACE_IMAGE_QUALITY', 'Không xác định được các điểm trên khuôn mặt.');
  }
  const mean = points => points.reduce(([x, y], point) => [x + point[0] / 5, y + point[1] / 5], [0, 0]);
  const [sx, sy] = mean(source), [dx, dy] = mean(CANONICAL_LANDMARKS);
  let denominator = 0, real = 0, imaginary = 0;
  for (let index = 0; index < 5; index++) {
    const x = source[index][0] - sx, y = source[index][1] - sy;
    const u = CANONICAL_LANDMARKS[index][0] - dx, v = CANONICAL_LANDMARKS[index][1] - dy;
    denominator += x * x + y * y;
    real += x * u + y * v;
    imaginary += x * v - y * u;
  }
  const a = real / denominator, b = imaginary / denominator;
  if (denominator < 1e-6 || !Number.isFinite(a) || !Number.isFinite(b) || a * a + b * b < 1e-8) {
    throw new FaceRecognitionError(422, 'FACE_IMAGE_QUALITY', 'Khuôn mặt chưa đủ rõ. Hãy nhìn thẳng vào camera.');
  }
  return [a, b, dx - a * sx + b * sy, dy - b * sx - a * sy];
}

export function alignRgb(image, width, height, landmarks) {
  const [a, b, tx, ty] = similarityTransform(landmarks);
  const determinant = a * a + b * b;
  const aligned = new Uint8Array(112 * 112 * 3);
  const pixel = (x, y, channel) => x < 0 || y < 0 || x >= width || y >= height ? 0 : image[(y * width + x) * 3 + channel];
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const sourceX = (a * (x - tx) + b * (y - ty)) / determinant;
    const sourceY = (-b * (x - tx) + a * (y - ty)) / determinant;
    const x0 = Math.floor(sourceX), y0 = Math.floor(sourceY), wx = sourceX - x0, wy = sourceY - y0;
    for (let channel = 0; channel < 3; channel++) {
      const value = pixel(x0, y0, channel) * (1 - wx) * (1 - wy) +
        pixel(x0 + 1, y0, channel) * wx * (1 - wy) +
        pixel(x0, y0 + 1, channel) * (1 - wx) * wy + pixel(x0 + 1, y0 + 1, channel) * wx * wy;
      aligned[(y * 112 + x) * 3 + channel] = Math.round(value);
    }
  }
  return aligned;
}

function intersectionOverUnion(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const overlap = width * height;
  return overlap / (left.width * left.height + right.width * right.height - overlap);
}

// Decode the three YuNet strides as described by OpenCV FaceDetectorYN.
export function decodeYuNet(outputs, width, height) {
  const candidates = [];
  for (const stride of [8, 16, 32]) {
    const columns = width / stride, rows = height / stride, count = columns * rows;
    const cls = outputs[`cls_${stride}`]?.data, obj = outputs[`obj_${stride}`]?.data;
    const boxes = outputs[`bbox_${stride}`]?.data, points = outputs[`kps_${stride}`]?.data;
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || cls?.length !== count || obj?.length !== count ||
        boxes?.length !== count * 4 || points?.length !== count * 10) {
      throw new FaceRecognitionError(503, 'FACE_SERVICE_UNAVAILABLE', 'Bộ nhận diện khuôn mặt chưa sẵn sàng.');
    }
    for (let index = 0; index < count; index++) {
      const score = Math.sqrt(Math.max(0, Math.min(1, cls[index])) * Math.max(0, Math.min(1, obj[index])));
      if (!Number.isFinite(score) || score < 0.9) continue;
      const column = index % columns, row = Math.floor(index / columns);
      const boxWidth = Math.exp(boxes[index * 4 + 2]) * stride;
      const boxHeight = Math.exp(boxes[index * 4 + 3]) * stride;
      const x = (column + boxes[index * 4]) * stride - boxWidth / 2;
      const y = (row + boxes[index * 4 + 1]) * stride - boxHeight / 2;
      const landmarks = Array.from({ length: 5 }, (_, point) => [
        (column + points[index * 10 + point * 2]) * stride,
        (row + points[index * 10 + point * 2 + 1]) * stride,
      ]);
      if (![x, y, boxWidth, boxHeight, ...landmarks.flat()].every(Number.isFinite) ||
          boxWidth <= 0 || boxHeight <= 0 || boxWidth > width * 4 || boxHeight > height * 4) continue;
      candidates.push({ x, y, width: boxWidth, height: boxHeight, landmarks, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const kept = [];
  for (const candidate of candidates.slice(0, 5000)) {
    if (!kept.some(previous => intersectionOverUnion(candidate, previous) >= 0.3)) kept.push(candidate);
  }
  return kept;
}
