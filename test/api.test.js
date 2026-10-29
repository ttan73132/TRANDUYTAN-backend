import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { PushDeliveryError } from '../src/fcm.js';
import { createNotifications } from '../src/notifications.js';

let pool, app, mail, timestamp, serial, pushes, pushError;
const password = 'A-long-test-password-29';
beforeEach(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'length', args: ['text'], returns: 'integer', implementation: value => value.length });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) db.public.none(await readFile(new URL(file, migrations), 'utf8'));
  const adapter = db.adapters.createPg();
  pool = new adapter.Pool();
  mail = [];
  serial = 0;
  pushes = []; pushError = null;
  timestamp = Date.now();
  app = createApp({ pool, config: {
    jwtSecret: 'test-only-jwt-secret-with-at-least-32-characters',
    otpSecret: 'test-only-otp-secret-with-at-least-32-characters',
    issuer: 'attendance-api', audience: 'attendance-app',
    fcmEnabled: true, fcmProjectId: 'test-project',
  }, now: () => new Date(timestamp), mailer: {
    async sendOtp(message) { mail.push(message); },
  }, pushProvider: { async send(fid, event) { if (pushError) throw pushError; pushes.push({ fid, ...event }); } } });
});
afterEach(async () => pool.end());
const api = () => request(app);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function register(extra = {}) {
  const n = ++serial;
  return api().post('/v1/auth/register').send({
    fullName: `Test User ${n}`, username: `user${n}`, email: `user${n}@example.test`, password, ...extra,
  });
}
async function verify(challengeId, code = mail.at(-1)?.code) {
  return api().post('/v1/auth/verify-otp').send({ challengeId, code });
}
async function account({ role = 'employee', status = 'active', branchId = null } = {}) {
  const registration = await register();
  assert.equal(registration.status, 202);
  const verified = await verify(registration.body.data.challengeId);
  assert.equal(verified.status, 200);
  const { user, accessToken, refreshToken } = verified.body.data;
  await pool.query('UPDATE users SET role=$1,status=$2,branch_id=$3 WHERE id=$4', [role, status, branchId, user.id]);
  return { ...user, role, status, branchId, accessToken, refreshToken };
}
async function branch(owner, name = 'Main branch') {
  const result = await api().post('/v1/branches').set(auth(owner.accessToken)).send({
    name, address: 'Test address', latitude: 10, longitude: 106, radiusMeters: 100,
  });
  assert.equal(result.status, 201);
  return result.body.data;
}
async function shift(owner, worker, branchId, extra = {}) {
  const result = await api().post('/v1/shifts').set(auth(owner.accessToken)).send({
    title: 'Morning shift', branchId, employeeId: worker.id,
    startsAt: new Date(timestamp - 3600000).toISOString(), endsAt: new Date(timestamp + 3600000).toISOString(), ...extra,
  });
  assert.equal(result.status, 201);
  return result.body.data;
}
async function workplace(shiftOptions = {}) {
  const admin = await account({ role: 'admin' });
  const office = await branch(admin);
  const employee = await account({ branchId: office.id });
  const duty = await shift(admin, employee, office.id, shiftOptions);
  return { admin, office, employee, duty };
}
async function advanceTo(time, ...users) {
  timestamp = typeof time === 'number' ? time : Date.parse(time);
  for (const user of users) {
    const response = await api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    assert.equal(response.status, 200);
    user.accessToken = response.body.data.accessToken;
    user.refreshToken = response.body.data.refreshToken;
  }
}
const fid = n => `c${String(n).padStart(21, '0')}`;
const factAnswersOf = row => row.criticalFacts.map(fact=>({factId:fact.id,value:fact.value}));
async function criticalHandover({ employee, recipient, duty, extra={} }) {
  const result = await api().post('/v1/handovers').set(auth(employee.accessToken)).send({shiftId:duty.id,recipientId:recipient.id,
    originalText:'Thiết bị EQ-12; số lượng 12.5; hạn 2026-10-29 17:30.',translatedText:'Equipment EQ-12; quantity 12.5; deadline 2026-10-29 17:30.',
    sourceLanguage:'vi',targetLanguage:'en',items:[{id:randomUUID(),text:'Kiểm tra hàng',translatedText:'Check inventory',state:'open'}],
    criticalFacts:[{id:randomUUID(),kind:'equipment',label:'Mã thiết bị',value:'EQ-12'},{id:randomUUID(),kind:'quantity',label:'Số lượng',value:'12.5'},{id:randomUUID(),kind:'deadline',label:'Hạn chót',value:'2026-10-29 17:30'}],status:'submitted',...extra});
  assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.data;
}
test('critical handover drafts allow partial composition but submission enforces 1-3 anchored valid facts', async()=>{
  const {employee,office,duty}=await workplace();const recipient=await account({branchId:office.id});
  const draft=await criticalHandover({employee,recipient,duty,extra:{status:'draft',criticalFacts:[]}});
  assert.deepEqual(draft.criticalFacts,[]);assert.equal(draft.criticalFactConfirmation,null);
  let response=await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({version:1,status:'submitted'});
  assert.equal(response.status,422);assert.equal(response.body.error.code,'CRITICAL_FACTS_REQUIRED');
  const fact={id:randomUUID(),kind:'quantity',label:'Số lượng',value:'１２,５０'};
  response=await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({version:1,criticalFacts:[fact],originalText:'Chưa soạn xong',translatedText:'Not composed yet'});
  assert.equal(response.status,200);assert.equal(response.body.data.status,'draft');assert.equal(response.body.data.criticalFacts[0].value,'12.5');
  response=await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({version:2,status:'submitted',originalText:'Số lượng 12.5',translatedText:'Quantity 112.5'});
  assert.equal(response.status,422);assert.equal(response.body.error.code,'CRITICAL_FACT_NOT_ANCHORED');
  response=await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({version:2,status:'submitted',originalText:'Số lượng １２,５０',translatedText:'Quantity 12.500'});
  assert.equal(response.status,200);assert.equal(response.body.data.version,3);assert.equal(response.body.data.status,'submitted');
});
test('wrong or forged critical-fact answers leave items, version, proof and revisions unchanged',async()=>{
  const {admin,employee,office,duty}=await workplace();const recipient=await account({branchId:office.id});const outsider=await account({branchId:office.id});
  const row=await criticalHandover({employee,recipient,duty}); const items=row.items.map(item=>({...item,state:'understood'}));const correct=factAnswersOf(row);
  const cases=[{answers:undefined,code:'FACT_ANSWERS_REQUIRED'},{answers:[...correct.slice(0,2),{factId:row.criticalFacts[2].id,value:'2026-10-29 17:31'}],code:'FACT_ANSWER_MISMATCH'},
    {answers:[correct[0],correct[0],correct[2]],code:'FACT_ANSWERS_INVALID'},{answers:[...correct,{factId:randomUUID(),value:'12'}],code:'FACT_ANSWERS_INVALID'},
    {answers:[{factId:randomUUID(),value:'EQ-12'},...correct.slice(1)],code:'FACT_ANSWERS_INVALID'}];
  for(const scenario of cases){const response=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:row.version,items,status:'acknowledged',...(scenario.answers?{factAnswers:scenario.answers}:{})});
    assert.equal(response.status,422);assert.equal(response.body.error.code,scenario.code);
    const unchanged=(await api().get(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken))).body.data;
    assert.equal(unchanged.version,1);assert.equal(unchanged.status,'submitted');assert.equal(unchanged.items[0].state,'open');assert.equal(unchanged.criticalFactConfirmation,null);
    assert.equal((await api().get(`/v1/handovers/${row.id}/revisions`).set(auth(recipient.accessToken))).body.data.length,1);}
  for(const user of [employee,admin]) assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(user.accessToken)).send({version:1,status:'acknowledged',items,factAnswers:correct})).status,403);
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(outsider.accessToken)).send({version:1,status:'acknowledged',items,factAnswers:correct})).status,404);
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,status:'submitted',factAnswers:correct})).body.error.code,'FACT_ANSWERS_FINAL_ONLY');
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,criticalFactConfirmation:{verifiedBy:recipient.id}})).status,422);
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,criticalFacts:row.criticalFacts})).status,403);
  const accepted=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,status:'acknowledged',items,factAnswers:[{...correct[0],value:'ｅｑ－１２'},{...correct[1],value:'１２,５０'},correct[2]]});
  assert.equal(accepted.status,200);assert.equal(accepted.body.data.criticalFactConfirmation.version,2);assert.equal(accepted.body.data.criticalFactConfirmation.verifiedBy,recipient.id);assert.equal(accepted.body.data.criticalFactConfirmation.answers[1].value,'12.5');
});
test('author amendments reopen acknowledged handovers and invalidate previous recipient proof with audit preserved',async()=>{
  const {employee,office,duty}=await workplace();const recipient=await account({branchId:office.id});
  const row=await criticalHandover({employee,recipient,duty});const understood=row.items.map(item=>({...item,state:'understood'}));
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,status:'acknowledged',items:understood,factAnswers:factAnswersOf(row)})).status,200);
  let changed=await api().patch(`/v1/handovers/${row.id}`).set(auth(employee.accessToken)).send({version:2,originalText:'Thiết bị EQ-12; số lượng 13; hạn 2026-10-29 17:30.',translatedText:'Equipment EQ-12; quantity 13; deadline 2026-10-29 17:30.',criticalFacts:row.criticalFacts.map(fact=>fact.kind==='quantity'?{...fact,value:'13'}:fact)});
  assert.equal(changed.status,200);changed=changed.body.data;assert.equal(changed.version,3);assert.equal(changed.status,'submitted');assert.equal(changed.items[0].state,'open');assert.equal(changed.criticalFactConfirmation,null);
  const history=(await api().get(`/v1/handovers/${row.id}/revisions`).set(auth(recipient.accessToken))).body.data;
  assert.equal(history.length,3);assert.equal(history[1].snapshot.criticalFactConfirmation.verifiedBy,recipient.id);assert.equal(history[2].snapshot.criticalFactConfirmation,null);
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(employee.accessToken)).send({version:3,status:'draft',criticalFacts:[]})).status,409);
  assert.equal((await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:2,status:'acknowledged',items:understood,factAnswers:factAnswersOf(row)})).status,409);
  const staleAnswers=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:3,status:'acknowledged',items:understood,factAnswers:factAnswersOf(row)});
  assert.equal(staleAnswers.status,422);assert.equal(staleAnswers.body.error.code,'FACT_ANSWER_MISMATCH');
  const accepted=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:3,status:'acknowledged',items:understood,factAnswers:factAnswersOf(changed)});
  assert.equal(accepted.status,200);assert.equal(accepted.body.data.criticalFactConfirmation.version,4);
});
test('legacy handovers remain readable but cannot be acknowledged until author adds anchored critical facts',async()=>{
  const {employee,office,duty}=await workplace();const recipient=await account({branchId:office.id});
  const row=await criticalHandover({employee,recipient,duty});await pool.query("UPDATE handovers SET critical_facts='[]'::jsonb WHERE id=$1",[row.id]);
  const response=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,status:'acknowledged',items:row.items.map(item=>({...item,state:'understood'})),factAnswers:[]});
  assert.equal(response.status,422);assert.equal(response.body.error.code,'CRITICAL_FACTS_REQUIRED');
  const amended=await api().patch(`/v1/handovers/${row.id}`).set(auth(employee.accessToken)).send({version:1,criticalFacts:row.criticalFacts});assert.equal(amended.status,200);
  const accepted=await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:2,status:'acknowledged',items:row.items.map(item=>({...item,state:'understood'})),factAnswers:factAnswersOf(amended.body.data)});assert.equal(accepted.status,200);
});
async function linkDevice(user, installationId = fid(1)) {
  const response = await api().post('/v1/notification-devices').set(auth(user.accessToken)).send({ installationId, firebaseProjectId: 'test-project', platform: 'android' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.recipientId, user.id);
  return response.body.data;
}

test('push registration requires an active account, matching project and current-session ownership', async () => {
  const pending = await account({ status: 'pending' });
  assert.equal((await api().post('/v1/notification-devices').set(auth(pending.accessToken)).send({ installationId: fid(1), firebaseProjectId: 'test-project', platform: 'android' })).status, 403);
  const user = await account(), other = await account();
  assert.equal((await api().post('/v1/notification-devices').set(auth(user.accessToken)).send({ installationId: fid(1), firebaseProjectId: 'different-project', platform: 'android' })).status, 422);
  const device = await linkDevice(user);
  const repeated = await linkDevice(user);
  assert.equal(repeated.id, device.id);
  assert.equal((await api().delete(`/v1/notification-devices/${device.id}`).set(auth(other.accessToken))).status, 404);
  const status = await api().get('/v1/notifications/status').set(auth(user.accessToken));
  assert.deepEqual(status.body.data, { enabled: true, provider: 'fcm', firebaseProjectId: 'test-project' });
  assert.equal((await api().delete(`/v1/notification-devices/${device.id}`).set(auth(user.accessToken))).status, 200);
});
test('shift outbox is transactional, deduplicated, and emits only creation or actual reassignment', async () => {
  const { admin, office, employee } = await workplace();
  const other = await account({ branchId: office.id });
  await linkDevice(employee); await linkDevice(other, fid(2));
  const duty = await shift(admin, employee, office.id);
  let rows = (await pool.query('SELECT * FROM notification_outbox')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].recipient_id, employee.id);
  assert.equal(pushes.length, 0, 'HTTP response does not wait for or fake a provider send');
  await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ title: 'Renamed only' });
  await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ employeeId: employee.id });
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length, 1);
  const invalid = await api().post('/v1/shifts').set(auth(admin.accessToken)).send({ title: 'Rejected shift', branchId: office.id, employeeId: employee.id, startsAt: new Date(timestamp + 1000).toISOString(), endsAt: new Date(timestamp).toISOString() });
  assert.equal(invalid.status, 422); assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length, 1);
  await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ employeeId: other.id });
  await app.locals.notifications.drain();
  rows = (await pool.query('SELECT * FROM notification_outbox ORDER BY created_at')).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.recipient_id === employee.id).status, 'skipped');
  assert.equal(pushes.length, 1); assert.equal(pushes[0].recipient_id, other.id); assert.equal(pushes[0].fid, fid(2));
  await app.locals.notifications.drain(); assert.equal(pushes.length, 1);
});
test('logout, refresh replay, suspension and shared-device rebinding invalidate queued push targets', async () => {
  const { admin, office, employee } = await workplace();
  const other = await account({ branchId: office.id });
  const old = await linkDevice(employee);
  await shift(admin, employee, office.id);
  const replacement = await linkDevice(other);
  assert.notEqual(replacement.id, old.id);
  assert.equal((await api().delete(`/v1/notification-devices/${replacement.id}`).set(auth(employee.accessToken))).status, 404);
  await app.locals.notifications.drain(); assert.equal(pushes.length, 0);
  await shift(admin, other, office.id);
  await api().post('/v1/auth/logout').send({ refreshToken: other.refreshToken });
  assert.equal((await pool.query('SELECT id FROM notification_devices WHERE user_id=$1', [other.id])).rows.length, 0);
  await app.locals.notifications.drain(); assert.equal(pushes.length, 0);
  await linkDevice(employee, fid(3)); await shift(admin, employee, office.id);
  await api().patch(`/v1/employees/${employee.id}`).set(auth(admin.accessToken)).send({ status: 'suspended' });
  await app.locals.notifications.drain(); assert.equal(pushes.length, 0);
  assert.equal((await pool.query('SELECT id FROM notification_devices WHERE user_id=$1', [employee.id])).rows.length, 0);
  const replayUser = await account({ branchId: office.id });
  await linkDevice(replayUser, fid(4)); await shift(admin, replayUser, office.id);
  const original = replayUser.refreshToken;
  assert.equal((await api().post('/v1/auth/refresh').send({ refreshToken: original })).status, 200);
  assert.equal((await api().post('/v1/auth/refresh').send({ refreshToken: original })).status, 401);
  await app.locals.notifications.drain(); assert.equal(pushes.length, 0);
  assert.equal((await pool.query('SELECT id FROM notification_devices WHERE user_id=$1', [replayUser.id])).rows.length, 0);
});
test('FCM outages preserve committed shifts, retry with backoff, and stop at six attempts', async () => {
  const { admin, employee, office } = await workplace();
  await linkDevice(employee);
  const duty = await shift(admin, employee, office.id);
  pushError = new PushDeliveryError('FCM_UNAVAILABLE', true);
  await app.locals.notifications.drain();
  let event = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  assert.equal(event.status, 'queued'); assert.equal(event.attempts, 1);
  assert.equal((await pool.query('SELECT id FROM shifts WHERE id=$1', [duty.id])).rows.length, 1);
  await app.locals.notifications.drain(); assert.equal((await pool.query('SELECT attempts FROM notification_outbox')).rows[0].attempts, 1);
  for (let i = 2; i <= 6; i++) { timestamp = new Date(event.available_at).getTime(); await app.locals.notifications.drain(); event = (await pool.query('SELECT * FROM notification_outbox')).rows[0]; }
  assert.equal(event.status, 'dead'); assert.equal(event.attempts, 6); assert.equal(event.last_error_code, 'FCM_UNAVAILABLE');
  assert.equal(pushes.length, 0);
});
test('push retry succeeds only after its due time and expired or unregistered targets stop safely', async () => {
  const { admin, employee, office } = await workplace();
  await linkDevice(employee);
  await shift(admin, employee, office.id);
  pushError = new PushDeliveryError('FCM_RATE_LIMITED', true);
  await app.locals.notifications.drain();
  let event = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  pushError = null;
  timestamp = new Date(event.available_at).getTime() - 1;
  await app.locals.notifications.drain(); assert.equal(pushes.length, 0);
  timestamp++;
  await app.locals.notifications.drain(); assert.equal(pushes.length, 1);
  event = (await pool.query('SELECT * FROM notification_outbox')).rows[0];
  assert.equal(event.status, 'sent'); assert.equal(event.attempts, 2);
  await advanceTo(timestamp, admin, employee);
  await shift(admin, employee, office.id);
  pushError = new PushDeliveryError('FCM_UNREGISTERED', false);
  await app.locals.notifications.drain();
  assert.equal((await pool.query('SELECT id FROM notification_devices')).rows.length, 0);
  assert.equal((await pool.query("SELECT id FROM notification_outbox WHERE status='dead'")).rows.length, 1);
  await linkDevice(employee, fid(2)); await shift(admin, employee, office.id);
  timestamp += 24 * 3600000;
  pushError = null; await app.locals.notifications.drain();
  assert.equal(pushes.length, 1);
  assert.equal((await pool.query("SELECT last_error_code FROM notification_outbox WHERE status='skipped'")).rows[0].last_error_code, 'EVENT_EXPIRED');
});
test('unconfigured push reports disabled and never accepts a pretend device registration', async () => {
  const user = await account();
  const disabledApp = createApp({ pool, config: { jwtSecret: 'test-only-jwt-secret-with-at-least-32-characters', otpSecret: 'test-only-otp-secret-with-at-least-32-characters' }, now: () => new Date(timestamp), mailer: { async sendOtp() {} } });
  const status = await request(disabledApp).get('/v1/notifications/status').set(auth(user.accessToken));
  assert.deepEqual(status.body.data, { enabled: false, provider: 'fcm', firebaseProjectId: null });
  const rejected = await request(disabledApp).post('/v1/notification-devices').set(auth(user.accessToken)).send({ installationId: fid(1), firebaseProjectId: 'test-project', platform: 'android' });
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error.code, 'PUSH_DISABLED');
  assert.equal((await pool.query('SELECT id FROM notification_devices')).rows.length, 0);
});
test('correction decisions notify once; pending edits and self-review failures never enqueue', async () => {
  const { admin, employee, duty } = await workplace();
  await linkDevice(employee);
  const created = await api().post('/v1/corrections').set(auth(employee.accessToken)).send({ shiftId: duty.id, requestedCheckIn: new Date(timestamp).toISOString(), reason: 'Forgot check-in' });
  const correctionId = created.body.data.id;
  await api().patch(`/v1/corrections/${correctionId}`).set(auth(employee.accessToken)).send({ reason: 'Please check evidence' });
  assert.equal((await api().patch(`/v1/corrections/${correctionId}`).set(auth(employee.accessToken)).send({ status: 'approved' })).status, 403);
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length, 0);
  assert.equal((await api().patch(`/v1/corrections/${correctionId}`).set(auth(admin.accessToken)).send({ status: 'rejected', resolutionNote: 'No matching evidence' })).status, 200);
  assert.equal((await api().patch(`/v1/corrections/${correctionId}`).set(auth(admin.accessToken)).send({ status: 'approved' })).status, 409);
  await app.locals.notifications.drain();
  assert.equal(pushes.length, 1); assert.equal(pushes[0].event_type, 'correction_reviewed'); assert.equal(pushes[0].entity_id, correctionId);
});
test('handover notifications target the latest author submission or amendment only', async () => {
  const { employee, office, duty } = await workplace();
  const recipient = await account({ branchId: office.id });
  await linkDevice(employee); await linkDevice(recipient, fid(2));
  const body = { shiftId: duty.id, recipientId: recipient.id, originalText: 'Check stock 12', translatedText: 'Kiểm tra hàng 12', criticalFacts: [{id:randomUUID(),kind:'quantity',label:'Quantity',value:'12'}], sourceLanguage: 'en', targetLanguage: 'vi', items: [{ id: randomUUID(), text: 'Count items', translatedText: 'Đếm hàng', state: 'open' }] };
  const draft = (await api().post('/v1/handovers').set(auth(employee.accessToken)).send(body)).body.data;
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length, 0);
  const submitted = await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({ version: draft.version, status: 'submitted' });
  assert.equal(submitted.status, 200);
  await api().patch(`/v1/handovers/${draft.id}`).set(auth(employee.accessToken)).send({ version: submitted.body.data.version, originalText: 'Check remaining stock 12' });
  await app.locals.notifications.drain();
  assert.equal(pushes.length, 1); assert.equal(pushes[0].recipient_id, recipient.id); assert.equal(pushes[0].event_type, 'handover_submitted');
});
test('concurrent workers skip superseded author events but not recipient-only version changes', async()=>{
  const {employee,office,duty}=await workplace();const recipient=await account({branchId:office.id});await linkDevice(recipient);
  const row=await criticalHandover({employee,recipient,duty});
  let current=(await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:1,items:row.items.map(item=>({...item,state:'clarify'}))})).body.data;
  assert.equal(current.version,2);assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length,1);
  await app.locals.notifications.drain();assert.equal(pushes.length,1);assert.equal(pushes[0].entity_version,1,'recipient partial update must not suppress original submission event');
  current=(await api().patch(`/v1/handovers/${row.id}`).set(auth(employee.accessToken)).send({version:2,originalText:row.originalText+' Ghi chú mới.'})).body.data;
  assert.equal(current.version,3);
  current=(await api().patch(`/v1/handovers/${row.id}`).set(auth(employee.accessToken)).send({version:3,translatedText:row.translatedText+' New note.'})).body.data;
  assert.equal(current.version,4);
  current=(await api().patch(`/v1/handovers/${row.id}`).set(auth(recipient.accessToken)).send({version:4,items:current.items.map(item=>({...item,state:'clarify'}))})).body.data;
  assert.equal(current.version,5);assert.equal((await pool.query('SELECT id FROM notification_outbox')).rows.length,3);
  const second=createNotifications({pool,config:{fcmEnabled:true,fcmProjectId:'test-project'},now:()=>new Date(timestamp),provider:{async send(fid,event){pushes.push({fid,...event});}}});
  await Promise.all([app.locals.notifications.drain(),second.drain()]);await second.stop();
  assert.equal(pushes.length,2);assert.equal(pushes[1].entity_version,4);
  const events=(await pool.query('SELECT entity_version,status FROM notification_outbox ORDER BY entity_version')).rows;
  assert.deepEqual(events.map(event=>[event.entity_version,event.status]),[[1,'sent'],[3,'skipped'],[4,'sent']]);
});

test('registration does not authenticate before the email code and creates a pending employee', async () => {
  const result = await register();
  assert.equal(result.status, 202);
  assert.equal(result.body.data.accessToken, undefined);
  assert.equal(result.body.data.code, undefined);
  assert.match(result.body.data.maskedEmail, /\*.*@/);
  const verified = await verify(result.body.data.challengeId);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.role, 'employee');
  assert.equal(verified.body.data.user.status, 'pending');
  assert.equal(verified.body.data.user.passwordHash, undefined);
  const denied = await api().get('/v1/shifts').set(auth(verified.body.data.accessToken));
  assert.equal(denied.status, 403);
});
test('registration rejects role mass assignment', async () => {
  assert.equal((await register({ role: 'admin' })).status, 422);
});
test('incorrect password never sends a login OTP', async () => {
  const user = await account();
  const count = mail.length;
  const result = await api().post('/v1/auth/login').send({ username: user.username, password: 'not-the-password' });
  assert.equal(result.status, 401);
  assert.equal(mail.length, count);
});
test('email OTP is consumed once and attempts cannot be reset by submitting the correct code', async () => {
  const result = await register();
  const id = result.body.data.challengeId;
  const right = mail.at(-1).code;
  const wrong = right === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await verify(id, wrong)).status, 401);
  assert.equal((await verify(id, right)).status, 401);
  const second = await register();
  const secondId = second.body.data.challengeId;
  const secondCode = mail.at(-1).code;
  assert.equal((await verify(secondId, secondCode)).status, 200);
  assert.equal((await verify(secondId, secondCode)).status, 401);
});
test('expired OTP is rejected and resend invalidates the previous code', async () => {
  const first = await register();
  const firstId = first.body.data.challengeId;
  const oldCode = mail.at(-1).code;
  assert.equal((await api().post('/v1/auth/resend-otp').send({ challengeId: firstId })).status, 429);
  timestamp += 61000;
  const resent = await api().post('/v1/auth/resend-otp').send({ challengeId: firstId });
  assert.equal(resent.status, 200);
  assert.equal((await verify(firstId, oldCode)).status, 401);
  timestamp += 11 * 60000;
  assert.equal((await verify(firstId, mail.at(-1).code)).status, 401);
});
test('failure to send real email yields an explicit unavailable error and leaves no usable challenge', async () => {
  const unavailable = createApp({ pool, config: { jwtSecret: 'x'.repeat(40), otpSecret: 'y'.repeat(40) },
    mailer: { async sendOtp() { throw new Error('provider unavailable'); } } });
  const result = await request(unavailable).post('/v1/auth/register').send({ fullName: 'Mail Test', username: 'mailtest', email: 'mail@example.test', password });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'EMAIL_UNAVAILABLE');
  const { rows } = await pool.query('SELECT * FROM otp_challenges WHERE consumed_at IS NULL');
  assert.equal(rows.length, 0);
});
test('refresh rotates its token and reuse revokes the whole session', async () => {
  const user = await account();
  const fresh = await api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.data.refreshToken, user.refreshToken);
  assert.equal((await api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken })).status, 401);
  assert.equal((await api().get('/v1/me').set(auth(fresh.body.data.accessToken))).status, 401);
});
test('logout and a server-side suspension revoke access even for an unexpired JWT', async () => {
  const user = await account();
  await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [user.id]);
  assert.equal((await api().get('/v1/me').set(auth(user.accessToken))).status, 403);
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [user.id]);
  assert.equal((await api().post('/v1/auth/logout').send({ refreshToken: user.refreshToken })).status, 200);
  assert.equal((await api().get('/v1/me').set(auth(user.accessToken))).status, 401);
});
test('an employee cannot promote itself or create a branch and a manager cannot see another branch', async () => {
  const admin = await account({ role: 'admin' });
  const a = await branch(admin, 'Branch A');
  const b = await branch(admin, 'Branch B');
  const worker = await account({ branchId: a.id });
  const manager = await account({ role: 'manager', branchId: b.id });
  assert.equal((await api().patch(`/v1/employees/${worker.id}`).set(auth(worker.accessToken)).send({ role: 'admin' })).status, 403);
  assert.equal((await api().post('/v1/branches').set(auth(worker.accessToken)).send({ name: 'Bad' })).status, 403);
  const visible = await api().get('/v1/employees').set(auth(manager.accessToken));
  assert.equal(visible.status, 200);
  assert.equal(visible.body.data.some(x => x.id === worker.id), false);
  assert.equal((await api().get(`/v1/branches/${a.id}`).set(auth(manager.accessToken))).status, 404);
});
test('last active admin cannot be demoted or deleted', async () => {
  const admin = await account({ role: 'admin' });
  assert.equal((await api().patch(`/v1/employees/${admin.id}`).set(auth(admin.accessToken)).send({ role: 'employee' })).status, 409);
  assert.equal((await api().delete(`/v1/employees/${admin.id}`).set(auth(admin.accessToken))).status, 409);
});
test('partial employee updates preserve omitted role, status and branch fields', async () => {
  const admin = await account({ role: 'admin' });
  const result = await api().patch(`/v1/employees/${admin.id}`).set(auth(admin.accessToken)).send({ fullName: 'Updated Admin Name' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.role, 'admin');
  assert.equal(result.body.data.status, 'active');
  assert.equal(result.body.data.fullName, 'Updated Admin Name');
});
test('partial shift update does not reset a recorded in-progress shift', async () => {
  const { admin, employee, duty } = await workplace();
  await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send({ shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 });
  const changed = await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ title: 'Renamed morning shift' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.status, 'in_progress');
});
test('geofence is checked server-side and duplicate check-in is rejected', async () => {
  const { employee, duty } = await workplace();
  const remote = { shiftId: duty.id, latitude: 11, longitude: 106, accuracyMeters: 5 };
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(remote)).status, 422);
  const local = { ...remote, latitude: 10 };
  const checkIn = await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(local);
  assert.equal(checkIn.status, 201);
  assert.equal(checkIn.body.data.employeeId, employee.id);
  assert.equal(new Date(checkIn.body.data.checkInAt).getTime(), timestamp);
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(local)).status, 409);
  timestamp += 60000;
  assert.equal((await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(local)).status, 200);
  assert.equal((await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(local)).status, 409);
});
test('a worker cannot punch another employee shift or check out before checking in', async () => {
  const { employee, duty, office } = await workplace();
  const other = await account({ branchId: office.id });
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(other.accessToken)).send(body)).status, 404);
  assert.equal((await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body)).status, 409);
});
test('location shares expire, stay branch-scoped, and can be stopped by their owner', async () => {
  const { admin, office, employee } = await workplace();
  const manager = await account({ role: 'manager', branchId: office.id });
  const outsider = await account({ role: 'manager', branchId: (await branch(admin, 'Other')).id });
  const shared = await api().post('/v1/location-shares').set(auth(employee.accessToken)).send({ latitude: 10, longitude: 106, accuracyMeters: 5, ttlMinutes: 5 });
  assert.equal(shared.status, 201);
  assert.equal((await api().get('/v1/location-shares').set(auth(manager.accessToken))).body.data.length, 1);
  assert.equal((await api().get('/v1/location-shares').set(auth(outsider.accessToken))).body.data.length, 0);
  assert.equal((await api().delete(`/v1/location-shares/${shared.body.data.id}`).set(auth(outsider.accessToken))).status, 404);
  timestamp += 6 * 60000;
  assert.equal((await api().get('/v1/location-shares').set(auth(manager.accessToken))).body.data.length, 0);
  assert.equal((await api().delete(`/v1/location-shares/${shared.body.data.id}`).set(auth(employee.accessToken))).status, 200);
});
test('correction cannot be self-approved and approved times change the actual attendance', async () => {
  const { admin, employee, duty } = await workplace();
  const requested = new Date(timestamp - 1800000).toISOString();
  const proposal = await api().post('/v1/corrections').set(auth(employee.accessToken)).send({ shiftId: duty.id, requestedCheckIn: requested, reason: 'Forgot to check in' });
  assert.equal(proposal.status, 201);
  assert.equal((await api().patch(`/v1/corrections/${proposal.body.data.id}`).set(auth(employee.accessToken)).send({ status: 'approved' })).status, 403);
  const approval = await api().patch(`/v1/corrections/${proposal.body.data.id}`).set(auth(admin.accessToken)).send({ status: 'approved', resolutionNote: 'Verified' });
  assert.equal(approval.status, 200);
  const attendance = await api().get('/v1/attendance').set(auth(employee.accessToken));
  assert.equal(new Date(attendance.body.data[0].checkInAt).toISOString(), requested);
});
test('handover understanding is recorded by its recipient with optimistic version checking', async () => {
  const { employee, duty, office } = await workplace();
  const recipient = await account({ branchId: office.id });
  const create = await api().post('/v1/handovers').set(auth(employee.accessToken)).send({
    shiftId: duty.id, recipientId: recipient.id, originalText: 'Check door EQ-12', translatedText: 'Kiểm tra cửa EQ-12',
    criticalFacts: [{id:randomUUID(),kind:'equipment',label:'Door equipment',value:'EQ-12'}],
    sourceLanguage: 'en', targetLanguage: 'vi', status: 'submitted', items: [{ id: randomUUID(), text: 'Check the door', translatedText: 'Kiểm tra cửa', state: 'open' }],
  });
  assert.equal(create.status, 201);
  const handover = create.body.data;
  const understood = handover.items.map(x => ({ ...x, state: 'understood' }));
  assert.equal((await api().patch(`/v1/handovers/${handover.id}`).set(auth(employee.accessToken)).send({ version: 1, status: 'acknowledged', items: understood })).status, 403);
  const accepted = await api().patch(`/v1/handovers/${handover.id}`).set(auth(recipient.accessToken)).send({ version: 1, status: 'acknowledged', items: understood, factAnswers: handover.criticalFacts.map(fact=>({factId:fact.id,value:fact.value})) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.version, 2);
  assert.equal(accepted.body.data.status, 'acknowledged');
  assert.equal((await api().patch(`/v1/handovers/${handover.id}`).set(auth(recipient.accessToken)).send({ version: 1, status: 'acknowledged', items: understood })).status, 409);
  const history = await api().get(`/v1/handovers/${handover.id}/revisions`).set(auth(recipient.accessToken));
  assert.equal(history.status, 200);
  assert.equal(history.body.data.length, 2);
});
test('CRUD removes an unreferenced branch after its only employee is deleted', async () => {
  const admin = await account({ role: 'admin' });
  const office = await branch(admin, 'Disposable branch');
  const created = await api().post('/v1/employees').set(auth(admin.accessToken)).send({ fullName: 'Created Employee', username: 'createdemployee', email: 'created@example.test', password, branchId: office.id, role: 'employee', status: 'pending' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.passwordHash, undefined);
  const id = created.body.data.id;
  assert.equal((await api().patch(`/v1/employees/${id}`).set(auth(admin.accessToken)).send({ fullName: 'Renamed Employee' })).status, 200);
  assert.equal((await api().delete(`/v1/branches/${office.id}`).set(auth(admin.accessToken))).status, 409);
  assert.equal((await api().delete(`/v1/employees/${id}`).set(auth(admin.accessToken))).status, 200);
  assert.equal((await api().get(`/v1/employees/${id}`).set(auth(admin.accessToken))).status, 404);
  assert.equal((await api().delete(`/v1/branches/${office.id}`).set(auth(admin.accessToken))).status, 200);
});
test('face enrollment and login use actual recognition and still require email OTP', async () => {
  const sharp = (await import('sharp')).default;
  const fixture = await readFile(new URL('../src/face/fixtures/opencv-sface-demo.jpg', import.meta.url));
  const target = (await sharp(fixture).extract({ left: 215, top: 30, width: 215, height: 265 }).jpeg({ quality: 95 }).toBuffer()).toString('base64');
  const same = (await sharp(fixture).extract({ left: 891, top: 143, width: 100, height: 120 }).jpeg({ quality: 95 }).toBuffer()).toString('base64');
  const different = (await sharp(fixture).extract({ left: 670, top: 155, width: 86, height: 115 }).jpeg({ quality: 95 }).toBuffer()).toString('base64');
  const user = await account();
  const enrolled = await api().post('/v1/face/enroll').set(auth(user.accessToken)).send({ imageBase64: target });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.body.data.enrolled, true);
  assert.equal(enrolled.body.data.embedding, undefined);
  assert.equal((await api().get('/v1/face/status').set(auth(user.accessToken))).body.data.enrolled, true);
  timestamp += 61000;
  const mailBefore = mail.length;
  assert.equal((await api().post('/v1/auth/face-login').send({ username: user.username, imageBase64: different })).status, 401);
  assert.equal(mail.length, mailBefore);
  const login = await api().post('/v1/auth/face-login').send({ username: user.username, imageBase64: same });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.accessToken, undefined);
  assert.equal(login.body.data.purpose, 'face_login');
  const verified = await verify(login.body.data.challengeId);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, user.id);
  assert.equal((await api().delete('/v1/face/enroll').set(auth(user.accessToken))).status, 200);
  assert.equal((await api().get('/v1/face/status').set(auth(user.accessToken))).body.data.enrolled, false);
});
test('malformed face input returns a safe validation error rather than an internal stack trace', async () => {
  const user = await account();
  const result = await api().post('/v1/face/enroll').set(auth(user.accessToken)).send({ imageBase64: '!'.repeat(100) });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'FACE_IMAGE_INVALID');
  assert.equal(result.body.error.stack, undefined);
});
test('dashboard counts the local workday across a UTC midnight', async () => {
  timestamp = Date.parse('2026-10-28T23:30:00Z');
  const { employee, duty } = await workplace();
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send({ shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 })).status, 201);
  timestamp = Date.parse('2026-10-29T01:30:00Z');
  const renewed = await api().post('/v1/auth/refresh').send({ refreshToken: employee.refreshToken });
  const result = await api().get('/v1/dashboard').set(auth(renewed.body.data.accessToken));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.checkedInCount, 1);
});
test('authorized handover recipients receive names and shift context without gaining broader employee or shift access', async () => {
  const { admin, employee, duty, office } = await workplace();
  const recipient = await account({ branchId: office.id });
  const outsider = await account({ branchId: office.id });
  const otherBranch = await branch(admin, 'Other metadata branch');
  const unrelatedManager = await account({ role: 'manager', branchId: otherBranch.id });
  const created = await api().post('/v1/handovers').set(auth(employee.accessToken)).send({
    shiftId: duty.id, recipientId: recipient.id, originalText: 'Lock storage door EQ-12', translatedText: 'Khóa cửa kho EQ-12',
    criticalFacts: [{id:randomUUID(),kind:'equipment',label:'Door equipment',value:'EQ-12'}],
    sourceLanguage: 'en', targetLanguage: 'vi', status: 'submitted',
    items: [{ id: randomUUID(), text: 'Lock the storage door', translatedText: 'Khóa cửa kho', state: 'open' }],
  });
  assert.equal(created.status, 201);
  const handoverId = created.body.data.id;
  assert.equal((await api().get(`/v1/employees/${employee.id}`).set(auth(recipient.accessToken))).status, 404);
  assert.equal((await api().get(`/v1/shifts/${duty.id}`).set(auth(recipient.accessToken))).status, 404);
  const listed = await api().get('/v1/handovers').set(auth(recipient.accessToken));
  const detail = await api().get(`/v1/handovers/${handoverId}`).set(auth(recipient.accessToken));
  assert.equal(listed.status, 200); assert.equal(detail.status, 200);
  for (const row of [listed.body.data[0], detail.body.data]) {
    assert.equal(row.createdByName, employee.fullName);
    assert.equal(row.recipientName, recipient.fullName);
    assert.equal(row.shiftTitle, duty.title);
    assert.equal(new Date(row.shiftStartsAt).toISOString(), duty.startsAt);
    assert.equal(row.scopeBranchId, undefined);
  }
  for (const user of [outsider, unrelatedManager]) {
    assert.equal((await api().get('/v1/handovers').set(auth(user.accessToken))).body.data.length, 0);
    assert.equal((await api().get(`/v1/handovers/${handoverId}`).set(auth(user.accessToken))).status, 404);
  }
  assert.equal((await api().patch(`/v1/handovers/${handoverId}`).set(auth(employee.accessToken)).send({ version: 1, createdByName: 'Forged name' })).status, 422);
});
test('shift lists and details identify assigned employees and branches only within existing scope', async () => {
  const { admin, employee, duty, office } = await workplace();
  const other = await account({ branchId: office.id });
  const listed = await api().get('/v1/shifts').set(auth(admin.accessToken));
  const detail = await api().get(`/v1/shifts/${duty.id}`).set(auth(employee.accessToken));
  assert.equal(listed.status, 200); assert.equal(detail.status, 200);
  for (const row of [listed.body.data[0], detail.body.data]) {
    assert.equal(row.employeeName, employee.fullName);
    assert.equal(row.branchName, office.name);
  }
  assert.equal((await api().get('/v1/shifts').set(auth(other.accessToken))).body.data.length, 0);
  assert.equal((await api().get(`/v1/shifts/${duty.id}`).set(auth(other.accessToken))).status, 404);
  assert.equal((await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ employeeName: 'Forged name' })).status, 422);
});
test('branch time policy is admin-managed and existing shift snapshots survive policy changes', async () => {
  const { admin, employee, duty, office } = await workplace();
  assert.deepEqual(office.timePolicy, { checkInEarlyMinutes: 30, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10, checkOutLateMinutes: 120 });
  const changedPolicy = { checkInEarlyMinutes: 60, lateGraceMinutes: 5, earlyLeaveGraceMinutes: 0, checkOutLateMinutes: 30 };
  assert.equal((await api().patch(`/v1/branches/${office.id}`).set(auth(employee.accessToken)).send({ timePolicy: changedPolicy })).status, 403);
  assert.equal((await api().patch(`/v1/branches/${office.id}`).set(auth(admin.accessToken)).send({ timePolicy: changedPolicy })).status, 200);
  const old = await api().get(`/v1/shifts/${duty.id}`).set(auth(employee.accessToken));
  assert.equal(old.body.data.timePolicySnapshot.checkInEarlyMinutes, 30);
  const next = await shift(admin, employee, office.id);
  assert.deepEqual(next.timePolicySnapshot, changedPolicy);
  const rescheduled = await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ startsAt: new Date(timestamp + 3600000).toISOString(), endsAt: new Date(timestamp + 7200000).toISOString() });
  assert.equal(rescheduled.status, 200);
  assert.deepEqual(rescheduled.body.data.timePolicySnapshot, changedPolicy);
});
test('check-in window rejects future and past shifts and includes its exact opening and closing boundaries', async () => {
  const start = timestamp + 3600000, end = timestamp + 7200000;
  const { admin, employee, duty, office } = await workplace({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  const tooEarly = await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  assert.equal(tooEarly.status, 409); assert.equal(tooEarly.body.error.code, 'PUNCH_WINDOW_CLOSED');
  await advanceTo(start - 30 * 60000, admin, employee);
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body)).status, 201);
  const closes = await shift(admin, employee, office.id, { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const expired = await shift(admin, employee, office.id, { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  await advanceTo(end, employee);
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send({ ...body, shiftId: closes.id })).status, 201);
  timestamp = end + 1;
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send({ ...body, shiftId: expired.id })).status, 409);
});
test('overnight check-out uses full instants and accepts the exact latest allowed time', async () => {
  const start = Date.parse('2026-10-29T15:00:00Z'), end = Date.parse('2026-10-29T23:00:00Z');
  timestamp = start;
  const { employee, duty } = await workplace({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  assert.equal((await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body)).status, 201);
  await advanceTo(end + 120 * 60000, employee);
  const checkedOut = await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body);
  assert.equal(checkedOut.status, 200);
  assert.equal(new Date(checkedOut.body.data.checkOutAt).toISOString(), '2026-10-30T01:00:00.000Z');
  assert.equal(checkedOut.body.data.timing.rawSpanMinutes, 600);
});
test('expired check-out window leaves the record open for a correction instead of inventing a check-out', async () => {
  const { employee, duty } = await workplace();
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  await advanceTo(Date.parse(duty.endsAt) + 120 * 60000 + 1, employee);
  const rejected = await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'PUNCH_WINDOW_CLOSED');
  const rows = (await api().get('/v1/attendance').set(auth(employee.accessToken))).body.data;
  assert.equal(rows[0].checkOutAt, null);
  assert.equal(rows[0].timing.rawSpanMinutes, null);
  assert.equal(rows[0].timing.missingCheckOut, true);
});
test('late and early-leave flags use grace boundaries while retaining actual offsets', async () => {
  const start = timestamp, end = timestamp + 2 * 3600000;
  const { admin, employee, duty, office } = await workplace({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const other = await account({ branchId: office.id });
  const otherDuty = await shift(admin, other, office.id, { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  await advanceTo(start + 10 * 60000, employee, other);
  const boundary = await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  assert.equal(boundary.body.data.timing.late, false);
  assert.equal(boundary.body.data.timing.arrivalDelayMinutes, 10);
  timestamp++;
  const late = await api().post('/v1/attendance/check-in').set(auth(other.accessToken)).send({ ...body, shiftId: otherDuty.id });
  assert.equal(late.body.data.timing.late, true);
  await advanceTo(end - 10 * 60000 - 1, employee, other);
  const early = await api().post('/v1/attendance/check-out').set(auth(other.accessToken)).send({ ...body, shiftId: otherDuty.id });
  assert.equal(early.body.data.timing.earlyLeave, true);
  timestamp++;
  const exact = await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body);
  assert.equal(exact.body.data.timing.earlyLeave, false);
  assert.equal(exact.body.data.timing.earlyLeaveMinutes, 10);
});
test('shift status is server-managed and planning cannot rewrite an attendance or correction history', async () => {
  const { admin, employee, duty, office } = await workplace();
  assert.equal((await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ status: 'completed' })).status, 422);
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  const locked = await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ endsAt: new Date(timestamp + 7200000).toISOString() });
  assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'SHIFT_PLAN_LOCKED');
  const detail = (await api().get(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken))).body.data;
  assert.equal(detail.planLocked, true); assert.equal(detail.hasAttendance, true);
  assert.equal((await api().patch(`/v1/shifts/${duty.id}`).set(auth(admin.accessToken)).send({ title: 'Corrected display title' })).status, 200);
  const missing = await shift(admin, employee, office.id);
  const correction = await api().post('/v1/corrections').set(auth(employee.accessToken)).send({ shiftId: missing.id, requestedCheckIn: new Date(timestamp - 60000).toISOString(), reason: 'Forgot to punch' });
  assert.equal(correction.status, 201);
  assert.equal((await api().patch(`/v1/shifts/${missing.id}`).set(auth(admin.accessToken)).send({ startsAt: new Date(timestamp - 7200000).toISOString() })).status, 409);
  assert.equal((await api().get(`/v1/shifts/${missing.id}`).set(auth(admin.accessToken))).body.data.hasCorrections, true);
});
test('approved correction preserves immutable device evidence and records before and after audit', async () => {
  const { admin, employee, duty } = await workplace();
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  const originalIn = new Date(timestamp).toISOString();
  await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  timestamp += 60000;
  const originalOut = new Date(timestamp).toISOString();
  await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body);
  const adjustedIn = new Date(Date.parse(originalIn) - 10 * 60000).toISOString();
  const adjustedOut = new Date(Date.parse(originalOut) + 15 * 60000).toISOString();
  const requested = await api().post('/v1/corrections').set(auth(employee.accessToken)).send({ shiftId: duty.id, requestedCheckIn: adjustedIn, requestedCheckOut: adjustedOut, reason: 'Verified time adjustment' });
  const approved = await api().patch(`/v1/corrections/${requested.body.data.id}`).set(auth(admin.accessToken)).send({ status: 'approved', resolutionNote: 'Checked evidence' });
  assert.equal(approved.status, 200);
  assert.equal(new Date(approved.body.data.beforeAttendance.checkInAt).toISOString(), originalIn);
  assert.equal(new Date(approved.body.data.afterAttendance.checkInAt).toISOString(), adjustedIn);
  assert.ok(approved.body.data.resolvedAt);
  const record = (await api().get('/v1/attendance').set(auth(employee.accessToken))).body.data[0];
  assert.equal(new Date(record.recordedCheckInAt).toISOString(), originalIn);
  assert.equal(new Date(record.recordedCheckOutAt).toISOString(), originalOut);
  assert.equal(new Date(record.checkInAt).toISOString(), adjustedIn);
  assert.equal(record.timing.rawSpanMinutes, 26);
  assert.equal(record.timing.recordedSpanMinutes, 1);
});
test('monthly report attributes overnight work to the local starting month and enforces role filters', async () => {
  const start = Date.parse('2026-10-31T15:00:00Z'), end = Date.parse('2026-10-31T23:00:00Z');
  timestamp = start;
  const { admin, employee, duty, office } = await workplace({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  const body = { shiftId: duty.id, latitude: 10, longitude: 106, accuracyMeters: 5 };
  await api().post('/v1/attendance/check-in').set(auth(employee.accessToken)).send(body);
  await advanceTo(end, admin, employee);
  await api().post('/v1/attendance/check-out').set(auth(employee.accessToken)).send(body);
  const otherBranch = await branch(admin, 'Report other branch');
  const manager = await account({ role: 'manager', branchId: otherBranch.id });
  const ownManager = await account({ role: 'manager', branchId: office.id });
  const october = await api().get('/v1/reports/monthly?month=2026-10').set(auth(employee.accessToken));
  assert.equal(october.status, 200);
  assert.equal(october.body.data.rows.length, 1);
  assert.equal(october.body.data.rows[0].workDate, '2026-10-31');
  assert.equal(october.body.data.rows[0].localTimes.endsAt, '2026-11-01 06:00');
  assert.equal(october.body.data.totals.rawSpanMinutes, 480);
  assert.equal((await api().get('/v1/reports/monthly?month=2026-11').set(auth(employee.accessToken))).body.data.rows.length, 0);
  assert.equal((await api().get('/v1/reports/monthly?month=2026-10').set(auth(manager.accessToken))).body.data.rows.length, 0);
  assert.equal((await api().get(`/v1/reports/monthly?month=2026-10&employeeId=${employee.id}`).set(auth(manager.accessToken))).status, 403);
  assert.equal((await api().get(`/v1/reports/monthly?month=2026-10&branchId=${otherBranch.id}`).set(auth(employee.accessToken))).status, 403);
  const managed = await api().get(`/v1/reports/monthly?month=2026-10&employeeId=${employee.id}`).set(auth(ownManager.accessToken));
  assert.equal(managed.status, 200); assert.equal(managed.body.data.rows.length, 1);
  const all = await api().get(`/v1/reports/monthly?month=2026-10&branchId=${office.id}`).set(auth(admin.accessToken));
  assert.equal(all.status, 200); assert.equal(all.body.data.rows.length, 1);
});
