// Explicit integration check on a real PostgreSQL server. Uses a unique, empty
// schema and drops only that exact schema in finally. Never contacts Firebase.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { databaseOptions } from '../src/config.js';
import { transaction } from '../src/security.js';
import { createNotifications } from '../src/notifications.js';

const schema = `push_test_${randomUUID().replaceAll('-', '')}`;
const options = databaseOptions();
const control = new pg.Pool({ ...options, max: 1 });
let pool;
try {
  await control.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({ ...options, max: 4, options: `-c search_path=${schema},public` });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const branchId = randomUUID(), userId = randomUUID(), sessionId = randomUUID(), deviceId = randomUUID();
  await pool.query('INSERT INTO branches(id,name,address,latitude,longitude,radius_meters) VALUES($1,$2,$3,10,106,100)', [branchId, 'Isolated test branch', 'Synthetic test address']);
  await pool.query("INSERT INTO users(id,full_name,username,email,password_hash,role,status,branch_id,email_verified) VALUES($1,$2,$3,$4,$5,'employee','active',$6,true)", [userId, 'Synthetic test user', 'push_test_user', 'push-test@example.test', 'test-only-not-used', branchId]);
  await pool.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)', [sessionId, userId]);
  await pool.query("INSERT INTO refresh_tokens(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)", [randomUUID(), sessionId, randomUUID(), new Date(Date.now() + 86400000)]);
  await pool.query("INSERT INTO notification_devices(id,user_id,session_id,installation_id,platform,registered_at) VALUES($1,$2,$3,$4,'android',$5)", [deviceId, userId, sessionId, 'c000000000000000000001', new Date()]);
  const sent = [];
  const settings = { pool, config: { fcmEnabled: true, fcmProjectId: 'test-project' }, provider: { async send(_fid, event) { sent.push(event.id); await new Promise(resolve => setTimeout(resolve, 30)); } } };
  const first = createNotifications(settings), second = createNotifications(settings);
  async function createShift(db, shiftId) {
    await db.query("INSERT INTO shifts(id,title,branch_id,employee_id,starts_at,ends_at,time_policy_snapshot) SELECT $1,'Synthetic test shift',b.id,$2,$3,$4,b.time_policy FROM branches b WHERE b.id=$5", [shiftId, userId, new Date(), new Date(Date.now() + 3600000), branchId]);
    await first.enqueue(db, { type: 'shift_assigned', entityId: shiftId, recipientId: userId });
  }
  const rolledBackId = randomUUID();
  await assert.rejects(transaction(pool, async db => { await createShift(db, rolledBackId); throw new Error('Expected rollback'); }), /Expected rollback/);
  assert.equal((await pool.query('SELECT id FROM shifts WHERE id=$1', [rolledBackId])).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rowCount, 0);
  console.log('PASS real PostgreSQL: shift and outbox roll back together.');
  const shiftId = randomUUID();
  await transaction(pool, db => createShift(db, shiftId));
  await Promise.all([first.drain(), second.drain()]);
  assert.equal(sent.length, 1);
  const row = (await pool.query('SELECT status,attempts FROM notification_outbox')).rows[0];
  assert.equal(row.status, 'sent'); assert.equal(row.attempts, 1);
  console.log('PASS real PostgreSQL: two workers claim and send the delivery once.');
  await first.stop(); await second.stop();
} finally {
  await pool?.end();
  try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await control.end(); }
}
