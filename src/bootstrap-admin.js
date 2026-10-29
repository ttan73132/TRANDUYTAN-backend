import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z, name, username, email, password, parse } from './validation.js';
import { databaseOptions } from './config.js';
import { hashPassword, transaction } from './security.js';

export function bootstrapInput(env = process.env) {
  return parse(z.object({ fullName: name, username, email, password }).strict(), {
    fullName: env.BOOTSTRAP_ADMIN_FULL_NAME, username: env.BOOTSTRAP_ADMIN_USERNAME,
    email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  });
}
export async function bootstrapAdmin(pool, input, { skipIfExists = false } = {}) {
  return transaction(pool, async db => {
    await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const existing = await db.query("SELECT id FROM users WHERE role='admin' AND deleted_at IS NULL LIMIT 1");
    if (existing.rows.length) {
      if (skipIfExists) return false;
      throw new Error('Đã có quản trị viên; bootstrap không được ghi đè tài khoản.');
    }
    const hash = await hashPassword(input.password);
    await db.query("INSERT INTO users(id,full_name,username,email,password_hash,role,status,email_verified) VALUES($1,$2,$3,$4,$5,'admin','active',true)", [randomUUID(), input.fullName, input.username, input.email, hash]);
    return true;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try { const input = bootstrapInput(); pool = new pg.Pool(databaseOptions()); await bootstrapAdmin(pool, input); console.log('Đã tạo quản trị viên đầu tiên. Hãy xóa BOOTSTRAP_ADMIN_PASSWORD khỏi môi trường deploy.'); }
  catch (error) { console.error(error.message?.startsWith('Đã có quản trị viên') ? error.message : 'Chưa tạo được quản trị viên. Kiểm tra BOOTSTRAP_ADMIN_* và kết nối PostgreSQL.'); process.exitCode = 1; }
  finally { await pool?.end(); }
}
