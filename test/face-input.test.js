import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmbedding } from '../src/face/recognizer.js';

test('face input rejects missing, noncanonical, nonimage and oversized data before inference', async () => {
  for (const value of [undefined, 18, '', '   ', 'not base64!', 'AA=A', 'data:text/html;base64,PGgxPmhpPC9oMT4=', 'data:image/svg+xml;base64,AA==', 'A'.repeat(2796208)]) {
    await assert.rejects(extractEmbedding(value), { code: 'FACE_IMAGE_INVALID', status: 422 });
  }
});

test('a valid base64 string containing a nonimage does not reach model inference', async () => {
  await assert.rejects(extractEmbedding(Buffer.from('this is not a face image').toString('base64')), {
    code: 'FACE_IMAGE_INVALID', status: 422,
  });
});
