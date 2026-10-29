import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENCV_ZOO_COMMIT = '48b10fa505aeb51fbd127fc60a5c660040e823b7';
export const FACE_MODELS = Object.freeze([
  {
    name: 'face_detection_yunet_2026may.onnx',
    directory: 'face_detection_yunet',
    bytes: 229738,
    sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
    license: 'MIT',
  },
  {
    name: 'face_recognition_sface_2021dec.onnx',
    directory: 'face_recognition_sface',
    bytes: 38696353,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    license: 'Apache-2.0',
  },
].map(model => Object.freeze({
  ...model,
  url: `https://media.githubusercontent.com/media/opencv/opencv_zoo/${OPENCV_ZOO_COMMIT}/models/${model.directory}/${model.name}`,
})));

export function getModelsDirectory() {
  return process.env.FACE_MODELS_DIR ? resolve(process.env.FACE_MODELS_DIR) : fileURLToPath(new URL('./models/', import.meta.url));
}

export async function verifyModelFile(path, model) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    if (bytes > model.bytes) throw new Error(`Unexpected model length: ${model.name}`);
    hash.update(chunk);
  }
  if (bytes !== model.bytes || hash.digest('hex') !== model.sha256) {
    throw new Error(`Model integrity check failed: ${model.name}`);
  }
}
