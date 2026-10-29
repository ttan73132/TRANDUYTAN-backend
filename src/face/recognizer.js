import { join } from 'node:path';
import { FaceRecognitionError } from './errors.js';
import { alignRgb, decodeYuNet, normalizeEmbedding } from './geometry.js';
import { FACE_MODELS, getModelsDirectory, verifyModelFile } from './models.js';

export { compareEmbeddings } from './geometry.js';
export { FaceRecognitionError } from './errors.js';

export const MAX_FACE_IMAGE_BYTES = 2 * 1024 * 1024;
let sharpPromise;
let sessionsPromise;
let pending = 0;
let previousInference = Promise.resolve();

function invalidImage() {
  return new FaceRecognitionError(422, 'FACE_IMAGE_INVALID', 'Hãy gửi một ảnh JPEG hoặc PNG rõ nét, tối đa 2 MB.');
}

function decodeImageBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_FACE_IMAGE_BYTES / 3) * 4 + 32) throw invalidImage();
  let encoded = value;
  if (value.startsWith('data:')) {
    const prefix = /^data:image\/(?:jpeg|png);base64,/.exec(value);
    if (!prefix) throw invalidImage();
    encoded = value.slice(prefix[0].length);
  }
  if (!encoded || encoded.length % 4 !== 0 || encoded.length > Math.ceil(MAX_FACE_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalidImage();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 16 || bytes.length > MAX_FACE_IMAGE_BYTES || bytes.toString('base64') !== encoded) throw invalidImage();
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw invalidImage();
  return bytes;
}

async function getSharp() {
  sharpPromise ??= import('sharp').then(module => module.default).catch(() => {
    sharpPromise = undefined;
    throw new FaceRecognitionError(503, 'FACE_SERVICE_UNAVAILABLE', 'Bộ nhận diện khuôn mặt chưa được cài đặt đầy đủ.');
  });
  return sharpPromise;
}

async function prepareImage(bytes) {
  const sharp = await getSharp();
  const options = { limitInputPixels: 16000000, failOn: 'error', sequentialRead: true };
  try {
    const metadata = await sharp(bytes, options).metadata();
    if (!['jpeg', 'png'].includes(metadata.format) || !metadata.width || !metadata.height ||
        metadata.width < 80 || metadata.height < 80 || metadata.width > 4096 || metadata.height > 4096 ||
        (metadata.pages ?? 1) !== 1) throw invalidImage();
    const { data, info } = await sharp(bytes, options).rotate().removeAlpha().toColourspace('srgb')
      .resize({ width: 320, height: 320, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw invalidImage();
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof FaceRecognitionError) throw error;
    throw invalidImage();
  }
}

async function getSessions() {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const directory = getModelsDirectory();
      for (const model of FACE_MODELS) await verifyModelFile(join(directory, model.name), model);
      const ort = await import('onnxruntime-node');
      const options = {
        executionProviders: ['cpu'], executionMode: 'sequential',
        intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'all',
        enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3,
      };
      const detector = await ort.InferenceSession.create(join(directory, FACE_MODELS[0].name), options);
      try {
        const recognizer = await ort.InferenceSession.create(join(directory, FACE_MODELS[1].name), options);
        return { ort, detector, recognizer };
      } catch (error) {
        await detector.release();
        throw error;
      }
    })().catch(() => {
      sessionsPromise = undefined;
      throw new FaceRecognitionError(503, 'FACE_SERVICE_UNAVAILABLE', 'Bộ nhận diện khuôn mặt chưa sẵn sàng. Vui lòng thử lại sau.');
    });
  }
  return sessionsPromise;
}

async function withInferenceSlot(operation) {
  // One native inference at a time and at most two waiting images.
  if (pending >= 3) throw new FaceRecognitionError(429, 'FACE_SERVICE_BUSY', 'Bộ nhận diện đang bận. Vui lòng thử lại sau vài giây.');
  pending++;
  const before = previousInference;
  let release;
  previousInference = new Promise(resolve => { release = resolve; });
  await before;
  try { return await operation(); } finally { pending--; release(); }
}

function makeDetectorTensor(ort, image) {
  const width = Math.ceil(image.width / 32) * 32, height = Math.ceil(image.height / 32) * 32;
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const source = (y * image.width + x) * 3, destination = y * width + x;
    // FaceDetectorYN consumes BGR; padding is zero on the right and bottom.
    data[destination] = image.data[source + 2];
    data[plane + destination] = image.data[source + 1];
    data[2 * plane + destination] = image.data[source];
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, height, width]), width, height };
}

function checkQuality(face, image) {
  const eyeDistance = Math.hypot(face.landmarks[0][0] - face.landmarks[1][0], face.landmarks[0][1] - face.landmarks[1][1]);
  if (Math.min(face.width, face.height) < 56 || eyeDistance < 16 ||
      face.landmarks.some(([x, y]) => x < 1 || y < 1 || x >= image.width - 1 || y >= image.height - 1)) {
    throw new FaceRecognitionError(422, 'FACE_IMAGE_QUALITY', 'Hãy đưa khuôn mặt gần hơn, nhìn thẳng và giữ đủ sáng.');
  }
}

export async function extractEmbedding(imageBase64) {
  return withInferenceSlot(async () => {
    const bytes = decodeImageBase64(imageBase64);
    const image = await prepareImage(bytes);
    const { ort, detector, recognizer } = await getSessions();
    const tensors = new Set();
    try {
      const detection = makeDetectorTensor(ort, image);
      tensors.add(detection.tensor);
      const outputs = await detector.run({ [detector.inputNames[0]]: detection.tensor });
      Object.values(outputs).forEach(tensor => tensors.add(tensor));
      const faces = decodeYuNet(outputs, detection.width, detection.height);
      if (!faces.length) throw new FaceRecognitionError(422, 'FACE_NOT_FOUND', 'Chưa tìm thấy khuôn mặt. Hãy nhìn thẳng vào camera.');
      if (faces.length !== 1) throw new FaceRecognitionError(422, 'FACE_MULTIPLE_FACES', 'Chỉ một người được xuất hiện trong khung hình.');
      checkQuality(faces[0], image);
      const aligned = alignRgb(image.data, image.width, image.height, faces[0].landmarks);
      const plane = 112 * 112, input = new Float32Array(plane * 3);
      // FaceRecognizerSF feeds aligned RGB in [0,255]; normalization is in ONNX.
      for (let index = 0; index < plane; index++) for (let channel = 0; channel < 3; channel++) {
        input[channel * plane + index] = aligned[index * 3 + channel];
      }
      const recognitionInput = new ort.Tensor('float32', input, [1, 3, 112, 112]);
      tensors.add(recognitionInput);
      const features = await recognizer.run({ [recognizer.inputNames[0]]: recognitionInput });
      Object.values(features).forEach(tensor => tensors.add(tensor));
      const vector = features[recognizer.outputNames[0]]?.data;
      return normalizeEmbedding(vector);
    } catch (error) {
      if (error instanceof FaceRecognitionError) throw error;
      throw new FaceRecognitionError(503, 'FACE_SERVICE_UNAVAILABLE', 'Không thể nhận diện lúc này. Vui lòng thử lại sau.');
    } finally {
      tensors.forEach(tensor => tensor.dispose());
    }
  });
}
