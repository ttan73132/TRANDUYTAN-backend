import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COSINE_THRESHOLD, CANONICAL_LANDMARKS, compareEmbeddings,
  similarityTransform, alignRgb, decodeYuNet,
} from '../src/face/geometry.js';

const vector = (x, y = 0) => [x, y, ...Array(126).fill(0)];

test('face comparison normalizes stored and probe vectors', () => {
  assert.deepEqual(compareEmbeddings(vector(2), vector(3)), {
    matches: true, score: 1, threshold: COSINE_THRESHOLD,
  });
  assert.equal(compareEmbeddings(vector(1), vector(0, 4)).matches, false);
  assert.equal(compareEmbeddings(vector(1), vector(-5)).score, -1);
});

test('face comparison uses the documented OpenCV cosine threshold', () => {
  for (const score of [0.3629, 0.3631]) {
    const actual = compareEmbeddings(vector(1), vector(score, Math.sqrt(1 - score * score)));
    assert.equal(actual.matches, score >= 0.363);
    assert.ok(Math.abs(actual.score - score) < 1e-10);
  }
});

test('face comparison rejects malformed, nonfinite and zero templates', () => {
  const invalid = [[], Array(127).fill(1), Array(128).fill(0), vector(NaN), vector(Infinity), 'not a template'];
  for (const value of invalid) {
    assert.throws(() => compareEmbeddings(value, vector(1)), { code: 'FACE_TEMPLATE_INVALID' });
    assert.throws(() => compareEmbeddings(vector(1), value), { code: 'FACE_TEMPLATE_INVALID' });
  }
});

test('five-point alignment removes a known rotation, scale and translation', () => {
  const angle = 0.31, scale = 1.7;
  const source = CANONICAL_LANDMARKS.map(([x, y]) => [
    scale * (Math.cos(angle) * x - Math.sin(angle) * y) + 19,
    scale * (Math.sin(angle) * x + Math.cos(angle) * y) - 8,
  ]);
  const [a, b, tx, ty] = similarityTransform(source);
  source.forEach(([x, y], index) => {
    assert.ok(Math.abs(a * x - b * y + tx - CANONICAL_LANDMARKS[index][0]) < 1e-7);
    assert.ok(Math.abs(b * x + a * y + ty - CANONICAL_LANDMARKS[index][1]) < 1e-7);
  });
  assert.throws(() => similarityTransform(Array(5).fill([0, 0])), { code: 'FACE_IMAGE_QUALITY' });
});

test('identity alignment preserves RGB channel order and pixels', () => {
  const image = new Uint8Array(112 * 112 * 3);
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const offset = (y * 112 + x) * 3;
    image[offset] = x; image[offset + 1] = y; image[offset + 2] = 171;
  }
  const aligned = alignRgb(image, 112, 112, CANONICAL_LANDMARKS);
  assert.deepEqual([...aligned.slice((50 * 112 + 40) * 3, (50 * 112 + 40) * 3 + 3)], [40, 50, 171]);
});

function detectorOutputs() {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const count = (32 / stride) ** 2;
    outputs[`cls_${stride}`] = { data: new Float32Array(count) };
    outputs[`obj_${stride}`] = { data: new Float32Array(count) };
    outputs[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
    outputs[`kps_${stride}`] = { data: new Float32Array(count * 10) };
  }
  return outputs;
}

test('YuNet decoder applies stride coordinates and score thresholds', () => {
  const outputs = detectorOutputs();
  outputs.cls_8.data[5] = 0.99;
  outputs.obj_8.data[5] = 0.99;
  outputs.bbox_8.data.set([0.5, 0.5, Math.log(2), Math.log(2)], 5 * 4);
  outputs.kps_8.data.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], 5 * 10);
  const faces = decodeYuNet(outputs, 32, 32);
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].x - 4) < 1e-5);
  assert.ok(Math.abs(faces[0].width - 16) < 1e-5);
  assert.deepEqual(faces[0].landmarks, [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]]);
  outputs.obj_8.data[5] = 0.1;
  assert.equal(decodeYuNet(outputs, 32, 32).length, 0);
});
