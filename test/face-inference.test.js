import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractEmbedding, compareEmbeddings } from '../src/face/recognizer.js';

let sharp;
let fixture;
let target;
let samePerson;
let differentPerson;

before(async () => {
  sharp = (await import('sharp')).default;
  fixture = await readFile(new URL('../src/face/fixtures/opencv-sface-demo.jpg', import.meta.url));
  assert.equal(createHash('sha256').update(fixture).digest('hex'), '0f879881a598fea6fec74e047e6a1d00e36d81de63bf0ed392b628e6ab6c2fc4');
  target = await sharp(fixture).extract({ left: 215, top: 30, width: 215, height: 265 }).jpeg({ quality: 95 }).toBuffer();
  samePerson = await sharp(fixture).extract({ left: 891, top: 143, width: 100, height: 120 }).jpeg({ quality: 95 }).toBuffer();
  differentPerson = await sharp(fixture).extract({ left: 670, top: 155, width: 86, height: 115 }).jpeg({ quality: 95 }).toBuffer();
});

test('real YuNet/SFace model recognizes the same person in two official sample photographs', async () => {
  const enrolled = await extractEmbedding(target.toString('base64'));
  const probe = await extractEmbedding(`data:image/jpeg;base64,${samePerson.toString('base64')}`);
  assert.equal(enrolled.length, 128);
  assert.ok(Math.abs(Math.hypot(...enrolled) - 1) < 1e-8);
  const match = compareEmbeddings(enrolled, probe);
  assert.equal(match.matches, true, `Official same-person pair cosine=${match.score}`);
});

test('real YuNet/SFace model rejects a different person from the official sample', async () => {
  const enrolled = await extractEmbedding(target.toString('base64'));
  const probe = await extractEmbedding(differentPerson.toString('base64'));
  const match = compareEmbeddings(enrolled, probe);
  assert.equal(match.matches, false, `Official different-person pair cosine=${match.score}`);
});

test('a valid blank photograph is rejected as no face', async () => {
  const blank = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(extractEmbedding(blank.toString('base64')), { code: 'FACE_NOT_FOUND', status: 422 });
});

test('two clear faces in a photograph cannot enroll as one identity', async () => {
  const closeup = await sharp(target).resize(256, 320, { fit: 'fill' }).toBuffer();
  const group = await sharp({ create: { width: 512, height: 320, channels: 3, background: '#ffffff' } })
    .composite([{ input: closeup, left: 0, top: 0 }, { input: closeup, left: 256, top: 0 }]).jpeg().toBuffer();
  await assert.rejects(extractEmbedding(group.toString('base64')), { code: 'FACE_MULTIPLE_FACES', status: 422 });
});

test('oversized image dimensions are rejected before ONNX inference', async () => {
  const narrow = await sharp({ create: { width: 80, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(extractEmbedding(narrow.toString('base64')), { code: 'FACE_IMAGE_INVALID', status: 422 });
});

test('bounded inference queue rejects overload and releases slots after failed detection', async () => {
  const blank = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const requests = Array.from({ length: 3 }, () => extractEmbedding(blank.toString('base64')));
  await assert.rejects(extractEmbedding(blank.toString('base64')), { code: 'FACE_SERVICE_BUSY', status: 429 });
  const results = await Promise.allSettled(requests);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'FACE_NOT_FOUND'));
  assert.equal((await extractEmbedding(target.toString('base64'))).length, 128);
});

test('missing model files fail closed with an explicit service-unavailable error', () => {
  const script = `
    import sharp from 'sharp';
    import { extractEmbedding } from './src/face/recognizer.js';
    const image = await sharp({create:{width:100,height:100,channels:3,background:'#ffffff'}}).png().toBuffer();
    try { await extractEmbedding(image.toString('base64')); process.exitCode=2; }
    catch(error) { console.log(JSON.stringify({status:error.status,code:error.code})); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, FACE_MODELS_DIR: fileURLToPath(new URL('../src/face/fixtures/missing-models/', import.meta.url)) },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 503, code: 'FACE_SERVICE_UNAVAILABLE' });
});
