import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
try {
  await writeFile(new URL('../../.env.relay', import.meta.url), `OTP_RELAY_SECRET=${randomBytes(48).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Đã tạo .env.relay (được Git bỏ qua). Mở cục bộ và nhập cùng khóa vào Script properties và môi trường backend; không dán khóa vào chat.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env.relay đã có; không ghi đè hoặc in khóa.');
  else throw error;
}
