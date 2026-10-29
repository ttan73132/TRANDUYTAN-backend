// Opt-in real PostgreSQL check: only a unique, owned test schema is mutated.
// Supply DATABASE_URL and DATABASE_SSL=true through the process environment.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { databaseOptions } from '../src/config.js';
import { applyMigrations } from '../src/migrate.js';

const schema = `test_so_ca_hn_radius_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^test_so_ca_hn_radius_[a-f0-9]{32}$/);
const options = databaseOptions();
assert.equal(options.ssl?.rejectUnauthorized, true, 'Verified PostgreSQL TLS is required.');
const control = new pg.Pool({ ...options, max: 1 });
let pool, created = false, stage = 'connect', checks = 0, failure = false;
const passed = name => { checks++; console.log(`PASS ${name}`); };
try {
  assert.equal((await control.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl, true);
  await control.query(`CREATE SCHEMA "${schema}"`); created = true;
  pool = new pg.Pool({ ...options, max: 1, options: `-c search_path=${schema}` });
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  passed('verified TLS and isolated search_path');

  stage = 'baseline';
  await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const folder = new URL('../migrations/', import.meta.url);
  const files = (await readdir(folder)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert.ok(files.includes('006_branch_radius_200km.sql'));
  for (const file of files.filter(file => file < '006_')) {
    const sql = await readFile(new URL(file, folder), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, createHash('sha256').update(sql).digest('hex')]);
  }
  const definition = (await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='branches'::regclass AND conname='branches_radius_meters_check'")).rows[0]?.definition;
  assert.ok(definition?.includes('5000'));
  const existingId = randomUUID();
  const insert = (id, radius) => pool.query("INSERT INTO branches(id,name,address,latitude,longitude,radius_meters) VALUES($1,'Isolated radius test','Synthetic test location',10,106,$2)", [id, radius]);
  await insert(existingId, 5000);
  await assert.rejects(insert(randomUUID(), 5000.001), error => error.code === '23514');
  passed('baseline PostgreSQL-generated constraint and original 5000m limit');

  stage = 'migration';
  await applyMigrations(pool); await applyMigrations(pool);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, files.length);
  passed('migration 006 applies forward and all migrations repeat safely');
  assert.equal((await pool.query('SELECT radius_meters FROM branches WHERE id=$1', [existingId])).rows[0].radius_meters, 5000);
  passed('existing branch radius remains unchanged');

  stage = 'bounds';
  for (const radius of [20, 200000]) await insert(randomUUID(), radius);
  passed('inclusive database bounds 20m and 200000m');
  for (const radius of [19.999, 200000.001]) await assert.rejects(insert(randomUUID(), radius), error => error.code === '23514');
  passed('database rejects values outside both bounds');
  await pool.query('UPDATE branches SET radius_meters=200000 WHERE id=$1', [existingId]);
  assert.equal((await pool.query('SELECT radius_meters FROM branches WHERE id=$1', [existingId])).rows[0].radius_meters, 200000);
  passed('existing branch can explicitly opt into 200km');
} catch (error) {
  failure = true;
  console.error(JSON.stringify({ status: 'failed', stage, code: /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'CHECK_FAILED' }));
} finally {
  await pool?.end();
  try {
    if (created) {
      assert.match(schema, /^test_so_ca_hn_radius_[a-f0-9]{32}$/);
      const owner = (await control.query('SELECT nspname,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
      assert.equal(owner?.nspname, schema); assert.equal(owner.owned, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      passed('exact owned test schema removed');
    }
  } catch { failure = true; console.error(JSON.stringify({ status: 'failed', stage: 'cleanup', code: 'CLEANUP_FAILED' })); }
  await control.end();
  console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', checks, cleanup: created && !failure }));
  if (failure) process.exitCode = 1;
}
