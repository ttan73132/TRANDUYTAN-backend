import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FACE_MODELS, getModelsDirectory, verifyModelFile } from '../src/face/models.js';

const directory = getModelsDirectory();
await mkdir(directory, { recursive: true });
for (const model of FACE_MODELS) {
  const destination = join(directory, model.name);
  let present = false;
  try { await access(destination); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present) {
    // Preserve an unexpected local file for investigation instead of overwriting it.
    await verifyModelFile(destination, model);
    console.log(`Verified ${model.name} (${model.bytes} bytes)`);
    continue;
  }
  const temporary = `${destination}.part-${randomUUID()}`;
  try {
    const response = await fetch(model.url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
    const reportedLength = response.headers.get('content-length');
    if (reportedLength && Number(reportedLength) !== model.bytes) throw new Error('Unexpected download length.');
    let received = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.byteLength;
        callback(received > model.bytes ? new Error('Model exceeds the pinned size.') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    await verifyModelFile(temporary, model);
    await rename(temporary, destination);
    console.log(`Downloaded and verified ${model.name} (${received} bytes)`);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
