import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './config.js';
import { transaction } from './security.js';

export async function applyMigrations(pool) {
  await transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(2380601398::bigint)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const folder = new URL('../migrations/', import.meta.url);
    const files = (await readdir(folder)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(new URL(file, folder), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows } = await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file]);
      if (rows[0]) { if (rows[0].checksum !== checksum) throw new Error('Migration đã áp dụng bị thay đổi. Hãy bổ sung migration mới.'); continue; }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, checksum]);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try { pool = new pg.Pool(databaseOptions()); await applyMigrations(pool); console.log('Đã áp dụng migration PostgreSQL.'); }
  catch { console.error('Chưa áp dụng được migration. Kiểm tra cấu hình, kết nối và quyền PostgreSQL.'); process.exitCode = 1; }
  finally { await pool?.end(); }
}
