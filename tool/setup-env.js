import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const configured = template.replace(/^JWT_SECRET=$/m, `JWT_SECRET=${randomBytes(48).toString('base64url')}`).replace(/^OTP_SECRET=$/m, `OTP_SECRET=${randomBytes(48).toString('base64url')}`);
try {
  await writeFile(new URL('../.env', import.meta.url), configured, { flag: 'wx', mode: 0o600 });
  console.log('Đã tạo .env với hai khóa ngẫu nhiên. Mở tệp cục bộ để điền PostgreSQL, Brevo và thông tin quản trị viên; không gửi tệp này lên Git.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env đã có; không ghi đè.');
  else throw error;
}
